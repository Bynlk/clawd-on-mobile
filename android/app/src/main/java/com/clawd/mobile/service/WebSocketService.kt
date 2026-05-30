package com.clawd.mobile.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.MainActivity
import com.clawd.mobile.R
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.ws.ClawdWebSocket
import com.clawd.mobile.ws.ConnectionState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

class WebSocketService : Service() {

    companion object {
        const val CHANNEL_SERVICE = "clawd_service"
        const val NOTIFICATION_ID = 9999
        const val ACTION_CONNECT = "com.clawd.mobile.CONNECT"
        const val ACTION_DISCONNECT = "com.clawd.mobile.DISCONNECT"

        @Volatile
        private var instance: WebSocketService? = null

        fun getWebSocket(): ClawdWebSocket? = instance?.webSocket

        fun isRunning(): Boolean = instance != null

        fun start(context: Context, config: ConnectionConfig? = null) {
            val intent = Intent(context, WebSocketService::class.java).apply {
                action = ACTION_CONNECT
                config?.let {
                    putExtra("host", it.host)
                    putExtra("port", it.port)
                    putExtra("token", it.token)
                }
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, WebSocketService::class.java).apply {
                action = ACTION_DISCONNECT
            })
        }
    }

    private val prefsStore by lazy { PrefsStore(this) }
    var webSocket: ClawdWebSocket? = null
        private set
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var stateCollectorJob: Job? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        webSocket = ClawdWebSocket(prefsStore)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                startForeground(NOTIFICATION_ID, buildNotification("连接中..."))
                acquireLocks()
                val host = intent.getStringExtra("host")
                val port = intent.getIntExtra("port", 0)
                val token = intent.getStringExtra("token")
                if (host != null && port > 0 && token != null) {
                    webSocket?.connect(ConnectionConfig(host, port, token))
                } else {
                    webSocket?.reconnect()
                }
                startStateCollector()
            }
            ACTION_DISCONNECT -> {
                webSocket?.disconnect()
                releaseLocks()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> {
                // Service restarted by system
                startForeground(NOTIFICATION_ID, buildNotification("已断开"))
                acquireLocks()
                webSocket?.reconnect()
                startStateCollector()
            }
        }
        return START_STICKY
    }

    private fun startStateCollector() {
        stateCollectorJob?.cancel()
        var previousState: ConnectionState? = null
        stateCollectorJob = scope.launch {
            webSocket?.connectionState?.collect { state ->
                val status = when (state) {
                    ConnectionState.CONNECTED -> "已连接 - ${webSocket?.currentHost ?: ""}"
                    ConnectionState.CONNECTING -> "连接中..."
                    ConnectionState.RECONNECTING -> "重新连接中..."
                    ConnectionState.AUTH_FAILED -> "认证失败"
                    ConnectionState.DISCONNECTED -> "已断开"
                }
                try {
                    val nm = getSystemService(android.app.NotificationManager::class.java)
                    nm.notify(NOTIFICATION_ID, buildNotification(status))

                    // Alert notifications for connection state changes
                    if (previousState == ConnectionState.CONNECTED && state == ConnectionState.DISCONNECTED) {
                        val alert = NotificationCompat.Builder(this@WebSocketService, NotificationHelper.CHANNEL_ALERT)
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setContentTitle("😴 和桌面端失联了")
                            .setContentText("检查一下网络？")
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .setAutoCancel(true)
                            .build()
                        nm.notify("conn:disconnect".hashCode(), alert)
                    }
                    if (previousState == ConnectionState.RECONNECTING && state == ConnectionState.CONNECTED) {
                        val alert = NotificationCompat.Builder(this@WebSocketService, NotificationHelper.CHANNEL_ALERT)
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setContentTitle("✅ 重新连上啦")
                            .setContentText("继续摸鱼！")
                            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                            .setAutoCancel(true)
                            .build()
                        nm.notify("conn:reconnect".hashCode(), alert)
                    }
                } catch (_: Exception) {}
                previousState = state
            }
        }
    }

    private fun buildNotification(status: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setContentTitle("Clawd Mobile")
            .setContentText(status)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun acquireLocks() {
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL, "clawd:sse").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wakeLock == null) {
            val pm = applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:sse").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseLocks() {
        try { wifiLock?.release() } catch (_: Exception) {}
        wifiLock = null
        try { wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stateCollectorJob?.cancel()
        releaseLocks()
        scope.cancel()
        webSocket?.destroy()
        webSocket = null
        instance = null
        super.onDestroy()
    }
}

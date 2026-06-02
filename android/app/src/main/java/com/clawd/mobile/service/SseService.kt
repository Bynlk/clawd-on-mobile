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
import com.clawd.mobile.ws.SseClient
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.util.SafeExecutor
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*

/**
 * Foreground service managing the SSE connection to Clawd server.
 */
class SseService : Service() {

    companion object {
        const val CHANNEL_SERVICE = "clawd_service"
        const val NOTIFICATION_ID = 9999
        const val ACTION_CONNECT = "com.clawd.mobile.CONNECT"
        const val ACTION_DISCONNECT = "com.clawd.mobile.DISCONNECT"

        private const val WAKELOCK_TIMEOUT_MS = 60 * 60 * 1000L       // 1 hour
        private const val WAKELOCK_RENEWAL_INTERVAL_MS = 30 * 60 * 1000L  // 30 minutes

        @Volatile
        private var instance: SseService? = null

        private val _clientReady = Channel<SseClient>(Channel.CONFLATED)

        /** Emits when a new SseClient instance is created and ready. */
        val clientReady: Flow<SseClient> = _clientReady.receiveAsFlow()

        fun getClient(): SseClient? = instance?.sseClient

        fun isRunning(): Boolean = instance != null

        fun start(context: Context, config: ConnectionConfig? = null) {
            val intent = Intent(context, SseService::class.java).apply {
                action = ACTION_CONNECT
                config?.let {
                    putExtra("use_new_config", true)
                }
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, SseService::class.java).apply {
                action = ACTION_DISCONNECT
            })
        }
    }

    private val prefsStore by lazy { PrefsStore.getInstance(this) }
    var sseClient: SseClient? = null
        private set
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var stateCollectorJob: Job? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        sseClient = SseClient(prefsStore)
        _clientReady.trySend(sseClient!!)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.status_connecting)))
                acquireLocks()
                val useNewConfig = intent.getBooleanExtra("use_new_config", false)
                if (useNewConfig) {
                    val config = prefsStore.loadConfig()
                    if (config != null) {
                        sseClient?.connect(config)
                    } else {
                        sseClient?.reconnect()
                    }
                } else {
                    sseClient?.reconnect()
                }
                startStateCollector()
            }
            ACTION_DISCONNECT -> {
                sseClient?.disconnect()
                releaseLocks()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> {
                // Service restarted by system
                startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.status_disconnected)))
                acquireLocks()
                sseClient?.reconnect()
                startStateCollector()
            }
        }
        return START_STICKY
    }

    private fun startStateCollector() {
        stateCollectorJob?.cancel()
        var previousState: ConnectionState? = null
        stateCollectorJob = scope.launch {
            // WakeLock renewal: check every 30 min, re-acquire if expired
            launch {
                while (isActive) {
                    delay(WAKELOCK_RENEWAL_INTERVAL_MS)
                    renewWakeLock()
                }
            }

            sseClient?.connectionState?.collect { state ->
                val status = when (state) {
                    ConnectionState.CONNECTED -> getString(R.string.status_connected_to, sseClient?.currentHost ?: "")
                    ConnectionState.CONNECTING -> getString(R.string.status_connecting)
                    ConnectionState.PENDING_CERT_CONFIRMATION -> getString(R.string.status_connected_to, sseClient?.currentHost ?: "")
                    ConnectionState.RECONNECTING -> getString(R.string.status_reconnecting)
                    ConnectionState.AUTH_FAILED -> getString(R.string.status_auth_failed)
                    ConnectionState.DISCONNECTED -> getString(R.string.status_disconnected)
                }
                SafeExecutor.tryOrNull("WS") {
                    val nm = getSystemService(android.app.NotificationManager::class.java)
                    nm.notify(NOTIFICATION_ID, buildNotification(status))

                    // Alert notifications for connection state changes
                    val alertOpenIntent = Intent(this@SseService, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    if (previousState == ConnectionState.CONNECTED && state == ConnectionState.DISCONNECTED) {
                        val alertPending = PendingIntent.getActivity(
                            this@SseService, "conn:disconnect".hashCode(), alertOpenIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                        val alert = NotificationCompat.Builder(this@SseService, NotificationHelper.CHANNEL_ALERT)
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setContentTitle(getString(R.string.alert_disconnect_title))
                            .setContentText(getString(R.string.alert_disconnect_text))
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .setAutoCancel(true)
                            .setContentIntent(alertPending)
                            .build()
                        nm.notify("conn:disconnect".hashCode(), alert)
                    }
                    if (previousState == ConnectionState.RECONNECTING && state == ConnectionState.CONNECTED) {
                        val alertPending = PendingIntent.getActivity(
                            this@SseService, "conn:reconnect".hashCode(), alertOpenIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                        val alert = NotificationCompat.Builder(this@SseService, NotificationHelper.CHANNEL_ALERT)
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setContentTitle(getString(R.string.alert_reconnect_title))
                            .setContentText(getString(R.string.alert_reconnect_text))
                            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                            .setAutoCancel(true)
                            .setContentIntent(alertPending)
                            .build()
                        nm.notify("conn:reconnect".hashCode(), alert)
                    }
                }
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
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "clawd:sse").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wakeLock == null) {
            val pm = applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:sse").apply {
                setReferenceCounted(false)
                acquire(WAKELOCK_TIMEOUT_MS)
            }
        }
    }

    private fun releaseLocks() {
        SafeExecutor.tryOrNull("WS") { wifiLock?.release() }
        wifiLock = null
        SafeExecutor.tryOrNull("WS") { wakeLock?.release() }
        wakeLock = null
    }

    /** Re-acquire WakeLock if it expired (called periodically by renewal coroutine). */
    private fun renewWakeLock() {
        wakeLock?.let { wl ->
            if (!wl.isHeld) {
                android.util.Log.d("SseService", "WakeLock expired, re-acquiring")
                wl.acquire(WAKELOCK_TIMEOUT_MS)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stateCollectorJob?.cancel()
        releaseLocks()
        scope.cancel()
        sseClient?.destroy()
        sseClient = null
        instance = null
        super.onDestroy()
    }
}

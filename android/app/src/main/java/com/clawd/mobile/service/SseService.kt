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
import com.clawd.mobile.ws.StreamingClient
import com.clawd.mobile.ws.WsClient
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.util.SafeExecutor
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*

/**
 * Foreground service managing the WebSocket connection to Clawd server.
 *
 * ## Lifecycle
 * - Started via [SseService.start] with [ACTION_CONNECT] or [ACTION_DISCONNECT].
 * - Runs as a foreground service with a persistent notification showing connection status.
 * - Returns [START_STICKY] to be restarted by the system if killed.
 *
 * ## Connection Management
 * - Uses [WsClient] (WebSocket) as the streaming transport.
 * - The [StreamingClient] instance is created in [onStartCommand] and exposed via [getClient].
 * - Connection state changes trigger notification updates and alert notifications
 *   (disconnect alert, reconnect alert).
 *
 * ## WakeLock Management
 * - WakeLock is held conditionally: only during active display states
 *   (working, notification, attention, error) to save battery.
 * - Released when display state returns to idle.
 * - WakeLock timeout is 1 hour with 30-minute renewal checks.
 *
 * ## WiFi Lock
 * - WiFi lock is held for the entire connection lifetime to prevent WiFi sleep.
 *
 * ## Companion Object
 * - [SseService.start] / [SseService.stop] — static entry points.
 * - [SseService.getClient] — returns the current [StreamingClient] instance.
 * - [SseService.isRunning] — whether the service is currently running.
 * - [SseService.clientReady] — flow emitting when a new client is created.
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

        private val _clientReady = Channel<StreamingClient>(Channel.CONFLATED)

        /** Emits when a new StreamingClient instance is created and ready. */
        val clientReady: Flow<StreamingClient> = _clientReady.receiveAsFlow()

        fun getClient(): StreamingClient? = instance?.sseClient

        fun isRunning(): Boolean = instance != null

        /** Start the service with an optional new [config]. If null, reconnects with saved config. */
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
    var sseClient: StreamingClient? = null
        private set
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var stateCollectorJob: Job? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        sseClient = WsClient(prefsStore)
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
            // WakeLock management: hold during active states, release when idle.
            // This saves battery when the pet is idle (no tasks running).
            launch {
                sseClient?.displayState?.collect { displayState ->
                    val isActive = displayState == "working" || displayState == "notification" ||
                        displayState == "attention" || displayState == "error"
                    if (isActive) {
                        ensureWakeLockHeld()
                    } else {
                        releaseWakeLockIfHeld()
                    }
                }
            }

            // WakeLock renewal: re-acquire if expired while active
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
                    ConnectionState.CIRCUIT_OPEN -> getString(R.string.status_circuit_open)
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
        // WakeLock is managed by display state collector — acquire on active, release on idle.
        // Initial acquisition happens when the first active display state is received.
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

    /** Ensure WakeLock is held — called when display state becomes active. */
    private fun ensureWakeLockHeld() {
        if (wakeLock?.isHeld != true) {
            android.util.Log.d("SseService", "Active state — acquiring WakeLock")
            acquireWakeLock()
        }
    }

    /** Release WakeLock if currently held — called when display state becomes idle. */
    private fun releaseWakeLockIfHeld() {
        wakeLock?.let { wl ->
            if (wl.isHeld) {
                android.util.Log.d("SseService", "Idle state — releasing WakeLock")
                SafeExecutor.tryOrNull("SseService") { wl.release() }
            }
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:sse").apply {
                setReferenceCounted(false)
            }
        }
        wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
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

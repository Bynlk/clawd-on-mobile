package com.clawd.mobile.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.MainActivity
import com.clawd.mobile.R
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.ws.StreamingClient
import com.clawd.mobile.ws.WsClient
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.ConnectionTag
import com.clawd.mobile.ws.LanConnectionStrategy
import com.clawd.mobile.ws.RelayConnectionStrategy
import com.clawd.mobile.ws.SessionMerger
import com.clawd.mobile.ws.TaggedSession
import com.clawd.mobile.util.SafeExecutor
import com.clawd.mobile.console.bootstrapConsoleConnection
import com.clawd.mobile.vpn.RemoteTunnelState
import com.clawd.mobile.vpn.GoBackendAdapter
import com.clawd.mobile.vpn.WireGuardController
import java.lang.ref.WeakReference
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*

interface VpnPermissionHost {
    fun launchVpnPermission(intent: Intent)
}

internal class VpnPermissionHostRegistry(
    private val dispatchToMain: ((() -> Unit) -> Unit) = { action ->
        Handler(Looper.getMainLooper()).post(action)
        Unit
    },
) {
    private val lock = Any()
    private var host = WeakReference<VpnPermissionHost>(null)

    fun attach(value: VpnPermissionHost) = synchronized(lock) {
        host = WeakReference(value)
    }

    fun detach(value: VpnPermissionHost) = synchronized(lock) {
        if (host.get() === value) host.clear()
    }

    fun launch(intent: Intent) {
        val target = current()
        dispatchToMain {
            val stillAttached = synchronized(lock) { host.get() === target }
            if (stillAttached) target.launchVpnPermission(intent)
        }
    }

    private fun current(): VpnPermissionHost = synchronized(lock) {
        host.get() ?: throw IllegalStateException("vpn_permission_host_unavailable")
    }
}

internal fun launchConnectionStateCollectors(
    scope: CoroutineScope,
    lan: StateFlow<ConnectionState>?,
    relay: StateFlow<ConnectionState>?,
    onLan: suspend (ConnectionState) -> Unit,
    onRelay: suspend (ConnectionState) -> Unit,
): List<Job> = listOfNotNull(
    lan?.let { states -> scope.launch { states.collect(onLan) } },
    relay?.let { states -> scope.launch { states.collect(onRelay) } },
)

internal fun launchRemoteServiceCleanup(
    scope: CoroutineScope,
    disconnect: suspend () -> Unit,
    finalize: () -> Unit,
): Job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
    try {
        disconnect()
    } finally {
        finalize()
    }
}

/**
 * Foreground service managing the WebSocket connection to Clawd server.
 *
 * ## Lifecycle
 * - Started via [WsConnectionService.start] with [ACTION_CONNECT] or [ACTION_DISCONNECT].
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
 * - WakeLock timeout is 1 hour with 25-minute renewal checks.
 *
 * ## WiFi Lock
 * - WiFi lock is held for the entire connection lifetime to prevent WiFi sleep.
 *
 * ## Companion Object
 * - [WsConnectionService.start] / [WsConnectionService.stop] — static entry points.
 * - [WsConnectionService.getClient] — returns the current [StreamingClient] instance.
 * - [WsConnectionService.isRunning] — whether the service is currently running.
 * - [WsConnectionService.clientReady] — flow emitting when a new client is created.
 */
class WsConnectionService : Service() {

    companion object {
        const val CHANNEL_SERVICE = "clawd_service"
        const val NOTIFICATION_ID = 9999
        const val ACTION_CONNECT = "com.clawd.mobile.CONNECT"
        const val ACTION_DISCONNECT = "com.clawd.mobile.DISCONNECT"
        const val ACTION_REMOTE_CONNECT = "com.clawd.mobile.REMOTE_CONNECT"
        const val ACTION_REMOTE_DISCONNECT = "com.clawd.mobile.REMOTE_DISCONNECT"

        private const val WAKELOCK_TIMEOUT_MS = 60 * 60 * 1000L       // 1 hour
        private const val WAKELOCK_RENEWAL_INTERVAL_MS = 25 * 60 * 1000L  // 25 minutes (< 1h timeout to prevent expiry gap)

        @Volatile
        private var instance: WsConnectionService? = null

        private val vpnPermissionHosts = VpnPermissionHostRegistry()

        private val _remoteConnectionState =
            MutableStateFlow<RemoteConnectionState>(RemoteConnectionState.DISCONNECTED)
        val remoteConnectionState: StateFlow<RemoteConnectionState> =
            _remoteConnectionState.asStateFlow()

        private val _clientReady = Channel<StreamingClient>(Channel.CONFLATED)

        /** Emits when a new StreamingClient instance is created and ready. */
        val clientReady: Flow<StreamingClient> = _clientReady.receiveAsFlow()

        fun getClient(): StreamingClient? = instance?.streamingClient

        /** 获取指定 tag 的 client（LAN 或 Relay） */
        fun getClientByTag(tag: ConnectionTag): StreamingClient? {
            return when (tag) {
                ConnectionTag.LAN -> instance?.streamingClient
                ConnectionTag.RELAY -> instance?.relayClient
            }
        }

        /** 获取所有活跃的 client 列表 */
        fun getAllClients(): List<StreamingClient> {
            val clients = mutableListOf<StreamingClient>()
            instance?.streamingClient?.let { clients.add(it) }
            instance?.relayClient?.let { clients.add(it) }
            return clients
        }

        fun isRunning(): Boolean = instance != null

        /** Start the service with an optional new [config]. If null, reconnects with saved config. */
        fun start(context: Context, config: ConnectionConfig? = null) {
            val intent = Intent(context, WsConnectionService::class.java).apply {
                action = ACTION_CONNECT
                config?.let {
                    putExtra("use_new_config", true)
                }
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, WsConnectionService::class.java).apply {
                action = ACTION_DISCONNECT
            })
        }

        /** Explicit remote actions carry no pairing material or token extras. */
        fun connectRemote(context: Context) {
            context.startForegroundService(Intent(context, WsConnectionService::class.java).apply {
                action = ACTION_REMOTE_CONNECT
            })
        }

        fun disconnectRemote(context: Context) {
            context.startForegroundService(Intent(context, WsConnectionService::class.java).apply {
                action = ACTION_REMOTE_DISCONNECT
            })
        }

        internal fun shouldStartRelay(action: String?): Boolean = action == ACTION_REMOTE_CONNECT

        internal fun shouldDisconnectRemote(action: String?): Boolean = action == ACTION_DISCONNECT

        fun attachVpnPermissionHost(host: VpnPermissionHost) = vpnPermissionHosts.attach(host)

        fun detachVpnPermissionHost(host: VpnPermissionHost) = vpnPermissionHosts.detach(host)

        fun onVpnPermissionResult(granted: Boolean) {
            instance?.wireGuardController?.onPermissionResult(granted)
        }

        /**
         * Shared flow for signaling approval completion across UI paths.
         * Emits requestId when an approval is completed (from notification or overlay).
         * extraBufferCapacity=16 ensures ApprovalWorker emit never suspends.
         */
        val approvalCompletedFlow = MutableSharedFlow<String>(extraBufferCapacity = 16)

        /** Relay peer 连接状态（PC 在线/离线） */
        private val _relayPeerState = MutableStateFlow<String>("disconnected")
        val relayPeerState: StateFlow<String> = _relayPeerState.asStateFlow()

        /** Session merger — 合并 LAN + Relay 的 sessions */
        fun getSessionMerger(): SessionMerger? = instance?.sessionMerger
    }

    private val prefsStore by lazy { PrefsStore.getInstance(this) }
    @Volatile
    var streamingClient: StreamingClient? = null
        private set
    @Volatile
    var relayClient: StreamingClient? = null
        private set
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var sessionMerger: SessionMerger? = null
    private var stateCollectorJob: Job? = null
    private var remoteStateCollectorJob: Job? = null
    private var shutdownJob: Job? = null
    private var remoteCoordinator: RemoteConnectionCoordinator? = null
    private var wireGuardController: WireGuardController? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastNetworkReconnectMs = 0L
    private val networkDebounceMs = 3000L // Debounce network callbacks to avoid concurrent connections

    override fun onCreate() {
        super.onCreate()
        instance = this
        val lanClient = WsClient(prefsStore)
        streamingClient = lanClient
        _clientReady.trySend(lanClient)

        // 创建 session merger
        val merger = SessionMerger(scope)
        sessionMerger = merger
        merger.register(ConnectionTag.LAN, lanClient.sessions)
        val controller = WireGuardController(
            backend = GoBackendAdapter(applicationContext),
            scope = scope,
            permissionIntentProvider = { VpnService.prepare(applicationContext) },
            permissionLauncher = vpnPermissionHosts::launch,
        )
        wireGuardController = controller
        configureRemoteCoordinator(controller)
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
                        streamingClient?.connect(config)
                    } else {
                        streamingClient?.reconnect()
                    }
                } else {
                    streamingClient?.reconnect()
                }
                startStateCollector()
            }
            ACTION_DISCONNECT -> {
                scope.launch {
                    remoteCoordinator?.disconnect()
                    streamingClient?.disconnect()
                    releaseLocks()
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
            ACTION_REMOTE_CONNECT -> {
                startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.relay_status_connecting)))
                acquireLocks()
                startStateCollector()
                scope.launch { remoteCoordinator?.connect() }
            }
            ACTION_REMOTE_DISCONNECT -> {
                startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.relay_status_disconnected)))
                scope.launch { remoteCoordinator?.disconnect() }
            }
            else -> {
                // Service restarted by system
                startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.status_disconnected)))
                acquireLocks()
                streamingClient?.reconnect()
                startStateCollector()
            }
        }
        return START_STICKY
    }

    private fun startStateCollector() {
        stateCollectorJob?.cancel()
        var previousState: ConnectionState? = null
        stateCollectorJob = scope.launch {
            fun CoroutineScope.watchConsoleConnection(client: StreamingClient) = launch {
                client.connectionState
                    .filter { it == ConnectionState.CONNECTED }
                    .collect {
                        bootstrapConsoleConnection(
                            client = client,
                            enabled = prefsStore.isConsoleSyncEnabled(),
                            deviceId = prefsStore.getOrCreateConsoleDeviceId(),
                        )
                    }
            }

            streamingClient?.let { watchConsoleConnection(it) }
            relayClient?.let { watchConsoleConnection(it) }

            // WakeLock management: hold during active states, release when idle.
            // This saves battery when the pet is idle (no tasks running).
            launch {
                streamingClient?.displayState?.collect { displayState ->
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

            suspend fun handleLanState(state: ConnectionState) {
                val status = when (state) {
                    ConnectionState.CONNECTED -> getString(R.string.status_connected_to, streamingClient?.currentHost ?: "")
                    ConnectionState.CONNECTING -> getString(R.string.status_connecting)
                    ConnectionState.PENDING_CERT_CONFIRMATION -> getString(R.string.status_connected_to, streamingClient?.currentHost ?: "")
                    ConnectionState.RECONNECTING -> getString(R.string.status_reconnecting)
                    ConnectionState.AUTH_FAILED -> getString(R.string.status_auth_failed)
                    ConnectionState.DISCONNECTED -> getString(R.string.status_disconnected)
                    ConnectionState.CIRCUIT_OPEN -> getString(R.string.status_circuit_open)
                }
                SafeExecutor.tryOrNull("WS") {
                    val nm = getSystemService(android.app.NotificationManager::class.java)
                    nm.notify(NOTIFICATION_ID, buildNotification(status))

                    // Alert notifications for connection state changes
                    val alertOpenIntent = Intent(this@WsConnectionService, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    if (previousState == ConnectionState.CONNECTED && state == ConnectionState.DISCONNECTED) {
                        val alertPending = PendingIntent.getActivity(
                            this@WsConnectionService, "conn:disconnect".hashCode(), alertOpenIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                        val alert = NotificationCompat.Builder(this@WsConnectionService, NotificationHelper.CHANNEL_ALERT)
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
                            this@WsConnectionService, "conn:reconnect".hashCode(), alertOpenIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                        val alert = NotificationCompat.Builder(this@WsConnectionService, NotificationHelper.CHANNEL_ALERT)
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

            // Relay client state collector
            suspend fun handleRelayState(state: ConnectionState) {
                val relayStatus = when (state) {
                    ConnectionState.CONNECTED -> getString(R.string.relay_status_connected)
                    ConnectionState.CONNECTING -> getString(R.string.relay_status_connecting)
                    ConnectionState.RECONNECTING -> getString(R.string.relay_status_reconnecting)
                    ConnectionState.AUTH_FAILED -> getString(R.string.relay_status_auth_failed)
                    ConnectionState.DISCONNECTED -> getString(R.string.relay_status_disconnected)
                    ConnectionState.CIRCUIT_OPEN -> getString(R.string.relay_status_circuit_open)
                    else -> getString(R.string.relay_status_unknown)
                }
                android.util.Log.d("WsConnectionService", "Relay state: $relayStatus")
                // 更新通知（如果有 relay 连接）
                if (state == ConnectionState.CONNECTED || state == ConnectionState.DISCONNECTED) {
                    SafeExecutor.tryOrNull("WS") {
                        val nm = getSystemService(android.app.NotificationManager::class.java)
                        nm.notify(NOTIFICATION_ID, buildNotification(relayStatus))
                    }
                }
            }

            launchConnectionStateCollectors(
                scope = this,
                lan = streamingClient?.connectionState,
                relay = relayClient?.connectionState,
                onLan = ::handleLanState,
                onRelay = ::handleRelayState,
            )
        }
    }

    private fun buildNotification(status: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(status)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun acquireLocks() {
        // WiFi lock 始终获取 — LAN 连接需要它，relay 连接可能走蜂窝但不影响
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL, "clawd:ws").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        // WakeLock is managed by display state collector — acquire on active, release on idle.
        // Initial acquisition happens when the first active display state is received.

        // Register network change callback for instant WiFi switch detection
        if (networkCallback == null) {
            val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now - lastNetworkReconnectMs < networkDebounceMs) {
                        android.util.Log.d("WsConnectionService", "Network available — debounced (${now - lastNetworkReconnectMs}ms ago)")
                        return
                    }
                    lastNetworkReconnectMs = now
                    android.util.Log.d("WsConnectionService", "Network available — triggering reconnect")
                    (streamingClient as? com.clawd.mobile.ws.WsClient)?.reconnectOnNetworkChange()
                    remoteCoordinator?.onNetworkChanged()
                }
            }
            networkCallback = callback
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.registerNetworkCallback(request, callback)
        }
    }

    private fun releaseLocks() {
        SafeExecutor.tryOrNull("WS") { wifiLock?.release() }
        wifiLock = null
        SafeExecutor.tryOrNull("WS") { wakeLock?.release() }
        wakeLock = null
        networkCallback?.let { cb ->
            SafeExecutor.tryOrNull("WsConnectionService") {
                val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.unregisterNetworkCallback(cb)
            }
        }
        networkCallback = null
    }

    /** Re-acquire WakeLock if it expired (called periodically by renewal coroutine). */
    private fun renewWakeLock() {
        wakeLock?.let { wl ->
            if (!wl.isHeld) {
                android.util.Log.d("WsConnectionService", "WakeLock expired, re-acquiring")
                wl.acquire(WAKELOCK_TIMEOUT_MS)
            }
        }
    }

    /** Ensure WakeLock is held — called when display state becomes active. */
    private fun ensureWakeLockHeld() {
        if (wakeLock?.isHeld != true) {
            android.util.Log.d("WsConnectionService", "Active state — acquiring WakeLock")
            acquireWakeLock()
        }
    }

    /** Release WakeLock if currently held — called when display state becomes idle. */
    private fun releaseWakeLockIfHeld() {
        wakeLock?.let { wl ->
            if (wl.isHeld) {
                android.util.Log.d("WsConnectionService", "Idle state — releasing WakeLock")
                SafeExecutor.tryOrNull("WsConnectionService") { wl.release() }
            }
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:ws").apply {
                setReferenceCounted(false)
            }
        }
        wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        val coordinator = remoteCoordinator
        stateCollectorJob?.cancel()
        remoteStateCollectorJob?.cancel()
        sessionMerger?.clear()
        sessionMerger = null
        releaseLocks()
        streamingClient?.destroy()
        streamingClient = null
        instance = null
        shutdownJob = launchRemoteServiceCleanup(
            scope = scope,
            disconnect = { coordinator?.disconnect() },
            finalize = {
                relayClient?.destroy()
                relayClient = null
                remoteCoordinator = null
                wireGuardController = null
                _remoteConnectionState.value = RemoteConnectionState.DISCONNECTED
                scope.cancel()
            },
        )
        super.onDestroy()
    }

    private fun configureRemoteCoordinator(controller: WireGuardController) {
        remoteStateCollectorJob?.cancel()
        val coordinator = RemoteConnectionCoordinator(
            scope = scope,
            pairingProvider = prefsStore::loadRelayPairing,
            vpn = object : RemoteVpnConnectionAdapter {
                override suspend fun start(pairing: com.clawd.mobile.data.RelayPairingConfig): RemoteVpnStartResult =
                    when (controller.start(pairing)) {
                        RemoteTunnelState.UP -> RemoteVpnStartResult.UP
                        RemoteTunnelState.DOWN -> RemoteVpnStartResult.PERMISSION_DENIED
                        else -> RemoteVpnStartResult.FAILED
                    }

                override suspend fun stop(): Boolean = when (controller.stop()) {
                    RemoteTunnelState.DOWN, RemoteTunnelState.UNPAIRED -> true
                    else -> false
                }
            },
            health = FixedRelayHealthCheckAdapter(),
            relay = object : RemoteRelayConnectionAdapter {
                override suspend fun connect(
                    config: com.clawd.mobile.data.RelayConnectionConfig,
                ): RemoteRelayConnectResult {
                    val client = ensureRelayClient()
                    client.connect(
                        ConnectionConfig(
                            host = "10.8.0.1",
                            port = 7891,
                            token = "relay",
                            relayUrl = config.url,
                            relayToken = config.token,
                            useRelay = false,
                        )
                    )
                    return when (client.connectionState.first { state ->
                        state == ConnectionState.CONNECTED ||
                            state == ConnectionState.AUTH_FAILED ||
                            state == ConnectionState.CIRCUIT_OPEN ||
                            state == ConnectionState.DISCONNECTED
                    }) {
                        ConnectionState.CONNECTED -> RemoteRelayConnectResult.CONNECTED
                        ConnectionState.AUTH_FAILED -> RemoteRelayConnectResult.AUTH_FAILED
                        else -> RemoteRelayConnectResult.FAILED
                    }
                }

                override suspend fun disconnect(): Boolean {
                    val client = relayClient ?: return true
                    client.disconnect()
                    client.destroy()
                    relayClient = null
                    sessionMerger?.unregister(ConnectionTag.RELAY)
                    return true
                }
            },
        )
        remoteCoordinator = coordinator
        remoteStateCollectorJob = scope.launch {
            coordinator.state.collect { _remoteConnectionState.value = it }
        }
    }

    private fun ensureRelayClient(): StreamingClient {
        relayClient?.let { return it }
        return WsClient(prefsStore, RelayConnectionStrategy()).also { relay ->
            relayClient = relay
            sessionMerger?.register(ConnectionTag.RELAY, relay.sessions)
            startStateCollector()
        }
    }
}

package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import com.clawd.mobile.util.ApprovalSender
import com.clawd.mobile.util.CertificateVerifier
import com.clawd.mobile.util.ConnectionLog
import com.clawd.mobile.util.HttpClientProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.Response

/**
 * Shared implementation for [StreamingClient] transport implementations.
 *
 * Holds all common state (flows, connection config, reconnect logic, message handler)
 * and delegates transport-specific work to three abstract hooks:
 * [doConnect], [closeTransport], [cancelTransport].
 *
 * Thread-safety contract:
 * - [config] is `@Volatile` — written from main/IO threads, read from coroutine dispatchers.
 * - `reconnectJob` / `watchdogJob` are only mutated from the [scope] dispatcher (IO).
 * - Flow backing fields (`_connectionState`, `_sessionsMap`, etc.) are safe by design
 *   ([MutableStateFlow] / [MutableSharedFlow] / [ConcurrentHashMap]).
 */
abstract class AbstractStreamingClient(
    protected val prefsStore: PrefsStore,
) : StreamingClient {

    /** Log tag, overridden per subclass (e.g. "WsClient"). */
    protected abstract val tag: String

    /** Watchdog timeout in milliseconds. WS uses 90s. */
    protected abstract val watchdogTimeoutMs: Long

    // ── Transport hooks ──────────────────────────────────────────────────

    /** Open the transport connection. Called from [connect] and [scheduleReconnect]. */
    protected abstract fun doConnect()

    /** Close the transport handle gracefully (called from [disconnect]). */
    protected abstract fun closeTransport()

    /** Force-cancel the transport handle (called from [destroy]). */
    protected abstract fun cancelTransport()

    /** Send a raw JSON message over the transport.
     *  @return true if sent successfully, false if not connected or buffer full. */
    abstract override fun sendMessage(json: String): Boolean

    // ── Shared state ─────────────────────────────────────────────────────

    @Volatile
    protected var config: ConnectionConfig? = null
    protected var reconnectDelay = 1000L
    protected val maxReconnectDelay = 30000L
    protected var reconnectJob: Job? = null
    protected var watchdogJob: Job? = null
    protected var reconnectAttempts = 0
    protected val maxReconnectAttempts = 10
    /** Delay before auto-recovering from circuit-open state (60 seconds). */
    private val CIRCUIT_OPEN_RETRY_MS = 60_000L
    protected val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    protected val messageParser = MessageParser()

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    override val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _sessionsMap = java.util.concurrent.ConcurrentHashMap<String, SessionData>()
    private val _sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
    override val sessions: StateFlow<Map<String, SessionData>> = _sessions

    /** Emit current [_sessionsMap] snapshot to the StateFlow. */
    protected fun emitSessions() {
        _sessions.value = _sessionsMap.toMap()
    }

    private val _permissionRequests = MutableSharedFlow<PermissionRequestData>(extraBufferCapacity = 16)
    override val permissionRequests: SharedFlow<PermissionRequestData> = _permissionRequests

    private val _syncing = MutableStateFlow(false)
    override val syncing: StateFlow<Boolean> = _syncing

    private val _displayState = MutableStateFlow("idle")
    override val displayState: StateFlow<String> = _displayState

    private val _certFingerprintPending = MutableSharedFlow<CertFingerprintInfo>(extraBufferCapacity = 1)
    override val certFingerprintPending: SharedFlow<CertFingerprintInfo> = _certFingerprintPending

    private val _reactions = MutableSharedFlow<String>(extraBufferCapacity = 8)
    override val reactions: SharedFlow<String> = _reactions

    // Lazy because `tag` is an abstract val not yet initialized during parent constructor
    protected val messageHandler by lazy {
        MessageHandler(
            tag = tag,
            sessionsMap = _sessionsMap,
            emitSessions = { emitSessions() },
            displayState = _displayState,
            syncing = _syncing,
            permissionRequests = _permissionRequests,
            reactions = _reactions,
            scope = scope,
            messageParser = messageParser,
            sendPong = { pongJson -> sendMessage(pongJson) },
        )
    }

    override val currentHost: String? get() = config?.host
    override val currentPort: Int? get() = config?.port

    // ── Shared concrete implementations ──────────────────────────────────

    override fun connect(config: ConnectionConfig) {
        android.util.Log.d(tag, "connect(${config.host}:${config.port})")
        ConnectionLog.d(tag, "connect(${config.host}:${config.port}) state=${_connectionState.value}")
        this.config = config
        prefsStore.saveConfig(config)
        HttpClientProvider.setCertFingerprint(prefsStore.getCertFingerprint())
        reconnectDelay = 1000L
        reconnectAttempts = 0
        doConnect()
    }

    override fun reconnect() {
        val state = _connectionState.value
        ConnectionLog.d(tag, "reconnect() state=$state")
        if (state == ConnectionState.CONNECTED || state == ConnectionState.PENDING_CERT_CONFIRMATION) return
        if (state == ConnectionState.CONNECTING) return  // already in progress — don't race with connect()
        val saved = config ?: prefsStore.loadConfig() ?: return
        config = saved
        HttpClientProvider.setCertFingerprint(prefsStore.getCertFingerprint())
        reconnectAttempts = 0
        reconnectDelay = 1000L
        doConnect()
    }

    override fun disconnect() {
        ConnectionLog.d(tag, "disconnect() state=${_connectionState.value}")
        reconnectJob?.cancel()
        watchdogJob?.cancel()
        closeTransport()
        HttpClientProvider.reset()
        _connectionState.value = ConnectionState.DISCONNECTED
        _sessionsMap.clear()
        emitSessions()
        _displayState.value = "idle"
    }

    override fun setConnectionState(state: ConnectionState) {
        _connectionState.value = state
    }

    override fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int?): Boolean {
        val json = ApprovalSender.buildPermissionResponseJson(requestId, behavior, suggestionIndex)
        return sendMessage(json)
    }

    override fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>): Boolean {
        val json = ApprovalSender.buildElicitationResponseJson(requestId, toolInput, answers)
        return sendMessage(json)
    }

    override fun destroy() {
        watchdogJob?.cancel()
        scope.cancel()
        cancelTransport()
    }

    // ── Shared helpers (called from transport listener callbacks) ─────────

    /** Reset the watchdog timer. Call from every transport onMessage/onEvent. */
    protected fun resetWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = scope.launch {
            delay(watchdogTimeoutMs)
            // No event received within timeout — connection is silently dead
            scheduleReconnect()
        }
    }

    /** Dispatch a raw message string to [messageHandler]. */
    protected fun handleMessage(rawText: String) {
        messageHandler.handleMessage(rawText, _connectionState.value == ConnectionState.PENDING_CERT_CONFIRMATION)
    }

    /** Common doConnect preamble: cancel previous reconnect job and set connection state. */
    protected fun doConnectPreamble() {
        ConnectionLog.d(tag, "doConnectPreamble delay=$reconnectDelay attempts=$reconnectAttempts")
        reconnectJob?.cancel()
        _connectionState.value =
            if (reconnectDelay > 1000) ConnectionState.RECONNECTING else ConnectionState.CONNECTING
    }

    /**
     * Called from transport `onOpen`. Handles TOFU cert check and sets connected state.
     * Subclasses call this from their transport-specific listener after any
     * transport-specific validation.
     */
    protected fun onTransportOpen(response: Response) {
        android.util.Log.d(tag, "onOpen code=${response.code}")
        ConnectionLog.d(tag, "onTransportOpen code=${response.code}")
        reconnectJob?.cancel()
        reconnectDelay = 1000L
        reconnectAttempts = 0
        resetWatchdog()

        // TOFU: first LAN connection — extract cert fingerprint for user confirmation
        val cfg = config
        if (cfg != null && cfg.isLan && prefsStore.getCertFingerprint() == null) {
            CertificateVerifier.extractFingerprint(response)?.let { fp ->
                _connectionState.value = ConnectionState.PENDING_CERT_CONFIRMATION
                scope.launch { _certFingerprintPending.emit(CertFingerprintInfo(cfg.host, fp)) }
            } ?: run {
                _connectionState.value = ConnectionState.CONNECTED
            }
        } else {
            _connectionState.value = ConnectionState.CONNECTED
        }
    }

    /** Called from transport `onMessage`/`onEvent`. Resets watchdog and dispatches. */
    protected fun onTransportMessage(text: String) {
        ConnectionLog.d(tag, "onTransportMessage len=${text.length}")
        resetWatchdog()
        handleMessage(text)
    }

    /** Called from transport `onFailure`. Handles 401 and schedules reconnect. */
    protected fun onTransportFailure(t: Throwable?, response: Response?) {
        android.util.Log.e(tag, "onFailure code=${response?.code} error=${t?.javaClass?.simpleName}: ${t?.message}")
        ConnectionLog.e(tag, "onTransportFailure code=${response?.code} err=${t?.javaClass?.simpleName}: ${t?.message}")
        if (response?.code == 401) {
            _connectionState.value = ConnectionState.AUTH_FAILED
            return
        }
        scheduleReconnect()
    }

    /** Called from transport `onClosed`. */
    protected fun onTransportClosed() {
        android.util.Log.d(tag, "onClosed")
        ConnectionLog.d(tag, "onTransportClosed")
        scheduleReconnect()
    }

    /**
     * Immediate reconnect triggered by network change (e.g. WiFi reconnection).
     * Unlike [scheduleReconnect], this bypasses the exponential backoff delay
     * and resets the circuit breaker, since the network path has changed.
     * Cancels any existing transport to prevent concurrent connections.
     */
    fun reconnectOnNetworkChange() {
        val state = _connectionState.value
        if (state == ConnectionState.DISCONNECTED) return
        if (state == ConnectionState.CONNECTED) return
        android.util.Log.d(tag, "Network changed — immediate reconnect")
        ConnectionLog.d(tag, "reconnectOnNetworkChange state=$state")
        reconnectJob?.cancel()
        watchdogJob?.cancel()
        closeTransport()  // Cancel existing connection before creating new one
        reconnectAttempts = 0
        reconnectDelay = 1000L
        _connectionState.value = ConnectionState.CONNECTING
        scope.launch { doConnect() }
    }

    /** Schedule a reconnect with exponential backoff. Trips circuit after [maxReconnectAttempts]. */
    protected fun scheduleReconnect() {
        if (_connectionState.value == ConnectionState.DISCONNECTED) return
        if (reconnectJob?.isActive == true) return
        reconnectAttempts++
        ConnectionLog.d(tag, "scheduleReconnect attempts=$reconnectAttempts delay=$reconnectDelay")
        if (reconnectAttempts > maxReconnectAttempts) {
            android.util.Log.w(tag, "Circuit open after $reconnectAttempts attempts — will auto-retry in ${CIRCUIT_OPEN_RETRY_MS / 1000}s")
            _connectionState.value = ConnectionState.CIRCUIT_OPEN
            _displayState.value = "idle"
            // Auto-recover: retry after a long delay instead of requiring manual intervention
            reconnectJob = scope.launch {
                delay(CIRCUIT_OPEN_RETRY_MS)
                if (_connectionState.value == ConnectionState.CIRCUIT_OPEN) {
                    ConnectionLog.d(tag, "Circuit open auto-recovery — retrying")
                    reconnectAttempts = 0
                    reconnectDelay = 1000L
                    _connectionState.value = ConnectionState.RECONNECTING
                    doConnect()
                }
            }
            return
        }
        _connectionState.value = ConnectionState.RECONNECTING
        // Don't clear sessions — they persist across reconnections.
        // The server re-sends the full session list on reconnect.
        _displayState.value = "idle"
        reconnectJob = scope.launch {
            delay(reconnectDelay)
            reconnectDelay = (reconnectDelay * 2 * (0.5 + kotlin.random.Random.nextDouble())).toLong().coerceAtMost(maxReconnectDelay)
            doConnect()
        }
    }
}

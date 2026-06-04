package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import com.clawd.mobile.util.ApprovalSender
import com.clawd.mobile.util.CertificateVerifier
import com.clawd.mobile.util.HttpClientProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.Response

/**
 * Shared implementation for [SseClient] and [WsClient].
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

    /** Log tag, overridden per subclass (e.g. "SseClient", "WsClient"). */
    protected abstract val tag: String

    /** Watchdog timeout in milliseconds. SSE uses 30s, WS uses 90s. */
    protected abstract val watchdogTimeoutMs: Long

    // ── Transport hooks ──────────────────────────────────────────────────

    /** Open the transport connection. Called from [connect] and [scheduleReconnect]. */
    protected abstract fun doConnect()

    /** Close the transport handle gracefully (called from [disconnect]). */
    protected abstract fun closeTransport()

    /** Force-cancel the transport handle (called from [destroy]). */
    protected abstract fun cancelTransport()

    /** Send a raw JSON message over the transport. */
    abstract override fun sendMessage(json: String)

    // ── Shared state ─────────────────────────────────────────────────────

    @Volatile
    protected var config: ConnectionConfig? = null
    protected var reconnectDelay = 1000L
    protected val maxReconnectDelay = 30000L
    protected var reconnectJob: Job? = null
    protected var watchdogJob: Job? = null
    protected var reconnectAttempts = 0
    protected val maxReconnectAttempts = 10
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
        )
    }

    override val currentHost: String? get() = config?.host
    override val currentPort: Int? get() = config?.port

    // ── Shared concrete implementations ──────────────────────────────────

    override fun connect(config: ConnectionConfig) {
        android.util.Log.d(tag, "connect(${config.host}:${config.port})")
        this.config = config
        prefsStore.saveConfig(config)
        HttpClientProvider.setCertFingerprint(prefsStore.getCertFingerprint())
        reconnectDelay = 1000L
        reconnectAttempts = 0
        doConnect()
    }

    override fun reconnect() {
        val state = _connectionState.value
        if (state == ConnectionState.CONNECTED || state == ConnectionState.PENDING_CERT_CONFIRMATION) return
        val saved = config ?: prefsStore.loadConfig() ?: return
        config = saved
        HttpClientProvider.setCertFingerprint(prefsStore.getCertFingerprint())
        reconnectAttempts = 0
        reconnectDelay = 1000L
        doConnect()
    }

    override fun disconnect() {
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

    override fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int?) {
        val json = ApprovalSender.buildPermissionResponseJson(requestId, behavior, suggestionIndex)
        sendMessage(json)
    }

    override fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>) {
        val json = ApprovalSender.buildElicitationResponseJson(requestId, toolInput, answers)
        sendMessage(json)
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
        reconnectJob?.cancel()
        _connectionState.value =
            if (reconnectDelay > 1000) ConnectionState.RECONNECTING else ConnectionState.CONNECTING
    }

    /**
     * Called from transport `onOpen`. Handles TOFU cert check and sets connected state.
     * Subclasses call this from their transport-specific listener after any
     * transport-specific validation (e.g. SSE Content-Type check).
     */
    protected fun onTransportOpen(response: Response) {
        android.util.Log.d(tag, "onOpen code=${response.code}")
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
        resetWatchdog()
        handleMessage(text)
    }

    /** Called from transport `onFailure`. Handles 401 and schedules reconnect. */
    protected fun onTransportFailure(t: Throwable?, response: Response?) {
        android.util.Log.e(tag, "onFailure code=${response?.code} error=${t?.javaClass?.simpleName}: ${t?.message}")
        if (response?.code == 401) {
            _connectionState.value = ConnectionState.AUTH_FAILED
            return
        }
        scheduleReconnect()
    }

    /** Called from transport `onClosed`. */
    protected fun onTransportClosed() {
        android.util.Log.d(tag, "onClosed")
        scheduleReconnect()
    }

    /** Schedule a reconnect with exponential backoff. Trips circuit after [maxReconnectAttempts]. */
    protected fun scheduleReconnect() {
        if (_connectionState.value == ConnectionState.DISCONNECTED) return
        if (reconnectJob?.isActive == true) return
        reconnectAttempts++
        if (reconnectAttempts > maxReconnectAttempts) {
            android.util.Log.w(tag, "Circuit open after $reconnectAttempts attempts — stopping reconnects")
            _connectionState.value = ConnectionState.CIRCUIT_OPEN
            _displayState.value = "idle"
            return
        }
        _connectionState.value = ConnectionState.RECONNECTING
        // Don't clear sessions — they persist across reconnections.
        // The server re-sends the full session list on reconnect.
        _displayState.value = "idle"
        reconnectJob = scope.launch {
            delay(reconnectDelay)
            reconnectDelay = (reconnectDelay * 2).coerceAtMost(maxReconnectDelay)
            doConnect()
        }
    }
}

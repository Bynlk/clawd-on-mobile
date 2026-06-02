package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import android.util.Log
import com.clawd.mobile.util.CertificateVerifier
import com.clawd.mobile.util.HttpClientProvider
import com.clawd.mobile.util.SafeExecutor

/** Info about a server certificate pending user confirmation (TOFU). */
data class CertFingerprintInfo(val host: String, val fingerprint: String)

class SseClient(private val prefsStore: PrefsStore) {

    companion object {
        private const val TAG = "SseClient"
    }

    private var eventSource: EventSource? = null
    private var config: ConnectionConfig? = null
    private var reconnectDelay = 1000L
    private val maxReconnectDelay = 30000L
    private var reconnectJob: Job? = null
    private var watchdogJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val watchdogTimeoutMs = 30_000L

    private val messageParser = MessageParser()

    private val sseFactory: EventSource.Factory
        get() {
            val cfg = config ?: return EventSources.createFactory(HttpClientProvider.getClient(ConnectionConfig("", 0, "")))
            return EventSources.createFactory(HttpClientProvider.getSseClient(cfg))
        }

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _sessionsMap = java.util.concurrent.ConcurrentHashMap<String, SessionData>()
    private val _sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
    val sessions: StateFlow<Map<String, SessionData>> = _sessions

    /** Emit current _sessionsMap snapshot to the StateFlow. */
    private fun emitSessions() {
        _sessions.value = _sessionsMap.toMap()
    }

    private val _messages = MutableSharedFlow<WsMessage>(extraBufferCapacity = 64)
    val messages: SharedFlow<WsMessage> = _messages

    private val _permissionRequests = MutableSharedFlow<PermissionRequestData>(extraBufferCapacity = 16)
    val permissionRequests: SharedFlow<PermissionRequestData> = _permissionRequests

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing

    private val _displayState = MutableStateFlow("idle")
    val displayState: StateFlow<String> = _displayState

    private val _certFingerprintPending = MutableSharedFlow<CertFingerprintInfo>(extraBufferCapacity = 1)
    val certFingerprintPending: SharedFlow<CertFingerprintInfo> = _certFingerprintPending

    val currentHost: String? get() = config?.host
    val currentPort: Int? get() = config?.port

    fun connect(config: ConnectionConfig) {
        Log.d("SseClient", "connect(${config.host}:${config.port})")
        this.config = config
        prefsStore.saveConfig(config)
        HttpClientProvider.setCertFingerprint(prefsStore.getCertFingerprint())
        reconnectDelay = 1000L
        doConnect()
    }

    fun reconnect() {
        if (_connectionState.value == ConnectionState.CONNECTED) return
        val saved = config ?: prefsStore.loadConfig() ?: return
        config = saved
        HttpClientProvider.setCertFingerprint(prefsStore.getCertFingerprint())
        doConnect()
    }

    fun disconnect() {
        reconnectJob?.cancel()
        watchdogJob?.cancel()
        eventSource?.cancel()
        eventSource = null
        HttpClientProvider.reset()
        _connectionState.value = ConnectionState.DISCONNECTED
        _sessionsMap.clear()
        emitSessions()
        _displayState.value = "idle"
    }

    private fun resetWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = scope.launch {
            delay(watchdogTimeoutMs)
            // No event received within timeout — connection is silently dead
            scheduleReconnect()
        }
    }

    private fun doConnect() {
        val cfg = config ?: return
        reconnectJob?.cancel()
        eventSource?.cancel()

        _connectionState.value = if (reconnectDelay > 1000) ConnectionState.RECONNECTING else ConnectionState.CONNECTING

        val url = cfg.streamUrl()
        Log.d("SseClient", "doConnect → ${cfg.streamUrlMasked()}")

        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", cfg.authHeader())
            .build()

        eventSource = sseFactory.newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                Log.d(TAG, "SSE onOpen code=${response.code}")
                reconnectJob?.cancel()
                reconnectDelay = 1000L
                resetWatchdog()

                // Content-Type validation: reject non-SSE responses
                val contentType = response.header("Content-Type") ?: ""
                if (!contentType.contains("text/event-stream", ignoreCase = true)) {
                    Log.w(TAG, "SSE rejected: Content-Type '$contentType' is not text/event-stream")
                    eventSource.cancel()
                    scheduleReconnect()
                    return
                }

                _connectionState.value = ConnectionState.CONNECTED

                // TOFU: first HTTPS connection — extract cert fingerprint for user confirmation
                val cfg = config
                if (cfg != null && prefsStore.getCertFingerprint() == null) {
                    CertificateVerifier.extractFingerprint(response)?.let { fp ->
                        scope.launch { _certFingerprintPending.emit(CertFingerprintInfo(cfg.host, fp)) }
                    }
                }
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                resetWatchdog()
                handleMessage(data)
            }

            override fun onClosed(eventSource: EventSource) {
                Log.d("SseClient", "SSE onClosed")
                scheduleReconnect()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                Log.e("SseClient", "SSE onFailure url=$url code=${response?.code} error=${t?.javaClass?.simpleName}: ${t?.message}")
                if (response?.code == 401) {
                    _connectionState.value = ConnectionState.AUTH_FAILED
                    return
                }
                scheduleReconnect()
            }
        })
    }

    private fun handleMessage(rawText: String) {
        val parsed = messageParser.parse(rawText) ?: return
        Log.d(TAG, "SSE message type=${parsed::class.simpleName}")

        when (parsed) {
            is ParsedMessage.Ping -> return  // server heartbeat, watchdog already reset in onEvent
            is ParsedMessage.Connected -> { /* SSE handshake confirmed */ }
            is ParsedMessage.ClearSessions -> {
                Log.d(TAG, "clear_sessions → syncing=true, sessions cleared")
                _sessionsMap.clear()
                emitSessions()
                _syncing.value = true
            }

            is ParsedMessage.Snapshot -> {
                parsed.displayState?.let { _displayState.value = it }
                Log.d(TAG, "snapshot (${parsed.sessions.size} sessions, displayState=${_displayState.value}) → syncing=false")
                _syncing.value = false
                _sessionsMap.clear()
                _sessionsMap.putAll(parsed.sessions)
                emitSessions()
            }

            is ParsedMessage.State -> {
                val data = parsed.sessionData ?: return
                parsed.displayState?.let { _displayState.value = it }
                if (data.isVisible) _sessionsMap[parsed.sessionId] = data
                else _sessionsMap.remove(parsed.sessionId)
                emitSessions()
                Log.d(TAG, "state sid=${parsed.sessionId} state=${data.state} displayState=${data.displayState} globalDisplayState=${_displayState.value} badge=${data.badge} chip=${data.chipText}/${data.chipColor} dot=${data.dotColor} visible=${data.isVisible}")
            }

            is ParsedMessage.ToolOutput -> {
                val existing = _sessionsMap[parsed.sessionId] ?: return
                _sessionsMap[parsed.sessionId] = existing.copy(
                    lastOutput = LastOutput(
                        toolName = parsed.toolName,
                        output = parsed.output,
                        at = parsed.timestamp,
                    )
                )
                emitSessions()
            }

            is ParsedMessage.SessionDeleted -> {
                _sessionsMap.remove(parsed.sessionId)
                emitSessions()
            }

            is ParsedMessage.PermissionRequest -> {
                scope.launch {
                    SafeExecutor.tryOrReport("WS") {
                        Log.d(TAG, "permission_request id=${parsed.data.requestId}")
                        _permissionRequests.emit(parsed.data)
                    }
                }
            }

            is ParsedMessage.Unknown -> { /* ignore unknown types */ }
        }

        scope.launch {
            val msg = WsMessage(
                type = parsed::class.simpleName ?: "unknown",
                timestamp = parsed.timestamp,
                sessionId = when (parsed) {
                    is ParsedMessage.State -> parsed.sessionId
                    is ParsedMessage.ToolOutput -> parsed.sessionId
                    is ParsedMessage.SessionDeleted -> parsed.sessionId
                    is ParsedMessage.PermissionRequest -> parsed.data.sessionId
                    else -> null
                },
            )
            _messages.emit(msg)
        }
    }

    fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int? = null) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            SafeExecutor.tryOrLog("WS") {
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", behavior)
                    if (suggestionIndex != null) put("suggestionIndex", suggestionIndex)
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .addHeader("Authorization", cfg.authHeader())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                HttpClientProvider.getClient(cfg).newCall(request).execute().close()
            }
        }
    }

    fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            SafeExecutor.tryOrLog("WS") {
                // Build updatedInput: { ...toolInput, answers: { "question": "answer" } }
                val inputObj = toolInput?.jsonObject ?: buildJsonObject {}
                val answersObj = buildJsonObject {
                    for ((k, v) in answers) put(k, v)
                }
                val updatedInput = buildJsonObject {
                    for ((k, v) in inputObj) if (k != "answers") put(k, v)
                    put("answers", answersObj)
                }
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", "allow")
                    put("updatedInput", updatedInput)
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .addHeader("Authorization", cfg.authHeader())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                HttpClientProvider.getClient(cfg).newCall(request).execute().close()
            }
        }
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        _connectionState.value = ConnectionState.RECONNECTING
        _sessionsMap.clear()
        emitSessions()
        _displayState.value = "idle"
        reconnectJob = scope.launch {
            delay(reconnectDelay)
            reconnectDelay = (reconnectDelay * 2).coerceAtMost(maxReconnectDelay)
            doConnect()
        }
    }

    fun destroy() {
        watchdogJob?.cancel()
        scope.cancel()
        eventSource?.cancel()
        eventSource = null
    }
}

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
import java.util.concurrent.TimeUnit

class ClawdWebSocket(private val prefsStore: PrefsStore) {

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var eventSource: EventSource? = null
    private var config: ConnectionConfig? = null
    private var reconnectDelay = 1000L
    private val maxReconnectDelay = 30000L
    private var reconnectJob: Job? = null
    private var watchdogJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val watchdogTimeoutMs = 30_000L

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val sseFactory: EventSource.Factory = EventSources.createFactory(client)

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
    val sessions: StateFlow<Map<String, SessionData>> = _sessions

    private val _messages = MutableSharedFlow<WsMessage>(extraBufferCapacity = 64)
    val messages: SharedFlow<WsMessage> = _messages

    private val _permissionRequests = MutableSharedFlow<PermissionRequestData>(extraBufferCapacity = 16)
    val permissionRequests: SharedFlow<PermissionRequestData> = _permissionRequests

    val currentHost: String? get() = config?.host
    val currentPort: Int? get() = config?.port

    fun connect(config: ConnectionConfig) {
        this.config = config
        prefsStore.saveConfig(config)
        reconnectDelay = 1000L
        doConnect()
    }

    fun reconnect() {
        val saved = config ?: prefsStore.loadConfig() ?: return
        config = saved
        doConnect()
    }

    fun disconnect() {
        reconnectJob?.cancel()
        watchdogJob?.cancel()
        eventSource?.cancel()
        eventSource = null
        _connectionState.value = ConnectionState.DISCONNECTED
        _sessions.value = emptyMap()
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

        val request = Request.Builder()
            .url(cfg.streamUrl())
            .build()

        eventSource = sseFactory.newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                reconnectDelay = 1000L
                _connectionState.value = ConnectionState.CONNECTED
                resetWatchdog()
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                resetWatchdog()
                handleMessage(data)
            }

            override fun onClosed(eventSource: EventSource) {
                scheduleReconnect()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                if (response?.code == 401) {
                    _connectionState.value = ConnectionState.AUTH_FAILED
                    return
                }
                scheduleReconnect()
            }
        })
    }

    private fun handleMessage(rawText: String) {
        val obj = try { json.decodeFromString<JsonObject>(rawText) } catch (_: Exception) { return }
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return

        when (type) {
            "ping" -> return  // server heartbeat, watchdog already reset in onEvent
            "connected" -> { /* SSE handshake confirmed */ }

            "snapshot" -> {
                val sessionsObj = obj["sessions"]?.jsonObject ?: return
                val map = mutableMapOf<String, SessionData>()
                for ((sid, el) in sessionsObj) {
                    try { map[sid] = json.decodeFromJsonElement<SessionData>(el) } catch (_: Exception) {}
                }
                _sessions.value = map
            }

            "state" -> {
                val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
                val recentEvents = try {
                    obj["recentEvents"]?.jsonArray?.map { el ->
                        val o = el.jsonObject
                        RecentEvent(
                            at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                            event = o["event"]?.jsonPrimitive?.contentOrNull,
                            state = o["state"]?.jsonPrimitive?.contentOrNull,
                        )
                    } ?: emptyList()
                } catch (_: Exception) { emptyList() }
                val lastOutput = try {
                    obj["lastOutput"]?.jsonObject?.let { o ->
                        LastOutput(
                            toolName = o["toolName"]?.jsonPrimitive?.contentOrNull ?: "",
                            output = o["output"]?.jsonPrimitive?.contentOrNull ?: "",
                            at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                        )
                    }
                } catch (_: Exception) { null }
                val data = SessionData(
                    state = obj["state"]?.jsonPrimitive?.contentOrNull ?: "idle",
                    event = obj["event"]?.jsonPrimitive?.contentOrNull,
                    agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
                    toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull,
                    sessionTitle = obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
                    cwd = obj["cwd"]?.jsonPrimitive?.contentOrNull,
                    updatedAt = obj["timestamp"]?.jsonPrimitive?.longOrNull,
                    recentEvents = recentEvents,
                    lastOutput = lastOutput,
                )
                _sessions.value = _sessions.value.toMutableMap().apply { put(sid, data) }
            }

            "tool_output" -> {
                val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
                val existing = _sessions.value[sid] ?: return
                val updated = existing.copy(
                    lastOutput = LastOutput(
                        toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull ?: "",
                        output = obj["output"]?.jsonPrimitive?.contentOrNull ?: "",
                        at = obj["timestamp"]?.jsonPrimitive?.longOrNull ?: 0L,
                    )
                )
                _sessions.value = _sessions.value.toMutableMap().apply { put(sid, updated) }
            }

            "session_deleted" -> {
                val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
                _sessions.value = _sessions.value.toMutableMap().apply { remove(sid) }
            }

            "permission_request" -> {
                scope.launch {
                    try {
                        val data = PermissionRequestData(
                            agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
                            toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull,
                            sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
                            requestId = obj["id"]?.jsonPrimitive?.contentOrNull,
                            timeout = obj["timeout"]?.jsonPrimitive?.longOrNull ?: 60000,
                        )
                        _permissionRequests.emit(data)
                    } catch (_: Exception) {}
                }
            }

            "elicitation_request" -> {
                scope.launch {
                    try {
                        val dataObj = obj["data"]?.jsonObject ?: obj
                        _permissionRequests.emit(
                            PermissionRequestData(
                                agentId = dataObj["agentId"]?.jsonPrimitive?.contentOrNull,
                                toolName = "elicitation",
                                toolInputSummary = dataObj["prompt"]?.jsonPrimitive?.contentOrNull,
                                sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
                                requestId = obj["id"]?.jsonPrimitive?.contentOrNull ?: obj["requestId"]?.jsonPrimitive?.contentOrNull,
                                elicitationOptions = try {
                                    dataObj["options"]?.jsonArray?.map { o ->
                                        val oo = o.jsonObject
                                        ElicitationOption(
                                            label = oo["label"]?.jsonPrimitive?.content ?: "",
                                            value = oo["value"]?.jsonPrimitive?.content ?: ""
                                        )
                                    } ?: emptyList()
                                } catch (_: Exception) { emptyList() },
                            )
                        )
                    } catch (_: Exception) {}
                }
            }
        }

        scope.launch {
            val msg = WsMessage(
                type = type,
                timestamp = obj["timestamp"]?.jsonPrimitive?.longOrNull ?: 0,
                sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
            )
            _messages.emit(msg)
        }
    }

    fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int? = null) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            try {
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", behavior)
                    if (suggestionIndex != null) put("suggestionIndex", suggestionIndex)
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                client.newCall(request).execute().close()
            } catch (_: Exception) {}
        }
    }

    fun sendElicitationResponse(requestId: String, answers: Map<String, String>) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            try {
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", answers["choice"] ?: "allow")
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                client.newCall(request).execute().close()
            } catch (_: Exception) {}
        }
    }

    private fun scheduleReconnect() {
        _connectionState.value = ConnectionState.RECONNECTING
        _sessions.value = emptyMap()
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

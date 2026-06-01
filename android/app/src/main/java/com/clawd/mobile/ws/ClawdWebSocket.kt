package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.CertificatePinner
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import android.util.Log
import com.clawd.mobile.util.SafeExecutor
import java.util.concurrent.TimeUnit

class ClawdWebSocket(private val prefsStore: PrefsStore) {

    private var eventSource: EventSource? = null
    private var config: ConnectionConfig? = null
    private var reconnectDelay = 1000L
    private val maxReconnectDelay = 30000L
    private var reconnectJob: Job? = null
    private var watchdogJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val watchdogTimeoutMs = 30_000L

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** OkHttpClient — rebuilt when config changes; adds CertificatePinner for non-LAN. */
    private var _client: OkHttpClient? = null
    private var _clientConfig: ConnectionConfig? = null
    private val client: OkHttpClient
        get() {
            val cfg = config
            if (_client == null || cfg != _clientConfig) {
                val builder = OkHttpClient.Builder()
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                // 非局域网连接：启用证书锁定
                if (cfg != null && !cfg.isLan) {
                    builder.certificatePinner(
                        CertificatePinner.Builder()
                            .add(cfg.host, "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") // TODO: 替换为实际证书指纹
                            .build()
                    )
                }
                _client = builder.build()
                _clientConfig = cfg
            }
            return _client!!
        }

    private val sseFactory: EventSource.Factory
        get() = EventSources.createFactory(client)

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
    val sessions: StateFlow<Map<String, SessionData>> = _sessions

    private val _messages = MutableSharedFlow<WsMessage>(extraBufferCapacity = 64)
    val messages: SharedFlow<WsMessage> = _messages

    private val _permissionRequests = MutableSharedFlow<PermissionRequestData>(extraBufferCapacity = 16)
    val permissionRequests: SharedFlow<PermissionRequestData> = _permissionRequests

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing

    private val _displayState = MutableStateFlow("idle")
    val displayState: StateFlow<String> = _displayState

    val currentHost: String? get() = config?.host
    val currentPort: Int? get() = config?.port

    fun connect(config: ConnectionConfig) {
        this.config = config
        prefsStore.saveConfig(config)
        reconnectDelay = 1000L
        doConnect()
    }

    fun reconnect() {
        if (_connectionState.value == ConnectionState.CONNECTED) return
        val saved = config ?: prefsStore.loadConfig() ?: return
        config = saved
        doConnect()
    }

    fun disconnect() {
        reconnectJob?.cancel()
        watchdogJob?.cancel()
        eventSource?.cancel()
        eventSource = null
        _client = null       // Reset client so next connect uses fresh config
        _clientConfig = null
        _connectionState.value = ConnectionState.DISCONNECTED
        _sessions.value = emptyMap()
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

        val request = Request.Builder()
            .url(cfg.streamUrl())
            .build()

        eventSource = sseFactory.newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                Log.d("ClawdWebSocket", "SSE connected")
                reconnectJob?.cancel()
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
        Log.d("ClawdWebSocket", "SSE message type=$type")

        when (type) {
            "ping" -> return  // server heartbeat, watchdog already reset in onEvent
            "connected" -> { /* SSE handshake confirmed */ }
            "clear_sessions" -> {
                Log.d("ClawdWebSocket", "clear_sessions → syncing=true, sessions cleared")
                _sessions.value = emptyMap()
                _syncing.value = true
            }

            "snapshot" -> {
                val sessionsObj = obj["sessions"]?.jsonObject
                if (sessionsObj == null) {
                    Log.d("ClawdWebSocket", "snapshot (no sessions field) → syncing=false")
                    _syncing.value = false
                    _sessions.value = emptyMap()
                    return
                }
                val map = mutableMapOf<String, SessionData>()
                for ((sid, el) in sessionsObj) {
                    SafeExecutor.tryOrNull("WS") {
                        val sd = json.decodeFromJsonElement<SessionData>(el)
                        if (sd.isReal && sd.isVisible) map[sid] = sd
                    }
                }
                obj["displayState"]?.jsonPrimitive?.contentOrNull?.let {
                    _displayState.value = it
                }
                Log.d("ClawdWebSocket", "snapshot (${map.size} sessions, displayState=${_displayState.value}) → syncing=false")
                _syncing.value = false
                _sessions.value = map
            }

            "state" -> {
                val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
                val isReal = obj["isReal"]?.jsonPrimitive?.booleanOrNull ?: true
                if (!isReal) return
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
                obj["displayState"]?.jsonPrimitive?.contentOrNull?.let {
                    _displayState.value = it
                }
                val data = SessionData(
                    sessionId = sid,
                    state = obj["state"]?.jsonPrimitive?.contentOrNull ?: "idle",
                    event = obj["event"]?.jsonPrimitive?.contentOrNull,
                    agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
                    toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull,
                    sessionTitle = obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
                    displayTitle = obj["displayTitle"]?.jsonPrimitive?.contentOrNull
                        ?: obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
                    cwd = obj["cwd"]?.jsonPrimitive?.contentOrNull,
                    updatedAt = obj["timestamp"]?.jsonPrimitive?.longOrNull,
                    recentEvents = recentEvents,
                    lastOutput = lastOutput,
                    displayState = obj["displayState"]?.jsonPrimitive?.contentOrNull,
                    badge = obj["badge"]?.jsonPrimitive?.contentOrNull ?: "idle",
                    chipText = obj["chipText"]?.jsonPrimitive?.contentOrNull,
                    chipColor = obj["chipColor"]?.jsonPrimitive?.contentOrNull,
                    dotColor = obj["dotColor"]?.jsonPrimitive?.contentOrNull,
                    isVisible = obj["isVisible"]?.jsonPrimitive?.booleanOrNull ?: true,
                )
                _sessions.value = _sessions.value.toMutableMap().apply {
                    if (data.isVisible) put(sid, data) else remove(sid)
                }
                Log.d("ClawdWebSocket", "state sid=$sid state=${data.state} displayState=${data.displayState} globalDisplayState=${_displayState.value} badge=${data.badge} chip=${data.chipText}/${data.chipColor} dot=${data.dotColor} visible=${data.isVisible}")
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
                    SafeExecutor.tryOrReport("WS") {
                        val reqId = obj["id"]?.jsonPrimitive?.contentOrNull
                        Log.d("ClawdWebSocket", "permission_request id=$reqId")
                        val toolNameStr = obj["toolName"]?.jsonPrimitive?.contentOrNull
                        val toolInputObj = obj["toolInput"]?.jsonObject
                        val suggestions = SafeExecutor.tryOrNull("WS") {
                            obj["suggestions"]?.jsonArray?.map { s ->
                                val so = s.jsonObject
                                PermissionSuggestion(
                                    label = so["label"]?.jsonPrimitive?.content ?: "",
                                    behavior = so["behavior"]?.jsonPrimitive?.content ?: "deny",
                                    rule = so["rule"]?.jsonPrimitive?.contentOrNull,
                                )
                            }
                        } ?: emptyList()
                        val data = PermissionRequestData(
                            agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
                            toolName = toolNameStr,
                            toolInputSummary = buildToolInputSummary(toolNameStr, toolInputObj),
                            sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
                            requestId = obj["id"]?.jsonPrimitive?.contentOrNull,
                            timeout = obj["timeout"]?.jsonPrimitive?.longOrNull ?: 60000,
                            suggestions = suggestions,
                        )
                        _permissionRequests.emit(data)
                    }
                }
            }

            "elicitation_request" -> {
                scope.launch {
                    SafeExecutor.tryOrReport("WS") {
                        val dataObj = obj["data"]?.jsonObject ?: obj
                        _permissionRequests.emit(
                            PermissionRequestData(
                                agentId = dataObj["agentId"]?.jsonPrimitive?.contentOrNull,
                                toolName = "elicitation",
                                toolInputSummary = dataObj["prompt"]?.jsonPrimitive?.contentOrNull,
                                sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
                                requestId = obj["id"]?.jsonPrimitive?.contentOrNull ?: obj["requestId"]?.jsonPrimitive?.contentOrNull,
                                elicitationOptions = SafeExecutor.tryOrNull("WS") {
                                    dataObj["options"]?.jsonArray?.map { o ->
                                        val oo = o.jsonObject
                                        ElicitationOption(
                                            label = oo["label"]?.jsonPrimitive?.content ?: "",
                                            value = oo["value"]?.jsonPrimitive?.content ?: ""
                                        )
                                    }
                                } ?: emptyList(),
                            )
                        )
                    }
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
            SafeExecutor.tryOrLog("WS") {
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
            }
        }
    }

    fun sendElicitationResponse(requestId: String, answers: Map<String, String>) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            SafeExecutor.tryOrLog("WS") {
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", answers["choice"] ?: "allow")
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                client.newCall(request).execute().close()
            }
        }
    }

    private fun buildToolInputSummary(toolName: String?, toolInput: JsonObject?): String? {
        if (toolInput == null) return null
        val key = toolName ?: ""
        val summary = when (key) {
            "Write", "Edit", "Delete", "Read" ->
                toolInput["file_path"]?.jsonPrimitive?.contentOrNull
            "Bash" ->
                toolInput["command"]?.jsonPrimitive?.contentOrNull
            "NotebookEdit" ->
                toolInput["notebook_path"]?.jsonPrimitive?.contentOrNull
            "WebFetch" ->
                toolInput["url"]?.jsonPrimitive?.contentOrNull
            "WebSearch" ->
                toolInput["query"]?.jsonPrimitive?.contentOrNull
            else -> {
                toolInput["description"]?.jsonPrimitive?.contentOrNull
                    ?: toolInput["summary"]?.jsonPrimitive?.contentOrNull
                    ?: toolInput["reason"]?.jsonPrimitive?.contentOrNull
            }
        }
        val text = summary?.take(60)?.trim()
        if (text.isNullOrBlank()) {
            val fallback = toolInput.toString().take(80)
            return if (fallback.length > 2) "$key → $fallback…" else null
        }
        return "$key → $text" + if (summary.length > 60) "…" else ""
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        _connectionState.value = ConnectionState.RECONNECTING
        _sessions.value = emptyMap()
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

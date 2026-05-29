package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.*
import java.util.concurrent.TimeUnit

class ClawdWebSocket(private val prefsStore: PrefsStore) {

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private var ws: WebSocket? = null
    private var config: ConnectionConfig? = null
    private var reconnectDelay = 1000L
    private val maxReconnectDelay = 30000L
    private var reconnectJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

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

    private var rawTextHandler: ((String) -> Unit)? = null

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
        ws?.close(1000, "User disconnect")
        ws = null
        _connectionState.value = ConnectionState.DISCONNECTED
    }

    private fun doConnect() {
        val cfg = config ?: return
        reconnectJob?.cancel()

        _connectionState.value = if (reconnectDelay > 1000) ConnectionState.RECONNECTING else ConnectionState.CONNECTING

        val request = Request.Builder().url(cfg.wsUrl()).build()

        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectDelay = 1000L
                _connectionState.value = ConnectionState.CONNECTED
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                android.util.Log.w("ClawdWS", "Closed: code=$code reason=$reason")
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                android.util.Log.e("ClawdWS", "Connection failed: ${t.message}", t)
                if (response?.code == 401 || response?.message?.contains("Invalid token") == true) {
                    _connectionState.value = ConnectionState.AUTH_FAILED
                    return
                }
                scheduleReconnect()
            }
        })
    }

    private fun handleMessage(rawText: String) {
        val msg = MessageParser.parse(rawText) ?: return

        when (msg.type) {
            "snapshot" -> {
                _sessions.value = msg.sessions ?: emptyMap()
            }
            "state" -> {
                val sid = msg.sessionId ?: return
                val data = msg.data ?: return
                _sessions.value = _sessions.value.toMutableMap().apply { put(sid, data) }
            }
            "permission_request" -> {
                scope.launch {
                    try {
                        val obj = json.decodeFromString<JsonObject>(rawText)
                        val dataObj = obj["data"]?.jsonObject
                        val requestId = obj["requestId"]?.jsonPrimitive?.contentOrNull
                        if (dataObj != null) {
                            val permData = PermissionRequestData(
                                agentId = dataObj["agentId"]?.jsonPrimitive?.contentOrNull,
                                toolName = dataObj["toolName"]?.jsonPrimitive?.contentOrNull,
                                toolInputSummary = dataObj["toolInputSummary"]?.jsonPrimitive?.contentOrNull,
                                sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
                                requestId = requestId,
                                suggestions = try {
                                    dataObj["suggestions"]?.jsonArray?.map { s ->
                                        val so = s.jsonObject
                                        PermissionSuggestion(
                                            label = so["label"]?.jsonPrimitive?.content ?: "",
                                            behavior = so["behavior"]?.jsonPrimitive?.content ?: "allow",
                                            rule = so["rule"]?.jsonPrimitive?.contentOrNull
                                        )
                                    } ?: emptyList()
                                } catch (_: Exception) { emptyList() },
                                timeout = dataObj["timeout"]?.jsonPrimitive?.longOrNull ?: 90000,
                            )
                            _permissionRequests.emit(permData)
                        }
                    } catch (_: Exception) {}
                }
            }
            "elicitation_request" -> {
                scope.launch {
                    try {
                        val obj = json.decodeFromString<JsonObject>(rawText)
                        val dataObj = obj["data"]?.jsonObject
                        if (dataObj != null) {
                            val elicitData = ElicitationRequestData(
                                agentId = dataObj["agentId"]?.jsonPrimitive?.contentOrNull,
                                prompt = dataObj["prompt"]?.jsonPrimitive?.contentOrNull,
                                sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
                                options = try {
                                    dataObj["options"]?.jsonArray?.map { o ->
                                        val oo = o.jsonObject
                                        ElicitationOption(
                                            label = oo["label"]?.jsonPrimitive?.content ?: "",
                                            value = oo["value"]?.jsonPrimitive?.content ?: ""
                                        )
                                    } ?: emptyList()
                                } catch (_: Exception) { emptyList() },
                            )
                            // Elicitation requests also go through permission flow
                            _permissionRequests.emit(
                                PermissionRequestData(
                                    agentId = elicitData.agentId,
                                    toolName = "elicitation",
                                    toolInputSummary = elicitData.prompt,
                                    sessionId = elicitData.sessionId,
                                    elicitationOptions = elicitData.options,
                                    requestId = obj["requestId"]?.jsonPrimitive?.contentOrNull,
                                )
                            )
                        }
                    } catch (_: Exception) {}
                }
            }
        }

        scope.launch { _messages.emit(msg) }
    }

    fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int? = null) {
        ws?.send(MessageParser.encodePermissionResponse(requestId, behavior, suggestionIndex))
    }

    fun sendElicitationResponse(requestId: String, answers: Map<String, String>) {
        ws?.send(MessageParser.encodeElicitationResponse(requestId, answers))
    }

    private fun scheduleReconnect() {
        _connectionState.value = ConnectionState.RECONNECTING
        reconnectJob = scope.launch {
            delay(reconnectDelay)
            reconnectDelay = (reconnectDelay * 2).coerceAtMost(maxReconnectDelay)
            doConnect()
        }
    }

    fun destroy() {
        scope.cancel()
        ws?.close(1001, "Destroying")
    }
}

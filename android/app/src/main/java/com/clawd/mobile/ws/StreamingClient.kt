package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

/** Abstraction over streaming transport (SSE or WebSocket). */
interface StreamingClient {
    val connectionState: StateFlow<ConnectionState>
    val sessions: StateFlow<Map<String, SessionData>>
    val displayState: StateFlow<String>
    val syncing: StateFlow<Boolean>
    val permissionRequests: SharedFlow<PermissionRequestData>
    val certFingerprintPending: SharedFlow<CertFingerprintInfo>
    val reactions: SharedFlow<String>
    val currentHost: String?
    val currentPort: Int?

    fun connect(config: ConnectionConfig)
    fun reconnect()
    fun disconnect()
    fun setConnectionState(state: ConnectionState)
    fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int? = null)
    fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>)
    fun destroy()
}

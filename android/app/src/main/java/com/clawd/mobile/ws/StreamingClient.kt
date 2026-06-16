package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

/** Abstraction over streaming transport (WebSocket). */
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
    fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int? = null): Boolean
    fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>): Boolean
    /** Send a raw JSON message over the current transport.
     *  @return true if sent successfully, false if not connected or buffer full. */
    fun sendMessage(json: String): Boolean
    fun destroy()
}

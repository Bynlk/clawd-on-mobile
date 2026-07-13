package com.clawd.mobile.console

import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.ws.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleSyncPreferenceTest {
    private class FakeClient : StreamingClient {
        override val connectionState = MutableStateFlow(ConnectionState.CONNECTED)
        override val sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
        override val displayState = MutableStateFlow("idle")
        override val syncing = MutableStateFlow(false)
        override val permissionRequests = MutableSharedFlow<PermissionRequestData>()
        override val certFingerprintPending = MutableSharedFlow<CertFingerprintInfo>()
        override val reactions = MutableSharedFlow<String>()
        override val currentHost: String? = null
        override val currentPort: Int? = null
        val sent = mutableListOf<String>()
        override fun connect(config: ConnectionConfig) = Unit
        override fun reconnect() = Unit
        override fun disconnect() = Unit
        override fun setConnectionState(state: ConnectionState) = Unit
        override fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int?) = true
        override fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>) = true
        override fun sendMessage(json: String): Boolean { sent += json; return true }
        override fun destroy() = Unit
    }

    @Test
    fun `disabled preference explicitly restores the closed content gate`() {
        val client = FakeClient()
        bootstrapConsoleConnection(client, enabled = false, deviceId = "phone-a")
        assertEquals(1, client.sent.size)
        assertTrue(client.sent.single().contains("managed_content_sync_set"))
        assertTrue(client.sent.single().contains("\"enabled\":false"))
    }

    @Test
    fun `enabled preference restores sync and requests capabilities and sessions`() {
        val client = FakeClient()
        bootstrapConsoleConnection(client, enabled = true, deviceId = "phone-a")

        assertEquals(3, client.sent.size)
        assertTrue(client.sent[0].contains("managed_content_sync_set"))
        assertTrue(client.sent[0].contains("\"enabled\":true"))
        assertTrue(client.sent[1].contains("managed_capabilities_request"))
        assertTrue(client.sent[2].contains("managed_sessions_request"))
        assertTrue(client.sent.all { it.contains("\"deviceId\":\"phone-a\"") })
    }
}

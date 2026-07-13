package com.clawd.mobile.console

import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.ws.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.ExperimentalCoroutinesApi

@OptIn(ExperimentalCoroutinesApi::class)
class ConsoleRepositoryTest {
    private class FakeClient : StreamingClient {
        override val connectionState = MutableStateFlow(ConnectionState.CONNECTED)
        override val sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
        override val displayState = MutableStateFlow("idle")
        override val syncing = MutableStateFlow(false)
        override val permissionRequests = MutableSharedFlow<PermissionRequestData>()
        override val certFingerprintPending = MutableSharedFlow<CertFingerprintInfo>()
        override val reactions = MutableSharedFlow<String>()
        override val consoleMessages = MutableSharedFlow<ConsoleServerMessage>(extraBufferCapacity = 16)
        override val currentHost: String? = null
        override val currentPort: Int? = null
        val sent = mutableListOf<String>()
        override fun connect(config: ConnectionConfig) {}
        override fun reconnect() {}
        override fun disconnect() {}
        override fun setConnectionState(state: ConnectionState) {}
        override fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int?) = true
        override fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>) = true
        override fun sendMessage(json: String): Boolean { sent += json; return true }
        override fun destroy() {}
    }

    @Test
    fun `merges history and live deltas in sequence order without duplicates`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = listOf(
                ConsoleRecord("s1", 2, "assistant_text", text = "two"),
                ConsoleRecord("s1", 1, "user_input", text = "one"),
            )
        ))
        client.consoleMessages.emit(ConsoleServerMessage.Delta(ConsoleRecord("s1", 2, "assistant_text", text = "two")))
        client.consoleMessages.emit(ConsoleServerMessage.Delta(ConsoleRecord("s1", 3, "diff", text = "+three")))
        advanceUntilIdle()

        assertEquals(listOf(1L, 2L, 3L), repository.records.value["s1"]!!.map { it.sequence })
        assertTrue(client.sent.any { it.contains("managed_session_ack") && it.contains("\"sequence\":3") })
        repository.close()
    }

    @Test
    fun `history reset discards stale local records`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        client.consoleMessages.emit(ConsoleServerMessage.Delta(ConsoleRecord("s1", 9, "terminal_delta", text = "stale")))
        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = listOf(ConsoleRecord("s1", 10, "assistant_text", text = "fresh")),
            resetRequired = true,
        ))
        advanceUntilIdle()
        assertEquals(listOf(10L), repository.records.value["s1"]!!.map { it.sequence })
        repository.close()
    }

    @Test
    fun `selection requests history and commands include stable device id`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repository.selectSession("s1")
        repository.acquireLease("s1")
        repository.sendInput("s1", "hello")
        repository.interrupt("s1")

        assertEquals("s1", repository.selectedSessionId.value)
        assertTrue(client.sent.all { it.contains("\"deviceId\":\"phone-a\"") })
        assertTrue(client.sent.any { it.contains("managed_session_history_request") })
        assertTrue(client.sent.any { it.contains("managed_session_input") })
        repository.close()
    }

    @Test
    fun `sync state capabilities sessions lease and errors update flows`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        client.consoleMessages.emit(ConsoleServerMessage.SyncState(true))
        client.consoleMessages.emit(ConsoleServerMessage.Capabilities(
            agents = listOf(ManagedAgent("codex", "Codex", "codex")),
            directories = listOf("/repo"),
        ))
        client.consoleMessages.emit(ConsoleServerMessage.SessionsSnapshot(
            listOf(ManagedSession("s1", "codex", "/repo", status = "running"))
        ))
        client.consoleMessages.emit(ConsoleServerMessage.LeaseChanged("s1", "phone-a", true))
        client.consoleMessages.emit(ConsoleServerMessage.Error("bad_request", sessionId = "s1"))
        advanceUntilIdle()

        assertTrue(repository.syncEnabled.value)
        assertEquals("codex", repository.capabilities.value.agents.single().id)
        assertEquals("s1", repository.sessions.value.single().id)
        assertTrue(repository.leases.value["s1"]!!.granted)
        assertEquals("bad_request", repository.lastError.value?.code)
        repository.close()
    }

    @Test
    fun `first session snapshot selects a session and requests its history`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")

        client.consoleMessages.emit(ConsoleServerMessage.SessionsSnapshot(
            listOf(ManagedSession("s1", "codex", "/repo", status = "running"))
        ))
        advanceUntilIdle()

        assertEquals("s1", repository.selectedSessionId.value)
        assertTrue(client.sent.any {
            it.contains("managed_session_history_request") &&
                it.contains("\"sessionId\":\"s1\"") &&
                it.contains("\"afterSequence\":0")
        })
        repository.close()
    }

    @Test
    fun `reconnect snapshot requests records after the highest local sequence`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repository.selectSession("s1")
        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = listOf(ConsoleRecord("s1", 7, "assistant_text", text = "latest")),
            resetRequired = true,
            oldestSequence = 7,
        ))
        advanceUntilIdle()
        client.sent.clear()

        client.consoleMessages.emit(ConsoleServerMessage.SessionsSnapshot(
            listOf(ManagedSession("s1", "codex", "/repo", status = "running", latestSequence = 9))
        ))
        advanceUntilIdle()

        assertTrue(client.sent.any {
            it.contains("managed_session_history_request") && it.contains("\"afterSequence\":7")
        })
        repository.close()
    }

    @Test
    fun `out of order live delta does not advance ack across a gap`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")

        client.consoleMessages.emit(ConsoleServerMessage.Delta(
            ConsoleRecord("s1", 3, "assistant_text", text = "three")
        ))
        advanceUntilIdle()

        assertTrue(repository.records.value["s1"].isNullOrEmpty())
        assertFalse(client.sent.any { it.contains("managed_session_ack") })
        assertTrue(client.sent.any {
            it.contains("managed_session_history_request") && it.contains("\"afterSequence\":0")
        })

        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = listOf(
                ConsoleRecord("s1", 1, "user_input", text = "one"),
                ConsoleRecord("s1", 2, "assistant_text", text = "two"),
            ),
        ))
        advanceUntilIdle()

        assertEquals(listOf(1L, 2L, 3L), repository.records.value["s1"]!!.map { it.sequence })
        assertTrue(client.sent.any { it.contains("managed_session_ack") && it.contains("\"sequence\":3") })
        repository.close()
    }

    @Test
    fun `multi chunk history waits for the final chunk before requesting another page`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repository.selectSession("s1")
        client.sent.clear()

        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = listOf(ConsoleRecord("s1", 1, "assistant_text", text = "one")),
            hasMore = true,
            chunkIndex = 0,
            chunkCount = 2,
        ))
        runCurrent()
        repository.selectSession("s1")
        assertFalse(client.sent.any { it.contains("managed_session_history_request") })

        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = listOf(ConsoleRecord("s1", 2, "assistant_text", text = "two")),
            hasMore = true,
            chunkIndex = 1,
            chunkCount = 2,
        ))
        runCurrent()

        assertEquals(1, client.sent.count { it.contains("managed_session_history_request") })
        assertTrue(client.sent.single { it.contains("managed_session_history_request") }
            .contains("\"afterSequence\":2"))
        repository.close()
    }

    @Test
    fun `switching sessions releases the previous lease and disconnect clears local ownership`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repository.selectSession("s1")
        client.consoleMessages.emit(ConsoleServerMessage.LeaseChanged("s1", "phone-a", true))
        advanceUntilIdle()

        repository.selectSession("s2")

        assertTrue(client.sent.any {
            it.contains("managed_session_input_lease_release") && it.contains("\"sessionId\":\"s1\"")
        })
        assertNull(repository.leases.value["s1"])

        client.consoleMessages.emit(ConsoleServerMessage.LeaseChanged("s2", "phone-a", true))
        advanceUntilIdle()
        client.connectionState.value = ConnectionState.DISCONNECTED
        advanceUntilIdle()
        assertTrue(repository.leases.value.isEmpty())
        repository.close()
    }

    @Test
    fun `creating and selecting a session releases the previous lease`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repository.selectSession("s1")
        client.consoleMessages.emit(ConsoleServerMessage.LeaseChanged("s1", "phone-a", true))
        advanceUntilIdle()

        client.consoleMessages.emit(ConsoleServerMessage.SessionCreated(
            ManagedSession("s2", "codex", "/repo")
        ))
        advanceUntilIdle()

        assertEquals("s2", repository.selectedSessionId.value)
        assertTrue(client.sent.any {
            it.contains("managed_session_input_lease_release") && it.contains("\"sessionId\":\"s1\"")
        })
        repository.close()
    }

    @Test
    fun `background mode defers record materialization and foreground requests missing history`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repository.setVisible(false)

        client.consoleMessages.emit(ConsoleServerMessage.Delta(
            ConsoleRecord("s1", 1, "assistant_text", text = "background")
        ))
        advanceUntilIdle()

        assertTrue(repository.records.value["s1"].isNullOrEmpty())
        assertFalse(client.sent.any { it.contains("managed_session_ack") })

        repository.setVisible(true)
        repository.selectSession("s1")
        assertTrue(client.sent.any {
            it.contains("managed_session_history_request") && it.contains("\"afterSequence\":0")
        })
        repository.close()
    }

    @Test
    fun `materialized history is bounded by records and bytes`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(
            client = client,
            scope = this,
            deviceId = "phone-a",
            maxRecordsPerSession = 3,
            maxBytesPerSession = 800,
        )
        client.consoleMessages.emit(ConsoleServerMessage.HistoryChunk(
            sessionId = "s1",
            records = (1L..5L).map {
                ConsoleRecord("s1", it, "terminal_delta", text = it.toString().repeat(200))
            },
        ))
        advanceUntilIdle()

        val retained = repository.records.value["s1"].orEmpty()
        assertTrue(retained.size <= 3)
        assertTrue(retained.sumOf(::consoleRecordApproxBytes) <= 800)
        assertEquals(5L, retained.last().sequence)
        repository.close()
    }

    @Test
    fun `live delta acknowledgements are coalesced`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")
        repeat(100) { index ->
            client.consoleMessages.emit(ConsoleServerMessage.Delta(
                ConsoleRecord("s1", index + 1L, "terminal_delta", text = "$index")
            ))
        }
        runCurrent()

        assertFalse(client.sent.any { it.contains("managed_session_ack") })
        advanceTimeBy(500)
        runCurrent()

        val acknowledgements = client.sent.filter { it.contains("managed_session_ack") }
        assertEquals(1, acknowledgements.size)
        assertTrue(acknowledgements.single().contains("\"sequence\":100"))
        repository.close()
    }

    @Test
    fun `oversized input is rejected locally with a visible error`() = runTest {
        val client = FakeClient()
        val repository = ConsoleRepository(client, this, "phone-a")

        val requestId = repository.sendInput("s1", "界".repeat(30_000))

        assertNull(requestId)
        assertEquals("input_too_large", repository.lastError.value?.code)
        assertFalse(client.sent.any { it.contains("managed_session_input") })
        repository.close()
    }
}

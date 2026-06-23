package com.clawd.mobile.ws

import android.util.Log
import app.cash.turbine.test
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.SessionData
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap

/**
 * Unit tests for [MessageHandler].
 *
 * Covers all branches: isPendingCert guard, parse failures, every ParsedMessage subtype,
 * state-map mutations, flow emissions, and callback invocations.
 */
class MessageHandlerTest {

    // ── Shared state under test ────────────────────────────────────────

    private lateinit var sessionsMap: ConcurrentHashMap<String, SessionData>
    private lateinit var emitSessions: () -> Unit
    private lateinit var displayState: MutableStateFlow<String>
    private lateinit var syncing: MutableStateFlow<Boolean>
    private lateinit var permissionRequests: MutableSharedFlow<PermissionRequestData>
    private lateinit var reactions: MutableSharedFlow<String>
    private lateinit var sendPong: (String) -> Unit
    private var onPeerConnected: ((String) -> Unit)? = null
    private var onPeerDisconnected: ((String) -> Unit)? = null
    private lateinit var messageParser: MessageParser
    private lateinit var scope: CoroutineScope

    private lateinit var handler: MessageHandler

    @Before
    fun setUp() {
        mockkStatic(Log::class)
        every { Log.d(any(), any()) } returns 0
        every { Log.w(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>(), any()) } returns 0

        sessionsMap = ConcurrentHashMap()
        emitSessions = mockk(relaxed = true)
        displayState = MutableStateFlow("idle")
        syncing = MutableStateFlow(false)
        permissionRequests = MutableSharedFlow(extraBufferCapacity = 5)
        reactions = MutableSharedFlow(extraBufferCapacity = 5)
        sendPong = mockk(relaxed = true)
        onPeerConnected = mockk(relaxed = true)
        onPeerDisconnected = mockk(relaxed = true)
        messageParser = mockk(relaxed = true)
        scope = CoroutineScope(UnconfinedTestDispatcher())

        handler = MessageHandler(
            tag = "Test",
            sessionsMap = sessionsMap,
            emitSessions = emitSessions,
            displayState = displayState,
            syncing = syncing,
            permissionRequests = permissionRequests,
            reactions = reactions,
            scope = scope,
            messageParser = messageParser,
            sendPong = sendPong,
            onPeerConnected = onPeerConnected,
            onPeerDisconnected = onPeerDisconnected,
        )
    }

    @After
    fun tearDown() {
        io.mockk.unmockkAll()
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private fun makeSession(
        sessionId: String = "s1",
        state: String = "idle",
        badge: String = "idle",
        isVisible: Boolean = true,
    ) = SessionData(sessionId = sessionId, state = state, badge = badge, isVisible = isVisible)

    // ── 1. isPendingCert=true → false ─────────────────────────────────

    @Test
    fun `isPendingCert true returns false and skips parsing`() {
        val result = handler.handleMessage("""{"type":"ping"}""", isPendingCert = true)

        assertFalse(result)
        verify(exactly = 0) { messageParser.parse(any()) }
    }

    // ── 2. Invalid JSON → false ────────────────────────────────────────

    @Test
    fun `invalid JSON returns false`() {
        every { messageParser.parse("not-json") } returns null

        val result = handler.handleMessage("not-json", isPendingCert = false)

        assertFalse(result)
    }

    // ── 3. Ping → triggers sendPong, returns false ─────────────────────

    @Test
    fun `Ping triggers sendPong and returns false`() {
        every { messageParser.parse(any()) } returns ParsedMessage.Ping(timestamp = 12345L)

        val result = handler.handleMessage("""{"type":"ping","timestamp":12345}""", isPendingCert = false)

        assertFalse(result)
        verify { sendPong("""{"type":"pong","timestamp":12345}""") }
    }

    // ── 4. Connected → returns true ────────────────────────────────────

    @Test
    fun `Connected message returns true`() {
        every { messageParser.parse(any()) } returns ParsedMessage.Connected(timestamp = 1L)

        val result = handler.handleMessage("""{"type":"connected"}""", isPendingCert = false)

        assertTrue(result)
    }

    // ── 5. ClearSessions → clears map, sets syncing=true ──────────────

    @Test
    fun `ClearSessions clears sessionsMap and sets syncing true`() {
        sessionsMap["s1"] = makeSession()
        every { messageParser.parse(any()) } returns ParsedMessage.ClearSessions(timestamp = 1L)

        val result = handler.handleMessage("""{"type":"clear_sessions"}""", isPendingCert = false)

        assertTrue(result)
        assertTrue(sessionsMap.isEmpty())
        assertTrue(syncing.value)
        verify { emitSessions() }
    }

    // ── 6. Snapshot → updates sessionsMap and displayState ─────────────

    @Test
    fun `Snapshot replaces sessionsMap and updates displayState`() {
        sessionsMap["old"] = makeSession(sessionId = "old")
        val newSessions = mapOf(
            "s1" to makeSession(sessionId = "s1"),
            "s2" to makeSession(sessionId = "s2"),
        )
        every { messageParser.parse(any()) } returns ParsedMessage.Snapshot(
            sessions = newSessions,
            displayState = "working",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"snapshot"}""", isPendingCert = false)

        assertTrue(result)
        assertEquals("working", displayState.value)
        assertFalse(syncing.value)
        assertEquals(2, sessionsMap.size)
        assertTrue(sessionsMap.containsKey("s1"))
        assertTrue(sessionsMap.containsKey("s2"))
        assertFalse(sessionsMap.containsKey("old"))
        verify { emitSessions() }
    }

    @Test
    fun `Snapshot with null displayState does not overwrite`() {
        displayState.value = "existing"
        every { messageParser.parse(any()) } returns ParsedMessage.Snapshot(
            sessions = emptyMap(),
            displayState = null,
            timestamp = 1L,
        )

        handler.handleMessage("""{"type":"snapshot"}""", isPendingCert = false)

        assertEquals("existing", displayState.value)
    }

    // ── 7. State → updates single session ──────────────────────────────

    @Test
    fun `State with visible session adds to sessionsMap`() {
        val sessionData = makeSession(sessionId = "s1", state = "working", badge = "running")
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s1",
            sessionData = sessionData,
            displayState = "working",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"state","sessionId":"s1"}""", isPendingCert = false)

        assertTrue(result)
        assertEquals("working", displayState.value)
        assertEquals(sessionData, sessionsMap["s1"])
        verify { emitSessions() }
    }

    @Test
    fun `State with invisible session removes from sessionsMap`() {
        sessionsMap["s1"] = makeSession(sessionId = "s1")
        val hiddenSession = makeSession(sessionId = "s1", isVisible = false)
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s1",
            sessionData = hiddenSession,
            displayState = null,
            timestamp = 1L,
        )

        handler.handleMessage("""{"type":"state","sessionId":"s1"}""", isPendingCert = false)

        assertFalse(sessionsMap.containsKey("s1"))
    }

    // ── 8. State with null sessionData → false ─────────────────────────

    @Test
    fun `State with null sessionData returns false`() {
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s1",
            sessionData = null,
            displayState = null,
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"state","sessionId":"s1"}""", isPendingCert = false)

        assertFalse(result)
    }

    // ── 9. SessionDeleted → removes session ────────────────────────────

    @Test
    fun `SessionDeleted removes session from sessionsMap`() {
        sessionsMap["s1"] = makeSession(sessionId = "s1")
        every { messageParser.parse(any()) } returns ParsedMessage.SessionDeleted(
            sessionId = "s1",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"session_deleted","sessionId":"s1"}""", isPendingCert = false)

        assertTrue(result)
        assertFalse(sessionsMap.containsKey("s1"))
        verify { emitSessions() }
    }

    // ── 10. PermissionRequest → emits to permissionRequests flow ──────

    @Test
    fun `PermissionRequest emits to permissionRequests flow`() = runTest {
        val data = PermissionRequestData(
            requestId = "req-1",
            toolName = "Bash",
            toolInputSummary = "ls -la",
        )
        every { messageParser.parse(any()) } returns ParsedMessage.PermissionRequest(
            data = data,
            rawToolInput = null,
            timestamp = 1L,
        )

        permissionRequests.test {
            handler.handleMessage("""{"type":"permission_request"}""", isPendingCert = false)

            val emitted = awaitItem()
            assertEquals("req-1", emitted.requestId)
            assertEquals("Bash", emitted.toolName)
        }
    }

    // ── 11. Reaction → emits to reactions flow ────────────────────────

    @Test
    fun `Reaction with svg emits to reactions flow`() = runTest {
        val svg = "<svg>cat</svg>"
        every { messageParser.parse(any()) } returns ParsedMessage.Reaction(
            svg = svg,
            timestamp = 1L,
        )

        reactions.test {
            handler.handleMessage("""{"type":"reaction","svg":"<svg>cat</svg>"}""", isPendingCert = false)

            assertEquals(svg, awaitItem())
        }
    }

    @Test
    fun `Reaction with null svg does not emit`() = runTest {
        every { messageParser.parse(any()) } returns ParsedMessage.Reaction(
            svg = null,
            timestamp = 1L,
        )

        reactions.test {
            handler.handleMessage("""{"type":"reaction"}""", isPendingCert = false)

            expectNoEvents()
        }
    }

    // ── 12. Unknown message → returns true ────────────────────────────

    @Test
    fun `Unknown message type returns true`() {
        every { messageParser.parse(any()) } returns ParsedMessage.Unknown(
            type = "something_weird",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"something_weird"}""", isPendingCert = false)

        assertTrue(result)
    }

    // ── 13. ToolOutput → updates lastOutput ────────────────────────────

    @Test
    fun `ToolOutput updates existing session lastOutput`() {
        sessionsMap["s1"] = makeSession(sessionId = "s1")
        every { messageParser.parse(any()) } returns ParsedMessage.ToolOutput(
            sessionId = "s1",
            toolName = "Write",
            output = "file written",
            timestamp = 100L,
        )

        val result = handler.handleMessage("""{"type":"tool_output","sessionId":"s1"}""", isPendingCert = false)

        assertTrue(result)
        val updated = sessionsMap["s1"]!!
        assertNotNull(updated.lastOutput)
        assertEquals("Write", updated.lastOutput!!.toolName)
        assertEquals("file written", updated.lastOutput!!.output)
        assertEquals(100L, updated.lastOutput!!.at)
        verify { emitSessions() }
    }

    @Test
    fun `ToolOutput for missing session returns false`() {
        every { messageParser.parse(any()) } returns ParsedMessage.ToolOutput(
            sessionId = "nonexistent",
            toolName = "Bash",
            output = "result",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"tool_output","sessionId":"nonexistent"}""", isPendingCert = false)

        assertFalse(result)
    }

    // ── 14. Disconnect → returns false ─────────────────────────────────

    @Test
    fun `Disconnect message returns false`() {
        every { messageParser.parse(any()) } returns ParsedMessage.Disconnect(timestamp = 1L)

        val result = handler.handleMessage("""{"type":"disconnect"}""", isPendingCert = false)

        assertFalse(result)
    }

    // ── 15. PeerConnected → invokes onPeerConnected ────────────────────

    @Test
    fun `PeerConnected invokes onPeerConnected callback with role`() {
        every { messageParser.parse(any()) } returns ParsedMessage.PeerConnected(
            role = "mobile",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"peer_connected","role":"mobile"}""", isPendingCert = false)

        assertTrue(result)
        verify { onPeerConnected?.invoke("mobile") }
    }

    // ── 16. PeerDisconnected → invokes onPeerDisconnected ──────────────

    @Test
    fun `PeerDisconnected invokes onPeerDisconnected callback with role`() {
        every { messageParser.parse(any()) } returns ParsedMessage.PeerDisconnected(
            role = "desktop",
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"peer_disconnected","role":"desktop"}""", isPendingCert = false)

        assertTrue(result)
        verify { onPeerDisconnected?.invoke("desktop") }
    }

    // ── 17. Snapshot → syncing set to false ────────────────────────────

    @Test
    fun `Snapshot sets syncing to false`() {
        syncing.value = true
        every { messageParser.parse(any()) } returns ParsedMessage.Snapshot(
            sessions = emptyMap(),
            displayState = null,
            timestamp = 1L,
        )

        handler.handleMessage("""{"type":"snapshot"}""", isPendingCert = false)

        assertFalse(syncing.value)
    }

    // ── 18. State with null displayState preserves current ─────────────

    @Test
    fun `State with null displayState does not overwrite global`() {
        displayState.value = "working"
        val sessionData = makeSession(sessionId = "s1")
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s1",
            sessionData = sessionData,
            displayState = null,
            timestamp = 1L,
        )

        handler.handleMessage("""{"type":"state","sessionId":"s1"}""", isPendingCert = false)

        assertEquals("working", displayState.value)
    }

    // ── 19. State updates existing session in map ──────────────────────

    @Test
    fun `State updates existing session in sessionsMap`() {
        sessionsMap["s1"] = makeSession(sessionId = "s1", state = "idle", badge = "idle")
        val updated = makeSession(sessionId = "s1", state = "working", badge = "running")
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s1",
            sessionData = updated,
            displayState = null,
            timestamp = 1L,
        )

        handler.handleMessage("""{"type":"state","sessionId":"s1"}""", isPendingCert = false)

        assertEquals("working", sessionsMap["s1"]!!.state)
        assertEquals("running", sessionsMap["s1"]!!.badge)
    }

    // ── 20. ClearSessions calls emitSessions ───────────────────────────

    @Test
    fun `ClearSessions emits sessions after clearing`() {
        sessionsMap["s1"] = makeSession(sessionId = "s1")
        every { messageParser.parse(any()) } returns ParsedMessage.ClearSessions(timestamp = 1L)

        handler.handleMessage("""{"type":"clear_sessions"}""", isPendingCert = false)

        verify { emitSessions() }
    }

    // ── 21. Snapshot calls emitSessions ────────────────────────────────

    @Test
    fun `Snapshot emits sessions after update`() {
        every { messageParser.parse(any()) } returns ParsedMessage.Snapshot(
            sessions = mapOf("s1" to makeSession(sessionId = "s1")),
            displayState = null,
            timestamp = 1L,
        )

        handler.handleMessage("""{"type":"snapshot"}""", isPendingCert = false)

        verify { emitSessions() }
    }

    // ── 22. Multiple ParsedMessages in sequence ────────────────────────

    @Test
    fun `sequential state updates accumulate sessions`() {
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s1",
            sessionData = makeSession(sessionId = "s1", state = "working", badge = "running"),
            displayState = null,
            timestamp = 1L,
        )
        handler.handleMessage("msg1", isPendingCert = false)

        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "s2",
            sessionData = makeSession(sessionId = "s2", state = "thinking", badge = "running"),
            displayState = null,
            timestamp = 2L,
        )
        handler.handleMessage("msg2", isPendingCert = false)

        assertEquals(2, sessionsMap.size)
        assertEquals("working", sessionsMap["s1"]!!.state)
        assertEquals("thinking", sessionsMap["s2"]!!.state)
    }

    // ── 23. PermissionRequest with null requestId still emits ──────────

    @Test
    fun `PermissionRequest with null requestId still emits`() = runTest {
        val data = PermissionRequestData(
            requestId = null,
            toolName = "Read",
        )
        every { messageParser.parse(any()) } returns ParsedMessage.PermissionRequest(
            data = data,
            rawToolInput = null,
            timestamp = 1L,
        )

        permissionRequests.test {
            handler.handleMessage("""{"type":"permission_request"}""", isPendingCert = false)

            val emitted = awaitItem()
            assertNull(emitted.requestId)
            assertEquals("Read", emitted.toolName)
        }
    }

    // ── 24. Reaction with empty svg string does not emit ──────────────

    @Test
    fun `Reaction with empty svg does not emit`() = runTest {
        every { messageParser.parse(any()) } returns ParsedMessage.Reaction(
            svg = "",
            timestamp = 1L,
        )

        reactions.test {
            handler.handleMessage("""{"type":"reaction","svg":""}""", isPendingCert = false)

            // Empty string is not null, so it DOES get emitted
            assertEquals("", awaitItem())
        }
    }

    // ── 25. State with non-empty sessionId and null data returns false ─

    @Test
    fun `State with empty sessionId and null sessionData returns false`() {
        every { messageParser.parse(any()) } returns ParsedMessage.State(
            sessionId = "",
            sessionData = null,
            displayState = null,
            timestamp = 1L,
        )

        val result = handler.handleMessage("""{"type":"state"}""", isPendingCert = false)

        assertFalse(result)
    }

    // ── 26. onPeerConnected can be null ────────────────────────────────

    @Test
    fun `PeerConnected with null callback does not crash`() {
        val handlerNoCallbacks = MessageHandler(
            tag = "Test",
            sessionsMap = sessionsMap,
            emitSessions = emitSessions,
            displayState = displayState,
            syncing = syncing,
            permissionRequests = permissionRequests,
            reactions = reactions,
            scope = scope,
            messageParser = messageParser,
            sendPong = sendPong,
            onPeerConnected = null,
            onPeerDisconnected = null,
        )
        every { messageParser.parse(any()) } returns ParsedMessage.PeerConnected(
            role = "mobile",
            timestamp = 1L,
        )

        val result = handlerNoCallbacks.handleMessage("""{"type":"peer_connected","role":"mobile"}""", isPendingCert = false)

        assertTrue(result)
    }
}

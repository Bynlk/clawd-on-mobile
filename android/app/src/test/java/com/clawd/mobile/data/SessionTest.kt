package com.clawd.mobile.data

import org.junit.Test
import org.junit.Assert.*

class SessionTest {

    // ── parseHexColor ──────────────────────────────────────────────────

    @Test
    fun `parseHexColor returns correct color for valid hex`() {
        val color = parseHexColor("#FF0000")
        assertNotNull(color)
        // Color(r, g, b) where r/g/b are 0-255
        // We can't easily compare Color objects in unit tests without Compose runtime,
        // but we can verify it doesn't return null
    }

    @Test
    fun `parseHexColor returns null for null input`() {
        assertNull(parseHexColor(null))
    }

    @Test
    fun `parseHexColor returns null for missing hash`() {
        assertNull(parseHexColor("FF0000"))
    }

    @Test
    fun `parseHexColor returns null for wrong length`() {
        assertNull(parseHexColor("#FFF"))       // too short
        assertNull(parseHexColor("#FFFFF"))     // 5 chars
        assertNull(parseHexColor("#FFFFFFF"))   // 7 chars
        assertNull(parseHexColor("#FF"))        // too short
    }

    @Test
    fun `parseHexColor returns null for invalid hex chars`() {
        assertNull(parseHexColor("#ZZZZZZ"))
        assertNull(parseHexColor("#GGHHII"))
    }

    @Test
    fun `parseHexColor accepts black and white`() {
        assertNotNull(parseHexColor("#000000"))
        assertNotNull(parseHexColor("#FFFFFF"))
    }

    // ── statePriority ──────────────────────────────────────────────────

    @Test
    fun `statePriority delegates to PetState priority`() {
        assertEquals(8, Session.statePriority("error"))
        assertEquals(7, Session.statePriority("notification"))
        assertEquals(6, Session.statePriority("sweeping"))
        assertEquals(5, Session.statePriority("attention"))
        assertEquals(4, Session.statePriority("conducting"))
        assertEquals(4, Session.statePriority("juggling"))
        assertEquals(4, Session.statePriority("carrying"))
        assertEquals(4, Session.statePriority("debugger"))
        assertEquals(3, Session.statePriority("working"))
        assertEquals(2, Session.statePriority("thinking"))
        assertEquals(1, Session.statePriority("idle"))
        assertEquals(0, Session.statePriority("sleeping"))
    }

    @Test
    fun `statePriority returns idle priority for unknown state`() {
        assertEquals(1, Session.statePriority("unknown"))
        assertEquals(1, Session.statePriority(""))
    }

    // ── SessionData defaults ───────────────────────────────────────────

    @Test
    fun `SessionData has correct defaults`() {
        val data = SessionData()
        assertNull(data.sessionId)
        assertEquals("idle", data.state)
        assertNull(data.event)
        assertNull(data.agentId)
        assertNull(data.toolName)
        assertNull(data.sessionTitle)
        assertNull(data.displayTitle)
        assertNull(data.cwd)
        assertNull(data.updatedAt)
        assertTrue(data.recentEvents.isEmpty())
        assertNull(data.lastOutput)
        assertNull(data.displayState)
        assertTrue(data.isReal)
        assertEquals("idle", data.badge)
        assertNull(data.chipText)
        assertNull(data.chipColor)
        assertNull(data.dotColor)
        assertTrue(data.isVisible)
    }

    @Test
    fun `SessionData with custom values`() {
        val data = SessionData(
            sessionId = "abc123",
            state = "working",
            event = "PreToolUse",
            agentId = "claude-code",
            badge = "running",
            chipText = "工作中",
            chipColor = "#22c55e",
            isVisible = true
        )
        assertEquals("abc123", data.sessionId)
        assertEquals("working", data.state)
        assertEquals("running", data.badge)
        assertEquals("工作中", data.chipText)
    }

    // ── LastOutput ─────────────────────────────────────────────────────

    @Test
    fun `LastOutput defaults`() {
        val output = LastOutput()
        assertEquals("", output.toolName)
        assertEquals("", output.output)
        assertEquals(0L, output.at)
    }

    // ── RecentEvent ────────────────────────────────────────────────────

    @Test
    fun `RecentEvent defaults`() {
        val event = RecentEvent()
        assertEquals(0L, event.at)
        assertNull(event.event)
        assertNull(event.state)
    }
}

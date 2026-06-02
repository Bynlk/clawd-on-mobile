package com.clawd.mobile.ws

import org.junit.Test
import org.junit.Assert.*

class MessageParserTest {

    private val parser = MessageParser()

    // ── Basic type routing ──────────────────────────────────────────────

    @Test
    fun `parse ping returns Ping`() {
        val result = parser.parse("""{"type":"ping"}""")
        assertTrue(result is ParsedMessage.Ping)
    }

    @Test
    fun `parse connected returns Connected`() {
        val result = parser.parse("""{"type":"connected"}""")
        assertTrue(result is ParsedMessage.Connected)
    }

    @Test
    fun `parse clear_sessions returns ClearSessions`() {
        val result = parser.parse("""{"type":"clear_sessions"}""")
        assertTrue(result is ParsedMessage.ClearSessions)
    }

    @Test
    fun `parse unknown type returns Unknown`() {
        val result = parser.parse("""{"type":"future_type"}""")
        assertTrue(result is ParsedMessage.Unknown)
        assertEquals("future_type", (result as ParsedMessage.Unknown).type)
    }

    @Test
    fun `parse malformed JSON returns null`() {
        assertNull(parser.parse("not json"))
        assertNull(parser.parse(""))
        assertNull(parser.parse("{}"))
    }

    // ── Snapshot ────────────────────────────────────────────────────────

    @Test
    fun `parse snapshot with sessions`() {
        val json = """
        {
            "type": "snapshot",
            "sessions": {
                "s1": {"state": "working", "badge": "running", "isVisible": true, "isReal": true},
                "s2": {"state": "idle", "badge": "idle", "isVisible": true, "isReal": false}
            },
            "displayState": "working"
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.Snapshot
        assertEquals(1, result.sessions.size)  // s2 filtered out (isReal=false)
        assertEquals("working", result.sessions["s1"]?.state)
        assertEquals("working", result.displayState)
    }

    @Test
    fun `parse snapshot without sessions field returns empty map`() {
        val json = """{"type": "snapshot", "displayState": "idle"}"""
        val result = parser.parse(json) as ParsedMessage.Snapshot
        assertTrue(result.sessions.isEmpty())
        assertEquals("idle", result.displayState)
    }

    // ── State ───────────────────────────────────────────────────────────

    @Test
    fun `parse state message with all fields`() {
        val json = """
        {
            "type": "state",
            "sessionId": "s1",
            "state": "working",
            "isReal": true,
            "badge": "running",
            "displayState": "working",
            "timestamp": 1717000000000
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.State
        assertEquals("s1", result.sessionId)
        assertNotNull(result.sessionData)
        assertEquals("working", result.sessionData!!.state)
        assertEquals("running", result.sessionData!!.badge)
        assertEquals("working", result.displayState)
        assertEquals(1717000000000L, result.timestamp)
    }

    @Test
    fun `parse state with isReal=false returns null sessionData`() {
        val json = """
        {"type": "state", "sessionId": "s1", "isReal": false}
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.State
        assertEquals("s1", result.sessionId)
        assertNull(result.sessionData)
    }

    @Test
    fun `parse state without sessionId returns empty sessionId`() {
        val json = """{"type": "state", "state": "working"}"""
        val result = parser.parse(json) as ParsedMessage.State
        assertEquals("", result.sessionId)
    }

    // ── Tool Output ─────────────────────────────────────────────────────

    @Test
    fun `parse tool_output`() {
        val json = """
        {
            "type": "tool_output",
            "sessionId": "s1",
            "toolName": "Bash",
            "output": "hello world",
            "timestamp": 12345
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.ToolOutput
        assertEquals("s1", result.sessionId)
        assertEquals("Bash", result.toolName)
        assertEquals("hello world", result.output)
        assertEquals(12345L, result.timestamp)
    }

    // ── Session Deleted ─────────────────────────────────────────────────

    @Test
    fun `parse session_deleted`() {
        val json = """{"type": "session_deleted", "sessionId": "s1"}"""
        val result = parser.parse(json) as ParsedMessage.SessionDeleted
        assertEquals("s1", result.sessionId)
    }

    // ── Permission Request ──────────────────────────────────────────────

    @Test
    fun `parse permission_request with suggestions`() {
        val json = """
        {
            "type": "permission_request",
            "id": "perm_abc",
            "toolName": "Bash",
            "toolInput": {"command": "ls"},
            "agentId": "claude-code",
            "sessionId": "s1",
            "timeout": 30000,
            "suggestions": [
                {"label": "Allow", "behavior": "allow"},
                {"label": "Deny", "behavior": "deny"}
            ]
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.PermissionRequest
        assertEquals("perm_abc", result.data.requestId)
        assertEquals("Bash", result.data.toolName)
        assertEquals("s1", result.data.sessionId)
        assertEquals(30000L, result.data.timeout)
        assertEquals(2, result.data.suggestions.size)
        assertEquals("Allow", result.data.suggestions[0].label)
        assertEquals("Bash → ls", result.data.toolInputSummary)
    }

    @Test
    fun `parse permission_request for AskUserQuestion includes elicitation`() {
        val json = """
        {
            "type": "permission_request",
            "id": "perm_xyz",
            "toolName": "AskUserQuestion",
            "toolInput": {
                "questions": [
                    {
                        "question": "Which approach?",
                        "header": "Approach",
                        "multiSelect": false,
                        "options": [
                            {"label": "Option A", "description": "Fast"},
                            {"label": "Option B", "description": "Safe"}
                        ]
                    }
                ]
            }
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.PermissionRequest
        assertEquals("AskUserQuestion", result.data.toolName)
        assertEquals(1, result.data.elicitationQuestions.size)
        assertEquals("Which approach?", result.data.elicitationQuestions[0].question)
        assertEquals(2, result.data.elicitationQuestions[0].options.size)
    }

    // ── Timestamp ───────────────────────────────────────────────────────

    @Test
    fun `parse extracts timestamp from message`() {
        val json = """{"type": "ping", "timestamp": 99999}"""
        val result = parser.parse(json) as ParsedMessage.Ping
        assertEquals(99999L, result.timestamp)
    }

    @Test
    fun `parse defaults timestamp to 0 when missing`() {
        val json = """{"type": "ping"}"""
        val result = parser.parse(json) as ParsedMessage.Ping
        assertEquals(0L, result.timestamp)
    }
}

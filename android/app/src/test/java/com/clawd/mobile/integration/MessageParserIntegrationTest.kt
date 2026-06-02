package com.clawd.mobile.integration

import com.clawd.mobile.data.*
import com.clawd.mobile.ws.MessageParser
import com.clawd.mobile.ws.ParsedMessage
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

/**
 * Integration tests verifying JSON → MessageParser → ParsedMessage → data model
 * end-to-end message processing pipeline.
 */
class MessageParserIntegrationTest {

    private val parser = MessageParser()

    // ── Snapshot pipeline ──────────────────────────────────────────────

    @Test
    fun `full snapshot pipeline - JSON to session map`() {
        val json = """
        {
            "type": "snapshot",
            "sessions": {
                "sess-1": {
                    "state": "working",
                    "badge": "running",
                    "isReal": true,
                    "isVisible": true,
                    "displayTitle": "Fix auth bug",
                    "agentId": "claude-code",
                    "toolName": "Bash",
                    "chipText": "工作中",
                    "chipColor": "#22c55e",
                    "dotColor": "#16a34a"
                },
                "sess-2": {
                    "state": "idle",
                    "badge": "idle",
                    "isReal": true,
                    "isVisible": false
                },
                "sess-3": {
                    "state": "working",
                    "badge": "running",
                    "isReal": false,
                    "isVisible": true
                }
            },
            "displayState": "working",
            "timestamp": 1717000000000
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.Snapshot

        // sess-2 filtered: isVisible=false
        // sess-3 filtered: isReal=false
        assertEquals(1, result.sessions.size)
        assertNotNull(result.sessions["sess-1"])
        assertNull(result.sessions["sess-2"])
        assertNull(result.sessions["sess-3"])

        val s1 = result.sessions["sess-1"]!!
        assertEquals("working", s1.state)
        assertEquals("running", s1.badge)
        assertEquals("Fix auth bug", s1.displayTitle)
        assertEquals("claude-code", s1.agentId)
        assertEquals("Bash", s1.toolName)
        assertEquals("工作中", s1.chipText)
        assertEquals("#22c55e", s1.chipColor)
        assertEquals("working", result.displayState)
        assertEquals(1717000000000L, result.timestamp)
    }

    // ── State update pipeline ──────────────────────────────────────────

    @Test
    fun `full state pipeline - JSON to SessionData with all mobile fields`() {
        val json = """
        {
            "type": "state",
            "sessionId": "sess-abc",
            "state": "working",
            "isReal": true,
            "badge": "running",
            "displayState": "working",
            "agentId": "claude-code",
            "toolName": "Edit",
            "sessionTitle": "Refactor module",
            "displayTitle": "Refactor auth module",
            "cwd": "/home/user/project",
            "timestamp": 1717000000000,
            "chipText": "编辑中",
            "chipColor": "#3b82f6",
            "dotColor": "#2563eb",
            "isVisible": true,
            "recentEvents": [
                {"at": 1000, "event": "PreToolUse", "state": "working"},
                {"at": 2000, "event": "PostToolUse", "state": "working"}
            ],
            "lastOutput": {
                "toolName": "Edit",
                "output": "File updated successfully",
                "at": 2000
            }
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.State
        val data = result.sessionData!!

        assertEquals("sess-abc", result.sessionId)
        assertEquals("working", data.state)
        assertEquals("running", data.badge)
        assertEquals("working", data.displayState)
        assertEquals("claude-code", data.agentId)
        assertEquals("Edit", data.toolName)
        assertEquals("Refactor module", data.sessionTitle)
        assertEquals("Refactor auth module", data.displayTitle)
        assertEquals("/home/user/project", data.cwd)
        assertEquals(1717000000000L, data.updatedAt)
        assertEquals("编辑中", data.chipText)
        assertEquals("#3b82f6", data.chipColor)
        assertEquals("#2563eb", data.dotColor)
        assertTrue(data.isVisible)
        assertTrue(data.isReal)

        // RecentEvents
        assertEquals(2, data.recentEvents.size)
        assertEquals("PreToolUse", data.recentEvents[0].event)
        assertEquals(1000L, data.recentEvents[0].at)
        assertEquals("PostToolUse", data.recentEvents[1].event)

        // LastOutput
        assertNotNull(data.lastOutput)
        assertEquals("Edit", data.lastOutput!!.toolName)
        assertEquals("File updated successfully", data.lastOutput!!.output)
        assertEquals(2000L, data.lastOutput!!.at)
    }

    @Test
    fun `state with isReal=false returns null sessionData`() {
        val json = """
        {"type": "state", "sessionId": "s1", "isReal": false, "state": "working"}
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.State
        assertEquals("s1", result.sessionId)
        assertNull(result.sessionData)
    }

    // ── Permission request pipeline ────────────────────────────────────

    @Test
    fun `permission request with elicitation questions parsed correctly`() {
        val json = """
        {
            "type": "permission_request",
            "id": "perm-123",
            "toolName": "AskUserQuestion",
            "agentId": "claude-code",
            "sessionId": "sess-1",
            "timeout": 60000,
            "toolInput": {
                "questions": [
                    {
                        "question": "Which database should we use?",
                        "header": "Database",
                        "multiSelect": false,
                        "options": [
                            {"label": "PostgreSQL", "description": "Robust relational DB"},
                            {"label": "MongoDB", "description": "Flexible document store"},
                            {"label": "SQLite", "description": "Lightweight embedded DB"}
                        ]
                    }
                ]
            }
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.PermissionRequest
        val data = result.data

        assertEquals("perm-123", data.requestId)
        assertEquals("AskUserQuestion", data.toolName)
        assertEquals("claude-code", data.agentId)
        assertEquals("sess-1", data.sessionId)
        assertEquals(60000L, data.timeout)
        assertTrue(data.suggestions.isEmpty())

        // Elicitation
        assertEquals(1, data.elicitationQuestions.size)
        val q = data.elicitationQuestions[0]
        assertEquals("Which database should we use?", q.question)
        assertEquals("Database", q.header)
        assertFalse(q.multiSelect)
        assertEquals(3, q.options.size)
        assertEquals("PostgreSQL", q.options[0].label)
        assertEquals("Robust relational DB", q.options[0].description)
    }

    @Test
    fun `permission request with suggestions parsed correctly`() {
        val json = """
        {
            "type": "permission_request",
            "id": "perm-456",
            "toolName": "Bash",
            "toolInput": {"command": "npm install"},
            "agentId": "claude-code",
            "sessionId": "sess-2",
            "timeout": 30000,
            "suggestions": [
                {"label": "Allow once", "behavior": "allow"},
                {"label": "Allow always", "behavior": "allow", "rule": "always"},
                {"label": "Deny", "behavior": "deny"}
            ]
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.PermissionRequest
        val data = result.data

        assertEquals("perm-456", data.requestId)
        assertEquals("Bash", data.toolName)
        assertEquals(30000L, data.timeout)
        assertEquals("Bash → npm install", data.toolInputSummary)

        assertEquals(3, data.suggestions.size)
        assertEquals("Allow once", data.suggestions[0].label)
        assertEquals("allow", data.suggestions[0].behavior)
        assertNull(data.suggestions[0].rule)
        assertEquals("always", data.suggestions[1].rule)
        assertEquals("deny", data.suggestions[2].behavior)
    }

    // ── Tool output pipeline ───────────────────────────────────────────

    @Test
    fun `tool output parsed with all fields`() {
        val json = """
        {
            "type": "tool_output",
            "sessionId": "sess-1",
            "toolName": "Bash",
            "output": "total 48\\ndrwxr-xr-x  6 user staff  192 Jan  1 00:00 .",
            "timestamp": 1717000001000
        }
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.ToolOutput
        assertEquals("sess-1", result.sessionId)
        assertEquals("Bash", result.toolName)
        assertTrue(result.output.startsWith("total 48"))
        assertEquals(1717000001000L, result.timestamp)
    }

    // ── Multiple message sequence ──────────────────────────────────────

    @Test
    fun `message sequence - clear_sessions then snapshot then state`() {
        val messages = listOf(
            """{"type": "clear_sessions", "timestamp": 100}""",
            """{"type": "snapshot", "sessions": {"s1": {"state": "working", "isReal": true, "isVisible": true}}, "timestamp": 200}""",
            """{"type": "state", "sessionId": "s1", "state": "idle", "isReal": true, "isVisible": true, "badge": "idle", "timestamp": 300}""",
        )

        val parsed = messages.map { parser.parse(it)!! }

        assertTrue(parsed[0] is ParsedMessage.ClearSessions)
        val snapshot = parsed[1] as ParsedMessage.Snapshot
        assertEquals(1, snapshot.sessions.size)
        assertEquals("working", snapshot.sessions["s1"]?.state)

        val state = parsed[2] as ParsedMessage.State
        assertEquals("s1", state.sessionId)
        assertEquals("idle", state.sessionData?.state)
        assertEquals("idle", state.sessionData?.badge)
    }

    // ── Edge cases ─────────────────────────────────────────────────────

    @Test
    fun `malformed JSON returns null`() {
        assertNull(parser.parse(""))
        assertNull(parser.parse("not json"))
        assertNull(parser.parse("{}"))
        assertNull(parser.parse("""{"type": null}"""))
    }

    @Test
    fun `unknown message type returns Unknown`() {
        val result = parser.parse("""{"type": "future_feature", "data": "something"}""")
        assertTrue(result is ParsedMessage.Unknown)
        assertEquals("future_feature", (result as ParsedMessage.Unknown).type)
    }

    @Test
    fun `displayTitle falls back to sessionTitle`() {
        val json = """
        {"type": "state", "sessionId": "s1", "state": "working", "isReal": true,
         "sessionTitle": "My Session", "timestamp": 100}
        """.trimIndent()

        val result = parser.parse(json) as ParsedMessage.State
        assertEquals("My Session", result.sessionData?.displayTitle)
    }
}

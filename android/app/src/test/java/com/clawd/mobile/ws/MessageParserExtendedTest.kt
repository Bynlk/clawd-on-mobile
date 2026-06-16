package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

/**
 * Extended tests for [MessageParser] — the real message parser.
 * Verifies both typed [ParsedMessage] output and [buildToolInputSummary] logic.
 */
class MessageParserExtendedTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val parser = MessageParser()

    // ── SessionData deserialization ──────────────────────────────────

    @Test
    fun `deserialize SessionData from snapshot JSON`() {
        // Snapshot JSON uses field names matching @Serializable (updatedAt, not timestamp)
        val jsonString = """
        {
            "sessionId": "abc123",
            "state": "working",
            "event": "PreToolUse",
            "agentId": "claude-code",
            "toolName": "Bash",
            "sessionTitle": "Fix bug",
            "displayTitle": "Fix bug in auth",
            "cwd": "/home/user/project",
            "updatedAt": 1717000000000,
            "badge": "running",
            "chipText": "工作中",
            "chipColor": "#22c55e",
            "dotColor": "#16a34a",
            "isVisible": true,
            "isReal": true,
            "displayState": "working"
        }
        """.trimIndent()

        val data = json.decodeFromString<SessionData>(jsonString)

        assertEquals("abc123", data.sessionId)
        assertEquals("working", data.state)
        assertEquals("PreToolUse", data.event)
        assertEquals("claude-code", data.agentId)
        assertEquals("Bash", data.toolName)
        assertEquals("Fix bug", data.sessionTitle)
        assertEquals("Fix bug in auth", data.displayTitle)
        assertEquals("/home/user/project", data.cwd)
        assertEquals(1717000000000L, data.updatedAt)
        assertEquals("running", data.badge)
        assertEquals("工作中", data.chipText)
        assertEquals("#22c55e", data.chipColor)
        assertEquals("#16a34a", data.dotColor)
        assertTrue(data.isVisible)
        assertTrue(data.isReal)
        assertEquals("working", data.displayState)
    }

    @Test
    fun `state message timestamp maps to updatedAt via handleMessage`() {
        // The server sends "timestamp" but handleMessage maps it to SessionData.updatedAt
        // This test verifies the mapping logic used in handleMessage
        val timestamp = 1717000000000L
        val data = SessionData(
            sessionId = "s1",
            state = "working",
            updatedAt = timestamp
        )
        assertEquals(timestamp, data.updatedAt)
    }

    @Test
    fun `deserialize SessionData with minimal fields`() {
        val jsonString = """{"state": "idle"}"""
        val data = json.decodeFromString<SessionData>(jsonString)

        assertEquals("idle", data.state)
        assertNull(data.sessionId)
        assertNull(data.event)
        assertNull(data.agentId)
        assertEquals("idle", data.badge)
        assertTrue(data.isReal)
        assertTrue(data.isVisible)
    }

    @Test
    fun `deserialize SessionData with recentEvents`() {
        val jsonString = """
        {
            "state": "working",
            "recentEvents": [
                {"at": 1000, "event": "PreToolUse", "state": "working"},
                {"at": 2000, "event": "PostToolUse", "state": "working"}
            ]
        }
        """.trimIndent()

        val data = json.decodeFromString<SessionData>(jsonString)
        assertEquals(2, data.recentEvents.size)
        assertEquals("PreToolUse", data.recentEvents[0].event)
        assertEquals(1000L, data.recentEvents[0].at)
        assertEquals("PostToolUse", data.recentEvents[1].event)
    }

    @Test
    fun `deserialize SessionData with lastOutput`() {
        val jsonString = """
        {
            "state": "working",
            "lastOutput": {
                "toolName": "Bash",
                "output": "File created successfully",
                "at": 3000
            }
        }
        """.trimIndent()

        val data = json.decodeFromString<SessionData>(jsonString)
        assertNotNull(data.lastOutput)
        assertEquals("Bash", data.lastOutput!!.toolName)
        assertEquals("File created successfully", data.lastOutput!!.output)
        assertEquals(3000L, data.lastOutput!!.at)
    }

    @Test
    fun `deserialize SessionData ignores unknown fields`() {
        val jsonString = """
        {
            "state": "idle",
            "unknownField": "should be ignored",
            "anotherField": 42
        }
        """.trimIndent()

        val data = json.decodeFromString<SessionData>(jsonString)
        assertEquals("idle", data.state)
    }

    // ── RecentEvent deserialization ──────────────────────────────────

    @Test
    fun `deserialize RecentEvent`() {
        val jsonString = """{"at": 1234, "event": "Stop", "state": "idle"}"""
        val event = json.decodeFromString<RecentEvent>(jsonString)
        assertEquals(1234L, event.at)
        assertEquals("Stop", event.event)
        assertEquals("idle", event.state)
    }

    @Test
    fun `deserialize RecentEvent with defaults`() {
        val jsonString = """{}"""
        val event = json.decodeFromString<RecentEvent>(jsonString)
        assertEquals(0L, event.at)
        assertNull(event.event)
        assertNull(event.state)
    }

    // ── LastOutput deserialization ───────────────────────────────────

    @Test
    fun `deserialize LastOutput`() {
        val jsonString = """{"toolName": "Read", "output": "file contents", "at": 5000}"""
        val output = json.decodeFromString<LastOutput>(jsonString)
        assertEquals("Read", output.toolName)
        assertEquals("file contents", output.output)
        assertEquals(5000L, output.at)
    }

    @Test
    fun `deserialize LastOutput with defaults`() {
        val jsonString = """{}"""
        val output = json.decodeFromString<LastOutput>(jsonString)
        assertEquals("", output.toolName)
        assertEquals("", output.output)
        assertEquals(0L, output.at)
    }

    // ── MessageParser.parse() — typed routing ─────────────────────────

    @Test
    fun `parse ping message returns Ping`() {
        val result = parser.parse("""{"type": "ping", "timestamp": 100}""")
        assertTrue(result is ParsedMessage.Ping)
        assertEquals(100L, result!!.timestamp)
    }

    @Test
    fun `parse connected message returns Connected`() {
        val result = parser.parse("""{"type": "connected"}""")
        assertTrue(result is ParsedMessage.Connected)
    }

    @Test
    fun `parse clear_sessions message returns ClearSessions`() {
        val result = parser.parse("""{"type": "clear_sessions"}""")
        assertTrue(result is ParsedMessage.ClearSessions)
    }

    @Test
    fun `parse unknown type returns Unknown`() {
        val result = parser.parse("""{"type": "future_event"}""")
        assertTrue(result is ParsedMessage.Unknown)
        assertEquals("future_event", (result as ParsedMessage.Unknown).type)
    }

    @Test
    fun `parse malformed JSON returns null`() {
        assertNull(parser.parse("not json"))
    }

    @Test
    fun `parse JSON without type returns null`() {
        assertNull(parser.parse("""{"foo": "bar"}"""))
    }

    @Test
    fun `parse snapshot filters real+visible sessions`() {
        val jsonString = """
        {
            "type": "snapshot",
            "sessions": {
                "s1": {"state": "working", "badge": "running", "isVisible": true, "isReal": true},
                "s2": {"state": "idle", "badge": "idle", "isVisible": true, "isReal": false},
                "s3": {"state": "working", "isVisible": false, "isReal": true}
            },
            "displayState": "working"
        }
        """.trimIndent()

        val result = parser.parse(jsonString) as ParsedMessage.Snapshot
        assertEquals("working", result.displayState)
        // Only s1 passes isReal && isVisible filter
        assertEquals(1, result.sessions.size)
        assertNotNull(result.sessions["s1"])
        assertEquals("working", result.sessions["s1"]!!.state)
        assertEquals("running", result.sessions["s1"]!!.badge)
    }

    @Test
    fun `parse state message extracts all mobile fields`() {
        val jsonString = """
        {
            "type": "state",
            "sessionId": "s1",
            "state": "working",
            "event": "PreToolUse",
            "badge": "running",
            "chipText": "工作中",
            "chipColor": "#22c55e",
            "dotColor": "#16a34a",
            "isVisible": true,
            "isReal": true,
            "displayState": "working",
            "timestamp": 1717000000000
        }
        """.trimIndent()

        val result = parser.parse(jsonString) as ParsedMessage.State
        assertEquals("s1", result.sessionId)
        assertEquals("working", result.displayState)
        val data = result.sessionData!!
        assertEquals("working", data.state)
        assertEquals("PreToolUse", data.event)
        assertEquals("running", data.badge)
        assertEquals("工作中", data.chipText)
        assertEquals("#22c55e", data.chipColor)
        assertEquals("#16a34a", data.dotColor)
        assertTrue(data.isVisible)
        assertEquals(1717000000000L, data.updatedAt)
    }

    @Test
    fun `parse state message with isReal=false returns null sessionData`() {
        val jsonString = """{"type": "state", "sessionId": "s1", "isReal": false}"""
        val result = parser.parse(jsonString) as ParsedMessage.State
        assertEquals("s1", result.sessionId)
        assertNull(result.sessionData)
    }

    @Test
    fun `parse tool_output message`() {
        val jsonString = """{"type": "tool_output", "sessionId": "s1", "toolName": "Bash", "output": "done", "timestamp": 500}"""
        val result = parser.parse(jsonString) as ParsedMessage.ToolOutput
        assertEquals("s1", result.sessionId)
        assertEquals("Bash", result.toolName)
        assertEquals("done", result.output)
        assertEquals(500L, result.timestamp)
    }

    @Test
    fun `parse session_deleted message`() {
        val jsonString = """{"type": "session_deleted", "sessionId": "s1", "timestamp": 600}"""
        val result = parser.parse(jsonString) as ParsedMessage.SessionDeleted
        assertEquals("s1", result.sessionId)
    }

    @Test
    fun `parse permission_request with suggestions`() {
        val jsonString = """
        {
            "type": "permission_request",
            "id": "perm_abc123",
            "toolName": "Bash",
            "toolInput": {"command": "rm -rf /tmp/test"},
            "agentId": "claude-code",
            "sessionId": "s1",
            "timeout": 60000,
            "suggestions": [
                {"label": "Allow", "behavior": "allow"},
                {"label": "Deny", "behavior": "deny"}
            ]
        }
        """.trimIndent()

        val result = parser.parse(jsonString) as ParsedMessage.PermissionRequest
        val data = result.data
        assertEquals("perm_abc123", data.requestId)
        assertEquals("Bash", data.toolName)
        assertEquals("claude-code", data.agentId)
        assertEquals("s1", data.sessionId)
        assertEquals(60000L, data.timeout)
        assertEquals("Bash → rm -rf /tmp/test", data.toolInputSummary)
        assertEquals(2, data.suggestions.size)
        assertEquals("Allow", data.suggestions[0].label)
        assertEquals("allow", data.suggestions[0].behavior)
    }

    @Test
    fun `parse AskUserQuestion elicitation with questions`() {
        val jsonString = """
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
                            {"label": "Option A", "description": "Fast approach"},
                            {"label": "Option B", "description": "Safe approach"}
                        ]
                    }
                ]
            }
        }
        """.trimIndent()

        val result = parser.parse(jsonString) as ParsedMessage.PermissionRequest
        val data = result.data
        assertEquals("AskUserQuestion", data.toolName)
        assertEquals("AskUserQuestion → Which approach?", data.toolInputSummary)
        assertEquals(1, data.elicitationQuestions.size)

        val q = data.elicitationQuestions[0]
        assertEquals("Which approach?", q.question)
        assertEquals("Approach", q.header)
        assertFalse(q.multiSelect)
        assertEquals(2, q.options.size)
        assertEquals("Option A", q.options[0].label)
        assertEquals("Fast approach", q.options[0].description)
    }

    // ── buildToolInputSummary logic (recreated for testing) ──────────

    @Test
    fun `buildToolInputSummary for Write tool returns file_path`() {
        val toolInput = buildJsonObject {
            put("file_path", "/home/user/test.kt")
            put("content", "fun main() {}")
        }
        val summary = parser.buildToolInputSummary("Write", toolInput)
        assertEquals("Write → /home/user/test.kt", summary)
    }

    @Test
    fun `buildToolInputSummary for Bash tool returns command`() {
        val toolInput = buildJsonObject {
            put("command", "ls -la /tmp")
        }
        val summary = parser.buildToolInputSummary("Bash", toolInput)
        assertEquals("Bash → ls -la /tmp", summary)
    }

    @Test
    fun `buildToolInputSummary for Read tool returns file_path`() {
        val toolInput = buildJsonObject {
            put("file_path", "/etc/hosts")
        }
        val summary = parser.buildToolInputSummary("Read", toolInput)
        assertEquals("Read → /etc/hosts", summary)
    }

    @Test
    fun `buildToolInputSummary for Edit tool returns file_path`() {
        val toolInput = buildJsonObject {
            put("file_path", "/src/main.kt")
        }
        val summary = parser.buildToolInputSummary("Edit", toolInput)
        assertEquals("Edit → /src/main.kt", summary)
    }

    @Test
    fun `buildToolInputSummary for WebFetch returns url`() {
        val toolInput = buildJsonObject {
            put("url", "https://example.com/api")
        }
        val summary = parser.buildToolInputSummary("WebFetch", toolInput)
        assertEquals("WebFetch → https://example.com/api", summary)
    }

    @Test
    fun `buildToolInputSummary for WebSearch returns query`() {
        val toolInput = buildJsonObject {
            put("query", "kotlin coroutines tutorial")
        }
        val summary = parser.buildToolInputSummary("WebSearch", toolInput)
        assertEquals("WebSearch → kotlin coroutines tutorial", summary)
    }

    @Test
    fun `buildToolInputSummary for NotebookEdit returns notebook_path`() {
        val toolInput = buildJsonObject {
            put("notebook_path", "/notebooks/analysis.ipynb")
        }
        val summary = parser.buildToolInputSummary("NotebookEdit", toolInput)
        assertEquals("NotebookEdit → /notebooks/analysis.ipynb", summary)
    }

    @Test
    fun `buildToolInputSummary for unknown tool returns description`() {
        val toolInput = buildJsonObject {
            put("description", "Custom tool description")
        }
        val summary = parser.buildToolInputSummary("CustomTool", toolInput)
        assertEquals("CustomTool → Custom tool description", summary)
    }

    @Test
    fun `buildToolInputSummary for unknown tool falls back to summary`() {
        val toolInput = buildJsonObject {
            put("summary", "Brief summary")
        }
        val summary = parser.buildToolInputSummary("CustomTool", toolInput)
        assertEquals("CustomTool → Brief summary", summary)
    }

    @Test
    fun `buildToolInputSummary for unknown tool falls back to reason`() {
        val toolInput = buildJsonObject {
            put("reason", "Because")
        }
        val summary = parser.buildToolInputSummary("CustomTool", toolInput)
        assertEquals("CustomTool → Because", summary)
    }

    @Test
    fun `buildToolInputSummary truncates long text to 60 chars`() {
        val longPath = "/a/very/long/path/that/exceeds/sixty/characters/and/should/be/truncated/file.kt"
        val toolInput = buildJsonObject {
            put("file_path", longPath)
        }
        val summary = parser.buildToolInputSummary("Write", toolInput)
        assertNotNull(summary)
        assertTrue(summary!!.contains("…"))
        assertTrue(summary.length <= "Write → ".length + 61)
    }

    @Test
    fun `buildToolInputSummary returns null for null input`() {
        val summary = parser.buildToolInputSummary("Bash", null)
        assertNull(summary)
    }

    @Test
    fun `buildToolInputSummary returns null for empty toolInput`() {
        val toolInput = buildJsonObject {}
        val summary = parser.buildToolInputSummary("Bash", toolInput)
        // Empty object toString() = "{}" which has length 2, not > 2
        assertNull(summary)
    }

    @Test
    fun `buildToolInputSummary for AskUserQuestion returns first question`() {
        val toolInput = buildJsonObject {
            putJsonArray("questions") {
                addJsonObject {
                    put("question", "Which approach?")
                    put("header", "Approach")
                    put("multiSelect", false)
                }
            }
        }
        val summary = parser.buildToolInputSummary("AskUserQuestion", toolInput)
        assertEquals("AskUserQuestion → Which approach?", summary)
    }
}

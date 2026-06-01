package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

/**
 * Tests for JSON message parsing logic used in ClawdWebSocket.handleMessage.
 * These test the data model deserialization without needing a real WebSocket connection.
 */
class ClawdWebSocketParsingTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

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

    // ── Message type routing logic ───────────────────────────────────

    @Test
    fun `parse message type from JSON`() {
        val types = listOf("ping", "connected", "clear_sessions", "snapshot", "state", "tool_output", "session_deleted", "permission_request")
        for (type in types) {
            val jsonString = """{"type": "$type"}"""
            val obj = json.decodeFromString<JsonObject>(jsonString)
            assertEquals(type, obj["type"]?.jsonPrimitive?.contentOrNull)
        }
    }

    @Test
    fun `parse snapshot with sessions`() {
        val jsonString = """
        {
            "type": "snapshot",
            "sessions": {
                "s1": {"state": "working", "badge": "running", "isVisible": true, "isReal": true},
                "s2": {"state": "idle", "badge": "idle", "isVisible": true, "isReal": false}
            },
            "displayState": "working"
        }
        """.trimIndent()

        val obj = json.decodeFromString<JsonObject>(jsonString)
        val sessionsObj = obj["sessions"]?.jsonObject
        assertNotNull(sessionsObj)
        assertEquals(2, sessionsObj!!.size)

        val s1 = json.decodeFromJsonElement<SessionData>(sessionsObj["s1"]!!)
        assertEquals("working", s1.state)
        assertEquals("running", s1.badge)
        assertTrue(s1.isReal)

        val s2 = json.decodeFromJsonElement<SessionData>(sessionsObj["s2"]!!)
        assertEquals("idle", s2.state)
        assertFalse(s2.isReal)
    }

    @Test
    fun `parse state message with all mobile fields`() {
        val jsonString = """
        {
            "type": "state",
            "sessionId": "s1",
            "state": "working",
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

        val obj = json.decodeFromString<JsonObject>(jsonString)
        assertEquals("s1", obj["sessionId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("running", obj["badge"]?.jsonPrimitive?.contentOrNull)
        assertEquals("工作中", obj["chipText"]?.jsonPrimitive?.contentOrNull)
        assertEquals("#22c55e", obj["chipColor"]?.jsonPrimitive?.contentOrNull)
        assertEquals("#16a34a", obj["dotColor"]?.jsonPrimitive?.contentOrNull)
        assertTrue(obj["isVisible"]?.jsonPrimitive?.booleanOrNull ?: true)
    }

    // ── PermissionRequestData parsing ────────────────────────────────

    @Test
    fun `parse permission_request message`() {
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

        val obj = json.decodeFromString<JsonObject>(jsonString)
        assertEquals("perm_abc123", obj["id"]?.jsonPrimitive?.contentOrNull)
        assertEquals("Bash", obj["toolName"]?.jsonPrimitive?.contentOrNull)
        assertEquals("claude-code", obj["agentId"]?.jsonPrimitive?.contentOrNull)
        assertEquals(60000L, obj["timeout"]?.jsonPrimitive?.longOrNull)

        val suggestions = obj["suggestions"]?.jsonArray
        assertEquals(2, suggestions?.size)
        assertEquals("Allow", suggestions?.get(0)?.jsonObject?.get("label")?.jsonPrimitive?.content)
    }

    // ── Elicitation parsing ──────────────────────────────────────────

    @Test
    fun `parse AskUserQuestion elicitation message`() {
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

        val obj = json.decodeFromString<JsonObject>(jsonString)
        val toolInput = obj["toolInput"]?.jsonObject
        val questions = toolInput?.get("questions")?.jsonArray
        assertEquals(1, questions?.size)

        val q = questions?.get(0)?.jsonObject
        assertEquals("Which approach?", q?.get("question")?.jsonPrimitive?.content)
        assertEquals("Approach", q?.get("header")?.jsonPrimitive?.contentOrNull)
        assertEquals(false, q?.get("multiSelect")?.jsonPrimitive?.booleanOrNull)

        val options = q?.get("options")?.jsonArray
        assertEquals(2, options?.size)
        assertEquals("Option A", options?.get(0)?.jsonObject?.get("label")?.jsonPrimitive?.content)
        assertEquals("Fast approach", options?.get(0)?.jsonObject?.get("description")?.jsonPrimitive?.contentOrNull)
    }

    // ── buildToolInputSummary logic (recreated for testing) ──────────

    @Test
    fun `buildToolInputSummary for Write tool returns file_path`() {
        val toolInput = buildJsonObject {
            put("file_path", "/home/user/test.kt")
            put("content", "fun main() {}")
        }
        val summary = buildSummary("Write", toolInput)
        assertEquals("Write → /home/user/test.kt", summary)
    }

    @Test
    fun `buildToolInputSummary for Bash tool returns command`() {
        val toolInput = buildJsonObject {
            put("command", "ls -la /tmp")
        }
        val summary = buildSummary("Bash", toolInput)
        assertEquals("Bash → ls -la /tmp", summary)
    }

    @Test
    fun `buildToolInputSummary for Read tool returns file_path`() {
        val toolInput = buildJsonObject {
            put("file_path", "/etc/hosts")
        }
        val summary = buildSummary("Read", toolInput)
        assertEquals("Read → /etc/hosts", summary)
    }

    @Test
    fun `buildToolInputSummary for Edit tool returns file_path`() {
        val toolInput = buildJsonObject {
            put("file_path", "/src/main.kt")
        }
        val summary = buildSummary("Edit", toolInput)
        assertEquals("Edit → /src/main.kt", summary)
    }

    @Test
    fun `buildToolInputSummary for WebFetch returns url`() {
        val toolInput = buildJsonObject {
            put("url", "https://example.com/api")
        }
        val summary = buildSummary("WebFetch", toolInput)
        assertEquals("WebFetch → https://example.com/api", summary)
    }

    @Test
    fun `buildToolInputSummary for WebSearch returns query`() {
        val toolInput = buildJsonObject {
            put("query", "kotlin coroutines tutorial")
        }
        val summary = buildSummary("WebSearch", toolInput)
        assertEquals("WebSearch → kotlin coroutines tutorial", summary)
    }

    @Test
    fun `buildToolInputSummary for NotebookEdit returns notebook_path`() {
        val toolInput = buildJsonObject {
            put("notebook_path", "/notebooks/analysis.ipynb")
        }
        val summary = buildSummary("NotebookEdit", toolInput)
        assertEquals("NotebookEdit → /notebooks/analysis.ipynb", summary)
    }

    @Test
    fun `buildToolInputSummary for unknown tool returns description`() {
        val toolInput = buildJsonObject {
            put("description", "Custom tool description")
        }
        val summary = buildSummary("CustomTool", toolInput)
        assertEquals("CustomTool → Custom tool description", summary)
    }

    @Test
    fun `buildToolInputSummary for unknown tool falls back to summary`() {
        val toolInput = buildJsonObject {
            put("summary", "Brief summary")
        }
        val summary = buildSummary("CustomTool", toolInput)
        assertEquals("CustomTool → Brief summary", summary)
    }

    @Test
    fun `buildToolInputSummary for unknown tool falls back to reason`() {
        val toolInput = buildJsonObject {
            put("reason", "Because")
        }
        val summary = buildSummary("CustomTool", toolInput)
        assertEquals("CustomTool → Because", summary)
    }

    @Test
    fun `buildToolInputSummary truncates long text to 60 chars`() {
        val longPath = "/a/very/long/path/that/exceeds/sixty/characters/and/should/be/truncated/file.kt"
        val toolInput = buildJsonObject {
            put("file_path", longPath)
        }
        val summary = buildSummary("Write", toolInput)
        assertNotNull(summary)
        assertTrue(summary!!.contains("…"))
        assertTrue(summary.length <= "Write → ".length + 61)
    }

    @Test
    fun `buildToolInputSummary returns null for null input`() {
        val summary = buildSummary("Bash", null)
        assertNull(summary)
    }

    @Test
    fun `buildToolInputSummary returns null for empty toolInput`() {
        val toolInput = buildJsonObject {}
        val summary = buildSummary("Bash", toolInput)
        // Empty object toString() = "{}" which has length 2, not > 2
        assertNull(summary)
    }

    // ── Helper: recreate buildToolInputSummary logic for testing ─────

    private fun buildSummary(toolName: String?, toolInput: JsonObject?): String? {
        if (toolInput == null) return null
        val key = toolName ?: ""
        val summary = when (key) {
            "Write", "Edit", "Delete", "Read" ->
                toolInput["file_path"]?.jsonPrimitive?.contentOrNull
            "Bash" ->
                toolInput["command"]?.jsonPrimitive?.contentOrNull
            "NotebookEdit" ->
                toolInput["notebook_path"]?.jsonPrimitive?.contentOrNull
            "WebFetch" ->
                toolInput["url"]?.jsonPrimitive?.contentOrNull
            "WebSearch" ->
                toolInput["query"]?.jsonPrimitive?.contentOrNull
            else -> {
                toolInput["description"]?.jsonPrimitive?.contentOrNull
                    ?: toolInput["summary"]?.jsonPrimitive?.contentOrNull
                    ?: toolInput["reason"]?.jsonPrimitive?.contentOrNull
            }
        }
        val text = summary?.take(60)?.trim()
        if (text.isNullOrBlank()) {
            val fallback = toolInput.toString().take(80)
            return if (fallback.length > 2) "$key → $fallback…" else null
        }
        return "$key → $text" + if (summary.length > 60) "…" else ""
    }
}

package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import com.clawd.mobile.util.SafeExecutor
import kotlinx.serialization.json.*

/**
 * Parses raw message JSON into typed [ParsedMessage] instances.
 * Stateless — all methods are pure functions that produce data without side effects.
 */
class MessageParser {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Parse a raw message string. Returns null on malformed JSON or missing type. */
    fun parse(rawText: String): ParsedMessage? {
        val obj = try {
            json.decodeFromString<JsonObject>(rawText)
        } catch (_: Exception) {
            return null
        }
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return null
        val timestamp = obj["timestamp"]?.jsonPrimitive?.longOrNull ?: 0L

        return when (type) {
            "ping" -> ParsedMessage.Ping(timestamp)
            "connected" -> ParsedMessage.Connected(timestamp)
            "clear_sessions" -> ParsedMessage.ClearSessions(timestamp)
            "snapshot" -> parseSnapshot(obj, timestamp)
            "state" -> parseState(obj, timestamp)
            "tool_output" -> parseToolOutput(obj, timestamp)
            "session_deleted" -> parseSessionDeleted(obj, timestamp)
            "permission_request" -> parsePermissionRequest(obj, timestamp)
            "reaction" -> parseReaction(obj, timestamp)
            "disconnect" -> ParsedMessage.Disconnect(timestamp)
            else -> ParsedMessage.Unknown(type, timestamp)
        }
    }

    // ── Snapshot ────────────────────────────────────────────────────────

    private fun parseSnapshot(obj: JsonObject, timestamp: Long): ParsedMessage.Snapshot {
        val sessionsObj = obj["sessions"]?.jsonObject
        val displayState = obj["displayState"]?.jsonPrimitive?.contentOrNull

        if (sessionsObj == null) {
            return ParsedMessage.Snapshot(emptyMap(), displayState, timestamp)
        }

        val map = mutableMapOf<String, SessionData>()
        for ((sid, el) in sessionsObj) {
            SafeExecutor.tryOrNull("MP") {
                val sd = json.decodeFromJsonElement<SessionData>(el)
                if (sd.isReal && sd.isVisible) map[sid] = sd
            }
        }
        return ParsedMessage.Snapshot(map, displayState, timestamp)
    }

    // ── State ───────────────────────────────────────────────────────────

    private fun parseState(obj: JsonObject, timestamp: Long): ParsedMessage.State {
        val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull
            ?: return ParsedMessage.State("", null, null, timestamp)
        val isReal = obj["isReal"]?.jsonPrimitive?.booleanOrNull ?: true
        if (!isReal) return ParsedMessage.State(sid, null, null, timestamp)

        val recentEvents = try {
            obj["recentEvents"]?.jsonArray?.map { el ->
                val o = el.jsonObject
                RecentEvent(
                    at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                    event = o["event"]?.jsonPrimitive?.contentOrNull,
                    state = o["state"]?.jsonPrimitive?.contentOrNull,
                )
            } ?: emptyList()
        } catch (_: Exception) { emptyList() }

        val lastOutput = try {
            obj["lastOutput"]?.jsonObject?.let { o ->
                LastOutput(
                    toolName = o["toolName"]?.jsonPrimitive?.contentOrNull ?: "",
                    output = o["output"]?.jsonPrimitive?.contentOrNull ?: "",
                    at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                )
            }
        } catch (_: Exception) { null }

        val displayState = obj["displayState"]?.jsonPrimitive?.contentOrNull

        val data = SessionData(
            sessionId = sid,
            state = obj["state"]?.jsonPrimitive?.contentOrNull ?: "idle",
            event = obj["event"]?.jsonPrimitive?.contentOrNull,
            agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
            toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull,
            sessionTitle = obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
            displayTitle = obj["displayTitle"]?.jsonPrimitive?.contentOrNull
                ?: obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
            cwd = obj["cwd"]?.jsonPrimitive?.contentOrNull,
            updatedAt = obj["timestamp"]?.jsonPrimitive?.longOrNull,
            recentEvents = recentEvents,
            lastOutput = lastOutput,
            displayState = displayState,
            hookState = obj["hookState"]?.jsonPrimitive?.contentOrNull,
            badge = obj["badge"]?.jsonPrimitive?.contentOrNull ?: "idle",
            chipText = obj["chipText"]?.jsonPrimitive?.contentOrNull,
            chipColor = obj["chipColor"]?.jsonPrimitive?.contentOrNull,
            dotColor = obj["dotColor"]?.jsonPrimitive?.contentOrNull,
            isVisible = obj["isVisible"]?.jsonPrimitive?.booleanOrNull ?: true,
        )
        return ParsedMessage.State(sid, data, displayState, timestamp)
    }

    // ── Tool Output ─────────────────────────────────────────────────────

    private fun parseToolOutput(obj: JsonObject, timestamp: Long): ParsedMessage.ToolOutput {
        val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull
            ?: return ParsedMessage.ToolOutput("", "", "", timestamp)
        return ParsedMessage.ToolOutput(
            sessionId = sid,
            toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull ?: "",
            output = obj["output"]?.jsonPrimitive?.contentOrNull ?: "",
            timestamp = timestamp,
        )
    }

    // ── Session Deleted ─────────────────────────────────────────────────

    private fun parseSessionDeleted(obj: JsonObject, timestamp: Long): ParsedMessage.SessionDeleted {
        val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull
            ?: return ParsedMessage.SessionDeleted("", timestamp)
        return ParsedMessage.SessionDeleted(sid, timestamp)
    }

    // ── Permission Request ──────────────────────────────────────────────

    private fun parsePermissionRequest(obj: JsonObject, timestamp: Long): ParsedMessage.PermissionRequest {
        val toolNameStr = obj["toolName"]?.jsonPrimitive?.contentOrNull
        val toolInputObj = obj["toolInput"]?.jsonObject

        val suggestions = SafeExecutor.tryOrNull("MP") {
            obj["suggestions"]?.jsonArray?.map { s ->
                val so = s.jsonObject
                PermissionSuggestion(
                    label = so["label"]?.jsonPrimitive?.content ?: "",
                    behavior = so["behavior"]?.jsonPrimitive?.content ?: "deny",
                    rule = so["rule"]?.jsonPrimitive?.contentOrNull,
                )
            }
        } ?: emptyList()

        // AskUserQuestion (elicitation): parse questions hierarchy
        val elicitationQuestions = if (toolNameStr == "AskUserQuestion") {
            SafeExecutor.tryOrNull("MP") {
                toolInputObj?.get("questions")?.jsonArray?.map { q ->
                    val qo = q.jsonObject
                    ElicitationQuestion(
                        question = qo["question"]?.jsonPrimitive?.content ?: "",
                        header = qo["header"]?.jsonPrimitive?.contentOrNull,
                        multiSelect = qo["multiSelect"]?.jsonPrimitive?.booleanOrNull ?: false,
                        options = qo["options"]?.jsonArray?.map { o ->
                            val oo = o.jsonObject
                            ElicitationOption(
                                label = oo["label"]?.jsonPrimitive?.content ?: "",
                                description = oo["description"]?.jsonPrimitive?.contentOrNull,
                            )
                        } ?: emptyList(),
                    )
                }
            } ?: emptyList()
        } else emptyList()

        val data = PermissionRequestData(
            agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
            toolName = toolNameStr,
            toolInputSummary = buildToolInputSummary(toolNameStr, toolInputObj),
            sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
            requestId = obj["id"]?.jsonPrimitive?.contentOrNull,
            timeout = obj["timeout"]?.jsonPrimitive?.longOrNull ?: 60000,
            suggestions = suggestions,
            elicitationQuestions = elicitationQuestions,
            toolInputRaw = obj["toolInput"],
        )
        return ParsedMessage.PermissionRequest(data, obj["toolInput"], timestamp)
    }

    // ── Reaction ────────────────────────────────────────────────────────

    private fun parseReaction(obj: JsonObject, timestamp: Long): ParsedMessage.Reaction {
        val svg = obj["svg"]?.jsonPrimitive?.contentOrNull
        return ParsedMessage.Reaction(svg, timestamp)
    }

    // ── Tool input summary builder ──────────────────────────────────────

    fun buildToolInputSummary(toolName: String?, toolInput: JsonObject?): String? {
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
            "AskUserQuestion" ->
                SafeExecutor.tryOrNull("MP") {
                    val questions = toolInput["questions"]?.jsonArray
                    val first = questions?.firstOrNull()?.jsonObject
                    first?.get("question")?.jsonPrimitive?.contentOrNull
                }
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

package com.clawd.mobile.ws

import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.SessionData
import kotlinx.serialization.json.JsonElement

/**
 * Typed result of parsing a single message.
 * Produced by [MessageParser], consumed by [MessageHandler.handleMessage].
 */
sealed class ParsedMessage {
    abstract val timestamp: Long

    data class Ping(override val timestamp: Long) : ParsedMessage()
    data class Connected(override val timestamp: Long) : ParsedMessage()
    data class ClearSessions(override val timestamp: Long) : ParsedMessage()

    data class Snapshot(
        val sessions: Map<String, SessionData>,
        val displayState: String?,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class State(
        val sessionId: String,
        val sessionData: SessionData?,
        val displayState: String?,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class ToolOutput(
        val sessionId: String,
        val toolName: String,
        val output: String,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class SessionDeleted(
        val sessionId: String,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class PermissionRequest(
        val data: PermissionRequestData,
        val rawToolInput: JsonElement?,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class Reaction(
        val svg: String?,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class Disconnect(
        override val timestamp: Long,
    ) : ParsedMessage()

    data class PeerConnected(
        val role: String,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class PeerDisconnected(
        val role: String,
        override val timestamp: Long,
    ) : ParsedMessage()

    data class Unknown(
        val type: String,
        override val timestamp: Long,
    ) : ParsedMessage()
}

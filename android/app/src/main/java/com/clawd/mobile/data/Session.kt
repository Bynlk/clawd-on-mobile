package com.clawd.mobile.data

import android.content.Context
import androidx.compose.ui.graphics.Color
import com.clawd.mobile.R
import com.clawd.mobile.overlay.PetState
import kotlinx.serialization.Serializable

@Serializable
data class SessionData(
    val sessionId: String? = null,
    val state: String = "idle",
    val event: String? = null,
    val agentId: String? = null,
    val toolName: String? = null,
    val sessionTitle: String? = null,
    val displayTitle: String? = null,
    val cwd: String? = null,
    val updatedAt: Long? = null,
    val recentEvents: List<RecentEvent> = emptyList(),
    val lastOutput: LastOutput? = null,
    val displayState: String? = null,
    /** Original hook state before ONESHOT collapse (e.g. "notification", "error"). Null if server doesn't send it. */
    val hookState: String? = null,
    val isReal: Boolean = true,
    // Mobile view model — all from desktop, zero inference on Android
    val badge: String = "idle",
    val chipText: String? = null,
    val chipColor: String? = null,
    val dotColor: String? = null,
    val isVisible: Boolean = true,
    // Resolved SVG from server (displayHintMap + tier logic).
    // Non-null for working/juggling/thinking when hook sends display_svg.
    val resolvedSvg: String? = null
)

@Serializable
data class LastOutput(
    val toolName: String = "",
    val output: String = "",
    val at: Long = 0
)

@Serializable
data class RecentEvent(
    val at: Long = 0,
    val event: String? = null,
    val state: String? = null
)

data class Session(
    val id: String,
    val data: SessionData
) {
    companion object {
        /** Priority for sorting — higher number = higher priority (via PetState). */
        fun statePriority(state: String): Int = PetState.fromString(state).priority

        /** Map event names to user-visible labels via string resources. */
        fun eventLabel(eventName: String?, context: Context): String = when (eventName) {
            "UserPromptSubmit" -> context.getString(R.string.event_user_prompt)
            "PreToolUse" -> context.getString(R.string.event_pre_tool)
            "PostToolUse" -> context.getString(R.string.event_post_tool)
            "PostToolUseFailure" -> context.getString(R.string.event_post_tool_fail)
            "Stop" -> context.getString(R.string.event_stop)
            "SessionStart" -> context.getString(R.string.event_session_start)
            "SessionEnd" -> context.getString(R.string.event_session_end)
            "PermissionRequest" -> context.getString(R.string.event_permission)
            "Elicitation" -> context.getString(R.string.event_elicitation)
            "Notification" -> context.getString(R.string.event_notification)
            "SubagentStart" -> context.getString(R.string.event_subagent_start)
            "SubagentStop" -> context.getString(R.string.event_subagent_stop)
            else -> eventName ?: ""
        }
    }
}

/** Parse "#RRGGBB" hex color string */
fun parseHexColor(hex: String?): Color? {
    if (hex == null || !hex.startsWith("#") || hex.length != 7) return null
    return try {
        val r = hex.substring(1, 3).toInt(16)
        val g = hex.substring(3, 5).toInt(16)
        val b = hex.substring(5, 7).toInt(16)
        Color(r, g, b)
    } catch (_: NumberFormatException) {
        null
    }
}

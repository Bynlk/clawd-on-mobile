package com.clawd.mobile.data

import kotlinx.serialization.Serializable

@Serializable
data class SessionData(
    val state: String = "idle",
    val event: String? = null,
    val agentId: String? = null,
    val toolName: String? = null,
    val sessionTitle: String? = null,
    val cwd: String? = null,
    val updatedAt: Long? = null,
    val recentEvents: List<RecentEvent> = emptyList(),
    val lastOutput: LastOutput? = null
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
        val STATE_CONFIG = mapOf(
            "error" to StateConfig("error", 0xFFEF4444, 0, "错误"),
            "attention" to StateConfig("attention", 0xFFB45309, 1, "需要关注"),
            "working" to StateConfig("working", 0xFF16803C, 2, "工作中"),
            "juggling" to StateConfig("juggling", 0xFF16803C, 2, "多任务"),
            "thinking" to StateConfig("thinking", 0xFF3B82F6, 3, "思考中"),
            "notification" to StateConfig("notification", 0xFFD97757, 4, "通知"),
            "sweeping" to StateConfig("sweeping", 0xFF71717A, 5, "清理中"),
            "carrying" to StateConfig("carrying", 0xFF71717A, 5, "搬运中"),
            "idle" to StateConfig("idle", 0xFF71717A, 6, "空闲"),
            "sleeping" to StateConfig("sleeping", 0xFFA1A1AA, 7, "休眠"),
        )

        /** Map event names to user-visible Chinese labels */
        fun eventLabel(eventName: String?): String = when (eventName) {
            "UserPromptSubmit" -> "用户输入"
            "PreToolUse" -> "工具启动"
            "PostToolUse" -> "工具完成"
            "PostToolUseFailure" -> "工具失败"
            "Stop" -> "已完成"
            "SessionStart" -> "会话开始"
            "SessionEnd" -> "会话结束"
            "PermissionRequest" -> "需要权限"
            "Notification" -> "通知"
            "SubagentStart" -> "子代理启动"
            "SubagentStop" -> "子代理停止"
            else -> eventName ?: ""
        }
    }

    val stateConfig: StateConfig
        get() = STATE_CONFIG[data.state] ?: STATE_CONFIG["idle"]!!
}

data class StateConfig(
    val iconKey: String,
    val color: Long,
    val priority: Int,
    val label: String
)

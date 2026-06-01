package com.clawd.mobile.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class WsMessage(
    val type: String,
    val timestamp: Long = 0,
    val sessionId: String? = null,
    val sessions: Map<String, SessionData>? = null,
    val data: SessionData? = null,
    val requestId: String? = null,
    val permissionData: PermissionRequestData? = null,
)

@Serializable
data class PermissionRequestData(
    val agentId: String? = null,
    val toolName: String? = null,
    val toolInputSummary: String? = null,
    val sessionId: String? = null,
    val suggestions: List<PermissionSuggestion> = emptyList(),
    val elicitationQuestions: List<ElicitationQuestion> = emptyList(),
    val toolInputRaw: JsonElement? = null,
    val timeout: Long = 60000,
    val requestId: String? = null,
)

@Serializable
data class PermissionSuggestion(
    val label: String,
    val behavior: String,  // "allow" or "deny"
    val rule: String? = null,
    val type: String? = null,
    val mode: String? = null,
)

@Serializable
data class ElicitationQuestion(
    val question: String,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<ElicitationOption> = emptyList(),
)

@Serializable
data class ElicitationOption(
    val label: String,
    val description: String? = null,
)

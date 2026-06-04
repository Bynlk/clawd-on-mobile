package com.clawd.mobile.util

import android.util.Log
import kotlinx.serialization.json.*

/**
 * Shared approval/elicitation response sender.
 * Constructs JSON payloads and sends via [StreamingClient.sendMessage].
 */
object ApprovalSender {

    private const val TAG = "ApprovalSender"

    fun buildPermissionResponseJson(
        requestId: String,
        behavior: String,
        suggestionIndex: Int? = null,
    ): String {
        return buildJsonObject {
            put("type", "permission_response")
            put("id", requestId)
            put("decision", behavior)
            if (suggestionIndex != null) put("suggestionIndex", suggestionIndex)
        }.toString()
    }

    fun buildElicitationResponseJson(
        requestId: String,
        toolInput: JsonElement?,
        answers: Map<String, String>,
    ): String {
        val inputObj = toolInput?.jsonObject ?: buildJsonObject {}
        val answersObj = buildJsonObject {
            for ((k, v) in answers) put(k, v)
        }
        val updatedInput = buildJsonObject {
            for ((k, v) in inputObj) if (k != "answers") put(k, v)
            put("answers", answersObj)
        }
        return buildJsonObject {
            put("type", "elicitation_response")
            put("id", requestId)
            put("decision", "allow")
            put("updatedInput", updatedInput)
        }.toString()
    }
}

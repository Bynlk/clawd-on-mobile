package com.clawd.mobile.util

import android.util.Log
import com.clawd.mobile.data.ConnectionConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Shared approval/elicitation response sender.
 * Used by both [SseClient] and [WsClient] to avoid duplicating
 * the ~54 lines of identical HTTP POST logic.
 */
object ApprovalSender {

    private const val TAG = "ApprovalSender"

    fun sendPermissionResponse(
        scope: CoroutineScope,
        config: ConnectionConfig?,
        requestId: String,
        behavior: String,
        suggestionIndex: Int? = null,
    ) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            SafeExecutor.tryOrLog(TAG) {
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", behavior)
                    if (suggestionIndex != null) put("suggestionIndex", suggestionIndex)
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .addHeader("Authorization", cfg.authHeader())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                val response = HttpClientProvider.getClient(cfg).newCall(request).execute()
                if (!response.isSuccessful) {
                    Log.w(TAG, "sendPermissionResponse failed: HTTP ${response.code}")
                }
                response.close()
            }
        }
    }

    fun sendElicitationResponse(
        scope: CoroutineScope,
        config: ConnectionConfig?,
        requestId: String,
        toolInput: JsonElement?,
        answers: Map<String, String>,
    ) {
        val cfg = config ?: return
        scope.launch(Dispatchers.IO) {
            SafeExecutor.tryOrLog(TAG) {
                val inputObj = toolInput?.jsonObject ?: buildJsonObject {}
                val answersObj = buildJsonObject {
                    for ((k, v) in answers) put(k, v)
                }
                val updatedInput = buildJsonObject {
                    for ((k, v) in inputObj) if (k != "answers") put(k, v)
                    put("answers", answersObj)
                }
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", "allow")
                    put("updatedInput", updatedInput)
                }.toString()
                val request = Request.Builder()
                    .url(cfg.approveUrl())
                    .addHeader("Authorization", cfg.authHeader())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                val response = HttpClientProvider.getClient(cfg).newCall(request).execute()
                if (!response.isSuccessful) {
                    Log.w(TAG, "sendElicitationResponse failed: HTTP ${response.code}")
                }
                response.close()
            }
        }
    }
}

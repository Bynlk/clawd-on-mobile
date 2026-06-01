package com.clawd.mobile.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.util.SafeExecutor
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class ApprovalReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_APPROVE = "com.clawd.mobile.APPROVE"
        const val ACTION_DENY = "com.clawd.mobile.DENY"
        const val ACTION_ELICITATION = "com.clawd.mobile.ELICITATION"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra("request_id") ?: return
        val notificationId = intent.getIntExtra("notification_id", -1)

        val decision = when (intent.action) {
            ACTION_APPROVE -> "allow"
            ACTION_DENY -> "deny"
            ACTION_ELICITATION -> intent.getStringExtra("elicitation_value") ?: return
            else -> return
        }

        // Load saved connection config
        val prefsStore = PrefsStore(context)
        val config = prefsStore.loadConfig() ?: return

        // POST directly to server — no Activity launch, no SSE disruption
        Thread {
            try {
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", decision)
                }.toString()
                val client = OkHttpClient.Builder()
                    .connectTimeout(5, TimeUnit.SECONDS)
                    .writeTimeout(5, TimeUnit.SECONDS)
                    .readTimeout(5, TimeUnit.SECONDS)
                    .build()
                val request = Request.Builder()
                    .url(config.approveUrl())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                client.newCall(request).execute().close()
            } catch (e: Exception) {
                android.util.Log.e("ApprovalReceiver", "Failed to send approval response", e)
            }
        }.start()

        // Dismiss notification
        if (notificationId >= 0) {
            NotificationHelper.cancelNotification(context, notificationId)
        }
    }
}

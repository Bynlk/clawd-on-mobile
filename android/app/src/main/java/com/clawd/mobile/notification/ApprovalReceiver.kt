package com.clawd.mobile.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.util.HttpClientProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ApprovalReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_APPROVE = "com.clawd.mobile.APPROVE"
        const val ACTION_DENY = "com.clawd.mobile.DENY"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra("request_id") ?: return
        val notificationId = intent.getIntExtra("notification_id", -1)

        val decision = when (intent.action) {
            ACTION_APPROVE -> "allow"
            ACTION_DENY -> "deny"
            else -> return
        }

        val pendingResult = goAsync()

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val prefsStore = PrefsStore.getInstance(context)
                val config = prefsStore.loadConfig() ?: return@launch
                val body = buildJsonObject {
                    put("id", requestId)
                    put("decision", decision)
                }.toString()
                val client = HttpClientProvider.getClient(config)
                val request = Request.Builder()
                    .url(config.approveUrl())
                    .addHeader("Authorization", config.authHeader())
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                val response = client.newCall(request).execute()
                if (!response.isSuccessful) {
                    Log.w("ApprovalReceiver", "Approval response: HTTP ${response.code}")
                }
                response.close()
            } catch (e: Exception) {
                Log.e("ApprovalReceiver", "Approval failed", e)
            } finally {
                if (notificationId >= 0) {
                    NotificationHelper.cancelNotification(context, notificationId)
                }
                pendingResult.finish()
            }
        }
    }
}

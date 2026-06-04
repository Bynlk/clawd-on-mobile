package com.clawd.mobile.notification

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.util.HttpClientProvider
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Handles approval/denial responses in the background via WorkManager.
 * Replaces the previous goAsync()+CoroutineScope approach in ApprovalReceiver,
 * eliminating ANR risk and providing automatic retry with exponential backoff.
 */
class ApprovalWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // Cap retries to prevent infinite retry loops (WorkManager default has no limit)
        if (runAttemptCount >= 3) {
            Log.w(TAG, "Max retry count reached ($runAttemptCount), giving up")
            return Result.failure()
        }

        val requestId = inputData.getString("request_id") ?: return Result.failure()
        val decision = inputData.getString("decision") ?: return Result.failure()
        val notificationId = inputData.getInt("notification_id", -1)

        return try {
            val prefsStore = PrefsStore.getInstance(applicationContext)
            val config = prefsStore.loadConfig() ?: return Result.failure()

            // TOFU guard: LAN connections must have a confirmed cert fingerprint
            // before we can safely send approval. Without it, the connection is untrusted
            // (first TOFU not yet confirmed, or fingerprint was cleared by reset()).
            if (config.isLan && prefsStore.getCertFingerprint() == null) {
                Log.w(TAG, "Cannot send approval: LAN connection has no confirmed cert fingerprint (TOFU not completed)")
                return Result.failure()
            }

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
            response.close()

            if (response.isSuccessful) {
                if (notificationId >= 0) {
                    NotificationHelper.cancelNotification(applicationContext, notificationId)
                }
                Result.success()
            } else {
                Log.w(TAG, "Approval failed: HTTP ${response.code}")
                Result.retry()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Approval error", e)
            Result.retry()
        }
    }

    companion object {
        private const val TAG = "ApprovalWorker"
        const val WORK_NAME_PREFIX = "approval_"
    }
}

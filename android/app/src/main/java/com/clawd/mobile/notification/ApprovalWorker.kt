package com.clawd.mobile.notification

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.clawd.mobile.service.SseService
import com.clawd.mobile.util.ApprovalSender

/**
 * Handles approval/denial responses in the background via WorkManager.
 * Sends via WebSocket through [SseService.getClient].
 * Falls back to [Result.retry] if the service is not running.
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

        val client = SseService.getClient()
        if (client == null) {
            Log.w(TAG, "Service not running, will retry")
            return Result.retry()
        }

        return try {
            val json = ApprovalSender.buildPermissionResponseJson(requestId, decision)
            client.sendMessage(json)

            if (notificationId >= 0) {
                NotificationHelper.cancelNotification(applicationContext, notificationId)
            }
            Result.success()
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

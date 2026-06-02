package com.clawd.mobile.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * Receives approval/denial intents from notification action buttons.
 * Delegates the actual network call to [ApprovalWorker] via WorkManager,
 * avoiding ANR risk from goAsync() timeout and unmanaged coroutine scopes.
 */
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

        val inputData = workDataOf(
            "request_id" to requestId,
            "decision" to decision,
            "notification_id" to notificationId,
        )

        val workRequest = OneTimeWorkRequestBuilder<ApprovalWorker>()
            .setInputData(inputData)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                "${ApprovalWorker.WORK_NAME_PREFIX}$requestId",
                ExistingWorkPolicy.KEEP,
                workRequest,
            )
    }
}

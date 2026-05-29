package com.clawd.mobile.notification

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.data.PermissionRequestData

object NotificationHelper {

    const val CHANNEL_STATUS = "clawd_status"
    const val CHANNEL_ALERT = "clawd_alert"

    private var notificationId = 1000

    fun showApprovalNotification(context: Context, request: PermissionRequestData) {
        val id = notificationId++
        val requestId = request.requestId ?: return

        // Allow intent
        val allowIntent = Intent(context, ApprovalReceiver::class.java).apply {
            action = "ACTION_APPROVE"
            putExtra("request_id", requestId)
            putExtra("notification_id", id)
        }
        val allowPending = PendingIntent.getBroadcast(
            context, id, allowIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Deny intent
        val denyIntent = Intent(context, ApprovalReceiver::class.java).apply {
            action = "ACTION_DENY"
            putExtra("request_id", requestId)
            putExtra("notification_id", id)
        }
        val denyPending = PendingIntent.getBroadcast(
            context, id + 10000, denyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Open app intent
        val openIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            context, id, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = "${request.agentId ?: "Agent"} 请求 ${request.toolName ?: "权限"}"
        val body = buildString {
            append(request.toolInputSummary ?: "需要您的确认")
            if (!request.sessionId.isNullOrBlank()) {
                append("\n会话: ${request.sessionId}")
            }
        }

        val notification = NotificationCompat.Builder(context, ClawdApp.CHANNEL_APPROVAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .addAction(android.R.drawable.ic_menu_save, "允许", allowPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "拒绝", denyPending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(id, notification)
    }

    fun showStatusNotification(context: Context, title: String, body: String, priority: Int = NotificationCompat.PRIORITY_DEFAULT) {
        val notification = NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(priority)
            .setAutoCancel(true)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationId++, notification)
    }

    fun cancelNotification(context: Context, id: Int) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(id)
    }
}

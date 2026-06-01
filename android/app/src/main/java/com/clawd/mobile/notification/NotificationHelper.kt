package com.clawd.mobile.notification

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.MainActivity
import com.clawd.mobile.R
import com.clawd.mobile.data.PermissionRequestData
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

object NotificationHelper {

    const val CHANNEL_STATUS = "clawd_status"
    const val CHANNEL_ALERT = "clawd_alert"

    fun showApprovalNotification(context: Context, request: PermissionRequestData, sessionName: String? = null) {
        val requestId = request.requestId ?: return
        val id = requestId.hashCode() and 0x7FFFFFFF  // 确保非负，确定性 ID
        Log.d("NotificationHelper", "showApprovalNotification request_id=$requestId tool=${request.toolName}")

        // Allow intent
        val allowIntent = Intent(context, ApprovalReceiver::class.java).apply {
            action = ApprovalReceiver.ACTION_APPROVE
            putExtra("request_id", requestId)
            putExtra("notification_id", id)
        }
        val allowPending = PendingIntent.getBroadcast(
            context, id, allowIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Deny intent
        val denyIntent = Intent(context, ApprovalReceiver::class.java).apply {
            action = ApprovalReceiver.ACTION_DENY
            putExtra("request_id", requestId)
            putExtra("notification_id", id)
        }
        val denyPending = PendingIntent.getBroadcast(
            context, id + 10000, denyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Open app intent — carry full request data so it survives Activity recreation
        val requestJson = Json.encodeToString(request)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("request_id", requestId)
            putExtra("request_json", requestJson)
        }
        val openPending = PendingIntent.getActivity(
            context, id, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val name = sessionName ?: request.agentId ?: "Agent"
        val title = context.getString(R.string.notify_permission_title, name)
        val body = request.toolInputSummary ?: context.getString(R.string.notify_permission_body)

        val notification = NotificationCompat.Builder(context, ClawdApp.CHANNEL_APPROVAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .addAction(android.R.drawable.ic_menu_save, context.getString(R.string.action_allow), allowPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.action_deny), denyPending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(id, notification)
    }

    fun showElicitationNotification(context: Context, request: PermissionRequestData, sessionName: String? = null) {
        val requestId = request.requestId ?: return
        val id = (requestId.hashCode() and 0x7FFFFFFF) + 1  // 偏移 1 避免与 approval 冲突
        Log.d("NotificationHelper", "showElicitationNotification request_id=$requestId")

        // Open app intent (elicitation requires choosing an option, open the app)
        val requestJson = Json.encodeToString(request)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("request_id", requestId)
            putExtra("request_json", requestJson)
        }
        val openPending = PendingIntent.getActivity(
            context, id, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val name = sessionName ?: request.agentId ?: "Agent"
        val title = context.getString(R.string.notify_elicitation_title, name)
        val body = request.toolInputSummary ?: context.getString(R.string.notify_elicitation_body)

        val notification = NotificationCompat.Builder(context, ClawdApp.CHANNEL_APPROVAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(id, notification)
    }

    fun cancelNotification(context: Context, id: Int) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(id)
    }
}

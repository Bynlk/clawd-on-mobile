package com.clawd.mobile.notification

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.clawd.mobile.MainActivity
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionData
import java.util.concurrent.ConcurrentHashMap

class StatusNotifier(private val context: Context, private val prefsStore: PrefsStore) {

    companion object {
        /** Tracks last notified display state to dedup attention/error alerts */
        @Volatile
        private var lastDisplayState: String? = null
        /** Skip notifications on the very first state snapshot */
        @Volatile
        private var firstLoad = true
    }

    /** Per-session badge tracking for completion notifications */
    private val lastBadge = ConcurrentHashMap<String, String>()

    /** Set by NavGraph to check if there are pending approval requests.
     *  Default to true so alert notifications still fire when NavGraph hasn't composed yet. */
    var hasPendingApprovals: () -> Boolean = { true }

    /** Resolve display name: custom > displayTitle > agentId > sessionId */
    private fun resolveName(sessionId: String, data: SessionData): String {
        return prefsStore.getSessionName(sessionId)
            ?: data.displayTitle
            ?: data.agentId
            ?: sessionId
    }

    /**
     * Unified notification entry point.
     * - Completion: per-session badge tracking (running → done / interrupted)
     * - Attention/error: global displayState dedup
     */
    fun updateNotifications(displayState: String, sessions: Map<String, SessionData>) {
        if (!prefsStore.isNotifyEnabled()) return

        // --- First load: record baselines, skip all notifications ---
        if (firstLoad) {
            firstLoad = false
            lastDisplayState = displayState
            for ((id, data) in sessions) lastBadge[id] = data.badge
            return
        }

        // --- Per-session badge tracking: running → done/interrupted triggers alert ---
        if (prefsStore.isNotifyStatus()) {
            for ((id, data) in sessions) {
                val prev = lastBadge[id]
                if (prev == "running" && data.badge == "done") {
                    val name = resolveName(id, data)
                    Log.d("StatusNotifier", "DONE: session=$id name=$name badge=$prev->${data.badge}")
                    showCompletionNotification(id, name)
                } else if (prev == "running" && data.badge == "interrupted") {
                    val name = resolveName(id, data)
                    Log.d("StatusNotifier", "INTERRUPTED: session=$id name=$name badge=$prev->${data.badge}")
                    showFailureNotification(id, name)
                }
                lastBadge[id] = data.badge
            }
        } else {
            for ((id, data) in sessions) lastBadge[id] = data.badge
        }
        // Clean up removed sessions
        lastBadge.keys.retainAll(sessions.keys)

        // --- Global displayState dedup for attention/error only ---
        if (displayState == lastDisplayState) return
        val prevState = lastDisplayState
        lastDisplayState = displayState

        val name = sessions.entries
            .maxByOrNull { it.value.updatedAt ?: 0L }
            ?.let { resolveName(it.key, it.value) }
            ?: "Clawd"

        Log.d("StatusNotifier", "displayState=$displayState prev=$prevState name=$name")

        val shouldAlert = when (displayState) {
            "attention", "error" -> prefsStore.isNotifyAlert() && hasPendingApprovals()
            "notification" -> prefsStore.isNotifyApproval() && hasPendingApprovals()
            else -> false
        }

        if (shouldAlert) {
            showAlertNotification(displayState, name)
        }
    }

    private fun showCompletionNotification(sessionId: String, name: String) {
        val title = context.getString(R.string.notify_done_title, name)
        val text = context.getString(R.string.notify_done_text)
        Log.d("StatusNotifier", "NOTIFY completion: $title")
        sendNotification("done:$sessionId", title, text)
    }

    private fun showFailureNotification(sessionId: String, name: String) {
        val title = context.getString(R.string.notify_fail_title, name)
        val text = context.getString(R.string.notify_fail_text)
        Log.d("StatusNotifier", "NOTIFY failure: $title")
        sendNotification("fail:$sessionId", title, text)
    }

    private fun showAlertNotification(displayState: String, name: String) {
        val (alertTitle, alertText) = when (displayState) {
            "attention" -> context.getString(R.string.notify_attention_title, name) to context.getString(R.string.notify_attention_text)
            "error" -> context.getString(R.string.notify_error_title, name) to context.getString(R.string.notify_error_text)
            "notification" -> context.getString(R.string.notify_approval_title, name) to context.getString(R.string.notify_approval_text)
            else -> return
        }
        Log.d("StatusNotifier", "NOTIFY alert: $alertTitle | $alertText")
        sendNotification("alert:$displayState", alertTitle, alertText)
    }

    private fun sendNotification(tag: String, title: String, text: String) {
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            context, tag.hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, NotificationHelper.CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(tag.hashCode(), notification)
    }

    fun clearSession(sessionId: String) {
        lastBadge.remove(sessionId)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel("done:$sessionId".hashCode())
        manager.cancel("fail:$sessionId".hashCode())
    }
}

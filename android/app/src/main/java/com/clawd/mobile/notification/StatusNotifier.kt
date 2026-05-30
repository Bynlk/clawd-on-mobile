package com.clawd.mobile.notification

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.clawd.mobile.MainActivity
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionData

class StatusNotifier(private val context: Context, private val prefsStore: PrefsStore) {

    companion object {
        private val notifiedStates = mutableMapOf<String, String>()
    }

    /** Set by NavGraph to check if there are pending approval requests */
    var hasPendingApprovals: () -> Boolean = { false }

    /** Resolve display name: custom > sessionTitle > agentId > sessionId */
    private fun resolveName(sessionId: String, data: SessionData): String {
        return prefsStore.getSessionName(sessionId)
            ?: data.sessionTitle
            ?: data.agentId
            ?: sessionId
    }

    /** Find a session whose state matches displayState for name resolution */
    private fun resolveSessionForDisplay(displayState: String, sessions: Map<String, SessionData>): Pair<String, SessionData>? {
        return sessions.entries
            .firstOrNull { it.value.state == displayState }
            ?.let { it.key to it.value }
    }

    fun onDisplayStateChanged(displayState: String, sessions: Map<String, SessionData>) {
        val prevState = notifiedStates["__display__"]
        if (prevState == displayState) return

        val hasApprovals = hasPendingApprovals()
        val shouldAlert = when (displayState) {
            "idle", "sweeping" -> true
            "attention", "error" -> hasApprovals
            else -> false
        }

        val session = resolveSessionForDisplay(displayState, sessions)
        val name = session?.let { resolveName(it.first, it.second) } ?: "Clawd"

        Log.d("StatusNotifier", "displayState=$displayState prev=$prevState shouldAlert=$shouldAlert hasApprovals=$hasApprovals name=$name")

        if (shouldAlert && notifiedStates["__display__"] != displayState) {
            notifiedStates["__display__"] = displayState
            showAlertNotification(displayState, name)
        }
    }

    private fun showAlertNotification(displayState: String, name: String) {
        val (alertTitle, alertText) = when (displayState) {
            "idle", "sweeping" -> "$name 搞定啦" to "快来看看成果！"
            "attention" -> "$name 遇到麻烦了" to "来看看？"
            "error" -> "$name 出错了" to "需要你关注一下"
            else -> return
        }
        Log.d("StatusNotifier", "NOTIFY: $alertTitle | $alertText")

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            context, "alert:$displayState".hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, NotificationHelper.CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(alertTitle)
            .setContentText(alertText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify("alert:$displayState".hashCode(), notification)
    }

    fun clearSession(sessionId: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel("alert:$sessionId".hashCode())
    }
}

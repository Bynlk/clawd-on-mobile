package com.clawd.mobile.notification

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionData

class StatusNotifier(private val context: Context, private val prefsStore: PrefsStore) {

    private val sessionStates = mutableMapOf<String, String>()

    /** Resolve display name: custom > sessionTitle > agentId > sessionId */
    private fun resolveName(sessionId: String, data: SessionData): String {
        return prefsStore.getSessionName(sessionId)
            ?: data.sessionTitle
            ?: data.agentId
            ?: sessionId
    }

    fun onSessionUpdate(sessionId: String, data: SessionData) {
        val prevState = sessionStates[sessionId]
        val newState = data.state
        sessionStates[sessionId] = newState

        if (prevState == newState) return

        val shouldAlert = when {
            newState == "idle" && (prevState == "working" || prevState == "thinking") -> true
            newState == "attention" || newState == "error" -> true
            else -> false
        }

        if (shouldAlert) {
            showAlertNotification(sessionId, data)
        }
    }

    private fun showAlertNotification(sessionId: String, data: SessionData) {
        val name = resolveName(sessionId, data)
        val state = sessionStates[sessionId] ?: return
        val (alertTitle, alertText) = when (state) {
            "idle" -> "🎉 $name 搞定啦" to "快来看看成果！"
            "attention" -> "⚠️ $name 遇到麻烦了" to "来看看？"
            "error" -> "⚠️ $name 出错了" to "需要你关注一下"
            else -> return
        }

        val notification = NotificationCompat.Builder(context, NotificationHelper.CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(alertTitle)
            .setContentText(alertText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify("alert:$sessionId".hashCode(), notification)
    }

    fun clearSession(sessionId: String) {
        sessionStates.remove(sessionId)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel("alert:$sessionId".hashCode())
    }
}

package com.clawd.mobile.notification

import android.app.NotificationManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.data.SessionData

class StatusNotifier(private val context: Context) {

    companion object {
        private val ANIMATING_STATES = setOf(
            "working", "thinking", "juggling", "attention", "error", "notification"
        )
        private const val ANIM_TICK_MS = 800L
    }

    private val sessionStates = mutableMapOf<String, String>()
    private val sessionTitles = mutableMapOf<String, String>()
    private var animToggle = false

    private val handler = Handler(Looper.getMainLooper())
    private val animRunnable = object : Runnable {
        override fun run() {
            animToggle = !animToggle
            refreshAnimatingNotifications()
            handler.postDelayed(this, ANIM_TICK_MS)
        }
    }

    fun onSessionUpdate(sessionId: String, data: SessionData) {
        val prevState = sessionStates[sessionId]
        val newState = data.state
        sessionStates[sessionId] = newState
        sessionTitles[sessionId] = data.sessionTitle ?: data.agentId ?: sessionId

        if (prevState == newState) return

        // Determine if this transition should fire an alert
        val shouldAlert = when {
            // Task completed: was working/thinking, now idle
            newState == "idle" && (prevState == "working" || prevState == "thinking") -> true
            // Attention or error always alerts
            newState == "attention" || newState == "error" -> true
            else -> false
        }

        if (shouldAlert) {
            showAlertNotification(sessionId)
        }

        updateStatusNotification(sessionId)
        updateAnimationTimer()
    }

    private fun showAlertNotification(sessionId: String) {
        val title = sessionTitles[sessionId] ?: sessionId
        val state = sessionStates[sessionId] ?: return
        val alertTitle = when (state) {
            "idle" -> "任务完成"
            "attention" -> "需要关注"
            "error" -> "出现错误"
            else -> return
        }

        val notification = NotificationCompat.Builder(context, NotificationHelper.CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(alertTitle)
            .setContentText(title)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify("alert:$sessionId".hashCode(), notification)
    }

    private fun updateStatusNotification(sessionId: String) {
        val state = sessionStates[sessionId] ?: return
        val title = sessionTitles[sessionId] ?: sessionId
        val color = NotificationIcons.colorForState(state)
        val isAnimating = state in ANIMATING_STATES
        val icon = if (isAnimating && animToggle) {
            NotificationIcons.coloredCircleDim(color)
        } else {
            NotificationIcons.coloredCircle(color)
        }

        val builder = NotificationCompat.Builder(context, NotificationHelper.CHANNEL_STATUS)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(state)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setShowBadge(false)
            .setCategory(NotificationCompat.CATEGORY_STATUS)

        val notification = builder.build()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(sessionId.hashCode(), notification)
    }

    private fun refreshAnimatingNotifications() {
        for ((sessionId, state) in sessionStates) {
            if (state in ANIMATING_STATES) {
                updateStatusNotification(sessionId)
            }
        }
    }

    private fun updateAnimationTimer() {
        val anyAnimating = sessionStates.values.any { it in ANIMATING_STATES }
        handler.removeCallbacks(animRunnable)
        if (anyAnimating) {
            handler.postDelayed(animRunnable, ANIM_TICK_MS)
        }
    }

    fun clearSession(sessionId: String) {
        sessionStates.remove(sessionId)
        sessionTitles.remove(sessionId)

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(sessionId.hashCode())
        manager.cancel("alert:$sessionId".hashCode())

        updateAnimationTimer()
    }
}

package com.clawd.mobile.ui.sessions

import android.content.Context
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionData

internal fun shortPath(p: String): String {
    val parts = p.split("/", "\\")
    return if (parts.size > 3) ".../${parts.takeLast(2).joinToString("/")}" else p
}

internal fun resolveSessionName(
    sessionId: String?,
    sessionsMap: Map<String, SessionData>,
    prefsStore: PrefsStore
): String? {
    if (sessionId == null) return null
    prefsStore.getSessionName(sessionId)?.let { return it }
    sessionsMap[sessionId]?.let { data ->
        data.displayTitle?.let { return it }
        data.agentId?.let { return it }
    }
    return sessionId
}

internal fun formatAgo(ts: Long?, context: Context): String {
    if (ts == null) return ""
    val sec = (System.currentTimeMillis() - ts) / 1000
    return when {
        sec < 5 -> context.getString(R.string.time_just_now)
        sec < 60 -> context.getString(R.string.time_seconds, sec)
        sec < 3600 -> context.getString(R.string.time_minutes, sec / 60)
        else -> context.getString(R.string.time_hours, sec / 3600)
    }
}

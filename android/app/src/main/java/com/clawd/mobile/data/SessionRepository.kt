package com.clawd.mobile.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/**
 * Unified access point for session-related data.
 * Encapsulates session list from SSE stream and session name persistence.
 */
class SessionRepository(
    private val sessionsFlow: StateFlow<Map<String, SessionData>>,
    private val prefsStore: PrefsStore,
) {
    private val scope = CoroutineScope(Dispatchers.Default)

    /** Currently visible sessions as a list. */
    val visibleSessions: StateFlow<List<SessionData>> = sessionsFlow
        .map { map -> map.values.filter { it.isVisible } }
        .stateIn(scope, SharingStarted.Eagerly, emptyList())

    /** Count of currently visible sessions. */
    val sessionCount: StateFlow<Int> = visibleSessions
        .map { it.size }
        .stateIn(scope, SharingStarted.Eagerly, 0)

    /** Get session display name (user-customized > server-provided > null). */
    fun getSessionName(sessionId: String): String? {
        prefsStore.getSessionName(sessionId)?.let { return it }
        val data = sessionsFlow.value[sessionId]
        return data?.displayTitle ?: data?.agentId
    }

    /** Save user-customized session name. */
    fun saveSessionName(sessionId: String, name: String) {
        prefsStore.saveSessionName(sessionId, name)
    }

    /** Clear user-customized session name. */
    fun clearSessionName(sessionId: String) {
        prefsStore.clearSessionName(sessionId)
    }
}

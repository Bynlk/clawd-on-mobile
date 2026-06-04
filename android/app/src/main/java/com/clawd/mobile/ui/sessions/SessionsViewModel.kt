package com.clawd.mobile.ui.sessions

import androidx.lifecycle.ViewModel
import com.clawd.mobile.data.Session
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.StreamingClient
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map

/**
 * Derived UI state for the SessionsScreen.
 *
 * Wraps [StreamingClient] flows and computes session list, connection status,
 * and other derived properties that were previously inlined in the Composable.
 *
 * Note: Not yet @HiltViewModel because [StreamingClient] is created at runtime
 * by SseService. Once DI is fully migrated, this can use @Inject constructor.
 */
class SessionsViewModel(
    private val sseClient: StreamingClient,
) : ViewModel() {

    /** Raw connection state from the streaming client. */
    val connectionState: StateFlow<ConnectionState> = sseClient.connectionState

    /** Raw sessions map from the streaming client. */
    val sessionsMap: StateFlow<Map<String, SessionData>> = sseClient.sessions

    /** Syncing indicator from the streaming client. */
    val syncing: StateFlow<Boolean> = sseClient.syncing

    /** Derived: sorted, filtered session list for display. */
    val sessions: List<Session>
        get() {
            val map = sseClient.sessions.value
            return map.map { (id, data) -> Session(id, data) }
                .filter { it.data.isVisible }
                .sortedWith(
                    compareByDescending<Session> { Session.statePriority(it.data.state) }
                        .thenByDescending { it.data.updatedAt ?: 0L }
                )
        }

    /** Derived: whether the client is connected. */
    val isConnected: Boolean
        get() = sseClient.connectionState.value == ConnectionState.CONNECTED

    /** Current host the client is connected to. */
    val currentHost: String? get() = sseClient.currentHost

    /** Current port the client is connected to. */
    val currentPort: Int? get() = sseClient.currentPort

    /** Trigger a manual reconnect. */
    fun reconnect() = sseClient.reconnect()
}

package com.clawd.mobile.ui.sessions

import androidx.lifecycle.ViewModel
import com.clawd.mobile.data.Session
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.SessionMerger
import com.clawd.mobile.ws.StreamingClient
import com.clawd.mobile.ws.TaggedSession
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map

/**
 * Derived UI state for the SessionsScreen.
 *
 * Wraps [StreamingClient] flows and computes session list, connection status,
 * and other derived properties that were previously inlined in the Composable.
 *
 * When [sessionMerger] is provided (dual LAN+Relay mode), uses merged sessions
 * that include both LAN and Relay sources. Otherwise falls back to LAN-only sessions.
 *
 * Note: Not yet @HiltViewModel because [StreamingClient] is created at runtime
 * by WsConnectionService. Once DI is fully migrated, this can use @Inject constructor.
 */
class SessionsViewModel(
    private val streamingClient: StreamingClient,
    private val sessionMerger: SessionMerger? = null,
) : ViewModel() {

    /** Raw connection state from the streaming client. */
    val connectionState: StateFlow<ConnectionState> = streamingClient.connectionState

    /** Raw sessions map — merged if sessionMerger available, otherwise LAN-only. */
    val sessionsMap: StateFlow<Map<String, SessionData>> = streamingClient.sessions

    /** Merged sessions with source tags (LAN/Relay). Only available in dual-connection mode. */
    val mergedSessionsMap: StateFlow<Map<String, List<TaggedSession>>>? =
        sessionMerger?.mergedSessions

    /** Syncing indicator from the streaming client. */
    val syncing: StateFlow<Boolean> = streamingClient.syncing

    /** Derived: sorted, filtered session list for display (LAN-only, backward compatible). */
    val sessions: List<Session>
        get() {
            val map = streamingClient.sessions.value
            return map.map { (id, data) -> Session(id, data) }
                .filter { it.data.isVisible }
                .sortedWith(
                    compareByDescending<Session> { Session.statePriority(it.data.state) }
                        .thenByDescending { it.data.updatedAt ?: 0L }
                )
        }

    /**
     * Derived: sorted, filtered tagged session list for dual-connection mode.
     * Each session includes its source tag (LAN / RELAY).
     * Falls back to LAN-only sessions if sessionMerger is not available.
     */
    val taggedSessions: List<Pair<Session, String>>
        get() {
            val merged = sessionMerger?.mergedSessions?.value
            if (merged != null) {
                return merged.flatMap { (id, taggedList) ->
                    taggedList.filter { it.session.isVisible }.map { tagged ->
                        Session(id, tagged.session) to tagged.tag.name
                    }
                }.sortedWith(
                    compareByDescending<Pair<Session, String>> { Session.statePriority(it.first.data.state) }
                        .thenByDescending { it.first.data.updatedAt ?: 0L }
                )
            }
            // Fallback: LAN-only
            return sessions.map { it to "LAN" }
        }

    /** Derived: whether the client is connected. */
    val isConnected: Boolean
        get() = streamingClient.connectionState.value == ConnectionState.CONNECTED

    /** Current host the client is connected to. */
    val currentHost: String? get() = streamingClient.currentHost

    /** Current port the client is connected to. */
    val currentPort: Int? get() = streamingClient.currentPort

    /** Trigger a manual reconnect. */
    fun reconnect() = streamingClient.reconnect()
}

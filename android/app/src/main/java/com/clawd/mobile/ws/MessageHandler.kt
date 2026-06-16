package com.clawd.mobile.ws

import android.util.Log
import com.clawd.mobile.data.LastOutput
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.util.SafeExecutor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Shared message handling logic for [StreamingClient] transport implementations.
 *
 * Extracted to eliminate ~70 lines of duplicated code between the two transport implementations.
 * The handler operates on shared state passed via constructor, keeping both clients' state
 * management identical.
 */
class MessageHandler(
    private val tag: String,
    private val sessionsMap: ConcurrentHashMap<String, SessionData>,
    private val emitSessions: () -> Unit,
    private val displayState: MutableStateFlow<String>,
    private val syncing: MutableStateFlow<Boolean>,
    private val permissionRequests: MutableSharedFlow<PermissionRequestData>,
    private val reactions: MutableSharedFlow<String>,
    private val scope: CoroutineScope,
    private val messageParser: MessageParser,
    private val sendPong: (String) -> Unit,
) {
    /**
     * Parse and dispatch a raw message string.
     * @return true if the message was handled, false if ignored (ping, unknown, cert pending).
     */
    fun handleMessage(rawText: String, isPendingCert: Boolean): Boolean {
        if (isPendingCert) return false
        val parsed = messageParser.parse(rawText) ?: return false
        Log.d(tag, "message type=${parsed::class.simpleName}")

        when (parsed) {
            is ParsedMessage.Ping -> {
                // Respond to server heartbeat so it knows we're alive.
                // Without this, the server terminates us after ~60s of silence.
                sendPong("""{"type":"pong","timestamp":${parsed.timestamp}}""")
                return false
            }
            is ParsedMessage.Connected -> { /* handshake confirmed */ }
            is ParsedMessage.ClearSessions -> {
                Log.d(tag, "clear_sessions → syncing=true, sessions cleared")
                sessionsMap.clear()
                emitSessions()
                syncing.value = true
            }

            is ParsedMessage.Snapshot -> {
                parsed.displayState?.let { displayState.value = it }
                Log.d(tag, "snapshot (${parsed.sessions.size} sessions, displayState=${displayState.value}) → syncing=false")
                syncing.value = false
                sessionsMap.clear()
                sessionsMap.putAll(parsed.sessions)
                emitSessions()
            }

            is ParsedMessage.State -> {
                val data = parsed.sessionData ?: return false
                parsed.displayState?.let { displayState.value = it }
                if (data.isVisible) sessionsMap[parsed.sessionId] = data
                else sessionsMap.remove(parsed.sessionId)
                emitSessions()
                Log.d(tag, "state sid=${parsed.sessionId} state=${data.state} displayState=${data.displayState} globalDisplayState=${displayState.value} badge=${data.badge} chip=${data.chipText}/${data.chipColor} dot=${data.dotColor} visible=${data.isVisible}")
            }

            is ParsedMessage.ToolOutput -> {
                val existing = sessionsMap[parsed.sessionId] ?: return false
                sessionsMap[parsed.sessionId] = existing.copy(
                    lastOutput = LastOutput(
                        toolName = parsed.toolName,
                        output = parsed.output,
                        at = parsed.timestamp,
                    )
                )
                emitSessions()
            }

            is ParsedMessage.SessionDeleted -> {
                sessionsMap.remove(parsed.sessionId)
                emitSessions()
            }

            is ParsedMessage.PermissionRequest -> {
                scope.launch {
                    SafeExecutor.tryOrReport(tag) {
                        Log.d(tag, "permission_request id=${parsed.data.requestId}")
                        permissionRequests.emit(parsed.data)
                    }
                }
            }

            is ParsedMessage.Reaction -> {
                val svg = parsed.svg
                if (svg != null) {
                    Log.d(tag, "reaction svg=$svg")
                    scope.launch { reactions.emit(svg) }
                }
            }

            is ParsedMessage.Disconnect -> {
                Log.w(tag, "Server sent disconnect — triggering reconnect")
                // Let the transport layer handle reconnection via onTransportClosed/onTransportFailure
                return false
            }

            is ParsedMessage.Unknown -> { /* ignore unknown types */ }
        }
        return true
    }
}

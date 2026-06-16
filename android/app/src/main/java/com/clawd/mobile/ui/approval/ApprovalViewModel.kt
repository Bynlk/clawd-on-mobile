package com.clawd.mobile.ui.approval

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import com.clawd.mobile.ui.sessions.resolveSessionName
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.ws.StreamingClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class ApprovalViewModel(
    application: Application,
    private val streamingClient: StreamingClient
) : AndroidViewModel(application) {

    class Factory(
        private val application: Application,
        private val streamingClient: StreamingClient
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T {
            return ApprovalViewModel(application, streamingClient) as T
        }
    }

    private val prefsStore = PrefsStore.getInstance(application)

    private val _pendingRequests = MutableStateFlow<List<PermissionRequestData>>(emptyList())
    val pendingRequests: StateFlow<List<PermissionRequestData>> = _pendingRequests

    // Tracks remaining seconds for each request (keyed by requestId)
    private val _countdowns = MutableStateFlow<Map<String, Int>>(emptyMap())
    val countdowns: StateFlow<Map<String, Int>> = _countdowns

    // Set when user taps a notification; consumed by UI to auto-show the sheet
    private val _notificationRequestId = MutableStateFlow<String?>(null)
    val notificationRequestId: StateFlow<String?> = _notificationRequestId

    // One-shot error events for UI (Snackbar)
    private val _errorEvents = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val errorEvents: SharedFlow<String> = _errorEvents

    fun setNotificationRequestId(requestId: String) {
        Log.d("ApprovalViewModel", "setNotificationRequestId=$requestId pending=${_pendingRequests.value.size} dismissed=${recentlyDismissed.containsKey(requestId)}")
        // Restore dismissed request if user taps notification after it was auto-shown
        recentlyDismissed.remove(requestId)?.let { dismissed ->
            if (_pendingRequests.value.none { it.requestId == requestId }) {
                Log.d("ApprovalViewModel", "Restoring dismissed request $requestId")
                activeRequestIds.add(requestId)
                _pendingRequests.update { it + dismissed }
                startCountdown(dismissed)
            }
        }
        _notificationRequestId.value = requestId
    }

    /** Restore a full request from notification intent extras (survives Activity recreation) */
    fun restoreRequestFromNotification(request: PermissionRequestData) {
        val requestId = request.requestId ?: return
        Log.d("ApprovalViewModel", "restoreRequestFromNotification id=$requestId pending=${_pendingRequests.value.size}")
        if (_pendingRequests.value.none { it.requestId == requestId }) {
            Log.d("ApprovalViewModel", "Adding request from notification $requestId")
            activeRequestIds.add(requestId)
            _pendingRequests.update { it + request }
            startCountdown(request)
        }
        _notificationRequestId.value = requestId
    }

    fun consumeNotificationRequestId() {
        _notificationRequestId.value = null
    }

    // Save recently dismissed requests so notification tap can restore them
    private companion object {
        const val MAX_DISMISSED = 20
    }
    private val recentlyDismissed = ConcurrentHashMap<String, PermissionRequestData>()

    private val activeRequestIds = ConcurrentHashMap.newKeySet<String>()
    private val respondedRequestIds = ConcurrentHashMap.newKeySet<String>()
    private val countdownJobs = ConcurrentHashMap<String, Job>()

    init {
        viewModelScope.launch {
            streamingClient.permissionRequests.collect { request ->
                handleNewRequest(request)
            }
        }
    }

    private fun resolveSessionName(sessionId: String?): String? =
        resolveSessionName(sessionId, streamingClient.sessions.value, prefsStore)

    private fun handleNewRequest(request: PermissionRequestData) {
        val requestId = request.requestId ?: return
        Log.d("ApprovalViewModel", "handleNewRequest id=$requestId tool=${request.toolName} currentPending=${_pendingRequests.value.size}")
        // Atomic dedup: WebSocket reconnect may re-deliver the same request
        if (!activeRequestIds.add(requestId)) {
            Log.d("ApprovalViewModel", "Duplicate request ignored: $requestId")
            return
        }
        _pendingRequests.update { it + request }

        val context = getApplication<Application>()
        val sessionName = resolveSessionName(request.sessionId)

        if (request.toolName == "AskUserQuestion") {
            NotificationHelper.showElicitationNotification(context, request, sessionName)
        } else {
            NotificationHelper.showApprovalNotification(context, request, sessionName)
        }

        // Start timeout countdown
        startCountdown(request)
    }

    private fun startCountdown(request: PermissionRequestData) {
        val requestId = request.requestId ?: return
        val timeoutMs = request.timeout.coerceIn(10_000, 300_000) // 10s to 5min
        val deadline = System.currentTimeMillis() + timeoutMs

        // Single job: countdown ticker + auto-dismiss combined
        countdownJobs[requestId]?.cancel()
        val job = viewModelScope.launch {
            while (true) {
                val remainingMs = deadline - System.currentTimeMillis()
                if (remainingMs <= 0) break
                val remainingSec = (remainingMs / 1000).toInt()
                _countdowns.update { it + (requestId to remainingSec) }
                // Sleep until next second boundary (drift-free)
                val nextTickMs = remainingMs % 1000
                delay(if (nextTickMs > 0) nextTickMs else 1000)
            }
            _countdowns.update { it - requestId }
            removeRequest(requestId, saveForRestore = true)
        }
        countdownJobs[requestId] = job
    }

    private fun removeRequest(requestId: String, saveForRestore: Boolean = false) {
        val request = _pendingRequests.value.find { it.requestId == requestId }
        if (saveForRestore && request != null) {
            recentlyDismissed[requestId] = request
            // Evict oldest entries if over limit
            while (recentlyDismissed.size > MAX_DISMISSED) {
                recentlyDismissed.keys.firstOrNull()?.let { recentlyDismissed.remove(it) }
            }
        }
        _pendingRequests.update { it.filter { it.requestId != requestId } }
        _countdowns.update { it - requestId }
        activeRequestIds.remove(requestId)
        respondedRequestIds.add(requestId)
        countdownJobs.remove(requestId)?.cancel()
        // Cancel the system notification so it doesn't linger in the tray
        runCatching {
            val nid = requestId.hashCode() and 0x7FFFFFFF
            NotificationHelper.cancelNotification(getApplication(), nid)         // approval
            NotificationHelper.cancelNotification(getApplication(), nid + 1)    // elicitation
        }
    }

    fun approve(requestId: String) {
        if (!ensureConnected()) return
        if (!respondedRequestIds.add(requestId)) return
        viewModelScope.launch {
            val ok = runCatching { streamingClient.sendPermissionResponse(requestId, "allow") }.getOrDefault(false)
            if (ok) {
                removeRequest(requestId, saveForRestore = false)
            } else {
                respondedRequestIds.remove(requestId)
                _errorEvents.tryEmit(getApplication<Application>().getString(
                    com.clawd.mobile.R.string.error_send_failed
                ))
            }
        }
    }

    fun deny(requestId: String) {
        if (!ensureConnected()) return
        if (!respondedRequestIds.add(requestId)) return
        viewModelScope.launch {
            val ok = runCatching { streamingClient.sendPermissionResponse(requestId, "deny") }.getOrDefault(false)
            if (ok) {
                removeRequest(requestId, saveForRestore = false)
            } else {
                respondedRequestIds.remove(requestId)
                _errorEvents.tryEmit(getApplication<Application>().getString(
                    com.clawd.mobile.R.string.error_send_failed
                ))
            }
        }
    }

    fun approveWithSuggestion(requestId: String, suggestionIndex: Int) {
        if (!ensureConnected()) return
        if (!respondedRequestIds.add(requestId)) return
        viewModelScope.launch {
            val ok = runCatching { streamingClient.sendPermissionResponse(requestId, "allow", suggestionIndex) }.getOrDefault(false)
            if (ok) {
                removeRequest(requestId, saveForRestore = false)
            } else {
                respondedRequestIds.remove(requestId)
                _errorEvents.tryEmit(getApplication<Application>().getString(
                    com.clawd.mobile.R.string.error_send_failed
                ))
            }
        }
    }

    fun submitElicitation(requestId: String, answers: Map<String, String>) {
        if (!ensureConnected()) return
        if (!respondedRequestIds.add(requestId)) return
        viewModelScope.launch {
            val request = _pendingRequests.value.find { it.requestId == requestId }
            val ok = runCatching { streamingClient.sendElicitationResponse(requestId, request?.toolInputRaw, answers) }.getOrDefault(false)
            if (ok) {
                removeRequest(requestId, saveForRestore = false)
            } else {
                respondedRequestIds.remove(requestId)
                _errorEvents.tryEmit(getApplication<Application>().getString(
                    com.clawd.mobile.R.string.error_send_failed
                ))
            }
        }
    }

    /** Returns true if connected; emits error event and returns false otherwise. */
    private fun ensureConnected(): Boolean {
        if (!streamingClient.connectionState.value.isConnected) {
            _errorEvents.tryEmit(getApplication<Application>().getString(
                com.clawd.mobile.R.string.error_not_connected
            ))
            return false
        }
        return true
    }

    fun dismissRequest(requestId: String) {
        removeRequest(requestId, saveForRestore = true)
    }

    override fun onCleared() {
        super.onCleared()
        countdownJobs.values.forEach { it.cancel() }
    }
}

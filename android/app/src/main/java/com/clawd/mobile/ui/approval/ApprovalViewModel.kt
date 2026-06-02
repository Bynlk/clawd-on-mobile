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
import com.clawd.mobile.ws.SseClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class ApprovalViewModel(
    application: Application,
    private val sseClient: SseClient
) : AndroidViewModel(application) {

    class Factory(
        private val application: Application,
        private val sseClient: SseClient
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T {
            return ApprovalViewModel(application, sseClient) as T
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

    fun setNotificationRequestId(requestId: String) {
        Log.d("ApprovalViewModel", "setNotificationRequestId=$requestId pending=${_pendingRequests.value.size} dismissed=${recentlyDismissed.containsKey(requestId)}")
        // Restore dismissed request if user taps notification after it was auto-shown
        recentlyDismissed.remove(requestId)?.let { dismissed ->
            if (_pendingRequests.value.none { it.requestId == requestId }) {
                Log.d("ApprovalViewModel", "Restoring dismissed request $requestId")
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

    private val timeoutJobs = ConcurrentHashMap<String, Job>()
    private val countdownJobs = ConcurrentHashMap<String, Job>()

    init {
        viewModelScope.launch {
            sseClient.permissionRequests.collect { request ->
                handleNewRequest(request)
            }
        }
    }

    private fun resolveSessionName(sessionId: String?): String? =
        resolveSessionName(sessionId, sseClient.sessions.value, prefsStore)

    private fun handleNewRequest(request: PermissionRequestData) {
        Log.d("ApprovalViewModel", "handleNewRequest id=${request.requestId} tool=${request.toolName} currentPending=${_pendingRequests.value.size}")
        // Deduplicate: SSE reconnect may re-deliver the same request
        val requestId = request.requestId
        if (requestId != null && _pendingRequests.value.any { it.requestId == requestId }) {
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
        val timeoutSec = (timeoutMs / 1000).toInt()

        // Countdown ticker
        countdownJobs[requestId]?.cancel()
        countdownJobs[requestId] = viewModelScope.launch {
            for (sec in timeoutSec downTo 0) {
                _countdowns.update { it + (requestId to sec) }
                delay(1000)
            }
            _countdowns.update { it - requestId }
        }

        // Auto-dismiss on timeout (saveForRestore=true so notification tap can restore)
        timeoutJobs[requestId]?.cancel()
        timeoutJobs[requestId] = viewModelScope.launch {
            delay(timeoutMs)
            removeRequest(requestId, saveForRestore = true)
        }
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
        timeoutJobs.remove(requestId)?.cancel()
        countdownJobs.remove(requestId)?.cancel()
    }

    fun approve(requestId: String) {
        sseClient.sendPermissionResponse(requestId, "allow")
        removeRequest(requestId, saveForRestore = false)
    }

    fun deny(requestId: String) {
        sseClient.sendPermissionResponse(requestId, "deny")
        removeRequest(requestId, saveForRestore = false)
    }

    fun approveWithSuggestion(requestId: String, suggestionIndex: Int) {
        sseClient.sendPermissionResponse(requestId, "allow", suggestionIndex)
        removeRequest(requestId, saveForRestore = false)
    }

    fun submitElicitation(requestId: String, answers: Map<String, String>) {
        val request = _pendingRequests.value.find { it.requestId == requestId }
        sseClient.sendElicitationResponse(requestId, request?.toolInputRaw, answers)
        removeRequest(requestId, saveForRestore = false)
    }

    fun dismissRequest(requestId: String) {
        removeRequest(requestId, saveForRestore = true)
    }

    override fun onCleared() {
        super.onCleared()
        timeoutJobs.values.forEach { it.cancel() }
        countdownJobs.values.forEach { it.cancel() }
    }
}

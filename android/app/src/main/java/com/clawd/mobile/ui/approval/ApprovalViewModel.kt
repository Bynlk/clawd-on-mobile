package com.clawd.mobile.ui.approval

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.ws.ClawdWebSocket
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class ApprovalViewModel(
    application: Application,
    private val webSocket: ClawdWebSocket
) : AndroidViewModel(application) {

    class Factory(
        private val application: Application,
        private val webSocket: ClawdWebSocket
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T {
            return ApprovalViewModel(application, webSocket) as T
        }
    }

    private val prefsStore = PrefsStore(application)

    private val _pendingRequests = MutableStateFlow<List<PermissionRequestData>>(emptyList())
    val pendingRequests: StateFlow<List<PermissionRequestData>> = _pendingRequests

    // Tracks remaining seconds for each request (keyed by requestId)
    private val _countdowns = MutableStateFlow<Map<String, Int>>(emptyMap())
    val countdowns: StateFlow<Map<String, Int>> = _countdowns

    // Set when user taps a notification; consumed by UI to auto-show the sheet
    private val _notificationRequestId = MutableStateFlow<String?>(null)
    val notificationRequestId: StateFlow<String?> = _notificationRequestId

    fun setNotificationRequestId(requestId: String) {
        _notificationRequestId.value = requestId
    }

    fun consumeNotificationRequestId() {
        _notificationRequestId.value = null
    }

    private val timeoutJobs = mutableMapOf<String, Job>()
    private val countdownJobs = mutableMapOf<String, Job>()

    init {
        viewModelScope.launch {
            webSocket.permissionRequests.collect { request ->
                handleNewRequest(request)
            }
        }
    }

    private fun resolveSessionName(sessionId: String?): String? {
        if (sessionId == null) return null
        prefsStore.getSessionName(sessionId)?.let { return it }
        webSocket.sessions.value[sessionId]?.let { data ->
            data.sessionTitle?.let { return it }
            data.agentId?.let { return it }
        }
        return sessionId
    }

    private fun handleNewRequest(request: PermissionRequestData) {
        _pendingRequests.value = _pendingRequests.value + request

        val context = getApplication<Application>()
        val sessionName = resolveSessionName(request.sessionId)

        if (request.toolName == "elicitation") {
            NotificationHelper.showElicitationNotification(context, request, sessionName)
        } else {
            NotificationHelper.showApprovalNotification(context, request, sessionName)
        }

        // Start timeout countdown
        val requestId = request.requestId ?: return
        val timeoutMs = request.timeout.coerceIn(10_000, 300_000) // 10s to 5min
        val timeoutSec = (timeoutMs / 1000).toInt()

        // Countdown ticker
        countdownJobs[requestId]?.cancel()
        countdownJobs[requestId] = viewModelScope.launch {
            for (sec in timeoutSec downTo 0) {
                _countdowns.value = _countdowns.value + (requestId to sec)
                delay(1000)
            }
            _countdowns.value = _countdowns.value - requestId
        }

        // Auto-dismiss on timeout
        timeoutJobs[requestId]?.cancel()
        timeoutJobs[requestId] = viewModelScope.launch {
            delay(timeoutMs)
            removeRequest(requestId)
        }
    }

    private fun removeRequest(requestId: String) {
        _pendingRequests.value = _pendingRequests.value.filter { it.requestId != requestId }
        _countdowns.value = _countdowns.value - requestId
        timeoutJobs.remove(requestId)?.cancel()
        countdownJobs.remove(requestId)?.cancel()
    }

    fun approve(requestId: String) {
        webSocket.sendPermissionResponse(requestId, "allow")
        removeRequest(requestId)
    }

    fun deny(requestId: String) {
        webSocket.sendPermissionResponse(requestId, "deny")
        removeRequest(requestId)
    }

    fun approveWithSuggestion(requestId: String, suggestionIndex: Int) {
        webSocket.sendPermissionResponse(requestId, "allow", suggestionIndex)
        removeRequest(requestId)
    }

    fun submitElicitation(requestId: String, value: String) {
        webSocket.sendElicitationResponse(requestId, mapOf("choice" to value))
        removeRequest(requestId)
    }

    fun dismissRequest(requestId: String) {
        removeRequest(requestId)
    }

    override fun onCleared() {
        super.onCleared()
        timeoutJobs.values.forEach { it.cancel() }
        countdownJobs.values.forEach { it.cancel() }
    }
}

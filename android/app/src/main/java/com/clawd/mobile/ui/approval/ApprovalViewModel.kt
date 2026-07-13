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
import com.clawd.mobile.ws.ApprovalResultData
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
    private var streamingClient: StreamingClient
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
        const val APPROVAL_CONFIRMATION_TIMEOUT_MS = 10_000L
    }
    private val recentlyDismissed = ConcurrentHashMap<String, PermissionRequestData>()

    private val activeRequestIds = ConcurrentHashMap.newKeySet<String>()
    private val respondedRequestIds = ConcurrentHashMap.newKeySet<String>()
    private val countdownJobs = ConcurrentHashMap<String, Job>()
    private val approvalConfirmationJobs = ConcurrentHashMap<String, Job>()
    private var permissionCollectorJob: Job? = null
    private var permissionResolvedCollectorJob: Job? = null
    private var approvalResultCollectorJob: Job? = null
    private var connectionCollectorJob: Job? = null

    init {
        bindClientCollectors()
    }

    private fun bindClientCollectors() {
        permissionCollectorJob = viewModelScope.launch {
            streamingClient.permissionRequests.collect { request ->
                handleNewRequest(request)
            }
        }
        permissionResolvedCollectorJob = viewModelScope.launch {
            streamingClient.permissionResolved.collect(::removeRequest)
        }
        approvalResultCollectorJob = viewModelScope.launch {
            streamingClient.approvalResults.collect(::handleApprovalResult)
        }
        connectionCollectorJob = viewModelScope.launch {
            streamingClient.connectionState.collect { state ->
                if (!state.isConnected) releaseUnconfirmedResponses()
            }
        }
    }

    fun updateClient(client: StreamingClient) {
        if (streamingClient === client) return
        permissionCollectorJob?.cancel()
        permissionResolvedCollectorJob?.cancel()
        approvalResultCollectorJob?.cancel()
        connectionCollectorJob?.cancel()
        releaseUnconfirmedResponses()
        streamingClient = client
        bindClientCollectors()
    }

    private fun handleApprovalResult(result: ApprovalResultData) {
        approvalConfirmationJobs.remove(result.requestId)?.cancel()
        if (result.ok) {
            removeRequest(result.requestId)
            return
        }
        respondedRequestIds.remove(result.requestId)
        _errorEvents.tryEmit(getApplication<Application>().getString(
            com.clawd.mobile.R.string.error_send_failed
        ))
    }

    private fun beginApprovalConfirmation(requestId: String) {
        approvalConfirmationJobs.remove(requestId)?.cancel()
        approvalConfirmationJobs[requestId] = viewModelScope.launch {
            delay(APPROVAL_CONFIRMATION_TIMEOUT_MS)
            approvalConfirmationJobs.remove(requestId)
            if (_pendingRequests.value.any { it.requestId == requestId }) {
                respondedRequestIds.remove(requestId)
                _errorEvents.tryEmit(getApplication<Application>().getString(
                    com.clawd.mobile.R.string.error_send_failed
                ))
            }
        }
    }

    private fun releaseUnconfirmedResponses() {
        val requestIds = approvalConfirmationJobs.keys.toList()
        requestIds.forEach { requestId ->
            approvalConfirmationJobs.remove(requestId)?.cancel()
            respondedRequestIds.remove(requestId)
        }
    }

    private fun resolveSessionName(sessionId: String?): String? =
        resolveSessionName(sessionId, streamingClient.sessions.value, prefsStore)

    private fun handleNewRequest(request: PermissionRequestData) {
        val requestId = request.requestId ?: return
        if (respondedRequestIds.contains(requestId)) {
            Log.d("ApprovalViewModel", "Resolved request ignored: $requestId")
            return
        }
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

        // Single job: countdown ticker + auto-dismiss combined
        countdownJobs[requestId]?.cancel()
        val job = viewModelScope.launch {
            var remainingMs = timeoutMs.toLong()
            var lastWallTime = System.currentTimeMillis()
            while (remainingMs > 0) {
                val remainingSec = ((remainingMs + 999L) / 1000L).toInt()
                _countdowns.update { it + (requestId to remainingSec) }
                val tickMs = minOf(remainingMs, 1000L)
                delay(tickMs)
                val now = System.currentTimeMillis()
                val wallElapsed = (now - lastWallTime).coerceAtLeast(0L)
                remainingMs -= maxOf(tickMs, wallElapsed)
                lastWallTime = now
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
        approvalConfirmationJobs.remove(requestId)?.cancel()
        rememberResponded(requestId)
        countdownJobs.remove(requestId)?.cancel()
        // Cancel the system notification so it doesn't linger in the tray
        runCatching {
            val nid = requestId.hashCode() and 0x7FFFFFFF
            NotificationHelper.cancelNotification(getApplication(), nid)         // approval
            NotificationHelper.cancelNotification(getApplication(), nid + 1)    // elicitation
        }
    }

    private fun rememberResponded(requestId: String) {
        respondedRequestIds.add(requestId)
        while (respondedRequestIds.size > 1000) {
            respondedRequestIds.firstOrNull()?.let(respondedRequestIds::remove) ?: break
        }
    }

    fun approve(requestId: String) {
        if (!ensureConnected()) return
        if (!respondedRequestIds.add(requestId)) return
        beginApprovalConfirmation(requestId)
        viewModelScope.launch {
            val ok = runCatching { streamingClient.sendPermissionResponse(requestId, "allow") }.getOrDefault(false)
            if (!ok) {
                approvalConfirmationJobs.remove(requestId)?.cancel()
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
        beginApprovalConfirmation(requestId)
        viewModelScope.launch {
            val ok = runCatching { streamingClient.sendPermissionResponse(requestId, "deny") }.getOrDefault(false)
            if (!ok) {
                approvalConfirmationJobs.remove(requestId)?.cancel()
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
        beginApprovalConfirmation(requestId)
        viewModelScope.launch {
            val ok = runCatching { streamingClient.sendPermissionResponse(requestId, "allow", suggestionIndex) }.getOrDefault(false)
            if (!ok) {
                approvalConfirmationJobs.remove(requestId)?.cancel()
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
        beginApprovalConfirmation(requestId)
        viewModelScope.launch {
            val request = _pendingRequests.value.find { it.requestId == requestId }
            val ok = runCatching { streamingClient.sendElicitationResponse(requestId, request?.toolInputRaw, answers) }.getOrDefault(false)
            if (!ok) {
                approvalConfirmationJobs.remove(requestId)?.cancel()
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
        permissionCollectorJob?.cancel()
        permissionResolvedCollectorJob?.cancel()
        approvalResultCollectorJob?.cancel()
        connectionCollectorJob?.cancel()
        approvalConfirmationJobs.values.forEach { it.cancel() }
    }
}

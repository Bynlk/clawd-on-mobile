package com.clawd.mobile.ui.navigation

import android.util.Log
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.notification.StatusNotifier
import com.clawd.mobile.service.SseService
import com.clawd.mobile.util.HttpClientProvider
import com.clawd.mobile.ws.CertFingerprintInfo
import com.clawd.mobile.ws.SseClient
import com.clawd.mobile.ws.StreamingClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Manages [SseService] lifecycle, client acquisition, TOFU certificate
 * handling, notification updates, and auto-reconnect.
 *
 * Extracted from [ClawdNavGraph] so the composable only owns routing.
 */
class ServiceManager(
    private val context: android.content.Context,
    private val scope: CoroutineScope,
    private val prefsStore: PrefsStore,
    private val statusNotifier: StatusNotifier,
) {
    companion object {
        private const val TAG = "ServiceManager"
    }

    private val _sseClient = MutableStateFlow<StreamingClient?>(null)
    /** Current [StreamingClient], null until service starts or fallback creates one. */
    val sseClient: StateFlow<StreamingClient?> = _sseClient.asStateFlow()

    private val collectorJobs = mutableListOf<Job>()

    private val _pendingCert = MutableStateFlow<CertFingerprintInfo?>(null)
    /** Non-null when a TOFU certificate confirmation dialog should be shown. */
    val pendingCert: StateFlow<CertFingerprintInfo?> = _pendingCert.asStateFlow()

    // ======================================================================
    //  Initialization
    // ======================================================================

    /**
     * Start service, acquire [StreamingClient], auto-reconnect, and begin collectors.
     * Call once from a `LaunchedEffect(Unit)`.
     */
    suspend fun initialize() {
        SseService.start(context)
        val client = acquireClient()
        _sseClient.value = client
        startCollectors(client)
    }

    /**
     * Re-acquire [StreamingClient] after a connection change (e.g. QR/manual scan).
     * Call from a `LaunchedEffect(refreshKey)`.
     */
    suspend fun refresh() {
        val client = acquireClient()
        _sseClient.value = client
        startCollectors(client)
    }

    private suspend fun acquireClient(): StreamingClient {
        SseService.getClient()?.let { ws ->
            ws.reconnect()
            return ws
        }
        val ws = withTimeoutOrNull(5_000L) {
            SseService.clientReady.first()
        }
        if (ws != null) {
            ws.reconnect()
            return ws
        }
        Log.w(TAG, "Service client not ready in 5s, using fallback")
        return SseClient(prefsStore)
    }

    // ======================================================================
    //  Long-running collectors
    // ======================================================================

    private fun startCollectors(ws: StreamingClient) {
        collectorJobs.forEach { it.cancel() }
        collectorJobs.clear()

        collectorJobs += scope.launch {
            ws.certFingerprintPending.collect { info ->
                _pendingCert.value = info
            }
        }

        collectorJobs += scope.launch {
            var lastDisplayState: String? = null
            var lastSessionsJson = ""
            ws.displayState.collect { displayState ->
                val sessionsMap = ws.sessions.value
                val sessionsJson = sessionsMap.keys.sorted().joinToString(",") +
                    "|" + sessionsMap.values.map { "${it.sessionId}:${it.state}:${it.badge}" }.joinToString(",")
                if (displayState != lastDisplayState || sessionsJson != lastSessionsJson) {
                    lastDisplayState = displayState
                    lastSessionsJson = sessionsJson
                    statusNotifier.updateNotifications(displayState, sessionsMap)
                }
            }
        }

        collectorJobs += scope.launch {
            for (request in ClawdApp.approvalChannel) {
                Log.d(TAG, "Received approval request from channel: id=${request.requestId}")
                onApprovalFromNotification?.invoke(request)
            }
        }
    }

    /** Callback set by NavGraph to route notification-tap approval requests to the ViewModel. */
    var onApprovalFromNotification: ((com.clawd.mobile.data.PermissionRequestData) -> Unit)? = null

    // ======================================================================
    //  Public actions
    // ======================================================================

    /** Start or restart the service with an optional new [config][com.clawd.mobile.data.ConnectionConfig]. */
    fun startService(config: com.clawd.mobile.data.ConnectionConfig? = null) {
        config?.let { prefsStore.saveConfig(it) }
        SseService.start(context, config)
    }

    /** Trust the pending TOFU certificate. */
    fun trustCert(cert: CertFingerprintInfo) {
        prefsStore.setCertFingerprint(cert.fingerprint)
        HttpClientProvider.setCertFingerprint(cert.fingerprint)
        _pendingCert.value = null
        _sseClient.value?.setConnectionState(com.clawd.mobile.ws.ConnectionState.CONNECTED)
    }

    /** Reject the pending TOFU certificate. */
    fun rejectCert(ws: StreamingClient) {
        _pendingCert.value = null
        ws.disconnect()
    }

    /** Cancel all long-running collectors and release resources. */
    fun destroy() {
        collectorJobs.forEach { it.cancel() }
        collectorJobs.clear()
    }
}

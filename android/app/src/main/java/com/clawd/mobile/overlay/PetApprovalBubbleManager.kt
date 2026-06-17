package com.clawd.mobile.overlay

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.service.WsConnectionService
import com.clawd.mobile.ws.StreamingClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Manages the approval bubble overlay that appears next to the floating pet.
 *
 * Lifecycle:
 * 1. Collects [StreamingClient.permissionRequests] from active clients
 * 2. Shows collapsed hint pill next to pet
 * 3. User taps hint → expands approval panel
 * 4. User swipes to approve/deny → sends response → auto-advance to next queued request
 * 5. Collects [WsConnectionService.approvalCompletedFlow] to sync with notification approvals
 */
class PetApprovalBubbleManager(
    private val context: Context,
    private val windowManager: WindowManager,
    private val scope: CoroutineScope,
    private val getPetView: () -> FloatingPetView?,
    private val getPetLayoutParams: () -> WindowManager.LayoutParams?
) {
    companion object {
        private const val TAG = "PetApprovalBubbleMgr"
        private const val BUBBLE_MAX_WIDTH_DP = 280
        private const val BUBBLE_MARGIN_DP = 16
        private const val BUBBLE_GAP_DP = 8
        private const val COUNTDOWN_INTERVAL_MS = 100L
    }

    // --- Thread-safe dedup (same pattern as ApprovalViewModel) ---
    private val respondedRequestIds = ConcurrentHashMap.newKeySet<String>()

    // --- Pending requests queue (FIFO) ---
    private data class PendingApproval(
        val requestId: String,
        val toolName: String,
        val summary: String,
        val suggestions: List<String>?,
        val isElicitation: Boolean,
        val timeoutMs: Long,
        val sourceClient: StreamingClient
    )
    private val pendingRequests = mutableListOf<PendingApproval>()

    // --- View state ---
    private var bubbleView: ApprovalBubbleView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var permissionCollectJob: Job? = null
    private var completionCollectJob: Job? = null
    private var countdownJob: Job? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // --- Public API ---

    fun start() {
        if (permissionCollectJob != null) return  // already started

        val ws = WsConnectionService.getClient()
        if (ws != null) {
            collectPermissionRequests(ws)
        }

        // Collect approval completions from notification path
        completionCollectJob = scope.launch {
            WsConnectionService.approvalCompletedFlow.collect { requestId ->
                respondedRequestIds.add(requestId)
                // If this request is currently showing, dismiss or advance
                mainHandler.post {
                    val currentShowing = pendingRequests.firstOrNull()
                    if (currentShowing?.requestId == requestId) {
                        pendingRequests.removeAt(0)
                        advanceOrDismiss()
                    } else {
                        pendingRequests.removeAll { it.requestId == requestId }
                    }
                }
            }
        }

        Log.d(TAG, "Started collecting approval requests")
    }

    fun stop() {
        permissionCollectJob?.cancel()
        permissionCollectJob = null
        completionCollectJob?.cancel()
        completionCollectJob = null
        countdownJob?.cancel()
        countdownJob = null
        dismissBubble()
        pendingRequests.clear()
        Log.d(TAG, "Stopped")
    }

    /** Returns true if there are pending approval requests. */
    fun hasPending(): Boolean = pendingRequests.isNotEmpty()

    /** Returns true if the approval bubble is currently showing. */
    fun isShowing(): Boolean = bubbleView != null

    // --- Permission request collection ---

    private fun collectPermissionRequests(client: StreamingClient) {
        permissionCollectJob?.cancel()
        permissionCollectJob = scope.launch {
            client.permissionRequests.collect { request ->
                val reqId = request.requestId ?: return@collect
                if (respondedRequestIds.contains(reqId)) {
                    Log.d(TAG, "Skipping already-responded request: $reqId")
                    return@collect
                }

                val suggestions = request.suggestions.map { it.label }.ifEmpty { null }
                val isElicitation = request.elicitationQuestions.isNotEmpty()

                val pending = PendingApproval(
                    requestId = reqId,
                    toolName = request.toolName ?: "Unknown",
                    summary = request.toolInputSummary ?: "",
                    suggestions = suggestions,
                    isElicitation = isElicitation,
                    timeoutMs = request.timeout,
                    sourceClient = client
                )

                mainHandler.post {
                    pendingRequests.add(pending)
                    if (bubbleView == null) {
                        showNextRequest()
                    }
                }
            }
        }
    }

    // --- Bubble display ---

    private fun showNextRequest() {
        val request = pendingRequests.firstOrNull() ?: run {
            dismissBubble()
            return
        }

        val petParams = getPetLayoutParams() ?: run {
            Log.w(TAG, "No pet layout params, cannot show bubble")
            return
        }

        if (bubbleView == null) {
            createBubble(petParams)
        }

        val view = bubbleView ?: return
        if (request.isElicitation) {
            view.showElicitationHint(request.requestId)
        } else {
            view.showApprovalHint(request.requestId, request.toolName, request.summary, request.suggestions, pendingRequests.size)
        }

        startCountdown(request.timeoutMs)
    }

    private fun createBubble(petLayoutParams: WindowManager.LayoutParams) {
        val density = context.resources.displayMetrics.density
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels
        val marginPx = (BUBBLE_MARGIN_DP * density).toInt()
        val gapPx = (BUBBLE_GAP_DP * density).toInt()

        val windowRect = Rect(petLayoutParams.x, petLayoutParams.y,
            petLayoutParams.x + petLayoutParams.width, petLayoutParams.y + petLayoutParams.height)
        val contentRect = getPetView()?.getContentRect(windowRect) ?: windowRect

        // Position above pet, fallback to below
        val bubbleW = (BUBBLE_MAX_WIDTH_DP * density).toInt()
        var x = contentRect.centerX() - bubbleW / 2
        x = x.coerceIn(marginPx, screenW - bubbleW - marginPx)

        var y = contentRect.top - gapPx  // bubble bottom touches gap above pet
        if (y < marginPx) {
            y = contentRect.bottom + gapPx
        }

        val newView = ApprovalBubbleView(context)
        newView.configureWithSuggestionIndex(
            approveCallback = { requestId -> handleApprove(requestId) },
            approveWithSuggestionCallback = { requestId, suggestionIndex -> handleApproveWithSuggestion(requestId, suggestionIndex) },
            denyCallback = { requestId -> handleDeny(requestId) },
            openAppCallback = { handleOpenApp() },
            swipeStateCallback = { expanded ->
                // When expanded, remove FLAG_NOT_FOCUSABLE for button interaction
                updateWindowFlags(expanded)
            }
        )

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            this.x = x
            this.y = y
        }

        newView.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE) {
                collapseBubble()
                true
            } else false
        }

        try {
            windowManager.addView(newView, params)
            bubbleView = newView
            bubbleParams = params
            Log.d(TAG, "Approval bubble shown at x=$x, y=$y")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to add approval bubble view", e)
        }
    }

    private fun updateWindowFlags(expanded: Boolean) {
        val view = bubbleView ?: return
        val params = bubbleParams ?: return
        params.flags = if (expanded) {
            // Expanded: allow focus for swipe interaction
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        } else {
            // Collapsed: not focusable
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        }
        try {
            windowManager.updateViewLayout(view, params)
        } catch (e: Exception) {
            Log.w(TAG, "updateViewLayout for flag change failed", e)
        }
    }

    private fun collapseBubble() {
        bubbleView?.collapse()
        updateWindowFlags(false)
    }

    private fun dismissBubble() {
        countdownJob?.cancel()
        countdownJob = null
        bubbleView?.let {
            try {
                windowManager.removeView(it)
            } catch (e: Exception) {
                Log.w(TAG, "dismissBubble: view already removed", e)
            }
        }
        bubbleView = null
        bubbleParams = null
    }

    private fun advanceOrDismiss() {
        if (pendingRequests.isEmpty()) {
            dismissBubble()
        } else {
            // Cancel current countdown and show next
            countdownJob?.cancel()
            showNextRequest()
        }
    }

    // --- Approval actions ---

    private fun handleApprove(requestId: String) {
        if (respondedRequestIds.contains(requestId)) return
        respondedRequestIds.add(requestId)

        val request = pendingRequests.firstOrNull { it.requestId == requestId }
        if (request == null) {
            Log.w(TAG, "handleApprove: request $requestId not found in queue")
            return
        }

        // Send response via source client
        request.sourceClient.sendPermissionResponse(requestId, "allow")

        // Cancel notification
        NotificationHelper.cancelNotification(context, requestId.hashCode() and 0x7FFFFFFF)

        // Emit completion
        scope.launch {
            WsConnectionService.approvalCompletedFlow.emit(requestId)
        }

        // Remove from queue and advance
        pendingRequests.removeAll { it.requestId == requestId }
        mainHandler.post { advanceOrDismiss() }

        Log.d(TAG, "Approved: $requestId")
    }

    private fun handleApproveWithSuggestion(requestId: String, suggestionIndex: Int) {
        if (respondedRequestIds.contains(requestId)) return
        respondedRequestIds.add(requestId)

        val request = pendingRequests.firstOrNull { it.requestId == requestId }
        if (request == null) {
            Log.w(TAG, "handleApproveWithSuggestion: request $requestId not found in queue")
            return
        }

        // Send response via source client with suggestion index
        request.sourceClient.sendPermissionResponse(requestId, "allow", suggestionIndex)

        // Cancel notification
        NotificationHelper.cancelNotification(context, requestId.hashCode() and 0x7FFFFFFF)

        // Emit completion
        scope.launch {
            WsConnectionService.approvalCompletedFlow.emit(requestId)
        }

        // Remove from queue and advance
        pendingRequests.removeAll { it.requestId == requestId }
        mainHandler.post { advanceOrDismiss() }

        Log.d(TAG, "Approved with suggestion[$suggestionIndex]: $requestId")
    }

    private fun handleDeny(requestId: String) {
        if (respondedRequestIds.contains(requestId)) return
        respondedRequestIds.add(requestId)

        val request = pendingRequests.firstOrNull { it.requestId == requestId }
        if (request == null) {
            Log.w(TAG, "handleDeny: request $requestId not found in queue")
            return
        }

        // Send response via source client
        request.sourceClient.sendPermissionResponse(requestId, "deny")

        // Cancel notification
        NotificationHelper.cancelNotification(context, requestId.hashCode() and 0x7FFFFFFF)

        // Emit completion
        scope.launch {
            WsConnectionService.approvalCompletedFlow.emit(requestId)
        }

        // Remove from queue and advance
        pendingRequests.removeAll { it.requestId == requestId }
        mainHandler.post { advanceOrDismiss() }

        Log.d(TAG, "Denied: $requestId")
    }

    private fun handleOpenApp() {
        val request = pendingRequests.firstOrNull() ?: return
        // Remove from queue — the notification path or in-app ApprovalViewModel handles the response
        pendingRequests.removeAll { it.requestId == request.requestId }
        collapseBubble()
        advanceOrDismiss()

        // Launch app with elicitation data
        val intent = Intent(context, com.clawd.mobile.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("approval_request_id", request.requestId)
        }
        context.startActivity(intent)
        Log.d(TAG, "Open app for elicitation: ${request.requestId}")
    }

    // --- Countdown ---

    private fun startCountdown(timeoutMs: Long) {
        countdownJob?.cancel()
        val startTime = System.currentTimeMillis()
        countdownJob = scope.launch {
            while (true) {
                kotlinx.coroutines.delay(COUNTDOWN_INTERVAL_MS)
                val elapsed = System.currentTimeMillis() - startTime
                val progress = ((elapsed.toDouble() / timeoutMs) * 1000).toInt()
                if (progress >= 1000) {
                    // Timeout — auto-deny
                    mainHandler.post {
                        val request = pendingRequests.firstOrNull()
                        if (request != null && !respondedRequestIds.contains(request.requestId)) {
                            handleDeny(request.requestId)
                        }
                    }
                    break
                }
                mainHandler.post {
                    bubbleView?.updateCountdown(1000 - progress)
                }
            }
        }
    }
}

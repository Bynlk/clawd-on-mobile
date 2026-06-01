package com.clawd.mobile.overlay

import android.app.Notification
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import android.graphics.PixelFormat
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.R
import com.clawd.mobile.service.WebSocketService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class FloatingPetService : Service() {

    companion object {
        private const val TAG = "FloatingPetService"
        const val ACTION_PET_SIZE = "com.clawd.mobile.PET_SIZE_CHANGED"
        const val ACTION_PET_CHARACTER = "com.clawd.mobile.PET_CHARACTER_CHANGED"
        const val ACTION_DISCONNECT = "com.clawd.mobile.ACTION_DISCONNECT"
        const val EXTRA_SIZE_DP = "size_dp"
        const val EXTRA_CHARACTER = "character"
        private const val NOTIFICATION_ID = 9001
        private const val DEFAULT_SIZE_DP = 96
        private const val EDGE_MARGIN_DP = 16
        private const val DRAG_THRESHOLD_SQ_PX = 100      // squared px before drag starts
        private const val BUBBLE_MAX_WIDTH_DP = 280
        private const val BUBBLE_HEIGHT_SCREEN_RATIO = 0.4
        private const val BUBBLE_MARGIN_DP = 16
        private const val BUBBLE_GAP_DP = 8
        private const val VIEWPORT_PADDING_RATIO = 0.15f   // 15% safety padding for asymmetric frames
    }

    // --- View & window ---
    private var windowManager: WindowManager? = null
    private var petView: FloatingPetView? = null
    private var layoutParams: WindowManager.LayoutParams? = null
    private var sizeDp = DEFAULT_SIZE_DP
    private var character = "clawd"
    private var contentOffsetDx = 0f
    private var contentOffsetDy = 0f
    private var svgFrameW: Int = 0
    private var svgFrameH: Int = 0
    private var lastSizeDp: Int = -1

    // --- Coroutine plumbing ---
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var started = false
    /** Collects unified StateCommand from PetStateManager — single pipe for all view mutations. */
    private var commandCollectorJob: Job? = null

    // --- State management (extracted) ---
    private lateinit var stateManager: PetStateManager

    // --- Drag state ---
    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    private var isDragging = false

    // --- Gesture detector ---
    private var gestureDetector: GestureDetector? = null

    // --- Bubble ---
    private var bubbleView: PetBubbleView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleUpdateJob: Job? = null

    // --- Broadcast receiver ---
    private var broadcastReceiver: BroadcastReceiver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    // ======================================================================
    //  Lifecycle
    // ======================================================================

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "onCreate")

        // No callback needed — ReactionGif commands flow through the unified stateFlow
        stateManager = PetStateManager(character)

        startForeground(NOTIFICATION_ID, buildNotification())
        loadPrefs()
        registerBroadcastReceiver()
        showFloatingWindow()
        reloadGif()   // Single entry point: serial Job chain handles all initialization
        started = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            Log.d(TAG, "ACTION_DISCONNECT received, gracefully shutting down")
            started = false
            dismissBubble()
            stateManager.reset()
            commandCollectorJob?.cancel()
            unregisterBroadcastReceiver()
            savePosition()
            removeFloatingWindow()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (started) {
            // Service recreated by system after kill — defensive cleanup
            Log.d(TAG, "onStartCommand: already started, cleaning up first")
            dismissBubble()
            stateManager.reset()
            commandCollectorJob?.cancel()
            removeFloatingWindow()
            contentOffsetDx = 0f
            contentOffsetDy = 0f
            showFloatingWindow()
            reloadGif()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
        started = false
        dismissBubble()
        stateManager.reset()
        commandCollectorJob?.cancel()
        scope.cancel()
        unregisterBroadcastReceiver()
        savePosition()
        removeFloatingWindow()
        super.onDestroy()
    }

    // ======================================================================
    //  Unified command collection (single pipe — no dual-pipeline race)
    // ======================================================================

    /**
     * Serial Job chain: reset → clear → start → collect.
     * All SVG loads happen sequentially in the single [commandCollectorJob]
     * on Main dispatcher — no concurrent loads possible.
     */
    private fun reloadGif() {
        // 0. Sync character before reset (may have changed via broadcast)
        stateManager.character = character

        // 1. State machine full reset (cancels its internal wsCollectorJob + idle + sleep)
        stateManager.reset()

        // 2. Cancel Service-side collector — clean slate
        commandCollectorJob?.cancel()

        // 3. Clear view rendering tree residual
        petView?.clearSvg()

        // 4. Single serial Job chain: start() → collect, no vacuum gap
        commandCollectorJob = scope.launch(Dispatchers.Main) {
            stateManager.start(this)   // pass this coroutine scope for internal launches

            // Collect the unified single pipe — every StateCommand handled sequentially
            stateManager.stateFlow.collect { command ->
                handleCommand(command)
            }
        }
    }

    /**
     * Apply a single [PetStateManager.StateCommand] to the view.
     * Runs on Main dispatcher inside the serial [commandCollectorJob] —
     * no concurrent SVG loads possible.
     */
    private fun handleCommand(command: PetStateManager.StateCommand) {
        when (command) {
            is PetStateManager.StateCommand.StateChanged -> {
                val state = command.state
                val sessionCount = WebSocketService.getWebSocket()
                    ?.sessions?.value?.values?.count { it.isVisible } ?: 0
                val assetPath = SvgLoader.resolveSvgAsset(state, sessionCount, character)
                val isOneshot = state in PetState.ONESHOT_STATES
                Log.w("PetState", "handleCommand state=${state.themeKey} sessionCount=$sessionCount assetPath=$assetPath isOneshot=$isOneshot")
                if (assetPath != null) {
                    SvgLoader.loadSvg(
                        petView ?: return, assetPath,
                        loop = !isOneshot,
                        onFinished = if (isOneshot) ({
                            Log.w(TAG, "Oneshot ${state.themeKey} SVG finished → Idle")
                            handleCommand(PetStateManager.StateCommand.StateChanged(PetState.Idle))
                        }) else null
                    )
                }
            }
            is PetStateManager.StateCommand.SvgLoad -> {
                val path = command.assetPath
                if (path != null) {
                    petView?.let { SvgLoader.loadSvg(it, path, loop = true) }
                }
            }
            is PetStateManager.StateCommand.ReactionSvg -> {
                val path = command.assetPath
                if (path != null) {
                    petView?.let { SvgLoader.loadSvg(it, path, loop = false) }
                }
            }
        }
    }

    // ======================================================================
    //  Notification
    // ======================================================================

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, ClawdApp.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(getString(R.string.pet_notification_title))
            .setContentText(getString(R.string.pet_notification_text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
    }

    // ======================================================================
    //  Prefs
    // ======================================================================

    private fun loadPrefs() {
        val prefs = getSharedPreferences("clawd_prefs", MODE_PRIVATE)
        sizeDp = prefs.getInt("pet_size_dp", DEFAULT_SIZE_DP)
        character = prefs.getString("pet_character", "clawd") ?: "clawd"
    }

    private fun savePosition() {
        layoutParams?.let {
            val contentCenterX = it.x + it.width / 2f + contentOffsetDx
            val contentCenterY = it.y + it.height / 2f + contentOffsetDy
            getSharedPreferences("clawd_prefs", MODE_PRIVATE).edit()
                .putFloat("pet_content_cx", contentCenterX)
                .putFloat("pet_content_cy", contentCenterY)
                .apply()
        }
    }

    // ======================================================================
    //  Floating Window
    // ======================================================================

    private fun showFloatingWindow() {
        if (!Settings.canDrawOverlays(this)) {
            Log.w(TAG, "No overlay permission, stopping self")
            stopSelf()
            return
        }

        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val density = resources.displayMetrics.density
        val sizePx = (sizeDp * density).toInt()
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels

        val prefs = getSharedPreferences("clawd_prefs", MODE_PRIVATE)
        val marginPx = (EDGE_MARGIN_DP * density).toInt()
        val defaultCx = screenW - sizePx / 2f - marginPx
        val defaultCy = screenH - sizePx / 2f - marginPx
        val savedCx = prefs.getFloat("pet_content_cx", defaultCx)
        val savedCy = prefs.getFloat("pet_content_cy", defaultCy)
        val savedX = (savedCx - sizePx / 2f).toInt()
        val savedY = (savedCy - sizePx / 2f).toInt()

        petView = FloatingPetView(this).apply {
            setBackgroundColor(0)
            targetContentPx = sizePx
        }

        layoutParams = WindowManager.LayoutParams(
            sizePx, sizePx,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = savedX
            y = savedY
        }

        setupGestureDetector()
        petView!!.onDragEnd = { savePosition() }
        petView!!.onContentReady = callback@{ offsetDx, offsetDy, fW, fH ->
            contentOffsetDx = offsetDx
            contentOffsetDy = offsetDy
            svgFrameW = fW
            svgFrameH = fH
            recalcWindowSize()
        }

        windowManager?.addView(petView!!, layoutParams)
        Log.d(TAG, "Pet view added at x=$savedX, y=$savedY, size=$sizePx")
    }

    /**
     * @param lockedCenterX optional pre-captured center X (avoids drift on rapid calls)
     * @param lockedCenterY optional pre-captured center Y
     */
    private fun recalcWindowSize(
        lockedCenterX: Float? = null,
        lockedCenterY: Float? = null
    ) {
        try {
            val lp = layoutParams ?: return
            val density = resources.displayMetrics.density

            // Use cached SVG frame dimensions (set in onContentReady),
            // NOT lp.width/lp.height which reflects the window size.
            val frameW = svgFrameW.toFloat()
            val frameH = svgFrameH.toFloat()
            if (frameW <= 0f || frameH <= 0f) {
                // GIF frame not ready yet — apply stable placeholder
                val safePx = (sizeDp * density).toInt()
                lp.width = safePx
                lp.height = safePx
                windowManager?.updateViewLayout(petView!!, lp)
                return
            }

            val contentW = (frameW - 2 * Math.abs(contentOffsetDx)).coerceAtLeast(1f)
            val contentH = (frameH - 2 * Math.abs(contentOffsetDy)).coerceAtLeast(1f)
            val contentScale = maxOf(contentW, contentH)
            if (contentScale <= 0f) return

            // 15% safety viewport padding so asymmetric frames (tails, ears) aren't clipped
            val paddedContentScale = contentScale * (1f - VIEWPORT_PADDING_RATIO)
            val windowDp = (sizeDp * maxOf(frameW, frameH) / paddedContentScale)
            val windowPx = (windowDp * density).toInt().coerceAtLeast((80 * density).toInt())

            // Skip if neither window size nor sizeDp changed (avoids onContentReady → recalc loop)
            val oldWindowPx = lp.width
            if (windowPx == oldWindowPx && sizeDp == lastSizeDp) return
            lastSizeDp = sizeDp

            // Use locked center if provided; otherwise read from current layout params
            val oldCenterX = lockedCenterX ?: (lp.x + lp.width / 2f)
            val oldCenterY = lockedCenterY ?: (lp.y + lp.height / 2f)

            lp.width = windowPx
            lp.height = windowPx

            val targetX = (oldCenterX - contentOffsetDx * (windowPx.toFloat() / frameW)).toInt()
            val targetY = (oldCenterY - contentOffsetDy * (windowPx.toFloat() / frameH)).toInt()
            lp.x = targetX - windowPx / 2
            lp.y = targetY - windowPx / 2

            windowManager?.updateViewLayout(petView!!, lp)

            // Sync targetContentPx for WebView content sizing
            petView?.let { pv ->
                pv.targetContentPx = windowPx
                pv.requestLayout()
                pv.invalidate()
            }
            Log.d(TAG, "recalcWindowSize: offset=($contentOffsetDx,$contentOffsetDy), frame=${frameW}x${frameH}, window=${windowPx}px, padding=${VIEWPORT_PADDING_RATIO}")
        } catch (e: Exception) {
            Log.e(TAG, "recalcWindowSize error", e)
        }
    }

    /**
     * Unified viewport readiness check.
     * Returns (frameW, frameH) if the SVG frame dimensions are known, or null if not.
     *
     * When the frame isn't ready (SVG still loading, or between character
     * switches), applies a stable [sizeDp]-based placeholder so the window
     * doesn't collapse to a 1px slit.
     */
    private fun ensureViewportReady(
        lp: WindowManager.LayoutParams,
        density: Float
    ): Pair<Float, Float>? {
        val frameW = svgFrameW
        val frameH = svgFrameH

        if (frameW <= 0 || frameH <= 0) {
            // Apply stable placeholder bounds
            val safePx = (sizeDp * density).toInt()
            lp.width = safePx
            lp.height = safePx
            windowManager?.updateViewLayout(petView!!, lp)
            Log.d(TAG, "ensureViewportReady: SVG frame not ready, applied safe placeholder ${safePx}px")
            return null
        }

        return Pair(frameW.toFloat(), frameH.toFloat())
    }

    private fun removeFloatingWindow() {
        petView?.let {
            it.clearSvg()
            try {
                windowManager?.removeView(it)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "View already removed: ${e.message}")
            }
        }
        petView = null
        windowManager = null
    }

    // ======================================================================
    //  Touch / Gesture
    // ======================================================================

    private fun openApp() {
        Log.d(TAG, "openApp called")
        dismissBubble()
        val intent = Intent(this, com.clawd.mobile.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        startActivity(intent)
    }

    private fun setupGestureDetector() {
        gestureDetector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
                layoutParams?.let {
                    initialX = it.x
                    initialY = it.y
                }
                initialTouchX = e.rawX
                initialTouchY = e.rawY
                isDragging = false
                return true
            }

            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                Log.d(TAG, "Single tap → toggleBubble")
                toggleBubble()
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                Log.d(TAG, "Double tap → openApp")
                dismissBubble()
                openApp()
                return true
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                if (e1 == null) return false
                val dx = (e2.rawX - initialTouchX).toInt()
                val dy = (e2.rawY - initialTouchY).toInt()
                if (!isDragging && (dx * dx + dy * dy) > DRAG_THRESHOLD_SQ_PX) {
                    isDragging = true
                    dismissBubble()
                }
                if (isDragging) {
                    val lp = layoutParams ?: return false
                    lp.x = initialX + dx
                    lp.y = initialY + dy
                    try {
                        windowManager?.updateViewLayout(petView!!, lp)
                    } catch (e: Exception) {
                        Log.w(TAG, "updateViewLayout during drag failed", e)
                    }
                }
                return true
            }
        })
        petView!!.gestureDetector = gestureDetector
    }

    // ======================================================================
    //  Bubble
    // ======================================================================

    private fun toggleBubble() {
        if (bubbleView != null) {
            dismissBubble()
        } else {
            showBubble()
        }
    }

    private fun dismissBubble() {
        bubbleUpdateJob?.cancel()
        bubbleUpdateJob = null
        bubbleView?.let {
            try {
                windowManager?.removeView(it)
            } catch (e: Exception) {
                Log.w(TAG, "dismissBubble: view already removed", e)
            }
        }
        bubbleView = null
        bubbleParams = null
    }

    private fun showBubble() {
        val density = resources.displayMetrics.density
        val maxBubbleW = (BUBBLE_MAX_WIDTH_DP * density).toInt()
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val maxBubbleH = (screenH * BUBBLE_HEIGHT_SCREEN_RATIO).toInt()

        val ws = WebSocketService.getWebSocket()
        val connectionState = ws?.connectionState?.value
        val sessions = ws?.sessions?.value?.values?.filter { it.isVisible } ?: emptyList()

        val newBubble = PetBubbleView(this)
        if (ws == null || connectionState == com.clawd.mobile.ws.ConnectionState.DISCONNECTED
            || connectionState == com.clawd.mobile.ws.ConnectionState.AUTH_FAILED) {
            newBubble.showNotConnected()
        } else if (sessions.isEmpty()) {
            newBubble.showNoSessions()
        } else {
            newBubble.updateSessions(sessions)
        }
        newBubble.onEnterApp = { openApp() }

        newBubble.measure(
            android.view.View.MeasureSpec.makeMeasureSpec(maxBubbleW, android.view.View.MeasureSpec.AT_MOST),
            android.view.View.MeasureSpec.makeMeasureSpec(maxBubbleH, android.view.View.MeasureSpec.AT_MOST)
        )

        val lp = layoutParams ?: return
        val petX = lp.x
        val petY = lp.y
        val petW = lp.width
        val bubbleW = newBubble.measuredWidth
        val bubbleH = newBubble.measuredHeight
        val marginPx = (BUBBLE_MARGIN_DP * density).toInt()
        val gapPx = (BUBBLE_GAP_DP * density).toInt()

        var x = petX + (petW - bubbleW) / 2
        x = x.coerceIn(marginPx, screenW - bubbleW - marginPx)

        var y = petY - bubbleH - gapPx
        if (y < marginPx) {
            y = petY + lp.height + gapPx
        }

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

        newBubble.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE) {
                dismissBubble()
                true
            } else false
        }

        windowManager?.addView(newBubble, params)
        bubbleView = newBubble
        bubbleParams = params

        bubbleUpdateJob?.cancel()
        if (ws != null) {
            bubbleUpdateJob = scope.launch {
                ws.sessions.collect { sessionMap ->
                    val visible = sessionMap.values.filter { it.isVisible }
                    if (visible.isEmpty()) {
                        bubbleView?.showNoSessions()
                    } else {
                        bubbleView?.updateSessions(visible)
                    }
                }
            }
        }

        Log.d(TAG, "Bubble shown at x=$x, y=$y, size=${bubbleW}x${bubbleH}")
    }

    // ======================================================================
    //  Broadcast Receiver
    // ======================================================================

    private fun registerBroadcastReceiver() {
        broadcastReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    ACTION_PET_SIZE -> {
                        sizeDp = intent.getIntExtra(EXTRA_SIZE_DP, DEFAULT_SIZE_DP)
                        updateSize()
                    }
                    ACTION_PET_CHARACTER -> {
                        character = intent.getStringExtra(EXTRA_CHARACTER) ?: "clawd"
                        Log.d(TAG, "Character changed to $character")
                        reloadGif()
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_PET_SIZE)
            addAction(ACTION_PET_CHARACTER)
        }
        ContextCompat.registerReceiver(this, broadcastReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun unregisterBroadcastReceiver() {
        broadcastReceiver?.let {
            try { unregisterReceiver(it) } catch (e: Exception) {
                Log.w(TAG, "unregisterBroadcastReceiver failed", e)
            }
        }
        broadcastReceiver = null
    }

    private fun updateSize() {
        // Lock center point BEFORE any layout mutation to prevent drift on rapid slider events
        val lp = layoutParams
        val lockedCX = lp?.let { it.x + it.width / 2f }
        val lockedCY = lp?.let { it.y + it.height / 2f }

        val density = resources.displayMetrics.density
        val sizePx = (sizeDp * density).toInt()
        petView?.let { pv ->
            pv.targetContentPx = sizePx
        }
        // Do NOT pre-set lp.width/height here — recalcWindowSize() owns that mutation
        // only when the SVG frame is actually ready.
        recalcWindowSize(lockedCX, lockedCY)

        // Force the view to re-measure and re-draw with the new window dimensions.
        // Safe no-op if recalcWindowSize returned early (frame not ready).
        petView?.requestLayout()
        petView?.invalidate()
    }
}

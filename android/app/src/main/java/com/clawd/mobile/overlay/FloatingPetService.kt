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
import android.widget.ImageView
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.data.Session
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.service.WebSocketService
import com.clawd.mobile.ws.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
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
    }

    private var windowManager: WindowManager? = null
    private var petView: FloatingPetView? = null
    private var layoutParams: WindowManager.LayoutParams? = null
    private var sizeDp = DEFAULT_SIZE_DP
    private var character = "clawd"
    private var contentOffsetDx = 0f
    private var contentOffsetDy = 0f
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var stateCollectorJob: Job? = null
    private var idleCycleJob: Job? = null
    private var broadcastReceiver: BroadcastReceiver? = null
    private var started = false
    private var lastNonIdleState: String = "idle"
    private var prevBadge: MutableMap<String, String> = mutableMapOf()

    // Drag state
    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    private var isDragging = false

    // Gesture detector
    private var gestureDetector: GestureDetector? = null

    // Reaction: play-once-then-restore (used by Bug 5 happy injection)
    private var gifGeneration = 0

    // Bubble state
    private var bubbleView: PetBubbleView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleUpdateJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "onCreate")
        PetGifLoader.init(this)
        startForeground(NOTIFICATION_ID, buildNotification())
        loadPrefs()
        registerBroadcastReceiver()
        showFloatingWindow()
        startStateCollector()
        started = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 优雅断开：清理所有状态后停止服务
        if (intent?.action == ACTION_DISCONNECT) {
            Log.d(TAG, "ACTION_DISCONNECT received, gracefully shutting down")
            started = false
            dismissBubble()
            cancelPendingReactions()
            stopIdleCycle()
            stateCollectorJob?.cancel()
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
            stopIdleCycle()
            stateCollectorJob?.cancel()
            removeFloatingWindow()
            contentOffsetDx = 0f
            contentOffsetDy = 0f
            gifGeneration = 0
            lastNonIdleState = "idle"
            prevBadge.clear()
            // Re-create from clean state
            showFloatingWindow()
            startStateCollector()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
        started = false
        dismissBubble()
        cancelPendingReactions()
        stopIdleCycle()
        stateCollectorJob?.cancel()
        scope.cancel()
        unregisterBroadcastReceiver()
        savePosition()
        removeFloatingWindow()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, ClawdApp.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Clawd 桌宠")
            .setContentText("桌宠正在运行中")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
    }

    // --- Prefs ---

    private fun loadPrefs() {
        val prefs = getSharedPreferences("clawd_prefs", MODE_PRIVATE)
        sizeDp = prefs.getInt("pet_size_dp", DEFAULT_SIZE_DP)
        character = prefs.getString("pet_character", "clawd") ?: "clawd"
    }

    private fun savePosition() {
        layoutParams?.let {
            // 保存内容中心位置，而非窗口左上角
            val contentCenterX = it.x + it.width / 2f + contentOffsetDx
            val contentCenterY = it.y + it.height / 2f + contentOffsetDy
            getSharedPreferences("clawd_prefs", MODE_PRIVATE).edit()
                .putFloat("pet_content_cx", contentCenterX)
                .putFloat("pet_content_cy", contentCenterY)
                .apply()
        }
    }

    // --- Floating Window ---

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

        // Read saved position (内容中心位置)，default to bottom-right
        val prefs = getSharedPreferences("clawd_prefs", MODE_PRIVATE)
        val marginPx = (EDGE_MARGIN_DP * density).toInt()
        val defaultCx = screenW - sizePx / 2f - marginPx
        val defaultCy = screenH - sizePx / 2f - marginPx
        val savedCx = prefs.getFloat("pet_content_cx", defaultCx)
        val savedCy = prefs.getFloat("pet_content_cy", defaultCy)
        // 用内容中心位置反算窗口左上角（初始无偏移时 center = window + size/2）
        val savedX = (savedCx - sizePx / 2f).toInt()
        val savedY = (savedCy - sizePx / 2f).toInt()

        petView = FloatingPetView(this).apply {
            setBackgroundColor(0)
        }

        layoutParams = WindowManager.LayoutParams(
            sizePx, sizePx,  // 初始值，onContentReady 回调后会更新
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = savedX
            y = savedY
        }

        // Load initial GIF
        val resId = PetGifLoader.getGifResId("idle", 0, character) ?: 0
        if (resId != 0) petView!!.loadGif(resId)

        // 手势检测器（支持三击检测）
        setupGestureDetector()

        // 拖拽结束时保存位置
        petView!!.onDragEnd = { savePosition() }

        // 内容就绪回调
        petView!!.onContentReady = callback@{ offsetDx, offsetDy, frameW, frameH ->
            contentOffsetDx = offsetDx
            contentOffsetDy = offsetDy
            recalcWindowSize()
        }

        windowManager?.addView(petView!!, layoutParams)
        Log.d(TAG, "Pet view added at x=$savedX, y=$savedY, size=$sizePx")
    }

    /** 重新计算窗口大小和位置（基于当前 sizeDp 和 contentOffset） */
    private fun recalcWindowSize() {
        try {
            val lp = layoutParams ?: return
            val density = resources.displayMetrics.density
            val frameW = petView?.drawable?.let {
                (it as? com.bumptech.glide.load.resource.gif.GifDrawable)?.firstFrame?.width
            } ?: return
            val frameH = petView?.drawable?.let {
                (it as? com.bumptech.glide.load.resource.gif.GifDrawable)?.firstFrame?.height
            } ?: return

            val contentW = (frameW - 2 * Math.abs(contentOffsetDx)).coerceAtLeast(1f)
            val contentH = (frameH - 2 * Math.abs(contentOffsetDy)).coerceAtLeast(1f)
            val contentScale = maxOf(contentW, contentH)
            if (contentScale <= 0f) return

            // 窗口大小 = sizeDp / (内容占帧比例)
            val windowDp = (sizeDp * maxOf(frameW, frameH) / contentScale)
            val windowPx = (windowDp * density).toInt()

            // 保存旧的窗口中心位置（屏幕坐标）
            val oldCenterX = lp.x + lp.width / 2f
            val oldCenterY = lp.y + lp.height / 2f

            lp.width = windowPx
            lp.height = windowPx

            // 窗口位置：让内容中心 = 目标屏幕位置
            val targetX = (oldCenterX - contentOffsetDx * (windowPx.toFloat() / frameW)).toInt()
            val targetY = (oldCenterY - contentOffsetDy * (windowPx.toFloat() / frameH)).toInt()
            lp.x = targetX - windowPx / 2
            lp.y = targetY - windowPx / 2

            windowManager?.updateViewLayout(petView!!, lp)
            Log.d(TAG, "recalcWindowSize: offset=($contentOffsetDx,$contentOffsetDy), frame=${frameW}x${frameH}, window=${windowPx}px")
        } catch (e: Exception) {
            Log.w(TAG, "recalcWindowSize error", e)
        }
    }

    private fun removeFloatingWindow() {
        petView?.let {
            it.clearGif()
            try {
                windowManager?.removeView(it)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "View already removed: ${e.message}")
            }
        }
        petView = null
        windowManager = null
    }

    // --- Touch / Gesture ---

    private fun openApp() {
        Log.d(TAG, "openApp called")
        dismissBubble()
        val intent = Intent(this, com.clawd.mobile.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        startActivity(intent)
    }

    private fun cancelPendingReactions() {
        // 预留：未来如有 postDelayed 回调可在此取消
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
                if (!isDragging && (dx * dx + dy * dy) > 100) {
                    isDragging = true
                    dismissBubble()
                }
                if (isDragging) {
                    val lp = layoutParams ?: return false
                    lp.x = initialX + dx
                    lp.y = initialY + dy
                    try {
                        windowManager?.updateViewLayout(petView!!, lp)
                    } catch (_: Exception) {}
                }
                return true
            }
        })
        petView!!.gestureDetector = gestureDetector
    }

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
            } catch (_: Exception) {}
        }
        bubbleView = null
        bubbleParams = null
    }

    private fun showBubble() {
        val density = resources.displayMetrics.density
        val maxBubbleW = (280 * density).toInt()
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val maxBubbleH = (screenH * 0.4).toInt()

        // Get current sessions
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
        newBubble.onEnterApp = {
            openApp()
        }

        // Measure to get dimensions
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
        val marginPx = (16 * density).toInt()
        val gapPx = (8 * density).toInt()

        // Horizontal: center on pet, clamp to screen
        var x = petX + (petW - bubbleW) / 2
        x = x.coerceIn(marginPx, screenW - bubbleW - marginPx)

        // Vertical: prefer above pet, fallback below
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

        // Detect outside touch to dismiss
        newBubble.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE) {
                dismissBubble()
                true
            } else false
        }

        windowManager?.addView(newBubble, params)
        bubbleView = newBubble
        bubbleParams = params

        // Real-time update via coroutine
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

    // --- State Collector ---

    private fun startStateCollector() {
        stateCollectorJob?.cancel()
        stateCollectorJob = scope.launch {
            while (true) {
                // Wait for WebSocket to become available
                val ws = waitForWebSocket()
                Log.d(TAG, "WebSocket acquired, collecting sessions")
                try {
                    collectSessions(ws)
                } catch (_: Exception) {
                    Log.d(TAG, "State collector exception, retrying")
                }
                val idleResId = PetGifLoader.getGifResId("idle", 0, character) ?: 0
                if (idleResId != 0) petView?.loadGif(idleResId)
                delay(3000)
            }
        }
    }

    private suspend fun waitForWebSocket(): com.clawd.mobile.ws.ClawdWebSocket {
        while (true) {
            WebSocketService.getWebSocket()?.let { return it }
            delay(3000)
        }
    }

    /** Collects sessions; returns when connection drops so caller can re-acquire ws. */
    private suspend fun collectSessions(ws: com.clawd.mobile.ws.ClawdWebSocket) {
        val disconnected = Channel<Unit>(Channel.CONFLATED)
        val watcher = scope.launch {
            ws.connectionState.collect { state ->
                if (state == ConnectionState.DISCONNECTED || state == ConnectionState.AUTH_FAILED) {
                    Log.d(TAG, "Connection lost (state=$state)")
                    disconnected.send(Unit)
                }
            }
        }
        try {
            var lastUpdateTime = System.currentTimeMillis()
            val collectJob = scope.launch {
                ws.sessions.collect { sessions ->
                    val visible = sessions.values.filter { it.isVisible }
                    if (visible.isEmpty()) {
                        enterIdleCycle()
                        lastUpdateTime = System.currentTimeMillis()
                        return@collect
                    }

                    // Bug 3 fix: sessionCount 只计算活跃任务（非 idle/sleeping）
                    val activeSessions = visible.filter {
                        val s = it.displayState ?: it.state
                        s != "idle" && s != "sleeping"
                    }

                    val bestSession = visible.minByOrNull {
                        Session.STATE_PRIORITY[it.displayState ?: it.state] ?: 99
                    }
                    val bestState = bestSession?.displayState ?: bestSession?.state ?: "idle"
                    val updatedAt = bestSession?.updatedAt ?: 0L
                    val stale = updatedAt > 0 && (System.currentTimeMillis() - updatedAt) > 30_000

                    // Bug 5 fix: 检测 badge 从 running → done，触发 happy 插播
                    checkBadgeTransitions(sessions.values)
                    // 更新 prevBadge
                    sessions.values.forEach { s ->
                        val sid = s.sessionId ?: return@forEach
                        prevBadge[sid] = s.badge
                    }

                    if (stale || bestState == "idle") {
                        if (stale) Log.d(TAG, "Session stale, forcing idle")
                        // Bug 4 fix: attention 结束后检查是否还有其他活跃任务
                        if (bestState == "attention" && !stale) {
                            stopIdleCycle()
                            val resId = PetGifLoader.getGifResId("attention", activeSessions.size, character)
                            if (resId != 0 && resId != null) {
                                lastNonIdleState = "attention"
                                petView?.loadGif(resId)
                            }
                            // attention 播完后延迟检查是否有其他任务
                            delay(3000)
                            // 重新检查是否有活跃任务
                            val recheckWs = WebSocketService.getWebSocket()
                            val recheckSessions = recheckWs?.sessions?.value?.values?.filter { it.isVisible } ?: emptyList()
                            val recheckActive = recheckSessions.filter {
                                val s = it.displayState ?: it.state
                                s != "idle" && s != "sleeping" && s != "attention"
                            }
                            if (recheckActive.isNotEmpty()) {
                                val recheckBest = recheckActive.minByOrNull {
                                    Session.STATE_PRIORITY[it.displayState ?: it.state] ?: 99
                                }
                                val recheckState = recheckBest?.displayState ?: recheckBest?.state ?: "idle"
                                val recheckResId = PetGifLoader.getGifResId(recheckState, recheckActive.size, character)
                                if (recheckResId != 0 && recheckResId != null) {
                                    lastNonIdleState = recheckState
                                    petView?.loadGif(recheckResId)
                                }
                            } else {
                                enterIdleCycle()
                            }
                        } else {
                            enterIdleCycle()
                        }
                    } else {
                        stopIdleCycle()
                        if (bestState != "idle" && bestState != "sleeping") {
                            lastNonIdleState = bestState
                        }
                        Log.d(TAG, "State update: displayState=${bestSession?.displayState}, state=${bestSession?.state}, resolved=$bestState, activeCount=${activeSessions.size}, character=$character")
                        val resId = PetGifLoader.getGifResId(bestState, activeSessions.size, character)
                        if (resId != 0 && resId != null) {
                            petView?.loadGif(resId)
                        }
                    }
                    lastUpdateTime = System.currentTimeMillis()
                }
            }
            val watchdogJob = scope.launch {
                while (true) {
                    delay(10_000)
                    val elapsed = System.currentTimeMillis() - lastUpdateTime
                    if (elapsed > 60_000) {
                        Log.d(TAG, "No session updates for ${elapsed / 1000}s, forcing idle")
                        enterIdleCycle()
                        lastUpdateTime = System.currentTimeMillis()
                    }
                }
            }
            disconnected.receive()
            collectJob.cancel()
            watchdogJob.cancel()
        } finally {
            stopIdleCycle()
            watcher.cancel()
            disconnected.close()
        }
    }

    // --- Bug 5: Badge transition detection ---

    /** 检测 badge 从 running → done，触发 1.5s happy 插播 */
    private fun checkBadgeTransitions(sessions: Collection<SessionData>) {
        for (s in sessions) {
            val sid = s.sessionId ?: continue
            val prev = prevBadge[sid] ?: continue
            val curr = s.badge
            // running → done：任务完成
            if (isRunningBadge(prev) && curr == "done") {
                Log.d(TAG, "Badge transition: $prev → done for session $sid, playing happy")
                val happyResId = PetGifLoader.getGifResId("attention", 0, character)
                if (happyResId != null && happyResId != 0) {
                    loadReactionAndRestore(happyResId, 1500)
                }
            }
        }
    }

    private fun isRunningBadge(badge: String): Boolean {
        return badge == "running" || badge == "working" || badge == "thinking"
            || badge == "tool_use" || badge == "typing"
    }

    // --- Idle Animation Cycle ---

    /** 进入 idle 循环：先检查是否需要播放 attention，然后 idle 循环 */
    private fun enterIdleCycle() {
        if (idleCycleJob?.isActive == true) return // 已经在循环中
        idleCycleJob = scope.launch {
            // 如果最后状态是 attention，先播放 3 秒
            if (lastNonIdleState == "attention") {
                val attentionResId = PetGifLoader.getGifResId("attention", 0, character)
                if (attentionResId != null && attentionResId != 0) {
                    petView?.loadGif(attentionResId)
                    delay(3000)
                }
            }
            // 进入正常 idle 循环
            while (true) {
                val idleResId = PetGifLoader.getGifResId("idle", 0, character) ?: 0
                if (idleResId != 0) petView?.loadGif(idleResId)
                delay(30_000)
                // 尝试播放 reading GIF（仅 clawd 和 cloudling 有）
                val readingResId = PetGifLoader.getReadingGifResId(character)
                if (readingResId != null) {
                    petView?.loadGif(readingResId)
                    delay(5_000)
                }
            }
        }
    }

    /** 退出 idle 循环（有活跃任务时） */
    private fun stopIdleCycle() {
        idleCycleJob?.cancel()
        idleCycleJob = null
    }

    // --- Reaction: play-once-then-restore (Bug 5 happy injection) ---

    /**
     * 加载反应 GIF，播完后恢复之前的状态。
     * 使用 generation 机制防止多次快速触发时旧的恢复覆盖新的。
     */
    private fun loadReactionAndRestore(gifResId: Int, delayMs: Long) {
        val view = petView ?: return
        val gen = ++gifGeneration
        val ws = WebSocketService.getWebSocket()
        val currentState = ws?.sessions?.value?.values
            ?.filter { it.isVisible }
            ?.minByOrNull { Session.STATE_PRIORITY[it.displayState ?: it.state] ?: 99 }
            ?.let { it.displayState ?: it.state } ?: "idle"
        val restoreResId = PetGifLoader.getGifResId(currentState, 1, character)

        PetGifLoader.loadGifWithReady(view, gifResId, force = true) {
            scope.launch {
                delay(delayMs)
                if (gifGeneration != gen) return@launch
                if (restoreResId != null && restoreResId != 0) {
                    petView?.loadGif(restoreResId, force = true)
                }
            }
        }
    }

    // --- Broadcast Receiver ---

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
            try { unregisterReceiver(it) } catch (_: Exception) {}
        }
        broadcastReceiver = null
    }

    private fun updateSize() {
        val density = resources.displayMetrics.density
        val sizePx = (sizeDp * density).toInt()
        layoutParams?.width = sizePx
        layoutParams?.height = sizePx
        // Bug 1 fix: 立即重新计算内容偏移和窗口位置
        recalcWindowSize()
    }

    private fun reloadGif() {
        stateCollectorJob?.cancel()
        stopIdleCycle()
        cancelPendingReactions()
        petView?.clearGif()
        val resId = PetGifLoader.getGifResId("idle", 0, character)
        Log.d(TAG, "reloadGif: character=$character, resId=$resId")
        if (resId != null && resId != 0) petView?.loadGif(resId, force = true)
        startStateCollector()
    }
}

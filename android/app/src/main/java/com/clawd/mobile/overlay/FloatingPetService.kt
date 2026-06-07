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
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.clawd.mobile.ClawdApp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.service.WsConnectionService
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
        const val ACTION_PET_RECENTER = "com.clawd.mobile.PET_RECENTER"
        const val ACTION_PET_SLEEP_TIMEOUT = "com.clawd.mobile.PET_SLEEP_TIMEOUT"
        const val ACTION_DISCONNECT = "com.clawd.mobile.ACTION_DISCONNECT"
        const val EXTRA_SLEEP_SEC = "sleep_sec"
        const val EXTRA_SIZE_DP = "size_dp"
        const val EXTRA_CHARACTER = "character"
        private const val NOTIFICATION_ID = 9001
        private const val DEFAULT_SIZE_DP = 96

        /** Whether the service is currently alive. Used by Settings to avoid redundant starts. */
        @Volatile
        var isRunning = false
            private set
    }

    // --- View & window ---
    private var windowManager: WindowManager? = null
    private var petView: FloatingPetView? = null
    private var layoutParams: WindowManager.LayoutParams? = null
    private var sizeDp = DEFAULT_SIZE_DP
    private var character = "clawd"

    // --- Coroutine plumbing ---
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var started = false
    private var commandCollectorJob: Job? = null

    // --- State management ---
    private lateinit var stateManager: PetStateManager

    // --- Prefs ---
    private lateinit var prefsStore: PrefsStore

    // --- Extracted helpers ---
    private var windowController: PetWindowController? = null
    private var gestureHandler: PetGestureHandler? = null
    private var bubbleManager: PetBubbleManager? = null

    // --- Broadcast receiver ---
    private var broadcastReceiver: BroadcastReceiver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    // ======================================================================
    //  Lifecycle
    // ======================================================================

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        Log.d(TAG, "onCreate")

        prefsStore = PrefsStore.getInstance(this)
        val sessionsFlow = WsConnectionService.getClient()?.sessions
            ?: kotlinx.coroutines.flow.MutableStateFlow(emptyMap())
        stateManager = PetStateManager(character, sessionsFlow)
        stateManager.sleepTimeoutMs = prefsStore.getSleepTimeoutSec().toLong() * 1000L

        startForeground(NOTIFICATION_ID, buildNotification())
        loadPrefs()
        registerBroadcastReceiver()
        showFloatingWindow()
        reloadGif()
        started = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            Log.d(TAG, "ACTION_DISCONNECT received, gracefully shutting down")
            started = false
            bubbleManager?.dismiss()
            stateManager.reset()
            commandCollectorJob?.cancel()
            unregisterBroadcastReceiver()
            windowController?.savePosition(prefsStore)
            windowController?.removeView()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (started) {
            Log.d(TAG, "onStartCommand: already started, cleaning up first")
            bubbleManager?.dismiss()
            stateManager.reset()
            commandCollectorJob?.cancel()
            windowController?.removeView()
            petView?.destroy()
            windowController = null
            petView = null
            showFloatingWindow()
            reloadGif()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
        isRunning = false
        started = false
        bubbleManager?.dismiss()
        stateManager.reset()
        commandCollectorJob?.cancel()
        scope.cancel()
        unregisterBroadcastReceiver()
        windowController?.savePosition(prefsStore)
        windowController?.removeView()
        petView?.destroy()
        petView = null
        super.onDestroy()
    }

    // ======================================================================
    //  Unified command collection
    // ======================================================================

    private fun reloadGif() {
        stateManager.character = character
        petView?.character = character
        stateManager.reset()
        commandCollectorJob?.cancel()
        petView?.clearSvg()

        commandCollectorJob = scope.launch(Dispatchers.Main) {
            stateManager.start(this)
            // Collect state commands
            launch {
                stateManager.stateFlow.collect { command ->
                    handleCommand(command)
                }
            }
            // Collect SSE reaction events from server
            launch {
                WsConnectionService.getClient()?.reactions?.collect { svg ->
                    val path = "svg/$character/$svg"
                    stateManager.loadReaction(path)
                }
            }
        }
    }

    private fun handleCommand(command: PetStateManager.StateCommand) {
        when (command) {
            is PetStateManager.StateCommand.StateChanged -> {
                val state = command.state
                val sessionCount = command.sessionCount
                // Use server-resolved SVG when available (displayHintMap match),
                // otherwise fall back to local tier/fallback logic.
                val assetPath = command.resolvedSvg?.let { "svg/$character/$it" }
                    ?: SvgLoader.resolveSvgAsset(state, sessionCount, character)
                val isOneshot = state in PetState.ONESHOT_STATES
                Log.d("PetState", "handleCommand state=${state.themeKey} sessionCount=$sessionCount assetPath=$assetPath isOneshot=$isOneshot")
                if (assetPath != null) {
                    // Oneshot states: loop=false so the SVG plays once then stops
                    // on its last frame. The autoReturn timer in PetStateManager
                    // handles the transition back to the resolved display state.
                    SvgLoader.loadSvg(
                        petView ?: return, assetPath,
                        loop = !isOneshot,
                        onFinished = null
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
        sizeDp = prefsStore.getPetSizeDp()
        character = prefsStore.getPetCharacter()
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

        val defaultCx = screenW / 2f
        val defaultCy = screenH / 2f
        val savedCx = prefsStore.getPetContentCx(defaultCx)
        val savedCy = prefsStore.getPetContentCy(defaultCy)
        val savedX = (savedCx - sizePx / 2f).toInt()
        val savedY = (savedCy - sizePx / 2f).toInt()

        petView = FloatingPetView(this).apply {
            setBackgroundColor(0)
            targetContentPx = sizePx
            character = this@FloatingPetService.character
        }

        layoutParams = WindowManager.LayoutParams(
            sizePx, sizePx,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = savedX
            y = savedY
        }

        // Initialize helpers
        windowController = PetWindowController(
            context = this,
            windowManager = windowManager!!,
            getPetView = { petView },
            layoutParams = layoutParams!!
        )

        bubbleManager = PetBubbleManager(
            context = this,
            windowManager = windowManager!!,
            scope = scope,
            getPetView = { petView },
            onEnterApp = { openApp() }
        )

        gestureHandler = PetGestureHandler(
            context = this,
            layoutParams = layoutParams!!,
            windowManager = windowManager!!,
            getPetView = { petView },
            onDragStart = {
                bubbleManager?.dismiss()
                stateManager.triggerDragReaction()
            },
            onDragEnd = {
                stateManager.restoreFromDragReaction()
            },
            onSingleTap = {
                layoutParams?.let { bubbleManager?.toggle(it) }
            },
            onDoubleTap = {
                stateManager.triggerClickReaction()
            },
            onTripleTap = {
                stateManager.triggerEasterEgg()
            }
        )
        petView!!.gestureDetector = gestureHandler!!.gestureDetector
        petView!!.gestureHandler = gestureHandler!!

        petView!!.onTouchUp = { event -> gestureHandler?.onTouchUp(event) }
        petView!!.onDragEnd = {
            windowController?.snapToEdge()
            windowController?.savePosition(prefsStore)
        }
        petView!!.onContentReady = { offsetDx, offsetDy, fW, fH ->
            windowController?.let {
                it.contentOffsetDx = offsetDx
                it.contentOffsetDy = offsetDy
                it.svgFrameW = fW
                it.svgFrameH = fH
                it.recalcWindowSize(sizeDp)
            }
        }
        petView!!.onInsetsReady = {
            windowController?.snapToEdge()
            windowController?.updateTouchRegion()
        }
        petView!!.onTouchRegionUpdate = {
            windowController?.updateTouchRegion()
        }
        petView!!.windowManagerForTouch = windowManager
        petView!!.overlayLayoutParams = layoutParams
        petView!!.clickThroughEnabled = prefsStore.isClickThroughEnabled()

        windowManager?.addView(petView!!, layoutParams)
        petView!!.post { petView!!.cacheHitTestBitmap() }
        Log.d(TAG, "Pet view added at x=$savedX, y=$savedY, size=$sizePx")
    }

    private fun openApp() {
        Log.d(TAG, "openApp called")
        bubbleManager?.dismiss()
        val intent = Intent(this, com.clawd.mobile.MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        startActivity(intent)
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
                    ACTION_PET_RECENTER -> {
                        Log.d(TAG, "Recenter pet to screen center")
                        windowController?.recenterToScreen()
                    }
                    ACTION_PET_SLEEP_TIMEOUT -> {
                        val sec = intent.getIntExtra(EXTRA_SLEEP_SEC, 60)
                        stateManager.sleepTimeoutMs = sec.toLong() * 1000L
                        Log.d(TAG, "Sleep timeout changed to ${sec}s")
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_PET_SIZE)
            addAction(ACTION_PET_CHARACTER)
            addAction(ACTION_PET_RECENTER)
            addAction(ACTION_PET_SLEEP_TIMEOUT)
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
        val lp = layoutParams
        val lockedCX = lp?.let { it.x + it.width / 2f }
        val lockedCY = lp?.let { it.y + it.height / 2f }

        val density = resources.displayMetrics.density
        val sizePx = (sizeDp * density).toInt()
        petView?.targetContentPx = sizePx

        windowController?.recalcWindowSize(sizeDp, lockedCX, lockedCY)

        petView?.requestLayout()
        petView?.invalidate()
    }
}

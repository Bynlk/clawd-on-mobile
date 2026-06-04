package com.clawd.mobile.overlay

import android.content.Context
import android.graphics.PixelFormat
import android.graphics.Rect
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import com.clawd.mobile.service.SseService
import com.clawd.mobile.ws.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Manages the info bubble that appears above/below the pet on tap.
 */
class PetBubbleManager(
    private val context: Context,
    private val windowManager: WindowManager,
    private val scope: CoroutineScope,
    private val getPetView: () -> FloatingPetView?,
    private val onEnterApp: () -> Unit
) {
    companion object {
        private const val TAG = "PetBubbleManager"
        private const val BUBBLE_MAX_WIDTH_DP = 280
        private const val BUBBLE_HEIGHT_SCREEN_RATIO = 0.4
        private const val BUBBLE_MARGIN_DP = 16
        private const val BUBBLE_GAP_DP = 8
    }

    private var bubbleView: PetBubbleView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleUpdateJob: Job? = null

    fun toggle(petLayoutParams: WindowManager.LayoutParams) {
        if (bubbleView != null) dismiss() else show(petLayoutParams)
    }

    fun dismiss() {
        bubbleUpdateJob?.cancel()
        bubbleUpdateJob = null
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

    private fun show(petLayoutParams: WindowManager.LayoutParams) {
        val density = context.resources.displayMetrics.density
        val maxBubbleW = (BUBBLE_MAX_WIDTH_DP * density).toInt()
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels
        val maxBubbleH = (screenH * BUBBLE_HEIGHT_SCREEN_RATIO).toInt()

        val ws = SseService.getClient()
        val connectionState = ws?.connectionState?.value
        val sessions = ws?.sessions?.value?.values?.filter { it.isVisible } ?: emptyList()

        val newBubble = PetBubbleView(context)
        if (ws == null || connectionState == ConnectionState.DISCONNECTED
            || connectionState == ConnectionState.AUTH_FAILED
            || connectionState == ConnectionState.CIRCUIT_OPEN) {
            newBubble.showNotConnected()
        } else if (sessions.isEmpty()) {
            newBubble.showNoSessions()
        } else {
            newBubble.updateSessions(sessions)
        }
        newBubble.onEnterApp = onEnterApp

        newBubble.measure(
            android.view.View.MeasureSpec.makeMeasureSpec(maxBubbleW, android.view.View.MeasureSpec.AT_MOST),
            android.view.View.MeasureSpec.makeMeasureSpec(maxBubbleH, android.view.View.MeasureSpec.AT_MOST)
        )

        val bubbleW = newBubble.measuredWidth
        val bubbleH = newBubble.measuredHeight
        val marginPx = (BUBBLE_MARGIN_DP * density).toInt()
        val gapPx = (BUBBLE_GAP_DP * density).toInt()

        // Use content rect (excluding transparent padding) for bubble positioning
        val windowRect = Rect(petLayoutParams.x, petLayoutParams.y,
            petLayoutParams.x + petLayoutParams.width, petLayoutParams.y + petLayoutParams.height)
        val contentRect = getPetView()?.getContentRect(windowRect) ?: windowRect

        var x = contentRect.centerX() - bubbleW / 2
        x = x.coerceIn(marginPx, screenW - bubbleW - marginPx)

        var y = contentRect.top - bubbleH - gapPx
        if (y < marginPx) {
            y = contentRect.bottom + gapPx
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
                dismiss()
                true
            } else false
        }

        windowManager.addView(newBubble, params)
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
}

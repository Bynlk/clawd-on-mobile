package com.clawd.mobile.overlay

import android.content.Context
import android.util.Log
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.WindowManager

/**
 * Handles pet touch gestures: drag (reaction + reposition), single tap (bubble toggle), double tap (reaction).
 */
class PetGestureHandler(
    context: Context,
    private val layoutParams: WindowManager.LayoutParams,
    private val windowManager: WindowManager,
    private val getPetView: () -> FloatingPetView?,
    private val onDragStart: () -> Unit,
    private val onDragEnd: () -> Unit,
    private val onSingleTap: () -> Unit,
    private val onDoubleTap: (MotionEvent) -> Unit,
    private val onTripleTap: () -> Unit = {}
) {
    companion object {
        private const val TAG = "PetGestureHandler"
        private const val DRAG_THRESHOLD_SQ_PX = 100
        private const val TRIPLE_TAP_TIMEOUT_MS = 600L
    }

    private var tapCount = 0
    private var lastTapTime = 0L

    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    var isDragging = false
        private set

    val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean {
            layoutParams.let {
                initialX = it.x
                initialY = it.y
            }
            initialTouchX = e.rawX
            initialTouchY = e.rawY
            isDragging = false
            return true
        }

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            tapCount = 0
            Log.d(TAG, "Single tap → toggleBubble")
            onSingleTap()
            return true
        }

        override fun onDoubleTapEvent(e: MotionEvent): Boolean {
            // Fires on second tap DOWN — before onSingleTapConfirmed resolves.
            // Returning true consumes the event, preventing single-tap from also firing.
            if (e.action == MotionEvent.ACTION_DOWN) {
                val now = System.currentTimeMillis()
                if (tapCount >= 2 && now - lastTapTime < TRIPLE_TAP_TIMEOUT_MS) {
                    // Third tap within timeout → triple tap!
                    Log.d(TAG, "Triple tap → Easter egg")
                    tapCount = 0
                    onTripleTap()
                } else {
                    // Second tap → double tap reaction
                    Log.d(TAG, "Double tap → reaction")
                    tapCount = 2
                    lastTapTime = now
                    onDoubleTap(e)
                }
            }
            return true
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            if (e1 == null) return false
            val dx = (e2.rawX - initialTouchX).toInt()
            val dy = (e2.rawY - initialTouchY).toInt()
            if (!isDragging && (dx * dx + dy * dy) > DRAG_THRESHOLD_SQ_PX) {
                isDragging = true
                onDragStart()
            }
            if (isDragging) {
                layoutParams.x = initialX + dx
                layoutParams.y = initialY + dy
                try {
                    getPetView()?.let { windowManager.updateViewLayout(it, layoutParams) }
                } catch (e: Exception) {
                    Log.w(TAG, "updateViewLayout during drag failed", e)
                }
            }
            return true
        }

    })

    /**
     * Call from the view's onTouchEvent for ACTION_UP/ACTION_CANCEL detection.
     * Handles drag-end cleanup that GestureDetector doesn't expose.
     */
    fun onTouchUp(event: MotionEvent) {
        if (event.action == MotionEvent.ACTION_UP || event.action == MotionEvent.ACTION_CANCEL) {
            if (isDragging) {
                isDragging = false
                onDragEnd()
            }
        }
    }
}

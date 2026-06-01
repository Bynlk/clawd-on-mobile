package com.clawd.mobile.overlay

import android.content.Context
import android.util.Log
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.WindowManager

/**
 * Handles pet touch gestures: drag, single tap (bubble toggle), double tap (open app).
 */
class PetGestureHandler(
    context: Context,
    private val layoutParams: WindowManager.LayoutParams,
    private val windowManager: WindowManager,
    private val getPetView: () -> FloatingPetView?,
    private val onDragStart: () -> Unit,
    private val onSingleTap: () -> Unit,
    private val onDoubleTap: () -> Unit
) {
    companion object {
        private const val TAG = "PetGestureHandler"
        private const val DRAG_THRESHOLD_SQ_PX = 100
    }

    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    private var isDragging = false

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
            Log.d(TAG, "Single tap → toggleBubble")
            onSingleTap()
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            Log.d(TAG, "Double tap → openApp")
            onDoubleTap()
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
}

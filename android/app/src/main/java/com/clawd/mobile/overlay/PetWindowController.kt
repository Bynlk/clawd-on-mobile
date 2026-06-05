package com.clawd.mobile.overlay

import android.content.Context
import android.util.Log
import android.view.WindowManager
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.util.SafeExecutor

/**
 * Manages the floating pet window: creation, sizing, edge-snap, position persistence.
 */
class PetWindowController(
    private val context: Context,
    private val windowManager: WindowManager,
    private val getPetView: () -> FloatingPetView?,
    val layoutParams: WindowManager.LayoutParams
) {
    companion object {
        private const val TAG = "PetWindowController"
        private const val EDGE_MARGIN_DP = 16
        private const val VIEWPORT_PADDING_RATIO = 0.15f
    }

    var contentOffsetDx = 0f
    var contentOffsetDy = 0f
    var svgFrameW: Int = 0
    var svgFrameH: Int = 0
    private var lastSizeDp: Int = -1

    /**
     * Recalculate window size based on SVG frame dimensions.
     * @param lockedCenterX optional pre-captured center X (avoids drift on rapid calls)
     * @param lockedCenterY optional pre-captured center Y
     */
    fun recalcWindowSize(
        sizeDp: Int,
        lockedCenterX: Float? = null,
        lockedCenterY: Float? = null
    ) {
        try {
            val lp = layoutParams
            val petView = getPetView() ?: return
            val density = context.resources.displayMetrics.density

            val frameW = svgFrameW.toFloat()
            val frameH = svgFrameH.toFloat()
            if (frameW <= 0f || frameH <= 0f) {
                val safePx = (sizeDp * density).toInt()
                lp.width = safePx
                lp.height = safePx
                windowManager.updateViewLayout(petView, lp)
                return
            }

            val contentW = (frameW - 2 * Math.abs(contentOffsetDx)).coerceAtLeast(1f)
            val contentH = (frameH - 2 * Math.abs(contentOffsetDy)).coerceAtLeast(1f)
            val contentScale = maxOf(contentW, contentH)
            if (contentScale <= 0f) return

            val paddedContentScale = contentScale * (1f - VIEWPORT_PADDING_RATIO)
            val windowDp = (sizeDp * maxOf(frameW, frameH) / paddedContentScale)
            val windowPx = (windowDp * density).toInt().coerceAtLeast((80 * density).toInt())

            val oldWindowPx = lp.width
            if (windowPx == oldWindowPx && sizeDp == lastSizeDp) return
            lastSizeDp = sizeDp

            val oldCenterX = lockedCenterX ?: (lp.x + lp.width / 2f)
            val oldCenterY = lockedCenterY ?: (lp.y + lp.height / 2f)

            lp.width = windowPx
            lp.height = windowPx

            val targetX = (oldCenterX - contentOffsetDx * (windowPx.toFloat() / frameW)).toInt()
            val targetY = (oldCenterY - contentOffsetDy * (windowPx.toFloat() / frameH)).toInt()
            lp.x = targetX - windowPx / 2
            lp.y = targetY - windowPx / 2

            windowManager.updateViewLayout(petView, lp)

            petView.targetContentPx = windowPx
            petView.requestLayout()
            petView.invalidate()
            // Re-cache hit-test bitmap after layout pass completes (window size changed)
            petView.post { petView.cacheHitTestBitmap() }
            updateTouchRegion()
            Log.d(TAG, "recalcWindowSize: offset=($contentOffsetDx,$contentOffsetDy), frame=${frameW}x${frameH}, window=${windowPx}px")
        } catch (e: Exception) {
            Log.e(TAG, "recalcWindowSize error", e)
        }
    }

    /**
     * Snap the pet to the nearest screen edge, accounting for content insets.
     * Uses [FloatingPetView.getContentRect] which handles both fixed bounds
     * (Clawd/Cloudling) and dynamic visualInsets (Calico).
     */
    fun snapToEdge() {
        val petView = getPetView() ?: return
        val lp = layoutParams
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels

        val windowRect = android.graphics.Rect(lp.x, lp.y, lp.x + lp.width, lp.y + lp.height)
        val contentRect = petView.getContentRect(windowRect)

        // No insets → allow free positioning
        if (contentRect == windowRect) return

        // Left/right/bottom: full pull-back. Top: allow half the content above screen.
        var adjusted = false
        val contentH = contentRect.height()
        if (contentRect.left < 0) { lp.x -= contentRect.left; adjusted = true }
        if (contentRect.right > screenW) { lp.x -= contentRect.right - screenW; adjusted = true }
        if (contentRect.bottom > screenH) { lp.y -= contentRect.bottom - screenH; adjusted = true }
        if (contentRect.top < -(contentH / 2)) {
            lp.y -= contentRect.top + contentH / 2
            adjusted = true
        }

        if (adjusted) {
            SafeExecutor.tryOrNull(TAG) { windowManager.updateViewLayout(petView, lp) }
        }
    }

    /**
     * Move the pet's visible content center to the screen center.
     */
    fun recenterToScreen() {
        val petView = getPetView() ?: return
        val lp = layoutParams
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels

        val windowRect = android.graphics.Rect(lp.x, lp.y, lp.x + lp.width, lp.y + lp.height)
        val contentRect = petView.getContentRect(windowRect)

        val contentCenterOffsetX = contentRect.centerX() - lp.x
        val contentCenterOffsetY = contentRect.centerY() - lp.y

        lp.x = screenW / 2 - contentCenterOffsetX
        lp.y = screenH / 2 - contentCenterOffsetY

        SafeExecutor.tryOrNull(TAG) { windowManager.updateViewLayout(petView, lp) }
        savePosition(com.clawd.mobile.data.PrefsStore.getInstance(context))
    }

    /**
     * Restrict the window's touchable area to the actual visible content.
     * Transparent regions become click-through at the WindowManager level.
     * Uses reflection for touchRegion (API 33+) since the field is not in compile stubs.
     */
    fun updateTouchRegion() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val petView = getPetView() ?: return
        val lp = layoutParams
        val windowRect = android.graphics.Rect(lp.x, lp.y, lp.x + lp.width, lp.y + lp.height)
        val contentRect = petView.getContentRect(windowRect)
        try {
            val field = lp.javaClass.getField("touchRegion")
            if (contentRect == windowRect) {
                field.set(lp, null)
            } else {
                field.set(lp, android.graphics.Region(
                    contentRect.left, contentRect.top,
                    contentRect.right, contentRect.bottom
                ))
            }
            windowManager.updateViewLayout(petView, lp)
        } catch (e: Exception) {
            Log.w(TAG, "updateTouchRegion failed (API ${android.os.Build.VERSION.SDK_INT})", e)
        }
    }

    /**
     * Save the pet's content center position to PrefsStore.
     */
    fun savePosition(prefsStore: PrefsStore) {
        layoutParams.let {
            val cx = it.x + it.width / 2f + contentOffsetDx
            val cy = it.y + it.height / 2f + contentOffsetDy
            prefsStore.setPetContentPosition(cx, cy)
        }
    }

    fun removeView() {
        getPetView()?.let {
            it.clearSvg()
            try {
                windowManager.removeView(it)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "View already removed: ${e.message}")
            } finally {
                it.destroy()
            }
        }
    }
}

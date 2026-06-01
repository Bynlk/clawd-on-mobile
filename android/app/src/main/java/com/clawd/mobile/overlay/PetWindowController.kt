package com.clawd.mobile.overlay

import android.content.Context
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.graphics.PixelFormat

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
            Log.d(TAG, "recalcWindowSize: offset=($contentOffsetDx,$contentOffsetDy), frame=${frameW}x${frameH}, window=${windowPx}px")
        } catch (e: Exception) {
            Log.e(TAG, "recalcWindowSize error", e)
        }
    }

    /**
     * Snap the pet to the nearest screen edge, accounting for visual insets.
     */
    fun snapToEdge() {
        val petView = getPetView() ?: return
        val lp = layoutParams
        val density = context.resources.displayMetrics.density
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels
        val marginPx = (EDGE_MARGIN_DP * density).toInt()

        val vi = petView.visualInsets ?: FloatingPetView.VisualInsets(0f, 0f, 0f, 0f)
        val vbSize = petView.viewBoxSize ?: 0f
        val windowPx = lp.width.toFloat()

        val scale = if (vbSize > 0f) windowPx / vbSize else 0f
        if (scale > 0f && (vi.left != 0f || vi.top != 0f || vi.right != 0f || vi.bottom != 0f)) {
            val leftPx = (vi.left * scale).toInt()
            val topPx = (vi.top * scale).toInt()
            val rightPx = (vi.right * scale).toInt()
            val bottomPx = (vi.bottom * scale).toInt()

            if (lp.x + leftPx < marginPx) lp.x = marginPx - leftPx
            if (lp.x + lp.width - rightPx > screenW - marginPx) lp.x = screenW - marginPx - lp.width + rightPx
            if (lp.y + topPx < marginPx) lp.y = marginPx - topPx
            if (lp.y + lp.height - bottomPx > screenH - marginPx) lp.y = screenH - marginPx - lp.height + bottomPx

            try { windowManager.updateViewLayout(petView, lp) } catch (_: Exception) {}
        }
    }

    /**
     * Save the pet's content center position to SharedPreferences.
     */
    fun savePosition(prefs: android.content.SharedPreferences) {
        layoutParams.let {
            val cx = it.x + it.width / 2f + contentOffsetDx
            val cy = it.y + it.height / 2f + contentOffsetDy
            prefs.edit()
                .putFloat("pet_content_cx", cx)
                .putFloat("pet_content_cy", cy)
                .apply()
        }
    }

    fun removeView() {
        getPetView()?.let {
            it.clearSvg()
            try {
                windowManager.removeView(it)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "View already removed: ${e.message}")
            }
        }
    }
}

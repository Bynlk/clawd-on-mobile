package com.clawd.mobile.overlay

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.util.AttributeSet
import android.util.Log
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler

/**
 * Floating pet overlay view — WebView-based for SVG rendering.
 *
 * Replaces the previous ImageView+Glide implementation to support CSS-animated
 * SVGs from the PC-side theme system (breathe, blink, tail-sway, etc.).
 *
 * **Hot-swap rendering**: After the initial HTML page loads, all subsequent
 * SVG/APNG changes go through `window.updatePetSvg(url)` via `evaluateJavascript`.
 * This eliminates page-reload flicker and maintains continuous hit-test regions.
 *
 * Touch transparent regions: caches a Bitmap snapshot after each SVG load and
 * checks pixel alpha at the touch point. Transparent pixels pass through to
 * windows below.
 */
class FloatingPetView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
    defStyleRes: Int = 0
) : WebView(context, attrs, defStyleAttr, defStyleRes) {

    companion object {
        private const val TAG = "FloatingPetView"
    }

    /** Whether the HTML page has finished loading (onPageFinished fired). */
    var isPageLoaded: Boolean = false
        internal set

    /** Currently loaded asset path (e.g. "svg/clawd/clawd-idle-follow.svg"). */
    var currentAssetPath: String? = null
        internal set

    /** Target content display size (px). Set by Service for window sizing. */
    var targetContentPx: Int = 0

    /** Current character name (e.g. "clawd"). Set by Service for fixed content bounds lookup. */
    var character: String = "clawd"

    /** Content ready callback: (offsetDx, offsetDy, frameW, frameH). */
    var onContentReady: ((Float, Float, Int, Int) -> Unit)? = null

    /** Gesture detector reference (set by Service). */
    var gestureDetector: GestureDetector? = null

    /** Gesture handler reference (set by Service, used for isDragging check on ACTION_UP). */
    var gestureHandler: PetGestureHandler? = null

    /** Drag end callback (set by Service, used to save position). */
    var onDragEnd: (() -> Unit)? = null

    /** Touch region update callback (set by Service, called after bitmap cache refresh). */
    var onTouchRegionUpdate: (() -> Unit)? = null

    /** Touch up callback (set by Service, used for gesture-handler drag-end detection). */
    var onTouchUp: ((MotionEvent) -> Unit)? = null

    /** Insets ready callback: fired after visualInsets are read from JS. */
    var onInsetsReady: (() -> Unit)? = null

    /** Visual insets: empty padding between SVG viewBox edge and actual visible content (getBBox). */
    data class VisualInsets(val left: Float, val top: Float, val right: Float, val bottom: Float)

    var visualInsets: VisualInsets = VisualInsets(0f, 0f, 0f, 0f)
        private set

    /** viewBox width for scaling insets to window pixels. */
    var viewBoxSize: Float = 0f
        private set

    /**
     * Calculate the screen rect of the actual visible content (excluding transparent padding).
     *
     * For Clawd/Cloudling: uses pre-computed fixed content bounds from SvgLoader,
     * scaled to window pixels with proper `preserveAspectRatio="xMidYMid meet"` handling.
     *
     * For other characters (e.g. Calico): falls back to dynamic visualInsets
     * read from JS getBBox.
     *
     * Falls back to [windowRect] if no bounds are available.
     */
    fun getContentRect(windowRect: Rect): Rect {
        // 1. Try fixed content bounds (Clawd/Cloudling)
        SvgLoader.getFixedContentBounds(character)?.let { bounds ->
            return getContentRectFromBounds(windowRect, bounds)
        }

        // 2. Fall back to dynamic visualInsets (Calico, etc.)
        val vbSize = viewBoxSize
        if (vbSize <= 0f) return windowRect
        val vi = visualInsets
        if (vi.left == 0f && vi.top == 0f && vi.right == 0f && vi.bottom == 0f) return windowRect
        val winW = windowRect.width().toFloat()
        val scale = winW / vbSize
        val left = windowRect.left + (vi.left * scale).toInt()
        val top = windowRect.top + (vi.top * scale).toInt()
        val right = windowRect.right - (vi.right * scale).toInt()
        val bottom = windowRect.bottom - (vi.bottom * scale).toInt()
        return Rect(left, top, right, bottom)
    }

    /**
     * Compute content rect from fixed bounds with `preserveAspectRatio="xMidYMid meet"` scaling.
     *
     * The SVG is rendered in a square window with uniform scaling (min of width/height scale)
     * and centered in the other dimension. Content insets are applied in viewBox coordinates
     * then scaled to window pixels.
     */
    private fun getContentRectFromBounds(
        windowRect: Rect,
        bounds: SvgLoader.FixedContentBounds
    ): Rect {
        val winW = windowRect.width().toFloat()
        val winH = windowRect.height().toFloat()
        if (winW <= 0f || winH <= 0f) return windowRect

        // meet mode: uniform scale = min(w/vbW, h/vbH)
        val scaleX = winW / bounds.vbW
        val scaleY = winH / bounds.vbH
        val scale = minOf(scaleX, scaleY)

        // Centering offset (content is centered in the larger dimension)
        val offsetX = ((winW - bounds.vbW * scale) / 2f).toInt()
        val offsetY = ((winH - bounds.vbH * scale) / 2f).toInt()

        val left = windowRect.left + offsetX + (bounds.contentLeft * scale).toInt()
        val top = windowRect.top + offsetY + (bounds.contentTop * scale).toInt()
        val right = windowRect.right - offsetX - (bounds.contentRight * scale).toInt()
        val bottom = windowRect.bottom - offsetY - (bounds.contentBottom * scale).toInt()

        // Safety: ensure rect is valid
        if (left >= right || top >= bottom) return windowRect
        return Rect(left, top, right, bottom)
    }

    /** Cached bitmap snapshot for transparent click-through hit testing. */
    private var hitTestBitmap: Bitmap? = null

    /** Asset loader: maps https://appassets.androidplatform.net/svg/ → assets/svg/ */
    private val assetLoader = WebViewAssetLoader.Builder()
        .addPathHandler("/", AssetsPathHandler(context.applicationContext))
        .build()

    init {
        // Transparent background — essential for overlay window
        setBackgroundColor(0)

        configureSettings()
        setupWebViewClient()
    }

    private fun configureSettings() {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            loadWithOverviewMode = true
            useWideViewPort = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    private fun setupWebViewClient() {
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request?.url ?: return null)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (view == null) return

                // Ignore about:blank (from clearSvg) — it would falsely set isPageLoaded
                // and cause subsequent loadSvg to use hot-swap on an empty page.
                if (url == "about:blank") return

                // Mark page as loaded — all subsequent SVG changes use hot-swap JS
                isPageLoaded = true

                // Initial dimension read after first page load.
                // The template's XHR sets _svgWidth/_svgHeight; poll briefly for it.
                readDimensionsAndCacheBitmap()
            }
        }
    }

    /**
     * Force the view to match the WindowManager's EXACT size.
     */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(w, h)
    }

    // ======================================================================
    //  SVG loading (called by FloatingPetService via SvgLoader)
    // ======================================================================

    /**
     * Load an SVG/APNG from assets. Called by FloatingPetService.
     *
     * First call: loads full HTML page (template + XHR).
     * Subsequent calls: hot-swaps via `window.updatePetSvg(url)` — zero flicker.
     *
     * @param assetPath Path relative to assets/, e.g. "svg/clawd/clawd-idle-follow.svg"
     */
    fun loadSvg(assetPath: String) {
        if (assetPath == currentAssetPath) return
        currentAssetPath = assetPath
        SvgLoader.loadSvg(this, assetPath, loop = true)
    }

    /**
     * Clear the current SVG content.
     */
    fun clearSvg() {
        currentAssetPath = null
        isPageLoaded = false
        hitTestBitmap?.recycle()
        hitTestBitmap = null
        SvgLoader.clearSvg(this)
    }

    override fun onDetachedFromWindow() {
        hitTestBitmap?.recycle()
        hitTestBitmap = null
        super.onDetachedFromWindow()
    }

    // ======================================================================
    //  Dimension reading & hit-test bitmap (called after SVG loads)
    // ======================================================================

    /**
     * Read SVG dimensions from JS globals and notify [onContentReady].
     * Then cache a hit-test bitmap for transparent click-through.
     *
     * Called from:
     * - [onPageFinished] (initial load)
     * - [SvgLoader.swapSvg] (hot-swap, via postDelayed)
     */
    internal fun readDimensionsAndCacheBitmap() {
        val js = """
            (function() {
                if (window._svgWidth > 0 && window._svgHeight > 0)
                    return window._svgWidth + ',' + window._svgHeight;
                var svg = document.querySelector('.container svg');
                if (!svg) return '0,0';
                var vb = svg.viewBox.baseVal;
                if (vb && vb.width > 0 && vb.height > 0) return vb.width + ',' + vb.height;
                return (svg.getAttribute('width') || '0') + ',' + (svg.getAttribute('height') || '0');
            })();
        """.trimIndent()

        fun tryQuery(attempt: Int) {
            evaluateJavascript(js) { result ->
                try {
                    val clean = result.trim('"').split(",")
                    val w = clean[0].toIntOrNull() ?: 0
                    val h = clean[1].toIntOrNull() ?: 0
                    if (w > 0 && h > 0) {
                        Log.d(TAG, "SVG dimensions: ${w}x${h}")
                        onContentReady?.invoke(0f, 0f, w, h)
                        readVisualInsets()
                        cacheHitTestBitmap()
                        onTouchRegionUpdate?.invoke()
                    } else if (attempt < 5) {
                        postDelayed({ tryQuery(attempt + 1) }, 100)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "SVG dimension query failed (attempt $attempt)", e)
                    if (attempt < 5) {
                        postDelayed({ tryQuery(attempt + 1) }, 100)
                    }
                }
            }
        }

        tryQuery(0)
    }

    /**
     * Cache a bitmap snapshot of the WebView content.
     * Used for pixel-level transparent click-through detection.
     *
     * Uses ARGB_8888 (not RGB_565) because the alpha channel is essential
     * for transparent click-through detection.
     *
     * Note: LAYER_TYPE_SOFTWARE is required here — HARDWARE would break
     * draw(canvas) pixel capture. The performance cost is negligible for
     * a single small overlay.
     */
    internal fun cacheHitTestBitmap() {
        try {
            val w = width
            val h = height
            if (w <= 0 || h <= 0) return

            hitTestBitmap?.recycle()
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            draw(canvas)
            hitTestBitmap = bmp
            Log.d(TAG, "Hit-test bitmap cached: ${w}x${h}")
        } catch (e: Exception) {
            Log.w(TAG, "cacheHitTestBitmap failed", e)
        }
    }

    /**
     * Read SVG visual insets (getBBox vs viewBox) via JS bridge.
     * These insets represent the empty padding around the actual visible content,
     * used by FloatingPetService for edge-snap correction.
     * Reads from window._visualInsets and window._viewBox set by SvgLoader.
     */
    private fun readVisualInsets() {
        val js = """
            (function() {
                var vi = window._visualInsets;
                var vb = window._viewBox;
                if (!vi || !vb) return '';
                return vi.left + ',' + vi.top + ',' + vi.right + ',' + vi.bottom + ',' + vb.width;
            })();
        """.trimIndent()
        evaluateJavascript(js) { result ->
            try {
                val clean = result.trim('"')
                if (clean.isEmpty() || clean == "null") return@evaluateJavascript
                val parts = clean.split(",").map { it.toFloatOrNull() ?: 0f }
                if (parts.size == 5 && (parts[0] != 0f || parts[1] != 0f || parts[2] != 0f || parts[3] != 0f)) {
                    visualInsets = VisualInsets(parts[0], parts[1], parts[2], parts[3])
                    viewBoxSize = parts[4]
                    Log.d(TAG, "Visual insets: L=${parts[0]} T=${parts[1]} R=${parts[2]} B=${parts[3]} vbW=${parts[4]}")
                }
            } catch (e: Exception) { Log.w(TAG, "readVisualInsets failed", e) }
            onInsetsReady?.invoke()
        }
    }

    /**
     * Check if a touch point hits visible (non-transparent) content.
     * Returns true if the point is on a visible pixel, false if transparent.
     */
    private fun isTouchOnContent(x: Float, y: Float): Boolean {
        val bmp = hitTestBitmap ?: return true // No bitmap → allow all touches
        val bx = x.toInt()
        val by = y.toInt()
        if (bx < 0 || by < 0 || bx >= bmp.width || by >= bmp.height) return false
        return bmp.getPixel(bx, by) ushr 24 != 0
    }

    // ======================================================================
    //  Touch handling
    // ======================================================================

    /** Whether transparent area taps pass through to apps below. Set by FloatingPetService. */
    var clickThroughEnabled = true

    private var transparentTouchStart = false

    /** Set by FloatingPetService for FLAG_NOT_TOUCHABLE toggling. */
    var windowManagerForTouch: WindowManager? = null
    var overlayLayoutParams: WindowManager.LayoutParams? = null

    override fun onTouchEvent(event: MotionEvent): Boolean {
        try {
            if (event.action == MotionEvent.ACTION_DOWN) {
                transparentTouchStart = clickThroughEnabled && !isTouchOnContent(event.x, event.y)
            }

            // Always let gesture detector process all events (drag must always work)
            val handled = gestureDetector?.onTouchEvent(event) ?: super.onTouchEvent(event)

            if (event.action == MotionEvent.ACTION_UP) {
                val wasDragging = gestureHandler?.isDragging == true
                onTouchUp?.invoke(event)
                if (wasDragging) {
                    onDragEnd?.invoke()
                }
                // Click-through: only trigger on tap (not drag) on transparent pixels
                if (!wasDragging && transparentTouchStart) {
                    setWindowTouchable(false)
                    postDelayed({ setWindowTouchable(true) }, 300)
                }
                transparentTouchStart = false
            }
            if (event.action == MotionEvent.ACTION_CANCEL) {
                transparentTouchStart = false
            }

            return handled
        } catch (e: Exception) {
            Log.w(TAG, "onTouchEvent error", e)
            return super.onTouchEvent(event)
        }
    }

    private fun setWindowTouchable(touchable: Boolean) {
        val wm = windowManagerForTouch ?: return
        val lp = overlayLayoutParams ?: return
        val changed = if (touchable) {
            val had = lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0
            lp.flags = lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
            had
        } else {
            val had = lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE == 0
            lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            had
        }
        if (changed) {
            try { wm.updateViewLayout(this, lp) } catch (_: Exception) {}
        }
    }
}

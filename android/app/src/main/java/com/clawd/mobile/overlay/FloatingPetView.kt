package com.clawd.mobile.overlay

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.AttributeSet
import android.util.Log
import android.view.GestureDetector
import android.view.MotionEvent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler

/**
 * Floating pet overlay view — now WebView-based for SVG rendering.
 *
 * Replaces the previous ImageView+Glide implementation to support CSS-animated
 * SVGs from the PC-side theme system (breathe, blink, tail-sway, etc.).
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

    /** Currently loaded asset path (e.g. "svg/clawd/clawd-idle-follow.svg"). */
    var currentAssetPath: String? = null
        internal set

    /** Target content display size (px). Set by Service for window sizing. */
    var targetContentPx: Int = 0

    /** Content ready callback: (offsetDx, offsetDy, frameW, frameH). */
    var onContentReady: ((Float, Float, Int, Int) -> Unit)? = null

    /** Gesture detector reference (set by Service). */
    var gestureDetector: GestureDetector? = null

    /** Drag end callback (set by Service, used to save position). */
    var onDragEnd: (() -> Unit)? = null

    /** Visual insets: empty padding between SVG viewBox edge and actual visible content (getBBox). */
    data class VisualInsets(val left: Float, val top: Float, val right: Float, val bottom: Float)

    var visualInsets: VisualInsets = VisualInsets(0f, 0f, 0f, 0f)
        private set

    /** viewBox width for scaling insets to window pixels. */
    var viewBoxSize: Float = 0f
        private set

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
            // SVG rendering — no JavaScript needed for Clawd/Calico
            // (Cloudling scripted SVGs need JS; enable per-character if needed)
            javaScriptEnabled = true                // SVG 内联 + CSS 动画需要
            domStorageEnabled = false               // 不需要
            // allowFileAccessFromFileURLs / allowUniversalAccessFromFileURLs removed —
            // deprecated in API 30+, default is false (WebViewAssetLoader uses HTTP streams)
            allowContentAccess = false               // 不需要
            // Disable zoom
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // Disable scroll
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            // Performance
            loadWithOverviewMode = true
            useWideViewPort = false
            // Cache
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

                // Poll until async XHR injects SVG into DOM
                fun tryQuery(attempt: Int) {
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

                    view.evaluateJavascript(js) { result ->
                        try {
                            val clean = result.trim('"').split(",")
                            val w = clean[0].toIntOrNull() ?: 0
                            val h = clean[1].toIntOrNull() ?: 0
                            if (w > 0 && h > 0) {
                                Log.d(TAG, "SVG dimensions: ${w}x${h}")
                                onContentReady?.invoke(0f, 0f, w, h)
                                readVisualInsets()
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

                postDelayed({ tryQuery(0) }, 100)
                postDelayed({ cacheHitTestBitmap() }, 500)
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
    //  Hit-test bitmap for transparent click-through
    // ======================================================================

    /**
     * Cache a bitmap snapshot of the WebView content.
     * Used for pixel-level transparent click-through detection.
     */
    private fun cacheHitTestBitmap() {
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

    /**
     * Transparent click-through: ACTION_DOWN checks pixel alpha.
     * Transparent → return false (pass through to windows below).
     * Opaque → delegate to gestureDetector.
     */
    override fun onTouchEvent(event: MotionEvent): Boolean {
        try {
            if (event.action == MotionEvent.ACTION_DOWN) {
                if (!isTouchOnContent(event.x, event.y)) {
                    return false // Transparent region — click through
                }
            }
            val handled = gestureDetector?.onTouchEvent(event) ?: super.onTouchEvent(event)
            if (event.action == MotionEvent.ACTION_UP) {
                onDragEnd?.invoke()
            }
            return handled
        } catch (e: Exception) {
            Log.w(TAG, "onTouchEvent error", e)
            return super.onTouchEvent(event)
        }
    }
}

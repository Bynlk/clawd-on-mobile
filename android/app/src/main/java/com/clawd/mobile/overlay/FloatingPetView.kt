package com.clawd.mobile.overlay

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.RectF
import android.util.AttributeSet
import android.util.Log
import android.view.GestureDetector
import android.view.MotionEvent
import android.widget.ImageView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.DataSource
import com.bumptech.glide.load.engine.GlideException
import com.bumptech.glide.load.resource.gif.GifDrawable
import com.bumptech.glide.request.RequestListener
import com.bumptech.glide.request.target.Target

class FloatingPetView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : ImageView(context, attrs, defStyleAttr) {

    internal var currentResId: Int = -1

    /** 内容就绪回调: (offsetDx, offsetDy, frameW, frameH) */
    var onContentReady: ((Float, Float, Int, Int) -> Unit)? = null

    /** 手势检测器引用（由 Service 设置） */
    var gestureDetector: GestureDetector? = null

    /** 拖拽结束回调（由 Service 设置，用于保存位置） */
    var onDragEnd: (() -> Unit)? = null

    init {
        // Use MATRIX so we can control scaling/translation manually
        scaleType = ScaleType.MATRIX
    }

    /**
     * 加载 GIF 资源。force=true 时跳过 currentResId 检查。
     */
    fun loadGif(resId: Int, force: Boolean = false) {
        if (!force && resId == currentResId) return
        currentResId = resId

        Glide.with(this.context)
            .asGif()
            .load(resId)
            .listener(object : RequestListener<GifDrawable> {
                override fun onLoadFailed(
                    e: GlideException?, model: Any?,
                    target: Target<GifDrawable>, isFirstResource: Boolean
                ): Boolean {
                    Log.w(TAG, "GIF load failed: resId=$resId", e)
                    return false
                }

                override fun onResourceReady(
                    resource: GifDrawable, model: Any, target: Target<GifDrawable>,
                    dataSource: DataSource, isFirstResource: Boolean
                ): Boolean {
                    resource.setLoopCount(GifDrawable.LOOP_FOREVER)
                    if (width > 0 && height > 0) {
                        post { applyContentMatrix(resource.firstFrame) }
                    }
                    // else: onSizeChanged will handle it
                    return false
                }
            })
            .into(this)
    }

    fun clearGif() {
        currentResId = -1
        Glide.with(this.context).clear(this)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w > 0 && h > 0) {
            val drawable = drawable
            if (drawable is GifDrawable) {
                post { applyContentMatrix(drawable.firstFrame) }
            }
        }
    }

    /**
     * Detects the non-transparent bounding box of [bitmap] and applies a
     * Matrix that translates so the visible content is centered in the view.
     */
    private fun applyContentMatrix(bitmap: Bitmap?) {
        if (bitmap == null || bitmap.isRecycled || width == 0 || height == 0) return

        try {
            val contentRect = findContentBounds(bitmap)
            if (contentRect.isEmpty) {
                Log.w(TAG, "Bitmap is entirely transparent, using FIT_CENTER fallback")
                scaleType = ScaleType.FIT_CENTER
                return
            }

            val matrix = Matrix()

            // 不缩放 (scale=1.0)，只平移让内容中心 = 视图中心
            val contentCenterX = contentRect.centerX()
            val contentCenterY = contentRect.centerY()
            matrix.postTranslate(width / 2f - contentCenterX, height / 2f - contentCenterY)
            imageMatrix = matrix

            // 回调通知 Service 内容偏移量
            val offsetDx = contentCenterX - bitmap.width / 2f
            val offsetDy = contentCenterY - bitmap.height / 2f
            onContentReady?.invoke(offsetDx, offsetDy, bitmap.width, bitmap.height)

            Log.d(TAG, "Content matrix applied: contentRect=$contentRect, offset=($offsetDx,$offsetDy), view=${width}x${height}")
        } catch (e: Exception) {
            Log.w(TAG, "applyContentMatrix error", e)
        }
    }

    /**
     * 透明区域点击穿透：ACTION_DOWN 时反变换坐标到 bitmap 空间检查 alpha，
     * 透明 return false（穿透到下方窗口），非透明交给 gestureDetector。
     */
    override fun onTouchEvent(event: MotionEvent): Boolean {
        try {
            if (event.action == MotionEvent.ACTION_DOWN) {
                val curDrawable = drawable
                if (curDrawable is GifDrawable && imageMatrix.isIdentity.not()) {
                    val inv = Matrix()
                    if (imageMatrix.invert(inv)) {
                        val pts = floatArrayOf(event.x, event.y)
                        inv.mapPoints(pts)
                        val bx = pts[0].toInt()
                        val by = pts[1].toInt()
                        val bmp = curDrawable.firstFrame
                        if (bmp != null && !bmp.isRecycled && bx in 0 until bmp.width && by in 0 until bmp.height) {
                            if (bmp.getPixel(bx, by) ushr 24 == 0) {
                                // 透明区域：点击穿透
                                return false
                            }
                        }
                    }
                }
            }
            // 非透明区域：正常处理手势
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

    /**
     * Scans the bitmap to find the tight bounding box of non-transparent pixels.
     * Uses row/column scanning for efficiency (O(w+h) instead of O(w*h)).
     */
    private fun findContentBounds(bitmap: Bitmap): RectF {
        val w = bitmap.width
        val h = bitmap.height

        // Scan rows to find top/bottom
        var top = -1
        var bottom = -1
        for (y in 0 until h) {
            for (x in 0 until w) {
                if (bitmap.getPixel(x, y) ushr 24 != 0) {
                    top = y
                    break
                }
            }
            if (top >= 0) break
        }
        if (top < 0) return RectF() // fully transparent

        for (y in h - 1 downTo top) {
            for (x in 0 until w) {
                if (bitmap.getPixel(x, y) ushr 24 != 0) {
                    bottom = y
                    break
                }
            }
            if (bottom >= 0) break
        }

        // Scan columns to find left/right
        var left = -1
        var right = -1
        for (x in 0 until w) {
            for (y in top..bottom) {
                if (bitmap.getPixel(x, y) ushr 24 != 0) {
                    left = x
                    break
                }
            }
            if (left >= 0) break
        }
        for (x in w - 1 downTo left) {
            for (y in top..bottom) {
                if (bitmap.getPixel(x, y) ushr 24 != 0) {
                    right = x
                    break
                }
            }
            if (right >= 0) break
        }

        return RectF(left.toFloat(), top.toFloat(), (right + 1).toFloat(), (bottom + 1).toFloat())
    }

    companion object {
        private const val TAG = "FloatingPetView"
    }
}

package com.clawd.mobile.overlay

import android.content.Context
import android.util.Log
import com.clawd.mobile.R
import com.bumptech.glide.Glide
import com.bumptech.glide.load.DataSource
import com.bumptech.glide.load.engine.GlideException
import com.bumptech.glide.load.resource.gif.GifDrawable
import com.bumptech.glide.request.RequestListener
import com.bumptech.glide.request.target.Target
import android.widget.ImageView

object PetGifLoader {

    private const val TAG = "PetGifLoader"

    /** 用于 getIdentifier 查询，需要 Context */
    private var appContext: Context? = null

    /** 在 Application.onCreate 或 Service.onCreate 中调用 */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Returns R.raw.xxx resource ID based on displayState + sessionCount.
     * Uses candidate chain: character-specific → clawd-specific → clawd_idle fallback.
     * @param character "clawd" / "calico" / "cloudling", default "clawd"
     */
    fun getGifResId(displayState: String, sessionCount: Int, character: String = "clawd"): Int? {
        return resolveGif(character, displayState, sessionCount)
    }

    /** 返回 reading GIF 的 resId，如果角色没有则返回 null */
    fun getReadingGifResId(character: String = "clawd"): Int? {
        return resolveGif(character, "idle_reading", 0)
    }

    /**
     * 运行时扫描：按 candidates 链查找第一个存在的 R.raw 资源。
     * 不再硬编码 GIF 资源 ID。
     */
    private fun resolveGif(character: String, state: String, sessionCount: Int = 1): Int? {
        val candidates = when (state) {
            "working" -> when {
                sessionCount >= 3 -> listOf("${character}_building", "${character}_typing", "${character}_idle")
                sessionCount == 2 -> listOf("${character}_headphones_groove", "${character}_typing", "${character}_idle")
                else -> listOf("${character}_typing", "${character}_idle")
            }
            "juggling" -> when {
                sessionCount >= 2 -> listOf("${character}_juggling", "${character}_typing", "${character}_idle")
                else -> listOf("${character}_headphones_groove", "${character}_typing", "${character}_idle")
            }
            "attention" -> listOf("${character}_attention", "${character}_happy", "${character}_idle")
            else -> listOf("${character}_${state}", "${character}_idle")
        }
        return candidates.firstNotNullOfOrNull { name ->
            resIdByName(name).takeIf { it != 0 }
        }
    }

    /**
     * 用 resources.getIdentifier 查找 R.raw.xxx，比反射更可靠。
     * 回退到反射作为兜底。
     */
    private fun resIdByName(name: String): Int? {
        val ctx = appContext
        if (ctx != null) {
            val id = ctx.resources.getIdentifier(name, "raw", ctx.packageName)
            if (id != 0) return id
        }
        return try {
            val field = R.raw::class.java.getField(name)
            field.getInt(null)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 加载 GIF 并在资源就绪时回调 onReady(forceReload)。
     * force=true 时跳过 currentResId 检查（用于恢复/插播）。
     */
    fun loadGifWithReady(view: ImageView, resId: Int, force: Boolean = false, onReady: (() -> Unit)? = null) {
        val petView = view as? FloatingPetView ?: return
        if (!force && resId == petView.currentResId) {
            onReady?.invoke()
            return
        }
        petView.currentResId = resId
        Glide.with(view.context)
            .asGif()
            .load(resId)
            .listener(object : RequestListener<GifDrawable> {
                override fun onLoadFailed(
                    e: GlideException?, model: Any?,
                    target: Target<GifDrawable>, isFirstResource: Boolean
                ): Boolean {
                    Log.w(TAG, "GIF load failed: resId=$resId", e)
                    onReady?.invoke()
                    return false
                }

                override fun onResourceReady(
                    resource: GifDrawable, model: Any, target: Target<GifDrawable>,
                    dataSource: DataSource, isFirstResource: Boolean
                ): Boolean {
                    resource.setLoopCount(GifDrawable.LOOP_FOREVER)
                    onReady?.invoke()
                    return false
                }
            })
            .into(view)
    }
}

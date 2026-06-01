package com.clawd.mobile.overlay

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.clawd.mobile.R
import com.clawd.mobile.data.SessionData

/**
 * Bubble overlay that shows the current session list.
 * Pure-code layout (no Compose) for use with WindowManager.
 */
class PetBubbleView(context: Context) : LinearLayout(context) {

    /** Callback when "进入 App" button is tapped. */
    var onEnterApp: (() -> Unit)? = null

    private val containerLayout: LinearLayout
    private val scrollView: ScrollView
    private val dp = context.resources.displayMetrics.density

    init {
        orientation = VERTICAL
        val pad = (12 * dp).toInt()
        setPadding(pad, pad, pad, pad)

        // Rounded dark card background
        val bg = GradientDrawable().apply {
            setColor(Color.parseColor("#FF1E1E2E"))
            cornerRadius = 14 * dp
        }
        background = bg

        // ScrollView with max height 40% screen
        scrollView = ScrollView(context).apply {
            isVerticalScrollBarEnabled = true
        }
        containerLayout = LinearLayout(context).apply {
            orientation = VERTICAL
        }
        scrollView.addView(containerLayout)
        addView(scrollView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        // Divider
        val divider = View(context).apply {
            setBackgroundColor(Color.parseColor("#33FFFFFF"))
        }
        addView(divider, LayoutParams(LayoutParams.MATCH_PARENT, (0.5 * dp).toInt()).apply {
            topMargin = (8 * dp).toInt()
            bottomMargin = (8 * dp).toInt()
        })

        // "进入 App" button
        val btn = TextView(context).apply {
            text = context.getString(R.string.pet_bubble_enter_app)
            setTextColor(Color.parseColor("#FFE0E0E0"))
            textSize = 14f
            gravity = Gravity.CENTER
            val hPad = (16 * dp).toInt()
            val vPad = (6 * dp).toInt()
            setPadding(hPad, vPad, hPad, vPad)
            val btnBg = GradientDrawable().apply {
                setColor(Color.parseColor("#FF2A2A3E"))
                cornerRadius = 8 * dp
            }
            background = btnBg
            setOnClickListener { onEnterApp?.invoke() }
        }
        addView(btn, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            topMargin = (4 * dp).toInt()
        })
    }

    fun updateSessions(sessions: List<SessionData>) {
        containerLayout.removeAllViews()
        for (session in sessions) {
            containerLayout.addView(buildSessionRow(session))
        }
    }

    fun showNotConnected() {
        containerLayout.removeAllViews()
        containerLayout.addView(buildSingleLine(context.getString(R.string.status_not_connected)))
    }

    fun showNoSessions() {
        containerLayout.removeAllViews()
        containerLayout.addView(buildSingleLine(context.getString(R.string.pet_bubble_no_sessions)))
    }

    private fun buildSingleLine(text: String): TextView {
        return TextView(context).apply {
            this.text = text
            setTextColor(Color.parseColor("#FF888888"))
            textSize = 13f
            setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
        }
    }

    private fun buildSessionRow(session: SessionData): LinearLayout {
        val row = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
        }

        // Status dot
        val dot = View(context).apply {
            val dotBg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(parseColorSafe(session.dotColor, 0xFF888888.toInt()))
            }
            background = dotBg
        }
        val dotSize = (8 * dp).toInt()
        row.addView(dot, LayoutParams(dotSize, dotSize).apply {
            marginEnd = (8 * dp).toInt()
        })

        // Session title
        val titleText = session.displayTitle ?: session.chipText ?: session.sessionTitle ?: ""
        val title = TextView(context).apply {
            text = titleText
            setTextColor(Color.parseColor("#FFE0E0E0"))
            textSize = 13f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        row.addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT).apply {
            weight = 1f
            marginEnd = (8 * dp).toInt()
        })

        return row
    }

    private fun parseColorSafe(hex: String?, fallback: Int): Int {
        if (hex == null || !hex.startsWith("#") || hex.length != 7) return fallback
        return try {
            Color.parseColor(hex)
        } catch (e: Exception) {
            android.util.Log.w("PetBubbleView", "parseColorSafe failed for $hex", e)
            fallback
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Limit max height to 40% of screen
        val screenH = context.resources.displayMetrics.heightPixels
        val maxH = (screenH * 0.4).toInt()
        val limitedHeightSpec = MeasureSpec.makeMeasureSpec(maxH, MeasureSpec.AT_MOST)
        super.onMeasure(widthMeasureSpec, limitedHeightSpec)
    }
}

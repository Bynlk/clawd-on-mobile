package com.clawd.mobile.overlay

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.clawd.mobile.R
import kotlin.math.abs

/**
 * Pure-code approval bubble view for the floating pet overlay.
 *
 * Two states:
 * - **Collapsed hint**: small pill showing "审批（点击展开）" or "问题（打开App）"
 * - **Expanded panel**: tool name, summary, swipe bar, countdown
 *
 * Swipe interaction: horizontal swipe over 50dp threshold triggers approve/deny.
 */
class ApprovalBubbleView(context: Context) : FrameLayout(context) {

    companion object {
        private const val CORNER_RADIUS_DP = 14f
        private const val HINT_PADDING_H_DP = 12
        private const val HINT_PADDING_V_DP = 6
        private const val PANEL_WIDTH_DP = 260
        private const val PANEL_PADDING_DP = 12
        private const val SWIPE_THRESHOLD_DP = 50
        private const val SWIPE_ACTIVATE_DP = 5  // minimum movement to start tracking swipe
        private const val SWIPE_BAR_HEIGHT_DP = 40
        private const val COUNTDOWN_HEIGHT_DP = 3
    }

    // --- State ---
    private var isExpanded = false
    private var requestId: String = ""
    private var onApprove: ((String) -> Unit)? = null
    private var onApproveWithSuggestion: ((String, Int) -> Unit)? = null
    private var onDeny: ((String) -> Unit)? = null
    private var onOpenApp: (() -> Unit)? = null
    private var onSwipeStateChanged: ((Boolean) -> Unit)? = null  // true = expanded

    // --- Hint view ---
    private val hintView: TextView

    // --- Expanded panel views ---
    private val panelView: LinearLayout
    private val toolNameView: TextView
    private val summaryView: TextView
    private val suggestionContainer: LinearLayout
    private val swipeBar: View
    private val swipeLabel: TextView
    private val countdownBar: ProgressBar

    // --- Swipe tracking ---
    private var swipeStartX = 0f
    private var isSwiping = false
    private val swipeThresholdPx: Int
    private val swipeActivatePx: Int

    init {
        val density = resources.displayMetrics.density
        swipeThresholdPx = (SWIPE_THRESHOLD_DP * density).toInt()
        swipeActivatePx = (SWIPE_ACTIVATE_DP * density).toInt()

        // Hint view
        hintView = TextView(context).apply {
            text = context.getString(R.string.approval_hint)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(null, Typeface.BOLD)
            val hPad = (HINT_PADDING_H_DP * density).toInt()
            val vPad = (HINT_PADDING_V_DP * density).toInt()
            setPadding(hPad, vPad, hPad, vPad)
            background = GradientDrawable().apply {
                cornerRadius = (CORNER_RADIUS_DP * density)
                setColor(Color.parseColor("#CC333333"))
            }
        }
        addView(hintView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))

        // Panel view
        panelView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (PANEL_PADDING_DP * density).toInt()
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                cornerRadius = (CORNER_RADIUS_DP * density)
                setColor(Color.parseColor("#E6222222"))
            }
            visibility = GONE
        }

        toolNameView = TextView(context).apply {
            setTextColor(Color.parseColor("#4FC3F7"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTypeface(null, Typeface.BOLD)
        }
        panelView.addView(toolNameView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        summaryView = TextView(context).apply {
            setTextColor(Color.parseColor("#CCCCCC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            val topMargin = (4 * density).toInt()
            (layoutParams as? LinearLayout.LayoutParams)?.topMargin = topMargin
        }
        panelView.addView(summaryView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = (4 * density).toInt()
        })

        suggestionContainer = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = GONE
        }
        panelView.addView(suggestionContainer, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = (6 * density).toInt()
        })

        // Swipe bar
        swipeBar = FrameLayout(context).apply {
            val barH = (SWIPE_BAR_HEIGHT_DP * density).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, barH).apply {
                topMargin = (8 * density).toInt()
            }
            background = GradientDrawable().apply {
                cornerRadius = (8 * density)
                setColor(Color.parseColor("#44444444"))
            }
        }

        swipeLabel = TextView(context).apply {
            text = context.getString(R.string.approval_swipe_hint)
            setTextColor(Color.parseColor("#88FFFFFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            gravity = Gravity.CENTER
        }
        swipeBar.addView(swipeLabel, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        panelView.addView(swipeBar)

        // Countdown bar
        countdownBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            val barH = (COUNTDOWN_HEIGHT_DP * density).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, barH).apply {
                topMargin = (4 * density).toInt()
            }
            max = 1000
            progressDrawable = context.getDrawable(android.R.drawable.progress_horizontal)?.mutate()?.apply {
                setTint(Color.parseColor("#4FC3F7"))
            }
        }
        panelView.addView(countdownBar)

        val panelWidth = (PANEL_WIDTH_DP * density).toInt()
        addView(panelView, LayoutParams(panelWidth, LayoutParams.WRAP_CONTENT))

        // Touch handling for swipe
        setOnTouchListener { _, event ->
            if (!isExpanded) return@setOnTouchListener false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    swipeStartX = event.rawX
                    isSwiping = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - swipeStartX
                    if (abs(dx) > swipeActivatePx) {
                        isSwiping = true
                    }
                    if (isSwiping) {
                        // Visual feedback: tint swipe bar (match send threshold)
                        val progress = (dx / swipeThresholdPx).coerceIn(-1f, 1f)
                        when {
                            progress >= 1f -> {
                                swipeBar.background.setTint(Color.parseColor("#444CAF50"))
                                swipeLabel.text = context.getString(R.string.approval_swipe_allow)
                            }
                            progress <= -1f -> {
                                swipeBar.background.setTint(Color.parseColor("#44F44336"))
                                swipeLabel.text = context.getString(R.string.approval_swipe_deny)
                            }
                            else -> {
                                swipeBar.background.setTint(Color.parseColor("#44444444"))
                                swipeLabel.text = context.getString(R.string.approval_swipe_hint)
                            }
                        }
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val dx = event.rawX - swipeStartX
                    if (isSwiping && abs(dx) >= swipeThresholdPx) {
                        if (dx > 0) {
                            onApprove?.invoke(requestId)
                        } else {
                            onDeny?.invoke(requestId)
                        }
                    }
                    // Reset swipe bar
                    swipeBar.background.setTint(Color.parseColor("#44444444"))
                    swipeLabel.text = context.getString(R.string.approval_swipe_hint)
                    isSwiping = false
                    true
                }
                else -> false
            }
        }

        // Hint click → expand
        hintView.setOnClickListener {
            if (!isExpanded) {
                expand()
            }
        }
    }

    // --- Public API ---

    /** Configure callbacks. Call before showing. */
    fun configure(
        approveCallback: (String) -> Unit,
        denyCallback: (String) -> Unit,
        openAppCallback: () -> Unit,
        swipeStateCallback: (Boolean) -> Unit
    ) {
        onApprove = approveCallback
        onDeny = denyCallback
        onOpenApp = openAppCallback
        onSwipeStateChanged = swipeStateCallback
    }

    /** Configure callbacks with suggestionIndex support. */
    fun configureWithSuggestionIndex(
        approveCallback: (String) -> Unit,
        approveWithSuggestionCallback: (String, Int) -> Unit,
        denyCallback: (String) -> Unit,
        openAppCallback: () -> Unit,
        swipeStateCallback: (Boolean) -> Unit
    ) {
        onApprove = approveCallback
        onApproveWithSuggestion = approveWithSuggestionCallback
        onDeny = denyCallback
        onOpenApp = openAppCallback
        onSwipeStateChanged = swipeStateCallback
    }

    /** Show collapsed hint for a standard approval request. */
    fun showApprovalHint(reqId: String, toolName: String, summary: String, suggestions: List<String>?, pendingCount: Int = 0) {
        requestId = reqId
        toolNameView.text = toolName
        summaryView.text = summary
        hintView.text = if (pendingCount > 1) context.getString(R.string.approval_hint_count, pendingCount) else context.getString(R.string.approval_hint)
        isExpanded = false
        hintView.visibility = VISIBLE
        panelView.visibility = GONE
        setupSuggestions(suggestions)
    }

    /** Show collapsed hint for an elicitation request (jump to app). */
    fun showElicitationHint(reqId: String) {
        requestId = reqId
        hintView.text = context.getString(R.string.approval_elicitation_hint)
        isExpanded = false
        hintView.visibility = VISIBLE
        panelView.visibility = GONE
        hintView.setOnClickListener { onOpenApp?.invoke() }
    }

    /** Expand the panel. */
    fun expand() {
        isExpanded = true
        hintView.visibility = GONE
        panelView.visibility = VISIBLE
        onSwipeStateChanged?.invoke(true)
    }

    /** Collapse back to hint. */
    fun collapse() {
        isExpanded = false
        panelView.visibility = GONE
        hintView.visibility = VISIBLE
        onSwipeStateChanged?.invoke(false)
    }

    /** Update countdown progress (0..1000). */
    fun updateCountdown(progress: Int) {
        countdownBar.progress = progress.coerceIn(0, 1000)
    }

    /** Check if currently expanded. */
    fun isPanelExpanded(): Boolean = isExpanded

    private fun setupSuggestions(suggestions: List<String>?) {
        suggestionContainer.removeAllViews()
        if (suggestions.isNullOrEmpty()) {
            suggestionContainer.visibility = GONE
            return
        }
        suggestionContainer.visibility = VISIBLE
        val density = resources.displayMetrics.density
        suggestions.forEachIndexed { index, label ->
            val btn = TextView(context).apply {
                text = label
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
                val hPad = (8 * density).toInt()
                val vPad = (4 * density).toInt()
                setPadding(hPad, vPad, hPad, vPad)
                background = GradientDrawable().apply {
                    cornerRadius = (6 * density)
                    setColor(Color.parseColor("#664FC3F7"))
                }
                setOnClickListener {
                    onApproveWithSuggestion?.invoke(requestId, index)
                }
            }
            suggestionContainer.addView(btn, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                marginEnd = (4 * density).toInt()
            })
        }
    }
}

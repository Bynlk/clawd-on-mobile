package com.clawd.mobile.overlay

import android.content.Context
import android.util.Log
import android.webkit.WebView
import java.io.IOException

/**
 * SVG asset loader replacing [PetGifLoader].
 *
 * Maps pet states to SVG/APNG files in `assets/svg/{character}/`, aligned with
 * PC-side `theme.json`. Renders via [WebView] to preserve CSS animations
 * (breathe, blink, tail-sway, etc.) that androidsvg-aar cannot render.
 *
 * Supports:
 * - Working tiers (session-count-based animation selection)
 * - Juggling tiers
 * - Idle animation variants (cycle through look/bubble/reading)
 * - Sleep sequence states (yawning, dozing, collapsing, waking)
 * - All 3 characters: clawd, cloudling, calico
 */
object SvgLoader {

    private const val TAG = "SvgLoader"
    private const val SVG_BASE = "https://appassets.androidplatform.net/svg"
    private const val MAX_CACHE_SIZE = 128

    /**
     * Safety-net timeout for oneshot SVG loadFinished callback (ms).
     * The authoritative return mechanism is PetStateManager's autoReturn timer
     * (5 000 ms for error, aligned with PC AUTO_RETURN_MS).  This timeout is
     * only a fallback in case the autoReturn path is somehow delayed.
     */
    private const val ONESHOT_TIMEOUT_MS = 6_000L

    private var appContext: Context? = null
    private var pollGeneration = 0  // cancelled on each loadSvg; stale polls check this

    /**
     * Initialize with application context for real asset existence checks.
     * Must be called once from [ClawdApp.onCreate].
     */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    // ======================================================================
    //  State → SVG filename mappings (from PC theme.json)
    // ======================================================================

    /** Default state → SVG mapping for Clawd */
    private val CLAWD_STATES = mapOf(
        "idle" to "clawd-idle-follow.svg",
        "yawning" to "clawd-idle-yawn.svg",
        "dozing" to "clawd-idle-doze.svg",
        "collapsing" to "clawd-collapse-sleep.svg",
        "thinking" to "clawd-working-thinking.svg",
        "working" to "clawd-working-typing.svg",
        "juggling" to "clawd-headphones-groove.svg",
        "sweeping" to "clawd-working-sweeping.svg",
        "error" to "clawd-error.svg",
        "attention" to "clawd-happy.svg",
        "notification" to "clawd-notification.svg",
        "carrying" to "clawd-working-carrying.svg",
        "sleeping" to "clawd-sleeping.svg",
        "waking" to "clawd-wake.svg",
        "conducting" to "clawd-working-juggling.svg",
        "debugger" to "clawd-working-debugger.svg",
    )

    /** Default state → SVG mapping for Cloudling */
    private val CLOUDLING_STATES = mapOf(
        "idle" to "cloudling-idle.svg",
        "yawning" to "cloudling-idle-to-dozing.svg",
        "dozing" to "cloudling-dozing.svg",
        "collapsing" to "cloudling-dozing-to-sleeping.svg",
        "thinking" to "cloudling-thinking.svg",
        "working" to "cloudling-typing.svg",
        "juggling" to "cloudling-juggling.svg",
        "sweeping" to "cloudling-sweeping.svg",
        "error" to "cloudling-error.svg",
        "attention" to "cloudling-attention.svg",
        "notification" to "cloudling-notification.svg",
        "carrying" to "cloudling-carrying.svg",
        "sleeping" to "cloudling-sleeping.svg",
        "waking" to "cloudling-sleeping-to-idle.svg",
        "conducting" to "cloudling-conducting.svg",
    )

    /** Default state → SVG/APNG mapping for Calico */
    private val CALICO_STATES = mapOf(
        "idle" to "calico-idle-follow.svg",
        "yawning" to "calico-yawning.apng",
        "dozing" to "calico-dozing.apng",
        "collapsing" to "calico-collapsing.apng",
        "thinking" to "calico-thinking.apng",
        "working" to "calico-working-typing.apng",
        "juggling" to "calico-working-juggling.apng",
        "sweeping" to "calico-working-sweeping.apng",
        "error" to "calico-error.apng",
        "attention" to "calico-happy.apng",
        "notification" to "calico-notification.apng",
        "carrying" to "calico-working-carrying.apng",
        "sleeping" to "calico-sleeping.apng",
        "waking" to "calico-waking.apng",
        "conducting" to "calico-working-conducting.apng",
    )

    private val CHARACTER_STATES = mapOf(
        "clawd" to CLAWD_STATES,
        "cloudling" to CLOUDLING_STATES,
        "calico" to CALICO_STATES,
    )

    // ======================================================================
    //  Working tiers (from PC theme.json workingTiers)
    // ======================================================================

    data class Tier(val minSessions: Int, val file: String)

    private val CLAWD_WORKING_TIERS = listOf(
        Tier(3, "clawd-working-building.svg"),
        Tier(2, "clawd-headphones-groove.svg"),
        Tier(1, "clawd-working-typing.svg"),
    )

    private val CLOUDLING_WORKING_TIERS = listOf(
        Tier(3, "cloudling-building.svg"),
        Tier(2, "cloudling-juggling.svg"),
        Tier(1, "cloudling-typing.svg"),
    )

    private val CALICO_WORKING_TIERS = listOf(
        Tier(3, "calico-working-building.apng"),
        Tier(2, "calico-working-juggling.apng"),
        Tier(1, "calico-working-typing.apng"),
    )

    private val CLAWD_JUGGLING_TIERS = listOf(
        Tier(2, "clawd-working-juggling.svg"),
        Tier(1, "clawd-headphones-groove.svg"),
    )

    private val CLOUDLING_JUGGLING_TIERS = listOf(
        Tier(2, "cloudling-conducting.svg"),
        Tier(1, "cloudling-juggling.svg"),
    )

    private val CALICO_JUGGLING_TIERS = listOf(
        Tier(2, "calico-working-conducting.apng"),
        Tier(1, "calico-working-juggling.apng"),
    )

    private val WORKING_TIERS = mapOf(
        "clawd" to CLAWD_WORKING_TIERS,
        "cloudling" to CLOUDLING_WORKING_TIERS,
        "calico" to CALICO_WORKING_TIERS,
    )

    private val JUGGLING_TIERS = mapOf(
        "clawd" to CLAWD_JUGGLING_TIERS,
        "cloudling" to CLOUDLING_JUGGLING_TIERS,
        "calico" to CALICO_JUGGLING_TIERS,
    )

    // ======================================================================
    //  Idle animation variants (from PC theme.json idleAnimations)
    // ======================================================================

    private val CLAWD_IDLE_ANIMATIONS = listOf(
        "clawd-idle-look.svg",
        "clawd-idle-bubble.svg",
        "clawd-idle-reading.svg",
    )

    private val CLOUDLING_IDLE_ANIMATIONS = listOf(
        "cloudling-idle-reading.svg",
    )

    private val CALICO_IDLE_ANIMATIONS = listOf(
        "calico-idle.apng",
    )

    private val IDLE_ANIMATIONS = mapOf(
        "clawd" to CLAWD_IDLE_ANIMATIONS,
        "cloudling" to CLOUDLING_IDLE_ANIMATIONS,
        "calico" to CALICO_IDLE_ANIMATIONS,
    )

    // ======================================================================
    //  ViewBox data (from PC theme.json viewBox)
    // ======================================================================

    data class ViewBoxInfo(val width: Int, val height: Int)

    private val VIEWBOXES = mapOf(
        "clawd" to ViewBoxInfo(45, 45),
        "cloudling" to ViewBoxInfo(88, 72),
        "calico" to ViewBoxInfo(266, 200),
    )

    // ======================================================================
    //  Public API
    // ======================================================================

    /**
     * Resolve the SVG/APNG asset path for a given state and character.
     * Returns a path relative to `assets/`, e.g. `"svg/clawd/clawd-idle-follow.svg"`.
     *
     * For `working` state, applies tier logic based on [sessionCount].
     * For `juggling` state, applies juggling tier logic.
     */
    fun resolveSvgAsset(state: PetState, sessionCount: Int, character: String = "clawd"): String? {
        return resolveSvgAsset(state.themeKey, sessionCount, character)
    }

    /** String-based overload. */
    fun resolveSvgAsset(stateKey: String, sessionCount: Int, character: String = "clawd"): String? {
        val charMap = CHARACTER_STATES[character] ?: CHARACTER_STATES["clawd"]!!

        // Working tier logic
        if (stateKey == "working") {
            val tiers = WORKING_TIERS[character] ?: WORKING_TIERS["clawd"]!!
            val tierFile = tiers.firstOrNull { sessionCount >= it.minSessions }?.file
            if (tierFile != null) return "svg/$character/$tierFile"
        }

        // Juggling tier logic
        if (stateKey == "juggling") {
            val tiers = JUGGLING_TIERS[character] ?: JUGGLING_TIERS["clawd"]!!
            val tierFile = tiers.firstOrNull { sessionCount >= it.minSessions }?.file
            if (tierFile != null) return "svg/$character/$tierFile"
        }

        // Direct state lookup with fallback chain
        val candidates = buildCandidateList(stateKey, character, charMap)
        for (candidate in candidates) {
            val path = "svg/$character/$candidate"
            if (assetExists(path)) return path
        }

        // Ultimate fallback: character idle
        val idleFile = charMap["idle"] ?: return null
        return "svg/$character/$idleFile"
    }

    /**
     * Pick a random idle animation variant for the current character.
     * Returns an asset path or null if no variants exist.
     */
    fun pickIdleAnimation(character: String = "clawd"): String? {
        val variants = IDLE_ANIMATIONS[character] ?: return null
        if (variants.isEmpty()) return null
        val file = variants.random()
        return "svg/$character/$file"
    }

    /**
     * Check whether [state] has a dedicated SVG for [character] (not a fallback).
     * Used by PetStateManager to decide whether to play sleep/wake animations.
     */
    fun hasSvgForState(state: PetState, character: String): Boolean {
        val charMap = CHARACTER_STATES[character] ?: return false
        val fileName = charMap[state.themeKey] ?: return false
        return assetExists("svg/$character/$fileName")
    }

    /**
     * Get the viewBox dimensions for a character.
     * Used by FloatingPetService for window sizing.
     */
    fun getViewBox(character: String): ViewBoxInfo {
        return VIEWBOXES[character] ?: VIEWBOXES["clawd"]!!
    }

    /**
     * Load an SVG/APNG into a WebView with an HTML wrapper.
     * The HTML ensures transparent background and proper sizing.
     *
     * @param webView The WebView to load into
     * @param assetPath Path relative to assets/, e.g. "svg/clawd/clawd-idle-follow.svg"
     * @param loop Whether to loop the animation (true for most states, false for oneshots)
     * @param onFinished Called when a non-looping animation ends (oneshot states)
     */
    fun loadSvg(
        webView: WebView,
        assetPath: String,
        loop: Boolean = true,
        onFinished: (() -> Unit)? = null
    ) {
        // Cancel any stale poll chain from a previous loadSvg call.
        // Without this, old postDelayed callbacks fire on new content and
        // can trigger onFinished at the wrong time.
        pollGeneration++

        val url = "$SVG_BASE/${assetPath.removePrefix("svg/")}"
        val loopStyle = if (loop) "" else "animation-iteration-count: 1;"
        val isApng = assetPath.endsWith(".apng")

        val templateName = if (isApng) "apng_template.html" else "svg_template.html"
        val html = loadTemplate(webView.context, templateName)
            .replace("{{URL}}", url)
            .replace("{{LOOP_STYLE}}", loopStyle)
            .replace("{{ANIM_END_SCRIPT}}", "")

        webView.loadDataWithBaseURL(
            "https://appassets.androidplatform.net/",
            html,
            "text/html",
            "UTF-8",
            null
        )

        // For non-looping animations, use a fixed timeout to detect end.
        // We do NOT rely on CSS animationend because all oneshot SVGs define
        // infinite animations on child elements — the injected
        // animation-iteration-count:1 on <svg> cannot override them.
        // The autoReturn timer in PetStateManager is the authoritative
        // return mechanism; this callback is a safety-net fallback.
        if (!loop && onFinished != null) {
            val gen = pollGeneration
            val timeoutMs = if (isApng) 3000L else ONESHOT_TIMEOUT_MS
            webView.postDelayed({
                if (pollGeneration == gen) onFinished()
            }, timeoutMs)
        }

        Log.d(TAG, "loadSvg: $assetPath (loop=$loop, isApng=$isApng)")
    }

    /**
     * Clear the WebView content.
     */
    fun clearSvg(webView: WebView) {
        webView.loadUrl("about:blank")
    }

    // ======================================================================
    //  Internal helpers
    // ======================================================================


    /**
     * Build candidate filename list for fallback resolution.
     * Pattern: character-specific → clawd fallback → idle
     */
    private fun buildCandidateList(
        stateKey: String,
        character: String,
        charMap: Map<String, String>
    ): List<String> {
        val primary = charMap[stateKey]
        val clawdMap = CHARACTER_STATES["clawd"]!!
        val clawdFallback = clawdMap[stateKey]
        val idle = charMap["idle"]

        return buildList {
            if (primary != null) add(primary)
            if (clawdFallback != null && clawdFallback != primary) add(clawdFallback)
            if (idle != null && idle != primary && idle != clawdFallback) add(idle)
        }
    }

    /** Load an HTML template from assets/html/ directory. */
    private fun loadTemplate(context: Context, name: String): String {
        return context.assets.open("html/$name").bufferedReader().readText()
    }

    /** Check if an asset file exists in the assets directory. Thread-safe. */
    private val assetCache = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val missingCache = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private fun assetExists(path: String): Boolean {
        if (path in assetCache) return true
        if (path in missingCache) return false
        val ctx = appContext
        if (ctx == null) {
            // Not initialized — assume asset exists (allows pure-logic unit tests without Android context)
            return true
        }
        return try {
            ctx.assets.open(path).use { /* open succeeded → file exists */ }
            assetCache.add(path)
            true
        } catch (_: IOException) {
            missingCache.add(path)
            false
        }
    }

    /** Reset caches for testing. */
    fun resetForTesting() {
        assetCache.clear()
        missingCache.clear()
    }
}

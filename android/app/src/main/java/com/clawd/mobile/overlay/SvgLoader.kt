package com.clawd.mobile.overlay

import android.content.Context
import android.util.Log
import android.webkit.WebView
import kotlinx.serialization.json.*
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
     * Loads `assets/svg_config.json` if present, otherwise uses hardcoded defaults.
     */
    fun init(context: Context) {
        appContext = context.applicationContext
        loadConfigFromAssets(context)
    }

    // ======================================================================
    //  Config data — loaded from assets/svg_config.json, hardcoded fallback
    // ======================================================================

    data class Tier(val minSessions: Int, val file: String)
    data class ViewBoxInfo(val width: Int, val height: Int)

    // ── Hardcoded defaults (fallback if JSON missing/invalid) ──────────

    private val DEFAULT_STATES = mapOf(
        "clawd" to mapOf(
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
        ),
        "cloudling" to mapOf(
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
        ),
        "calico" to mapOf(
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
        ),
    )

    private val DEFAULT_workingTiers = mapOf(
        "clawd" to listOf(
            Tier(3, "clawd-working-building.svg"),
            Tier(2, "clawd-headphones-groove.svg"),
            Tier(1, "clawd-working-typing.svg"),
        ),
        "cloudling" to listOf(
            Tier(3, "cloudling-building.svg"),
            Tier(2, "cloudling-juggling.svg"),
            Tier(1, "cloudling-typing.svg"),
        ),
        "calico" to listOf(
            Tier(3, "calico-working-building.apng"),
            Tier(2, "calico-working-juggling.apng"),
            Tier(1, "calico-working-typing.apng"),
        ),
    )

    private val DEFAULT_jugglingTiers = mapOf(
        "clawd" to listOf(
            Tier(2, "clawd-working-juggling.svg"),
            Tier(1, "clawd-headphones-groove.svg"),
        ),
        "cloudling" to listOf(
            Tier(2, "cloudling-conducting.svg"),
            Tier(1, "cloudling-juggling.svg"),
        ),
        "calico" to listOf(
            Tier(2, "calico-working-conducting.apng"),
            Tier(1, "calico-working-juggling.apng"),
        ),
    )

    private val DEFAULT_idleAnimations = mapOf(
        "clawd" to listOf("clawd-idle-look.svg", "clawd-idle-bubble.svg", "clawd-idle-reading.svg"),
        "cloudling" to listOf("cloudling-idle-reading.svg"),
        "calico" to listOf("calico-idle.apng"),
    )

    private val DEFAULT_viewBoxes = mapOf(
        "clawd" to ViewBoxInfo(45, 45),
        "cloudling" to ViewBoxInfo(88, 72),
        "calico" to ViewBoxInfo(266, 200),
    )

    // ── Active config (populated from JSON or defaults) ────────────────

    private var characterStates: Map<String, Map<String, String>> = DEFAULT_STATES
    private var workingTiers: Map<String, List<Tier>> = DEFAULT_workingTiers
    private var jugglingTiers: Map<String, List<Tier>> = DEFAULT_jugglingTiers
    private var idleAnimations: Map<String, List<String>> = DEFAULT_idleAnimations
    private var viewBoxes: Map<String, ViewBoxInfo> = DEFAULT_viewBoxes

    // ── JSON config loader ─────────────────────────────────────────────

    private fun loadConfigFromAssets(context: Context) {
        try {
            val jsonStr = context.assets.open("svg_config.json").bufferedReader().readText()
            val root = Json.parseToJsonElement(jsonStr).jsonObject

            root["states"]?.jsonObject?.let { statesObj ->
                val result = mutableMapOf<String, Map<String, String>>()
                for ((char, mappings) in statesObj) {
                    result[char] = mappings.jsonObject.mapValues { it.value.jsonPrimitive.content }
                }
                characterStates = result
            }

            root["workingTiers"]?.jsonObject?.let { tiersObj ->
                workingTiers = tiersObj.mapValues { (_, arr) ->
                    arr.jsonArray.map { Tier(it.jsonObject["minSessions"]!!.jsonPrimitive.int, it.jsonObject["file"]!!.jsonPrimitive.content) }
                }
            }

            root["jugglingTiers"]?.jsonObject?.let { tiersObj ->
                jugglingTiers = tiersObj.mapValues { (_, arr) ->
                    arr.jsonArray.map { Tier(it.jsonObject["minSessions"]!!.jsonPrimitive.int, it.jsonObject["file"]!!.jsonPrimitive.content) }
                }
            }

            root["idleAnimations"]?.jsonObject?.let { animObj ->
                idleAnimations = animObj.mapValues { (_, arr) ->
                    arr.jsonArray.map { it.jsonPrimitive.content }
                }
            }

            root["viewBoxes"]?.jsonObject?.let { vbObj ->
                viewBoxes = vbObj.mapValues { (_, obj) ->
                    ViewBoxInfo(obj.jsonObject["width"]!!.jsonPrimitive.int, obj.jsonObject["height"]!!.jsonPrimitive.int)
                }
            }

            Log.d(TAG, "Loaded svg_config.json: ${characterStates.size} characters")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load svg_config.json, using hardcoded defaults", e)
        }
    }

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
        val charMap = characterStates[character] ?: characterStates["clawd"]!!

        // Working tier logic
        if (stateKey == "working") {
            val tiers = workingTiers[character] ?: workingTiers["clawd"]!!
            val tierFile = tiers.firstOrNull { sessionCount >= it.minSessions }?.file
            if (tierFile != null) return "svg/$character/$tierFile"
        }

        // Juggling tier logic
        if (stateKey == "juggling") {
            val tiers = jugglingTiers[character] ?: jugglingTiers["clawd"]!!
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
        val variants = idleAnimations[character] ?: return null
        if (variants.isEmpty()) return null
        val file = variants.random()
        return "svg/$character/$file"
    }

    /**
     * Check whether [state] has a dedicated SVG for [character] (not a fallback).
     * Used by PetStateManager to decide whether to play sleep/wake animations.
     */
    fun hasSvgForState(state: PetState, character: String): Boolean {
        val charMap = characterStates[character] ?: return false
        val fileName = charMap[state.themeKey] ?: return false
        return assetExists("svg/$character/$fileName")
    }

    /**
     * Get the viewBox dimensions for a character.
     * Used by FloatingPetService for window sizing.
     */
    fun getViewBox(character: String): ViewBoxInfo {
        return viewBoxes[character] ?: viewBoxes["clawd"]!!
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
        var html = loadTemplate(webView.context, templateName)
            .replace("{{URL}}", url)
            .replace("{{LOOP_STYLE}}", loopStyle)
            .replace("{{ANIM_END_SCRIPT}}", "")

        // Defense-in-depth: sanitize SVG content in Kotlin before building HTML.
        // APNGs are binary and not subject to XSS; the JS sanitizer in the template
        // is the secondary layer for the XHR path.
        if (!isApng) {
            try {
                val rawSvg = webView.context.assets.open(assetPath).bufferedReader().readText()
                val sanitized = sanitizeSvg(rawSvg)
                html = html.replace(
                    "xhr.open('GET', '{{URL}}', true);",
                    "// Sanitized inline (Kotlin-side)\n      xhr.open('GET', 'about:blank', true);"
                ).replace(
                    "document.querySelector('.container').innerHTML = sanitizeSvg(xhr.responseText);",
                    "document.querySelector('.container').innerHTML = " + org.json.JSONObject().put("s", sanitized).toString().removeSurrounding("{\"s\":", "}") + ";"
                )
            } catch (e: IOException) {
                Log.w(TAG, "Failed to inline-sanitize $assetPath, falling back to XHR", e)
            }
        }

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
     * Defense-in-depth SVG sanitizer. Strips potentially dangerous elements
     * from SVG content before embedding in a WebView. Applied in both Kotlin
     * (inline path) and JavaScript (template XHR path).
     *
     * Removes: `<script>`, `<foreignObject>`, `on*` event attributes, `javascript:` URLs.
     */
    private fun sanitizeSvg(raw: String): String {
        var s = raw
        s = Regex("<script[\\s\\S]*?</script>", RegexOption.IGNORE_CASE).replace(s, "")
        s = Regex("<foreignObject[\\s\\S]*?</foreignObject>", RegexOption.IGNORE_CASE).replace(s, "")
        s = Regex("""\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", RegexOption.IGNORE_CASE).replace(s, "")
        s = Regex("""(href|xlink:href)\s*=\s*["']?\s*javascript\s*:[^"'\s>]*""", RegexOption.IGNORE_CASE).replace(s, "")
        return s
    }

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
        val clawdMap = characterStates["clawd"]!!
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

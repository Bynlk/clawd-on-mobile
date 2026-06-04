package com.clawd.mobile.overlay

/**
 * Static configuration data for [PetStateManager].
 * Extracted from the companion object to reduce its size (~100 lines of data maps).
 *
 * Contains: timing constants, per-state auto-return delays, reaction SVG assets,
 * and per-character sleep sequence timings.
 */
object PetStateConfig {

    // --- Timing constants (ms) ---
    const val STALE_THRESHOLD_MS       = 30_000L
    const val ATTENTION_RECHECK_MS     = 3_000L
    const val REACTION_DISPLAY_MS      = 4_000L
    const val IDLE_ANIM_INTERVAL_MS    = 30_000L
    const val IDLE_ANIM_DISPLAY_MS     = 5_000L
    const val STATE_COLLECTOR_RETRY_MS = 3_000L
    const val WS_POLL_INTERVAL_MS     = 3_000L
    const val WATCHDOG_INTERVAL_MS     = 10_000L
    const val WATCHDOG_TIMEOUT_MS      = 60_000L
    const val IDLE_RECHECK_SETTLE_MS   = 200L
    const val IDLE_SLEEP_TIMEOUT_MS    = 60_000L  // 对齐 PC 端 MOUSE_SLEEP_TIMEOUT
    const val DONE_SESSION_TTL_MS      = 5 * 60 * 1000L  // 5 minutes — expired done-session IDs are cleaned up

    /** Per-state auto-return delay (ms). Aligns with PC theme-schema.js DEFAULT_TIMINGS.autoReturn. */
    val ONESHOT_AUTO_RETURN_MS: Map<PetState, Long> = mapOf(
        PetState.Attention to 4_000L,
        PetState.Error to 5_000L,
        PetState.Sweeping to 300_000L,   // 5 min — matches PC
        PetState.Notification to 2_500L,
        PetState.Carrying to 3_000L,
    )

    // --- Reaction SVG assets (from PC theme.json) ---
    /** Click/double-tap reaction SVGs per character. */
    val CLICK_REACTIONS: Map<String, List<String>> = mapOf(
        "clawd" to listOf("clawd-react-left.svg", "clawd-react-right.svg", "clawd-react-annoyed.svg"),
        "cloudling" to emptyList(),
        "calico" to emptyList(),
    )

    /** Drag reaction SVG per character (loops during drag). */
    val DRAG_REACTIONS: Map<String, String?> = mapOf(
        "clawd" to "clawd-react-drag.svg",
        "cloudling" to "cloudling-react-drag.svg",
        "calico" to null,
    )

    /** Notification state SVG per character (used as reaction overlay). */
    val NOTIFICATION_REACTIONS: Map<String, String> = mapOf(
        "clawd" to "clawd-notification.svg",
        "cloudling" to "cloudling-notification.svg",
        "calico" to "calico-notification.apng",
    )

    // --- Per-character sleep sequence timings (from PC theme.json) ---
    data class SleepConfig(
        val yawnMs: Long,
        val dozingMs: Long,   // Dozing (浅睡) duration before collapsing; aligns with PC DEEP_SLEEP_TIMEOUT
        val collapseMs: Long,
        val wakeMs: Long,
        val deepSleepMs: Long
    )

    val SLEEP_TIMINGS: Map<String, SleepConfig> = mapOf(
        "clawd"     to SleepConfig(yawnMs = 3_000, dozingMs = 600_000, collapseMs = 0,     wakeMs = 1_500, deepSleepMs = 600_000),
        "calico"    to SleepConfig(yawnMs = 8_000, dozingMs = 600_000, collapseMs = 5_200, wakeMs = 5_800, deepSleepMs = 600_000),
        "cloudling" to SleepConfig(yawnMs = 9_030, dozingMs = 600_000, collapseMs = 4_700, wakeMs = 3_650, deepSleepMs = 600_000)
    )
}

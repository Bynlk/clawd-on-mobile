package com.clawd.mobile.overlay

/**
 * Unified pet state representation.
 * Priority aligns with PC side: higher number = higher priority (wins selection).
 *
 * @property priority  Numeric priority for best-state selection (PC convention).
 * @property themeKey   String key used for GIF resolution and logging.
 */
sealed class PetState(val priority: Int, val themeKey: String) {

    /** True for states that are functionally idle (Idle, Sleeping, sleep-sequence). */
    val isIdleLike: Boolean
        get() = this is Idle || this is Sleeping || this is Yawning || this is Dozing || this is Collapsing

    /** True for states representing active work (not idle-like, not Waking). */
    val isActive: Boolean get() = !isIdleLike && this !is Waking

    /** True if this state is part of the sleep sequence. */
    val isSleepSequence: Boolean get() = this in SLEEP_SEQUENCE

    // --- Concrete states (PC-aligned priority) ---

    // Priority table aligned with PC state-priority.js
    data object Error       : PetState(8, "error")
    data object Notification: PetState(7, "notification")
    data object Sweeping    : PetState(6, "sweeping")
    data object Attention   : PetState(5, "attention")
    data object Conducting  : PetState(4, "conducting")
    data object Juggling    : PetState(4, "juggling")
    data object Carrying    : PetState(4, "carrying")
    data object Debugger    : PetState(4, "debugger")
    data object Working     : PetState(3, "working")
    data object Thinking    : PetState(2, "thinking")
    data object Idle        : PetState(1, "idle")
    data object Yawning     : PetState(1, "yawning")
    data object Dozing      : PetState(1, "dozing")
    data object Collapsing  : PetState(1, "collapsing")
    data object Waking      : PetState(1, "waking")
    data object Sleeping    : PetState(0, "sleeping")

    companion object {

        /** All known states, ordered by descending priority. Lazy to avoid data object init race. */
        val ALL: List<PetState> by lazy { listOf(
            Error, Notification, Sweeping, Attention,
            Conducting, Juggling, Carrying, Debugger,
            Working, Thinking,
            Idle, Yawning, Dozing, Collapsing, Waking,
            Sleeping
        ) }

        /** States that form the sleep animation sequence. */
        val SLEEP_SEQUENCE: Set<PetState> by lazy { setOf(
            Yawning, Dozing, Collapsing, Sleeping, Waking
        ) }

        /** States that fire once then auto-return to previous state. */
        val ONESHOT_STATES: Set<PetState> by lazy { setOf(
            Attention, Error, Sweeping, Notification, Carrying
        ) }

        /** Badge strings considered "running" (task in progress). */
        val RUNNING_BADGES: Set<String> = setOf(
            "running", "working", "thinking", "tool_use", "typing"
        )

        /** Parse a state string into the corresponding [PetState]. */
        fun fromString(value: String?): PetState = when (value) {
            "error"        -> Error
            "notification" -> Notification
            "sweeping"     -> Sweeping
            "attention"    -> Attention
            "conducting"   -> Conducting
            "juggling"     -> Juggling
            "carrying"     -> Carrying
            "debugger"     -> Debugger
            "working"      -> Working
            "thinking"     -> Thinking
            "yawning"      -> Yawning
            "dozing"       -> Dozing
            "collapsing"   -> Collapsing
            "waking"       -> Waking
            "sleeping"     -> Sleeping
            else           -> Idle
        }
    }
}

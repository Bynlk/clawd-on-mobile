package com.clawd.mobile.overlay

/**
 * Unified pet state representation.
 * Priority aligns with PC side: higher number = higher priority (wins selection).
 *
 * @property priority  Numeric priority for best-state selection (PC convention).
 * @property themeKey   String key used for GIF resolution and logging.
 */
sealed class PetState(val priority: Int, val themeKey: String) {

    /** Check whether this state should trigger the idle animation cycle. */
    val isIdleLike: Boolean get() = this is Idle || this is Sleeping

    /** Non-idle, non-sleeping state suitable for lastNonIdleState tracking. */
    val isActive: Boolean get() = !isIdleLike

    // --- Concrete states (PC-aligned priority) ---

    data object Error       : PetState(8, "error")
    data object Notification: PetState(7, "notification")
    data object Sweeping    : PetState(6, "sweeping")
    data object Attention   : PetState(5, "attention")
    data object Juggling    : PetState(4, "juggling")
    data object Carrying    : PetState(4, "carrying")
    data object Working     : PetState(3, "working")
    data object Thinking    : PetState(2, "thinking")
    data object Idle        : PetState(1, "idle")
    data object Sleeping    : PetState(0, "sleeping")

    companion object {

        /** All known states, ordered by descending priority. */
        val ALL: List<PetState> = listOf(
            Error, Notification, Sweeping, Attention,
            Juggling, Carrying, Working, Thinking,
            Idle, Sleeping
        )

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
            "juggling"     -> Juggling
            "carrying"     -> Carrying
            "working"      -> Working
            "thinking"     -> Thinking
            "sleeping"     -> Sleeping
            else           -> Idle
        }
    }
}

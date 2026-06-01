package com.clawd.mobile.overlay

import org.junit.Test
import org.junit.Assert.*

class PetStateTest {

    @Test
    fun `fromString maps known states`() {
        assertEquals(PetState.Error, PetState.fromString("error"))
        assertEquals(PetState.Notification, PetState.fromString("notification"))
        assertEquals(PetState.Sweeping, PetState.fromString("sweeping"))
        assertEquals(PetState.Attention, PetState.fromString("attention"))
        assertEquals(PetState.Conducting, PetState.fromString("conducting"))
        assertEquals(PetState.Juggling, PetState.fromString("juggling"))
        assertEquals(PetState.Carrying, PetState.fromString("carrying"))
        assertEquals(PetState.Debugger, PetState.fromString("debugger"))
        assertEquals(PetState.Working, PetState.fromString("working"))
        assertEquals(PetState.Thinking, PetState.fromString("thinking"))
        assertEquals(PetState.Idle, PetState.fromString("idle"))
        assertEquals(PetState.Sleeping, PetState.fromString("sleeping"))
    }

    @Test
    fun `fromString returns Idle for unknown`() {
        assertEquals(PetState.Idle, PetState.fromString("unknown"))
        assertEquals(PetState.Idle, PetState.fromString(null))
        assertEquals(PetState.Idle, PetState.fromString(""))
    }

    @Test
    fun `priority ordering is correct`() {
        assertTrue(PetState.Error.priority > PetState.Notification.priority)
        assertTrue(PetState.Notification.priority > PetState.Sweeping.priority)
        assertTrue(PetState.Sweeping.priority > PetState.Attention.priority)
        assertTrue(PetState.Attention.priority > PetState.Working.priority)
        assertTrue(PetState.Working.priority > PetState.Thinking.priority)
        assertTrue(PetState.Thinking.priority > PetState.Idle.priority)
        assertTrue(PetState.Idle.priority > PetState.Sleeping.priority)
    }

    @Test
    fun `equal priority states exist`() {
        assertEquals(PetState.Conducting.priority, PetState.Juggling.priority)
        assertEquals(PetState.Juggling.priority, PetState.Carrying.priority)
        assertEquals(PetState.Carrying.priority, PetState.Debugger.priority)
    }

    @Test
    fun `isIdleLike classification`() {
        assertTrue(PetState.Idle.isIdleLike)
        assertTrue(PetState.Sleeping.isIdleLike)
        assertTrue(PetState.Yawning.isIdleLike)
        assertTrue(PetState.Dozing.isIdleLike)
        assertTrue(PetState.Collapsing.isIdleLike)
        assertFalse(PetState.Working.isIdleLike)
        assertFalse(PetState.Error.isIdleLike)
        assertFalse(PetState.Attention.isIdleLike)
    }

    @Test
    fun `isActive classification`() {
        assertTrue(PetState.Working.isActive)
        assertTrue(PetState.Error.isActive)
        assertTrue(PetState.Attention.isActive)
        assertFalse(PetState.Idle.isActive)
        assertFalse(PetState.Sleeping.isActive)
        assertFalse(PetState.Waking.isActive)
    }

    @Test
    fun `isSleepSequence classification`() {
        assertTrue(PetState.Yawning.isSleepSequence)
        assertTrue(PetState.Dozing.isSleepSequence)
        assertTrue(PetState.Collapsing.isSleepSequence)
        assertTrue(PetState.Sleeping.isSleepSequence)
        assertTrue(PetState.Waking.isSleepSequence)
        assertFalse(PetState.Idle.isSleepSequence)
        assertFalse(PetState.Working.isSleepSequence)
    }

    @Test
    fun `themeKey matches state name`() {
        assertEquals("error", PetState.Error.themeKey)
        assertEquals("working", PetState.Working.themeKey)
        assertEquals("idle", PetState.Idle.themeKey)
        assertEquals("sleeping", PetState.Sleeping.themeKey)
    }

    // ── ALL list completeness ──────────────────────────────────────────

    @Test
    fun `ALL contains exactly 16 states`() {
        assertEquals(16, PetState.ALL.size)
    }

    @Test
    fun `ALL contains all concrete states`() {
        val allThemes = PetState.ALL.map { it.themeKey }.toSet()
        val expected = setOf(
            "error", "notification", "sweeping", "attention",
            "conducting", "juggling", "carrying", "debugger",
            "working", "thinking",
            "idle", "yawning", "dozing", "collapsing", "waking",
            "sleeping"
        )
        assertEquals(expected, allThemes)
    }

    @Test
    fun `ALL is ordered by descending priority`() {
        for (i in 0 until PetState.ALL.size - 1) {
            assertTrue(
                "ALL[$i] (${PetState.ALL[i].themeKey}) should have >= priority than ALL[$i+1] (${PetState.ALL[i+1].themeKey})",
                PetState.ALL[i].priority >= PetState.ALL[i + 1].priority
            )
        }
    }

    // ── ONESHOT_STATES ─────────────────────────────────────────────────

    @Test
    fun `ONESHOT_STATES contains expected states`() {
        val expected = setOf("attention", "error", "sweeping", "notification", "carrying")
        val actual = PetState.ONESHOT_STATES.map { it.themeKey }.toSet()
        assertEquals(expected, actual)
    }

    @Test
    fun `ONESHOT_STATES size is 5`() {
        assertEquals(5, PetState.ONESHOT_STATES.size)
    }

    // ── RUNNING_BADGES ─────────────────────────────────────────────────

    @Test
    fun `RUNNING_BADGES contains expected values`() {
        val expected = setOf("running", "working", "thinking", "tool_use", "typing")
        assertEquals(expected, PetState.RUNNING_BADGES)
    }

    // ── SLEEP_SEQUENCE ─────────────────────────────────────────────────

    @Test
    fun `SLEEP_SEQUENCE contains exactly 5 states`() {
        assertEquals(5, PetState.SLEEP_SEQUENCE.size)
    }

    @Test
    fun `SLEEP_SEQUENCE contains yawning dozing collapsing sleeping waking`() {
        assertTrue(PetState.SLEEP_SEQUENCE.contains(PetState.Yawning))
        assertTrue(PetState.SLEEP_SEQUENCE.contains(PetState.Dozing))
        assertTrue(PetState.SLEEP_SEQUENCE.contains(PetState.Collapsing))
        assertTrue(PetState.SLEEP_SEQUENCE.contains(PetState.Sleeping))
        assertTrue(PetState.SLEEP_SEQUENCE.contains(PetState.Waking))
    }

    // ── fromString completeness ────────────────────────────────────────

    @Test
    fun `fromString maps all 16 theme keys`() {
        val allThemeKeys = PetState.ALL.map { it.themeKey }
        for (key in allThemeKeys) {
            val state = PetState.fromString(key)
            assertEquals("fromString('$key') should return state with themeKey='$key'", key, state.themeKey)
        }
    }

    @Test
    fun `fromString is case sensitive`() {
        assertEquals(PetState.Idle, PetState.fromString("Idle"))  // uppercase → unknown → Idle
        assertEquals(PetState.Idle, PetState.fromString("ERROR")) // uppercase → unknown → Idle
    }

    // ── Waking classification ──────────────────────────────────────────

    @Test
    fun `Waking is neither idleLike nor active`() {
        assertFalse(PetState.Waking.isIdleLike)
        assertFalse(PetState.Waking.isActive)
        assertTrue(PetState.Waking.isSleepSequence)
    }
}

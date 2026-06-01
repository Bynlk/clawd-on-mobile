package com.clawd.mobile.overlay

import com.clawd.mobile.data.SessionData
import org.junit.Test
import org.junit.Assert.*

/**
 * Tests for PetStateManager's resolveDisplayState logic.
 * Recreated as a pure function to test the priority selection algorithm
 * without Android framework dependencies.
 */
class PetStateManagerLogicTest {

    // ── Helper: recreate resolveDisplayState logic ───────────────────

    /**
     * Pure recreation of PetStateManager.resolveDisplayState for testing.
     * The actual method is private and coupled to instance state (consumedDoneSessions).
     * This tests the algorithm directly.
     */
    private fun resolveDisplayState(
        visible: List<SessionData>,
        consumedDoneSessions: MutableSet<String> = mutableSetOf()
    ): PetState {
        var best: PetState = PetState.Idle
        for (session in visible) {
            val state = when {
                session.displayState != null && session.displayState != "idle" ->
                    PetState.fromString(session.displayState)
                session.badge == "interrupted" -> PetState.Error
                session.badge == "done" -> {
                    val sid = session.sessionId
                    if (sid != null && sid !in consumedDoneSessions) {
                        consumedDoneSessions.add(sid)
                        PetState.Attention
                    } else {
                        PetState.Idle
                    }
                }
                session.badge == "running" -> {
                    session.sessionId?.let { consumedDoneSessions.remove(it) }
                    PetState.fromString(session.state)
                }
                else -> PetState.Idle
            }
            if (state.isSleepSequence) continue
            if (state.priority > best.priority) best = state
        }
        return best
    }

    private fun session(
        sessionId: String,
        state: String = "idle",
        badge: String = "idle",
        displayState: String? = null,
        isVisible: Boolean = true
    ) = SessionData(
        sessionId = sessionId,
        state = state,
        badge = badge,
        displayState = displayState,
        isVisible = isVisible
    )

    // ── Empty / idle ─────────────────────────────────────────────────

    @Test
    fun `empty sessions returns Idle`() {
        assertEquals(PetState.Idle, resolveDisplayState(emptyList()))
    }

    @Test
    fun `single idle session returns Idle`() {
        val sessions = listOf(session("s1", state = "idle", badge = "idle"))
        assertEquals(PetState.Idle, resolveDisplayState(sessions))
    }

    // ── Priority selection ───────────────────────────────────────────

    @Test
    fun `working beats idle`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle"),
            session("s2", state = "working", badge = "running")
        )
        assertEquals(PetState.Working, resolveDisplayState(sessions))
    }

    @Test
    fun `error beats working`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "error", badge = "running")
        )
        assertEquals(PetState.Error, resolveDisplayState(sessions))
    }

    @Test
    fun `thinking beats idle`() {
        val sessions = listOf(
            session("s1", state = "thinking", badge = "running")
        )
        assertEquals(PetState.Thinking, resolveDisplayState(sessions))
    }

    @Test
    fun `notification beats working`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "notification", badge = "running")
        )
        assertEquals(PetState.Notification, resolveDisplayState(sessions))
    }

    @Test
    fun `sweeping beats attention`() {
        val sessions = listOf(
            session("s1", state = "attention", badge = "running"),
            session("s2", state = "sweeping", badge = "running")
        )
        assertEquals(PetState.Sweeping, resolveDisplayState(sessions))
    }

    @Test
    fun `highest priority wins among many`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "thinking", badge = "running"),
            session("s3", state = "error", badge = "running"),
            session("s4", state = "idle", badge = "idle")
        )
        assertEquals(PetState.Error, resolveDisplayState(sessions))
    }

    // ── Badge-based state mapping ────────────────────────────────────

    @Test
    fun `badge interrupted maps to Error`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "interrupted")
        )
        assertEquals(PetState.Error, resolveDisplayState(sessions))
    }

    @Test
    fun `badge done maps to Attention on first encounter`() {
        val consumed = mutableSetOf<String>()
        val sessions = listOf(
            session("s1", state = "idle", badge = "done")
        )
        assertEquals(PetState.Attention, resolveDisplayState(sessions, consumed))
    }

    @Test
    fun `badge done maps to Idle on second encounter`() {
        val consumed = mutableSetOf<String>()
        val sessions = listOf(
            session("s1", state = "idle", badge = "done")
        )
        // First call: Attention
        assertEquals(PetState.Attention, resolveDisplayState(sessions, consumed))
        // Second call: Idle (consumed)
        assertEquals(PetState.Idle, resolveDisplayState(sessions, consumed))
    }

    @Test
    fun `badge running maps from state string`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running")
        )
        assertEquals(PetState.Working, resolveDisplayState(sessions))
    }

    @Test
    fun `badge running resets consumed done`() {
        val consumed = mutableSetOf<String>()
        // First: done → Attention
        val doneSessions = listOf(session("s1", state = "idle", badge = "done"))
        assertEquals(PetState.Attention, resolveDisplayState(doneSessions, consumed))
        assertTrue(consumed.contains("s1"))

        // Then: running → resets consumed
        val runningSessions = listOf(session("s1", state = "working", badge = "running"))
        assertEquals(PetState.Working, resolveDisplayState(runningSessions, consumed))
        assertFalse(consumed.contains("s1"))
    }

    // ── displayState override ────────────────────────────────────────

    @Test
    fun `displayState overrides state when not idle`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle", displayState = "working")
        )
        assertEquals(PetState.Working, resolveDisplayState(sessions))
    }

    @Test
    fun `displayState of idle does not override`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running", displayState = "idle")
        )
        // displayState="idle" → falls through to badge="running" → state="working"
        assertEquals(PetState.Working, resolveDisplayState(sessions))
    }

    @Test
    fun `displayState null falls through to badge`() {
        val sessions = listOf(
            session("s1", state = "thinking", badge = "running", displayState = null)
        )
        assertEquals(PetState.Thinking, resolveDisplayState(sessions))
    }

    // ── Sleep sequence states are skipped ────────────────────────────

    @Test
    fun `sleep sequence states are skipped`() {
        val sessions = listOf(
            session("s1", state = "yawning", badge = "running"),
            session("s2", state = "working", badge = "running")
        )
        // Yawning is sleep sequence → skipped, Working wins
        assertEquals(PetState.Working, resolveDisplayState(sessions))
    }

    @Test
    fun `all sleep sequence states returns Idle`() {
        val sessions = listOf(
            session("s1", state = "yawning", badge = "running"),
            session("s2", state = "dozing", badge = "running"),
            session("s3", state = "sleeping", badge = "running"),
            session("s4", state = "waking", badge = "running")
        )
        assertEquals(PetState.Idle, resolveDisplayState(sessions))
    }

    // ── Conducting/Juggling/Carrying/Debugger (priority 4) ───────────

    @Test
    fun `conducting beats working`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "conducting", badge = "running")
        )
        assertEquals(PetState.Conducting, resolveDisplayState(sessions))
    }

    @Test
    fun `juggling beats thinking`() {
        val sessions = listOf(
            session("s1", state = "thinking", badge = "running"),
            session("s2", state = "juggling", badge = "running")
        )
        assertEquals(PetState.Juggling, resolveDisplayState(sessions))
    }

    // ── Multiple done sessions ───────────────────────────────────────

    @Test
    fun `multiple done sessions each trigger Attention once`() {
        val consumed = mutableSetOf<String>()
        val sessions = listOf(
            session("s1", state = "idle", badge = "done"),
            session("s2", state = "idle", badge = "done")
        )
        // First call: both trigger Attention (priority equal, last one wins)
        val result1 = resolveDisplayState(sessions, consumed)
        assertEquals(PetState.Attention, result1)
        assertTrue(consumed.contains("s1"))
        assertTrue(consumed.contains("s2"))

        // Second call: both consumed → Idle
        val result2 = resolveDisplayState(sessions, consumed)
        assertEquals(PetState.Idle, result2)
    }

    // ── Edge cases ───────────────────────────────────────────────────

    @Test
    fun `unknown state falls back to Idle`() {
        val sessions = listOf(
            session("s1", state = "unknown_state", badge = "running")
        )
        // fromString("unknown_state") → Idle
        assertEquals(PetState.Idle, resolveDisplayState(sessions))
    }

    @Test
    fun `badge unknown falls to Idle`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "unknown_badge")
        )
        assertEquals(PetState.Idle, resolveDisplayState(sessions))
    }

    @Test
    fun `done with null sessionId goes to else branch`() {
        val consumed = mutableSetOf<String>()
        val sessions = listOf(
            SessionData(sessionId = null, state = "idle", badge = "done")
        )
        // sessionId is null → sid != null is false → else branch → Idle
        assertEquals(PetState.Idle, resolveDisplayState(sessions, consumed))
    }
}

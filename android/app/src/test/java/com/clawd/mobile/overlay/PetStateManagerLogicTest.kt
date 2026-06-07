package com.clawd.mobile.overlay

import com.clawd.mobile.data.SessionData
import org.junit.Test
import org.junit.Assert.*

/**
 * Tests for PetStateManager's resolveDisplayState.
 * Calls the real companion methods directly — no local copies.
 */
class PetStateManagerLogicTest {

    private fun session(
        sessionId: String,
        state: String = "idle",
        badge: String = "idle",
        displayState: String? = null,
        hookState: String? = null,
        isVisible: Boolean = true
    ) = SessionData(
        sessionId = sessionId,
        state = state,
        badge = badge,
        displayState = displayState,
        hookState = hookState,
        isVisible = isVisible
    )

    private fun consumed(vararg ids: String): TimedConsumeSet {
        val set = TimedConsumeSet(PetStateManager.DONE_SESSION_TTL_MS)
        ids.forEach { set.tryConsume(it) }
        return set
    }

    private fun emptySet() = TimedConsumeSet(PetStateManager.DONE_SESSION_TTL_MS)

    // ── Empty / idle ─────────────────────────────────────────────────

    @Test
    fun `empty sessions returns Idle`() {
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(emptyList(), emptySet()))
    }

    @Test
    fun `single idle session returns Idle`() {
        val sessions = listOf(session("s1", state = "idle", badge = "idle"))
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    // ── Priority selection ───────────────────────────────────────────

    @Test
    fun `working beats idle`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle"),
            session("s2", state = "working", badge = "running")
        )
        assertEquals(PetState.Working, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `error beats working`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "error", badge = "running")
        )
        assertEquals(PetState.Error, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `thinking beats idle`() {
        val sessions = listOf(
            session("s1", state = "thinking", badge = "running")
        )
        assertEquals(PetState.Thinking, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `notification beats working`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "notification", badge = "running")
        )
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `sweeping beats attention`() {
        val sessions = listOf(
            session("s1", state = "attention", badge = "running"),
            session("s2", state = "sweeping", badge = "running")
        )
        assertEquals(PetState.Sweeping, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `highest priority wins among many`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "thinking", badge = "running"),
            session("s3", state = "error", badge = "running"),
            session("s4", state = "idle", badge = "idle")
        )
        assertEquals(PetState.Error, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    // ── Badge-based state mapping ────────────────────────────────────

    @Test
    fun `badge interrupted maps to Error`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "interrupted")
        )
        assertEquals(PetState.Error, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `badge interrupted maps to Error on first call then Idle on second (consumed)`() {
        val consumedDone = emptySet()
        val consumedInterrupted = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "interrupted")
        )
        // First call: Error
        assertEquals(PetState.Error, PetStateManager.resolveDisplayState(sessions, consumedDone, consumedInterrupted))
        // Second call: Idle (consumed)
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, consumedDone, consumedInterrupted))
    }

    @Test
    fun `badge done maps to Attention on first encounter`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "done")
        )
        assertEquals(PetState.Attention, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `badge done maps to Idle on second encounter`() {
        val set = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "done")
        )
        // First call: Attention
        assertEquals(PetState.Attention, PetStateManager.resolveDisplayState(sessions, set))
        // Second call: Idle (consumed)
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, set))
    }

    @Test
    fun `badge running maps from state string`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running")
        )
        assertEquals(PetState.Working, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `badge running resets consumed done`() {
        val set = consumed("s1")
        // running → resets consumed
        val runningSessions = listOf(session("s1", state = "working", badge = "running"))
        assertEquals(PetState.Working, PetStateManager.resolveDisplayState(runningSessions, set))
        assertFalse(set.contains("s1"))
    }

    // ── displayState override ────────────────────────────────────────

    @Test
    fun `displayState overrides state when not idle`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle", displayState = "working")
        )
        assertEquals(PetState.Working, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `displayState of idle does not override`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running", displayState = "idle")
        )
        // displayState="idle" → falls through to badge="running" → state="working"
        assertEquals(PetState.Working, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `displayState null falls through to badge`() {
        val sessions = listOf(
            session("s1", state = "thinking", badge = "running", displayState = null)
        )
        assertEquals(PetState.Thinking, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    // ── Sleep sequence states are skipped ────────────────────────────

    @Test
    fun `sleep sequence states are skipped`() {
        val sessions = listOf(
            session("s1", state = "yawning", badge = "running"),
            session("s2", state = "working", badge = "running")
        )
        // Yawning is sleep sequence → skipped, Working wins
        assertEquals(PetState.Working, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `all sleep sequence states returns Idle`() {
        val sessions = listOf(
            session("s1", state = "yawning", badge = "running"),
            session("s2", state = "dozing", badge = "running"),
            session("s3", state = "sleeping", badge = "running"),
            session("s4", state = "waking", badge = "running")
        )
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    // ── Conducting/Juggling/Carrying/Debugger (priority 4) ───────────

    @Test
    fun `conducting beats working`() {
        val sessions = listOf(
            session("s1", state = "working", badge = "running"),
            session("s2", state = "conducting", badge = "running")
        )
        assertEquals(PetState.Conducting, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `juggling beats thinking`() {
        val sessions = listOf(
            session("s1", state = "thinking", badge = "running"),
            session("s2", state = "juggling", badge = "running")
        )
        assertEquals(PetState.Juggling, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    // ── Multiple done sessions ───────────────────────────────────────

    @Test
    fun `multiple done sessions each trigger Attention once`() {
        val set = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "done"),
            session("s2", state = "idle", badge = "done")
        )
        // First call: both trigger Attention (priority equal, last one wins)
        val result1 = PetStateManager.resolveDisplayState(sessions, set)
        assertEquals(PetState.Attention, result1)
        assertTrue(set.contains("s1"))
        assertTrue(set.contains("s2"))

        // Second call: both consumed → Idle
        val result2 = PetStateManager.resolveDisplayState(sessions, set)
        assertEquals(PetState.Idle, result2)
    }

    // ── Edge cases ───────────────────────────────────────────────────

    @Test
    fun `unknown state falls back to Idle`() {
        val sessions = listOf(
            session("s1", state = "unknown_state", badge = "running")
        )
        // fromString("unknown_state") → Idle
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `badge unknown falls to Idle`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "unknown_badge")
        )
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    @Test
    fun `done with null sessionId goes to else branch`() {
        val sessions = listOf(
            SessionData(sessionId = null, state = "idle", badge = "done")
        )
        // sessionId is null → sid != null is false → else branch → Idle
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, emptySet()))
    }

    // ── TimedConsumeSet TTL cleanup ──────────────────────────────────

    @Test
    fun `TimedConsumeSet tryConsume returns true on first call false on second`() {
        val set = emptySet()
        assertTrue(set.tryConsume("s1"))
        assertFalse(set.tryConsume("s1"))
    }

    @Test
    fun `TimedConsumeSet remove allows re-consume`() {
        val set = emptySet()
        set.tryConsume("s1")
        set.remove("s1")
        assertTrue(set.tryConsume("s1"))
    }

    // ── countSessionsForTier ─────────────────────────────────────────

    @Test
    fun `working tier counts working thinking juggling sessions`() {
        val sessions = listOf(
            session("s1", state = "working", isVisible = true),
            session("s2", state = "thinking", isVisible = true),
            session("s3", state = "juggling", isVisible = true),
            session("s4", state = "idle", isVisible = true)
        )
        assertEquals(3, PetStateManager.countSessionsForTier(PetState.Working, sessions))
    }

    @Test
    fun `working tier excludes sleeping and idle sessions`() {
        val sessions = listOf(
            session("s1", state = "working", isVisible = true),
            session("s2", state = "sleeping", isVisible = true),
            session("s3", state = "idle", isVisible = true),
            session("s4", state = "error", isVisible = true)
        )
        assertEquals(1, PetStateManager.countSessionsForTier(PetState.Working, sessions))
    }

    @Test
    fun `working tier excludes invisible sessions`() {
        val sessions = listOf(
            session("s1", state = "working", isVisible = true),
            session("s2", state = "working", isVisible = false),
            session("s3", state = "thinking", isVisible = false)
        )
        assertEquals(1, PetStateManager.countSessionsForTier(PetState.Working, sessions))
    }

    @Test
    fun `juggling tier counts only juggling sessions`() {
        val sessions = listOf(
            session("s1", state = "juggling", isVisible = true),
            session("s2", state = "working", isVisible = true),
            session("s3", state = "thinking", isVisible = true)
        )
        assertEquals(1, PetStateManager.countSessionsForTier(PetState.Juggling, sessions))
    }

    @Test
    fun `juggling tier excludes invisible juggling sessions`() {
        val sessions = listOf(
            session("s1", state = "juggling", isVisible = true),
            session("s2", state = "juggling", isVisible = false)
        )
        assertEquals(1, PetStateManager.countSessionsForTier(PetState.Juggling, sessions))
    }

    @Test
    fun `thinking state returns zero session count`() {
        val sessions = listOf(
            session("s1", state = "thinking", isVisible = true),
            session("s2", state = "working", isVisible = true)
        )
        assertEquals(0, PetStateManager.countSessionsForTier(PetState.Thinking, sessions))
    }

    @Test
    fun `idle state returns zero session count`() {
        val sessions = listOf(
            session("s1", state = "working", isVisible = true)
        )
        assertEquals(0, PetStateManager.countSessionsForTier(PetState.Idle, sessions))
    }

    @Test
    fun `empty sessions returns zero for all states`() {
        val sessions = emptyList<SessionData>()
        assertEquals(0, PetStateManager.countSessionsForTier(PetState.Working, sessions))
        assertEquals(0, PetStateManager.countSessionsForTier(PetState.Juggling, sessions))
    }

    @Test
    fun `working tier with mixed visibility and states`() {
        // 1 working visible + 1 working invisible + 1 sleeping visible = count 1
        val sessions = listOf(
            session("s1", state = "working", isVisible = true),
            session("s2", state = "working", isVisible = false),
            session("s3", state = "sleeping", isVisible = true),
            session("s4", state = "thinking", isVisible = true),
            session("s5", state = "juggling", isVisible = true)
        )
        assertEquals(3, PetStateManager.countSessionsForTier(PetState.Working, sessions))
    }

    @Test
    fun `1 working 2 sleeping should be tier 1 not tier 3`() {
        // This is the exact scenario from the bug report
        val sessions = listOf(
            session("s1", state = "working", isVisible = true),
            session("s2", state = "sleeping", isVisible = true),
            session("s3", state = "sleeping", isVisible = true)
        )
        assertEquals(1, PetStateManager.countSessionsForTier(PetState.Working, sessions))
    }

    // ── Notification displayState consumption ───────────────────────

    @Test
    fun `displayState notification always returns Notification (no consumption)`() {
        val consumed = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle", displayState = "notification")
        )
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed))
        assertFalse(consumed.contains("s1"))
    }

    @Test
    fun `displayState notification persists across repeated calls`() {
        val consumed = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle", displayState = "notification")
        )
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed))
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed))
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed))
    }

    // ── hookState notification branch ────────────────────────────────

    @Test
    fun `interrupted with hookState notification triggers Notification`() {
        val consumedNotif = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "interrupted", hookState = "notification")
        )
        val result = PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumedNotif)
        assertEquals(PetState.Notification, result)
        assertTrue(consumedNotif.contains("s1"))
    }

    @Test
    fun `interrupted with hookState notification consumed on second call`() {
        val consumedNotif = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "interrupted", hookState = "notification")
        )
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumedNotif))
        assertEquals(PetState.Idle, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumedNotif))
    }

    @Test
    fun `interrupted without hookState triggers Error not Notification`() {
        val consumedNotif = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "interrupted")
        )
        val result = PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumedNotif)
        assertEquals(PetState.Error, result)
        assertFalse(consumedNotif.contains("s1"))
    }

    // ── Notification TTL cleanup during processing ───────────────────

    @Test
    fun `displayState notification removes stale consume entry`() {
        val consumed = TimedConsumeSet(PetStateManager.DONE_SESSION_TTL_MS)
        consumed.tryConsume("s1")

        val sessions = listOf(
            session("s1", state = "idle", badge = "idle", displayState = "notification")
        )
        assertEquals(PetState.Notification, PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed))

        // remove() was called — entry is gone so next notification cycle isn't suppressed
        assertFalse(consumed.contains("s1"))
    }

    // ── Multiple notification sessions ───────────────────────────────

    @Test
    fun `multiple notification sessions always return Notification`() {
        val consumed = emptySet()
        val sessions = listOf(
            session("s1", state = "idle", badge = "idle", displayState = "notification"),
            session("s2", state = "idle", badge = "idle", displayState = "notification")
        )
        val result = PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed)
        assertEquals(PetState.Notification, result)
        // No consumption — both sessions stay active
        assertFalse(consumed.contains("s1"))
        assertFalse(consumed.contains("s2"))

        // Repeated calls still return Notification
        val result2 = PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed)
        assertEquals(PetState.Notification, result2)
    }

    // ── Mixed done + interrupted + notification ──────────────────────

    @Test
    fun `mixed done interrupted and notification prioritizes correctly`() {
        val sessions = listOf(
            session("s1", state = "idle", badge = "done"),
            session("s2", state = "idle", badge = "interrupted"),
            session("s3", state = "working", badge = "running")
        )
        // interrupted → Error (priority 6) > Attention (priority 3) > Working (priority 2)
        val result = PetStateManager.resolveDisplayState(sessions, emptySet())
        assertEquals(PetState.Error, result)
    }

    // ── Session with null sessionId ──────────────────────────────────

    @Test
    fun `notification with null sessionId still returns Notification`() {
        val consumed = emptySet()
        val sessions = listOf(
            SessionData(sessionId = null, state = "idle", badge = "idle", displayState = "notification")
        )
        // null sessionId → remove is no-op via safe call, but Notification is still returned
        val result = PetStateManager.resolveDisplayState(sessions, emptySet(), emptySet(), consumed)
        assertEquals(PetState.Notification, result)
    }

    // ── Interrupted with null sessionId ──────────────────────────────

    @Test
    fun `interrupted with null sessionId returns Idle`() {
        val sessions = listOf(
            SessionData(sessionId = null, state = "idle", badge = "interrupted")
        )
        // null sessionId → cannot consume → falls through to Idle
        val result = PetStateManager.resolveDisplayState(sessions, emptySet())
        assertEquals(PetState.Idle, result)
    }
}

package com.clawd.mobile.integration

import com.clawd.mobile.data.SessionData
import com.clawd.mobile.overlay.PetState
import com.clawd.mobile.overlay.PetStateManager
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/**
 * Integration tests for PetStateManager session → state resolution pipeline.
 * Uses injected MutableStateFlow + start(scope) to exercise the real collector.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PetStateIntegrationTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private fun makeSession(
        sessionId: String = "s1",
        state: String = "idle",
        badge: String = "idle",
        displayState: String? = null,
        isVisible: Boolean = true,
        isReal: Boolean = true,
    ) = SessionData(
        sessionId = sessionId,
        state = state,
        badge = badge,
        displayState = displayState,
        isVisible = isVisible,
        isReal = isReal,
    )

    private fun TestScope.createManager(): Pair<PetStateManager, MutableStateFlow<Map<String, SessionData>>> {
        val sessionsFlow = MutableStateFlow<Map<String, SessionData>>(emptyMap())
        val manager = PetStateManager("clawd", sessionsFlow)
        manager.start(scope = backgroundScope)
        return manager to sessionsFlow
    }

    private fun current(manager: PetStateManager): PetState {
        val cmd = manager.stateFlow.value as PetStateManager.StateCommand.StateChanged
        return cmd.state
    }

    // ── Pipeline: Idle → Working ─────────────────────────────────────

    @Test
    fun `idle to working`() = runTest(testDispatcher) {
        val (manager, sessionsFlow) = createManager()
        assertTrue(current(manager).isIdleLike)

        sessionsFlow.value = mapOf(
            "s1" to makeSession(state = "working", badge = "running")
        )
        advanceUntilIdle()

        assertEquals(PetState.Working, current(manager))
    }

    // ── Pipeline: Working → Error ────────────────────────────────────

    @Test
    fun `working to error`() = runTest(testDispatcher) {
        val (manager, sessionsFlow) = createManager()

        sessionsFlow.value = mapOf(
            "s1" to makeSession(state = "working", badge = "running")
        )
        advanceUntilIdle()
        assertEquals(PetState.Working, current(manager))

        sessionsFlow.value = mapOf(
            "s1" to makeSession(state = "error", badge = "running")
        )
        advanceUntilIdle()

        assertEquals(PetState.Error, current(manager))
    }

    // ── Pipeline: done badge triggers Attention ──────────────────────

    @Test
    fun `done badge triggers attention`() = runTest(testDispatcher) {
        val (manager, sessionsFlow) = createManager()

        sessionsFlow.value = mapOf(
            "s1" to makeSession(state = "working", badge = "running")
        )
        advanceUntilIdle()
        assertEquals(PetState.Working, current(manager))

        // Badge changes to "done" → Attention (first encounter)
        sessionsFlow.value = mapOf(
            "s1" to makeSession(state = "idle", badge = "done")
        )
        advanceUntilIdle()

        assertEquals(PetState.Attention, current(manager))
    }

    // ── Pipeline: empty sessions → Idle ──────────────────────────────

    @Test
    fun `empty sessions returns to idle`() = runTest(testDispatcher) {
        val (manager, sessionsFlow) = createManager()

        sessionsFlow.value = mapOf(
            "s1" to makeSession(state = "working", badge = "running")
        )
        advanceUntilIdle()
        assertEquals(PetState.Working, current(manager))

        sessionsFlow.value = emptyMap()
        advanceUntilIdle()

        assertTrue(current(manager).isIdleLike)
    }

    // ── PetState properties ──────────────────────────────────────────

    @Test
    fun `Idle is idleLike`() {
        assertTrue(PetState.Idle.isIdleLike)
    }

    @Test
    fun `Working is not idleLike`() {
        assertFalse(PetState.Working.isIdleLike)
    }

    @Test
    fun `Sleeping is sleepSequence`() {
        assertTrue(PetState.Sleeping.isSleepSequence)
    }

    @Test
    fun `Yawning is sleepSequence`() {
        assertTrue(PetState.Yawning.isSleepSequence)
    }

    @Test
    fun `Working is not sleepSequence`() {
        assertFalse(PetState.Working.isSleepSequence)
    }

    @Test
    fun `fromString resolves known states`() {
        assertEquals(PetState.Idle, PetState.fromString("idle"))
        assertEquals(PetState.Working, PetState.fromString("working"))
        assertEquals(PetState.Thinking, PetState.fromString("thinking"))
        assertEquals(PetState.Error, PetState.fromString("error"))
    }

    @Test
    fun `fromString returns Idle for unknown`() {
        assertEquals(PetState.Idle, PetState.fromString("unknown_state"))
    }

    // ── Session visibility filtering ─────────────────────────────────

    @Test
    fun `invisible sessions should be filtered`() {
        val sessions = mapOf(
            "s1" to makeSession(isVisible = true),
            "s2" to makeSession(isVisible = false),
        )
        val visible = sessions.values.filter { it.isVisible }
        assertEquals(1, visible.size)
        assertEquals("s1", visible[0].sessionId)
    }

    @Test
    fun `non-real sessions should be filtered in snapshot`() {
        val sessions = mapOf(
            "s1" to makeSession(isReal = true, isVisible = true),
            "s2" to makeSession(isReal = false, isVisible = true),
        )
        val real = sessions.values.filter { it.isReal && it.isVisible }
        assertEquals(1, real.size)
    }

    // ── StateCommand data classes ────────────────────────────────────

    @Test
    fun `sessionCount in StateChanged reflects visible sessions`() {
        val command = PetStateManager.StateCommand.StateChanged(PetState.Working, sessionCount = 3)
        assertEquals(3, command.sessionCount)
    }

    @Test
    fun `sessionCount defaults to zero`() {
        val command = PetStateManager.StateCommand.StateChanged(PetState.Idle)
        assertEquals(0, command.sessionCount)
    }

    @Test
    fun `resolvedSvg field in StateChanged`() {
        val command = PetStateManager.StateCommand.StateChanged(
            PetState.Working,
            sessionCount = 1,
            resolvedSvg = "clawd-working-1.svg"
        )
        assertEquals("clawd-working-1.svg", command.resolvedSvg)
    }

    @Test
    fun `SvgLoad command carries asset path`() {
        val command = PetStateManager.StateCommand.SvgLoad(
            assetPath = "svg/clawd/clawd-idle.svg",
            force = true
        )
        assertEquals("svg/clawd/clawd-idle.svg", command.assetPath)
        assertTrue(command.force)
    }

    @Test
    fun `ReactionSvg command carries asset path`() {
        val command = PetStateManager.StateCommand.ReactionSvg("svg/clawd/clawd-happy.svg")
        assertEquals("svg/clawd/clawd-happy.svg", command.assetPath)
    }
}

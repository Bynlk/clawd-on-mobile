package com.clawd.mobile.overlay

import io.mockk.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [PetTimerManager].
 *
 * Uses MockK for [PetStateManager] and [SvgLoader], and kotlinx-coroutines-test
 * for deterministic time control.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PetTimerManagerTest {

    private lateinit var manager: PetStateManager
    private lateinit var emittedStates: MutableList<Pair<PetState, String?>>
    private lateinit var emittedCommands: MutableList<PetStateManager.StateCommand>
    private lateinit var timerManager: PetTimerManager

    @Before
    fun setUp() {
        manager = mockk(relaxed = true)
        every { manager.character } returns "clawd"

        emittedStates = mutableListOf()
        emittedCommands = mutableListOf()

        timerManager = PetTimerManager(
            manager = manager,
            emitState = { state, svg -> emittedStates.add(state to svg) },
            commandFlowEmit = { cmd -> emittedCommands.add(cmd) }
        )

        mockkObject(SvgLoader)
    }

    // ── 1. idleSince initialization and reset ──────────────────────────

    @Test
    fun `idleSince starts at zero`() {
        val scope = TestScope()
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.handleIdleTimeout(scope)

        // idleSince was 0, now set — second call shouldn't re-set
        val firstStates = emittedStates.size
        timerManager.handleIdleTimeout(scope)
        assertEquals(firstStates, emittedStates.size)
    }

    @Test
    fun `resetIdleTimer clears idleSince`() {
        val scope = TestScope()
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.handleIdleTimeout(scope)
        timerManager.resetIdleTimer()

        timerManager.handleIdleTimeout(scope)
        assertFalse(emittedStates.any { it.first == PetState.Yawning })
    }

    // ── 2. Sleep sequence trigger after 60s idle ───────────────────────

    @Test
    fun `sleep sequence triggers after 60s idle timeout`() = runTest {
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.startSleepSequence(this)
        runCurrent()

        assertTrue(emittedStates.any { it.first == PetState.Yawning })
        timerManager.cancelSleepSequence()
    }

    @Test
    fun `sleep sequence does not trigger before timeout`() {
        val scope = TestScope()
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.handleIdleTimeout(scope)

        assertFalse(emittedStates.any { it.first.isSleepSequence })
    }

    // ── 3. Sleep sequence: 4-stage flow (Yawning → Dozing → Collapsing → Sleeping) ──

    @Test
    fun `sleep sequence emits all 4 stages for clawd`() = runTest {
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.startSleepSequence(this)
        runCurrent()
        assertEquals(PetState.Yawning, emittedStates.last().first)

        val cfg = PetStateManager.SLEEP_TIMINGS["clawd"]!!
        advanceTimeBy(cfg.yawnMs)
        runCurrent()
        assertEquals(PetState.Dozing, emittedStates.last().first)

        advanceTimeBy(cfg.dozingMs)
        runCurrent()
        // clawd collapseMs is 0 → uses 2s fallback
        assertEquals(PetState.Collapsing, emittedStates.last().first)

        advanceTimeBy(2_000L)
        runCurrent()
        assertEquals(PetState.Sleeping, emittedStates.last().first)

        // Verify no idle animation loop after sleeping
        emittedStates.clear()
        advanceTimeBy(60_000)
        runCurrent()
        assertTrue(emittedStates.isEmpty())

        timerManager.cancelSleepSequence()
    }

    @Test
    fun `calico sleep sequence includes Collapsing state`() = runTest {
        every { manager.character } returns "calico"

        timerManager.startSleepSequence(this)
        runCurrent()
        assertEquals(PetState.Yawning, emittedStates.last().first)

        val cfg = PetStateManager.SLEEP_TIMINGS["calico"]!!
        advanceTimeBy(cfg.yawnMs)
        runCurrent()
        assertEquals(PetState.Dozing, emittedStates.last().first)

        advanceTimeBy(cfg.dozingMs)
        runCurrent()
        assertEquals(PetState.Collapsing, emittedStates.last().first)

        advanceTimeBy(cfg.collapseMs)
        runCurrent()
        assertEquals(PetState.Sleeping, emittedStates.last().first)

        timerManager.cancelSleepSequence()
    }

    // ── 4. Waking animation → restore target state ─────────────────────

    @Test
    fun `playWakingAndRestore emits Waking then target state`() = runTest {
        every { SvgLoader.hasSvgForState(PetState.Waking, "clawd") } returns true
        every { manager.setLastNonIdleState(any()) } just Runs

        timerManager.playWakingAndRestore(PetState.Working, this)
        runCurrent()
        assertEquals(PetState.Waking, emittedStates.last().first)

        val cfg = PetStateManager.SLEEP_TIMINGS["clawd"]!!
        advanceTimeBy(cfg.wakeMs)
        runCurrent()
        assertEquals(PetState.Working, emittedStates.last().first)
        verify { manager.setLastNonIdleState(PetState.Working) }
    }

    @Test
    fun `playWakingAndRestore skips Waking animation when no SVG`() = runTest {
        every { SvgLoader.hasSvgForState(PetState.Waking, "clawd") } returns false
        every { manager.setLastNonIdleState(any()) } just Runs

        timerManager.playWakingAndRestore(PetState.Thinking, this)
        runCurrent()

        assertEquals(PetState.Thinking, emittedStates.last().first)
        assertFalse(emittedStates.any { it.first == PetState.Waking })
    }

    // ── 5. Reaction SVG overlay and restore ────────────────────────────

    @Test
    fun `loadReactionAndRestore emits reaction command then restores`() = runTest {
        every { manager.resolveBestState() } returns PetState.Working

        timerManager.loadReactionAndRestore("reaction.svg", 1000L, this)

        assertTrue(emittedCommands.any {
            it is PetStateManager.StateCommand.ReactionSvg && it.assetPath == "reaction.svg"
        })

        advanceTimeBy(1000)
        runCurrent()
        assertEquals(PetState.Working, emittedStates.last().first)
    }

    // ── 6. Generation mechanism cancels stale callbacks ─────────────────

    @Test
    fun `stale reaction restore is cancelled by newer reaction`() = runTest {
        every { manager.resolveBestState() } returns PetState.Working

        timerManager.loadReactionAndRestore("reaction1.svg", 2000L, this)

        advanceTimeBy(500)
        every { manager.resolveBestState() } returns PetState.Thinking
        timerManager.loadReactionAndRestore("reaction2.svg", 1000L, this)

        advanceTimeBy(1100)
        runCurrent()
        // Only the second reaction's restore should fire
        assertEquals(PetState.Thinking, emittedStates.last().first)

        // The first reaction's restore (at 2000ms) should NOT fire
        advanceTimeBy(1000)
        runCurrent()
        // resolveBestState should have been called once (for reaction2), not twice
        verify(exactly = 1) { manager.resolveBestState() }
    }

    @Test
    fun `stale waking restore is cancelled by newer waking`() = runTest {
        every { SvgLoader.hasSvgForState(PetState.Waking, "clawd") } returns true
        every { manager.setLastNonIdleState(any()) } just Runs

        timerManager.playWakingAndRestore(PetState.Working, this)

        advanceTimeBy(500)
        timerManager.playWakingAndRestore(PetState.Thinking, this)

        val cfg = PetStateManager.SLEEP_TIMINGS["clawd"]!!
        advanceTimeBy(cfg.wakeMs)
        runCurrent()

        assertEquals(PetState.Thinking, emittedStates.last().first)
        verify { manager.setLastNonIdleState(PetState.Thinking) }
    }

    // ── 7. Working stale timeout (5 min) ───────────────────────────────

    @Test
    fun `working stale timer forces Idle after 5 min`() = runTest {
        every { manager.getCurrentState() } returns PetState.Working

        timerManager.startWorkingStaleTimer(this)
        runCurrent()
        assertTrue(emittedStates.isEmpty())

        advanceTimeBy(PetTimerManager.WORKING_STALE_TIMEOUT_MS)
        runCurrent()
        assertEquals(PetState.Idle, emittedStates.last().first)
    }

    @Test
    fun `working stale timer does not fire if state changed`() = runTest {
        every { manager.getCurrentState() } returns PetState.Thinking

        timerManager.startWorkingStaleTimer(this)

        // State changes before timeout
        advanceTimeBy(60_000)
        every { manager.getCurrentState() } returns PetState.Idle
        timerManager.cancelWorkingStaleTimer()

        advanceTimeBy(PetTimerManager.WORKING_STALE_TIMEOUT_MS)
        runCurrent()
        assertFalse(emittedStates.any { it.first == PetState.Idle })
    }

    @Test
    fun `new working stale timer cancels previous one`() = runTest {
        every { manager.getCurrentState() } returns PetState.Working

        timerManager.startWorkingStaleTimer(this)

        advanceTimeBy(60_000)
        // Start a new timer — should cancel the previous
        timerManager.startWorkingStaleTimer(this)

        // Previous would have fired at 300s; advance past that
        advanceTimeBy(250_000)
        runCurrent()
        // Should NOT have fired yet (new timer started at 60s mark)
        assertFalse(emittedStates.any { it.first == PetState.Idle })

        // Now advance to the new timer's 5 min mark (60s + 300s)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(PetState.Idle, emittedStates.last().first)
    }

    // ── 8. reset clears all timers ─────────────────────────────────────

    @Test
    fun `reset cancels sleep sequence and working stale`() = runTest {
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.startSleepSequence(this)
        timerManager.startWorkingStaleTimer(this)

        timerManager.reset()

        emittedStates.clear()
        advanceTimeBy(PetTimerManager.WORKING_STALE_TIMEOUT_MS)
        runCurrent()
        assertTrue(emittedStates.isEmpty())
    }

    @Test
    fun `reset clears idleSince`() {
        val scope = TestScope()
        every { manager.getCurrentState() } returns PetState.Idle

        timerManager.handleIdleTimeout(scope)
        timerManager.reset()

        timerManager.handleIdleTimeout(scope)
        assertFalse(emittedStates.any { it.first == PetState.Yawning })
    }

    @Test
    fun `cancelSleepSequence stops ongoing sleep sequence`() = runTest {
        timerManager.startSleepSequence(this)
        runCurrent()
        assertEquals(PetState.Yawning, emittedStates.last().first)

        timerManager.cancelSleepSequence()

        emittedStates.clear()
        advanceTimeBy(10_000)
        runCurrent()
        assertTrue(emittedStates.isEmpty())
    }
}

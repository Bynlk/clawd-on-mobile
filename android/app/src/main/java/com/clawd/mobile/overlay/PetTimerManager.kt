package com.clawd.mobile.overlay

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger

/**
 * Timer and animation-sequence logic extracted from [PetStateManager].
 *
 * Manages:
 * - Idle timeout → sleep sequence trigger (60s, aligns PC MOUSE_SLEEP_TIMEOUT)
 * - 4-stage sleep sequence: yawning → dozing → collapsing → sleeping
 * - Waking animation on activity resume
 * - 5-minute working stale timeout (aligns PC working stale protection)
 * - Reaction SVG overlay with timed restore
 *
 * Delegates state emission back to [PetStateManager] via constructor callbacks.
 */
class PetTimerManager(
    private val manager: PetStateManager,
    private val emitState: (PetState, String?) -> Unit,
    private val commandFlowEmit: (PetStateManager.StateCommand) -> Unit,
) {
    companion object {
        private const val TAG = "PetTimerManager"

        /** Working/Thinking stale timeout — 5 minutes, aligns PC. */
        const val WORKING_STALE_TIMEOUT_MS = 300_000L
    }

    private val gifGeneration = AtomicInteger(0)
    @Volatile private var idleSince: Long = 0L
    private var sleepSequenceJob: Job? = null
    private var workingStaleJob: Job? = null

    private val character: String get() = manager.character
    private val sleepConfig: PetStateConfig.SleepConfig
        get() = PetStateConfig.SLEEP_TIMINGS[character] ?: PetStateConfig.SLEEP_TIMINGS["clawd"]!!

    // ======================================================================
    //  Idle timeout → sleep
    // ======================================================================

    /**
     * Idle timeout handler: starts timer on first idle, enters sleep sequence after 60s.
     * Aligns with PC MOUSE_SLEEP_TIMEOUT.
     */
    fun handleIdleTimeout(scope: CoroutineScope) {
        val now = System.currentTimeMillis()
        if (idleSince == 0L) {
            idleSince = now
            Log.d(TAG, "Idle timeout started")
        }
        val timeout = manager.sleepTimeoutMs
        if (timeout > 0 && now - idleSince >= timeout) {
            if (!manager.getCurrentState().isSleepSequence) {
                Log.d(TAG, "Idle timeout reached (${timeout}ms), starting sleep sequence")
                startSleepSequence(scope)
            }
        }
    }

    // ======================================================================
    //  Sleep sequence (yawning → dozing → collapsing → sleeping)
    // ======================================================================

    /**
     * Start the 4-stage sleep animation sequence as a coroutine.
     * Strictly follows: Yawning → Dozing → Collapsing → Sleeping.
     * No idle animation loop during deep sleep — aligns with PC.
     */
    fun startSleepSequence(scope: CoroutineScope) {
        if (sleepSequenceJob?.isActive == true) return
        sleepSequenceJob = scope.launch {
            val cfg = sleepConfig

            // Stage 1: Yawning
            emitState(PetState.Yawning, null)
            delay(cfg.yawnMs)
            if (!isActive) return@launch

            // Stage 2: Dozing (浅睡) — cancellable by new activity
            emitState(PetState.Dozing, null)
            delay(cfg.dozingMs)
            if (!isActive) return@launch

            // Stage 3: Collapsing — always present (use fallback if config is 0)
            val collapseDelay = if (cfg.collapseMs > 0) cfg.collapseMs else 2_000L
            emitState(PetState.Collapsing, null)
            delay(collapseDelay)
            if (!isActive) return@launch

            // Stage 4: Sleeping (deep sleep) — fully static, no idle anim loop
            emitState(PetState.Sleeping, null)
        }
    }

    /**
     * Play waking animation then restore to [targetState].
     * Starts working stale timer if target is Working/Thinking.
     */
    fun playWakingAndRestore(targetState: PetState, scope: CoroutineScope) {
        cancelSleepSequence()
        cancelWorkingStaleTimer()
        val gen = gifGeneration.incrementAndGet()

        if (SvgLoader.hasSvgForState(PetState.Waking, character)) {
            emitState(PetState.Waking, null)
            scope.launch {
                delay(sleepConfig.wakeMs)
                if (gifGeneration.get() != gen) return@launch
                if (targetState.isActive) manager.setLastNonIdleState(targetState)
                Log.d(TAG, "Waking complete → ${targetState.themeKey}")
                emitState(targetState, null)
                // Start working stale timer after waking into Working/Thinking
                if (targetState == PetState.Working || targetState == PetState.Thinking) {
                    startWorkingStaleTimer(scope)
                }
            }
        } else {
            if (targetState.isActive) manager.setLastNonIdleState(targetState)
            Log.d(TAG, "No waking GIF, direct → ${targetState.themeKey}")
            emitState(targetState, null)
            if (targetState == PetState.Working || targetState == PetState.Thinking) {
                startWorkingStaleTimer(scope)
            }
        }
    }

    fun cancelSleepSequence() {
        sleepSequenceJob?.cancel()
        sleepSequenceJob = null
    }

    // ======================================================================
    //  Working stale timeout (5 min, aligns PC)
    // ======================================================================

    /**
     * Start a 5-minute working stale timer.
     * If the pet stays in Working/Thinking for 5 min without a state change,
     * force-return to Idle. Aligns with PC working stale protection.
     */
    fun startWorkingStaleTimer(scope: CoroutineScope) {
        cancelWorkingStaleTimer()
        workingStaleJob = scope.launch {
            delay(WORKING_STALE_TIMEOUT_MS)
            workingStaleJob = null
            val current = manager.getCurrentState()
            if (current == PetState.Working || current == PetState.Thinking) {
                Log.w(TAG, "Working stale timeout (5 min), forcing Idle")
                emitState(PetState.Idle, null)
            }
        }
    }

    /** Cancel any pending working stale timer. Called on state change or reset. */
    fun cancelWorkingStaleTimer() {
        workingStaleJob?.cancel()
        workingStaleJob = null
    }

    // ======================================================================
    //  Reaction SVG overlay
    // ======================================================================

    /**
     * Play a reaction SVG, then restore the previous state.
     * Uses [gifGeneration] to discard stale restore callbacks.
     */
    fun loadReactionAndRestore(assetPath: String, delayMs: Long, scope: CoroutineScope) {
        val gen = gifGeneration.incrementAndGet()
        commandFlowEmit(PetStateManager.StateCommand.ReactionSvg(assetPath))

        scope.launch {
            delay(delayMs)
            if (gifGeneration.get() != gen) return@launch
            val restoreState = manager.resolveBestState()
            emitState(restoreState, null)
        }
    }

    // ======================================================================
    //  Lifecycle
    // ======================================================================

    fun reset() {
        cancelSleepSequence()
        cancelWorkingStaleTimer()
        gifGeneration.set(0)
        idleSince = 0L
    }

    /** Reset idle timer — called when entering an active state. */
    fun resetIdleTimer() {
        idleSince = 0L
    }
}

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
 * - Sleep sequence: yawning → [collapsing →] sleeping → idle animation loop
 * - Waking animation on activity resume
 * - Auto-return from oneshot states
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
    }

    private val gifGeneration = AtomicInteger(0)
    @Volatile private var idleSince: Long = 0L
    private var sleepSequenceJob: Job? = null
    private var autoReturnJob: Job? = null

    private val character: String get() = manager.character
    private val sleepConfig: PetStateManager.Companion.SleepConfig
        get() = PetStateManager.SLEEP_TIMINGS[character] ?: PetStateManager.SLEEP_TIMINGS["clawd"]!!

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
        if (now - idleSince >= PetStateManager.IDLE_SLEEP_TIMEOUT_MS) {
            if (!manager.getCurrentState().isSleepSequence) {
                Log.d(TAG, "Idle timeout reached (${PetStateManager.IDLE_SLEEP_TIMEOUT_MS}ms), starting sleep sequence")
                startSleepSequence(scope)
            }
        }
    }

    // ======================================================================
    //  Sleep sequence (yawning → [collapsing →] sleeping → idle anim loop)
    // ======================================================================

    /**
     * Start the sleep animation sequence as a coroutine.
     * Skips states that have no dedicated SVG (falls back through SvgLoader).
     */
    fun startSleepSequence(scope: CoroutineScope) {
        if (sleepSequenceJob?.isActive == true) return
        sleepSequenceJob = scope.launch {
            val cfg = sleepConfig

            emitState(PetState.Yawning, null)
            delay(cfg.yawnMs)
            if (!isActive) return@launch

            // Dozing (浅睡) — aligns with PC dozing state.
            // Cancellable: cancelSleepSequence() cancels this job, so new sessions can wake immediately.
            emitState(PetState.Dozing, null)
            delay(cfg.dozingMs)
            if (!isActive) return@launch

            if (cfg.collapseMs > 0) {
                emitState(PetState.Collapsing, null)
                delay(cfg.collapseMs)
                if (!isActive) return@launch
            }

            emitState(PetState.Sleeping, null)

            while (isActive) {
                delay(PetStateManager.IDLE_ANIM_INTERVAL_MS)
                if (!isActive) break
                val idlePath = SvgLoader.pickIdleAnimation(character)
                if (idlePath != null) {
                    commandFlowEmit(PetStateManager.StateCommand.SvgLoad(idlePath, force = false))
                    delay(PetStateManager.IDLE_ANIM_DISPLAY_MS)
                }
            }
        }
    }

    /**
     * Play waking animation then restore to [targetState].
     */
    fun playWakingAndRestore(targetState: PetState, scope: CoroutineScope) {
        cancelSleepSequence()
        val gen = gifGeneration.incrementAndGet()

        if (SvgLoader.hasSvgForState(PetState.Waking, character)) {
            emitState(PetState.Waking, null)
            scope.launch {
                delay(sleepConfig.wakeMs)
                if (gifGeneration.get() != gen) return@launch
                if (targetState.isActive) manager.setLastNonIdleState(targetState)
                Log.d(TAG, "Waking complete → ${targetState.themeKey}")
                emitState(targetState, null)
            }
        } else {
            if (targetState.isActive) manager.setLastNonIdleState(targetState)
            Log.d(TAG, "No waking GIF, direct → ${targetState.themeKey}")
            emitState(targetState, null)
        }
    }

    fun cancelSleepSequence() {
        sleepSequenceJob?.cancel()
        sleepSequenceJob = null
    }

    // ======================================================================
    //  Auto-return timer (aligns with PC AUTO_RETURN_MS)
    // ======================================================================

    /**
     * Schedule an auto-return from a oneshot state to the resolved display state.
     * Mirrors PC `autoReturnTimer` in state.js (applyState, line 485).
     */
    fun scheduleAutoReturn(state: PetState, scope: CoroutineScope) {
        cancelAutoReturn()
        val delayMs = PetStateManager.AUTO_RETURN_MS[state] ?: return
        autoReturnJob = scope.launch {
            delay(delayMs)
            autoReturnJob = null
            val resolved = manager.resolveBestState()
            Log.d(TAG, "Auto-return from ${state.themeKey} → ${resolved.themeKey}")
            emitState(resolved, null)
        }
    }

    fun cancelAutoReturn() {
        autoReturnJob?.cancel()
        autoReturnJob = null
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
        cancelAutoReturn()
        gifGeneration.set(0)
        idleSince = 0L
    }

    /** Reset idle timer — called when entering an active state. */
    fun resetIdleTimer() {
        idleSince = 0L
    }
}

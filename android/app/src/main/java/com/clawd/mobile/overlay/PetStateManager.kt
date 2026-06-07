package com.clawd.mobile.overlay

import android.util.Log
import com.clawd.mobile.data.SessionData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Centralised state decision engine extracted from [FloatingPetService].
 *
 * Owns all session-filtering, best-state selection (priority-based, PC-aligned),
 * the sleep sequence (yawning→dozing→collapsing→sleeping→waking), and random
 * idle animation variants during deep sleep.
 *
 * **Single-pipe architecture**: All state transitions AND one-shot GIF load
 * requests are unified into a single [stateFlow] of [StateCommand] objects.
 * The Service collects this one flow to drive all view mutations — no separate
 * Channel, no dual-pipeline race window.
 *
 * **Multi-session handling**: Selects the highest-priority state across all visible
 * sessions. Juggling/Conducting mapping is resolved server-side via [SessionData.displayState].
 *
 * Thread safety contract:
 * - [updateSessions] runs under [sessionMutex], protecting all state reads/writes within.
 * - [currentState], [lastNonIdleState], [activeScope] are @Volatile — visible across coroutines.
 * - [prevBadge] is ConcurrentHashMap, safe for concurrent clear/put.
 * - [gifGeneration] is AtomicInteger, safe for cross-coroutine increment/check.
 * - [reset] is called only from Service lifecycle (onDestroy/onStartCommand), which is serialized by Android.
 * - [emitState] and [commandFlowEmit] write to [MutableStateFlow] which is thread-safe by design.
 * - [emitState] is also called from timerManager callbacks (sleep sequence, waking) outside sessionMutex.
 *   Known race: compound operations (currentState + pendingRestoreState) are not atomic.
 *   Impact: cosmetic only (wrong restore state for reaction animation), self-correcting on next updateSessions.
 */
class PetStateManager(
    var character: String,
    private val sessionsFlow: StateFlow<Map<String, SessionData>>,
) {

    /** Sleep timeout in ms. 0 = never sleep. Set by FloatingPetService from PrefsStore. */
    var sleepTimeoutMs: Long = IDLE_SLEEP_TIMEOUT_MS

    // ======================================================================
    //  Unified command type — single pipe output
    // ======================================================================

    /**
     * All view-layer commands emitted through the unified [stateFlow].
     * The Service collects this single flow and applies each command sequentially
     * on the Main dispatcher, eliminating dual-pipeline race conditions.
     */
    sealed interface StateCommand {
        /** Pet state changed — load the corresponding SVG. */
        data class StateChanged(
            val state: PetState,
            val sessionCount: Int = 0,
            /** Server-resolved SVG filename (from displayHintMap / tier logic). */
            val resolvedSvg: String? = null,
            /** Unique id to prevent MutableStateFlow deduplication of identical commands. */
            val nonce: Long = System.nanoTime()
        ) : StateCommand
        /** One-shot SVG load (reaction, idle animation variant). Does not change [currentState]. */
        data class SvgLoad(val assetPath: String?, val force: Boolean) : StateCommand
        /** Reaction SVG overlay — load immediately, then auto-restore after delay. */
        data class ReactionSvg(val assetPath: String?) : StateCommand
    }

    companion object {
        private const val TAG = "PetStateManager"

        // Delegate to PetStateConfig for data constants.
        // Re-exported here for backward compatibility with existing references.
        const val STALE_THRESHOLD_MS       = PetStateConfig.STALE_THRESHOLD_MS
        const val ATTENTION_RECHECK_MS     = PetStateConfig.ATTENTION_RECHECK_MS
        const val REACTION_DISPLAY_MS      = PetStateConfig.REACTION_DISPLAY_MS
        const val IDLE_ANIM_INTERVAL_MS    = PetStateConfig.IDLE_ANIM_INTERVAL_MS
        const val IDLE_ANIM_DISPLAY_MS     = PetStateConfig.IDLE_ANIM_DISPLAY_MS
        const val STATE_COLLECTOR_RETRY_MS = PetStateConfig.STATE_COLLECTOR_RETRY_MS
        const val WS_POLL_INTERVAL_MS     = PetStateConfig.WS_POLL_INTERVAL_MS
        const val WATCHDOG_INTERVAL_MS     = PetStateConfig.WATCHDOG_INTERVAL_MS
        const val WATCHDOG_TIMEOUT_MS      = PetStateConfig.WATCHDOG_TIMEOUT_MS
        const val IDLE_RECHECK_SETTLE_MS   = PetStateConfig.IDLE_RECHECK_SETTLE_MS
        const val IDLE_SLEEP_TIMEOUT_MS    = PetStateConfig.IDLE_SLEEP_TIMEOUT_MS
        const val DONE_SESSION_TTL_MS      = PetStateConfig.DONE_SESSION_TTL_MS

        val ONESHOT_AUTO_RETURN_MS get() = PetStateConfig.ONESHOT_AUTO_RETURN_MS
        val CLICK_REACTIONS get() = PetStateConfig.CLICK_REACTIONS
        val DRAG_REACTIONS get() = PetStateConfig.DRAG_REACTIONS
        val NOTIFICATION_REACTIONS get() = PetStateConfig.NOTIFICATION_REACTIONS
        val SLEEP_TIMINGS get() = PetStateConfig.SLEEP_TIMINGS

        // ── Extracted for testing ─────────────────────────────────────────

        /**
         * Count sessions that contribute to tier selection for the given [state].
         * Aligned with PC [countActiveSessionsByStates]:
         * - Working: sessions with state in {"working", "thinking", "juggling"} and visible
         * - Juggling: sessions with state == "juggling" and visible
         * - Other states: 0 (no tier selection)
         */
        internal fun countSessionsForTier(state: PetState, sessions: Collection<SessionData>): Int = when (state) {
            PetState.Working -> {
                val workingStates = setOf("working", "thinking", "juggling")
                sessions.count { it.isVisible && it.state in workingStates }
            }
            PetState.Juggling -> {
                sessions.count { it.isVisible && it.state == "juggling" }
            }
            else -> 0
        }

        /**
         * Resolve the dominant display state from visible sessions.
         * Excludes sleep-sequence states (they are locally managed).
         * Aligns with PC [resolveDominantSessionState].
         *
         * Note: Juggling/Conducting mapping is handled server-side via [SessionData.displayState].
         * Local applyConductingMapping was removed as dead code (2026-06-01 audit).
         */
        internal fun resolveDisplayState(
            visible: List<SessionData>,
            consumedDoneSessions: TimedConsumeSet,
            consumedInterruptedSessions: TimedConsumeSet = TimedConsumeSet(DONE_SESSION_TTL_MS),
            consumedNotificationSessions: TimedConsumeSet = TimedConsumeSet(DONE_SESSION_TTL_MS)
        ): PetState {
            var best: PetState = PetState.Idle
            for (session in visible) {
                val state = when {
                    session.displayState == "notification" -> {
                        // Notification persists until displayState changes (PC-aligned).
                        // Do NOT consume — the server keeps displayState="notification"
                        // while permission is pending, and we must keep showing it.
                        // Clean up any stale consume entry so the next notification
                        // for this session isn't suppressed after an approval cycle.
                        session.sessionId?.let { consumedNotificationSessions.remove(it) }
                        PetState.Notification
                    }
                    session.displayState != null && session.displayState != "idle" ->
                        PetState.fromString(session.displayState)
                    session.badge == "interrupted" -> {
                        val sid = session.sessionId
                        // hookState distinguishes notification from error when both share badge="interrupted"
                        if (session.hookState == "notification") {
                            if (sid != null && consumedNotificationSessions.tryConsume(sid)) {
                                PetState.Notification
                            } else {
                                PetState.Idle
                            }
                        } else if (sid != null && consumedInterruptedSessions.tryConsume(sid)) {
                            PetState.Error  // 只触发一次
                        } else {
                            PetState.Idle  // 已消费
                        }
                    }
                    session.badge == "done" -> {
                        val sid = session.sessionId
                        if (sid != null && consumedDoneSessions.tryConsume(sid)) {
                            PetState.Attention  // 只触发一次
                        } else {
                            PetState.Idle  // 已消费
                        }
                    }
                    session.badge == "running" -> {
                        session.sessionId?.let { consumedDoneSessions.remove(it) }  // 新任务开始，重置
                        PetState.fromString(session.state)
                    }
                    else -> PetState.Idle
                }
                if (state.isSleepSequence) continue
                if (state.priority > best.priority) best = state
            }
            return best
        }
    }

    // --- Unified output ---

    private val _commandFlow = MutableStateFlow<StateCommand>(StateCommand.StateChanged(PetState.Idle))
    /**
     * Single-pipe output: all state changes AND GIF load requests.
     * The Service collects this and applies commands sequentially on Main.
     * Uses distinct data class equality so consecutive identical commands
     * (e.g. same resId) still emit when forced.
     */
    val stateFlow: StateFlow<StateCommand> = _commandFlow.asStateFlow()

    // --- Internal state (used for conditional logic inside the state machine) ---

    /** The current resolved PetState. Updated on every [emitState] call. */
    @Volatile
    private var currentState: PetState = PetState.Idle

    @Volatile private var lastNonIdleState: PetState = PetState.Idle
    private var prevBadge: MutableMap<String, String> = java.util.concurrent.ConcurrentHashMap()
    private val consumedDoneSessions = TimedConsumeSet(DONE_SESSION_TTL_MS)
    private val consumedInterruptedSessions = TimedConsumeSet(DONE_SESSION_TTL_MS)
    private val consumedNotificationSessions = TimedConsumeSet(DONE_SESSION_TTL_MS)
    private var wsCollectorJob: Job? = null
    @Volatile private var activeScope: CoroutineScope? = null
    private val sessionMutex = Mutex()

    /** State to restore after a oneshot animation completes. Saved from the state interrupted by the oneshot. */
    private var pendingRestoreState: PetState? = null
    /** Timer job for oneshot auto-return. Cancelled if a new non-oneshot state arrives. */
    private var oneshotRestoreJob: Job? = null

    /** Timer/sequence delegate — owns idle timeout, sleep sequence, auto-return, reactions. */
    internal val timerManager = PetTimerManager(
        manager = this,
        emitState = ::emitState,
        commandFlowEmit = ::commandFlowEmit,
    )

    // ======================================================================
    //  Public lifecycle
    // ======================================================================

    /** Start the session collector loop. Collects from the injected [sessionsFlow]. */
    fun start(scope: CoroutineScope) {
        wsCollectorJob?.cancel()
        activeScope = scope
        wsCollectorJob = scope.launch {
            Log.d(TAG, "Collecting sessions from injected flow")
            try {
                collectSessions(scope)
            } catch (e: Exception) {
                Log.e(TAG, "State collector exception", e)
            }
        }
    }

    /** Full reset — called on ACTION_DISCONNECT or Service.onDestroy. */
    fun reset() {
        wsCollectorJob?.cancel()
        wsCollectorJob = null
        activeScope = null
        timerManager.reset()
        lastNonIdleState = PetState.Idle
        prevBadge.clear()
        consumedDoneSessions.clear()
        consumedInterruptedSessions.clear()
        consumedNotificationSessions.clear()
        pendingRestoreState = null
        oneshotRestoreJob?.cancel()
        oneshotRestoreJob = null
        currentState = PetState.Idle
        // Reset the command flow so new subscribers start from a clean Idle state
        _commandFlow.value = StateCommand.StateChanged(PetState.Idle)
    }

    /** Expose current state for [PetTimerManager]. */
    internal fun getCurrentState(): PetState = currentState

    /** Update lastNonIdleState from [PetTimerManager]. */
    internal fun setLastNonIdleState(state: PetState) {
        if (state.isActive) lastNonIdleState = state
    }

    // ======================================================================
    //  Session → State pipeline
    // ======================================================================

    /**
     * Main entry point: called by the sessions collector on every emission.
     * Runs under [sessionMutex] to prevent concurrent state mutations.
     */
    private suspend fun updateSessions(
        sessions: Map<String, SessionData>,
        scope: CoroutineScope
    ) = sessionMutex.withLock {
        val visible = sessions.values.filter { it.isVisible }
        val allSleeping = visible.isNotEmpty() && visible.all {
            it.displayState == "sleeping" || it.state == "sleeping"
        }
        if (visible.isEmpty()) {
            // 无可见 session → 立即回 Idle（如果当前是活跃状态），然后走超时逻辑
            if (!currentState.isIdleLike) {
                emitState(PetState.Idle)
            }
            timerManager.handleIdleTimeout(scope)
            return@withLock
        }
        if (allSleeping && !currentState.isSleepSequence) {
            // SessionEnd 场景：对齐 PC 端，立即进入睡眠序列（不等 60s 超时）
            timerManager.startSleepSequence(scope)
            return@withLock
        }

        // Resolve best state from sessions (excludes sleep sequence states)
        // displayState 已由服务器正确设置（包括 juggling/conducting），不再本地映射
        val bestState = resolveDisplayState(visible)

        // Extract server-resolved SVG from the session that contributed the best state.
        // For working/juggling/thinking, the server resolves display_svg via displayHintMap
        // so mobile shows the same animation as desktop.
        val resolvedSvg = visible
            .filter { PetState.fromString(it.displayState ?: it.state) == bestState }
            .maxByOrNull { it.updatedAt ?: 0L }
            ?.resolvedSvg

        // Update previous badge tracking (no happy interlude — aligns with PC)
        sessions.values.forEach { s ->
            val sid = s.sessionId ?: return@forEach
            prevBadge[sid] = s.badge
        }

        if (bestState == PetState.Notification) {
            // Notification persists while displayState stays "notification" (PC-aligned).
            // The server keeps displayState="notification" while permission is pending;
            // when resolved, displayState changes and resolveDisplayState returns a different state.
            timerManager.cancelSleepSequence()
            timerManager.resetIdleTimer()
            lastNonIdleState = bestState
            emitState(bestState, resolvedSvg)
        } else if (bestState.isActive) {
            // Active state — wake from sleep or update directly
            timerManager.cancelSleepSequence()
            timerManager.resetIdleTimer()
            if (currentState.isSleepSequence) {
                timerManager.playWakingAndRestore(bestState, scope)
            } else {
                lastNonIdleState = bestState
                Log.d("PetState", "emitState: ${bestState.themeKey}")
                Log.d(TAG, "State update: resolved=${bestState.themeKey}, activeCount=${visible.size}")
                timerManager.cancelWorkingStaleTimer()
                emitState(bestState, resolvedSvg)
                // Start working stale timer for long-running Working/Thinking states
                if (bestState == PetState.Working || bestState == PetState.Thinking) {
                    timerManager.startWorkingStaleTimer(scope)
                }
            }
        } else {
            // Idle — 等待超时后进入睡眠序列（对齐 PC 端 60s MOUSE_SLEEP_TIMEOUT）
            timerManager.handleIdleTimeout(scope)
        }
    }

    /**
     * Resolve the dominant display state from visible sessions.
     * Delegates to [companion object][Companion.resolveDisplayState] with instance state.
     */
    private fun resolveDisplayState(visible: List<SessionData>): PetState {
        Log.d("PetState", "resolveDisplayState input sessions: ${visible.map { "${it.sessionId}:state=${it.state}:displayState=${it.displayState}:badge=${it.badge}:isVisible=${it.isVisible}" }}")
        val result = resolveDisplayState(visible, consumedDoneSessions, consumedInterruptedSessions, consumedNotificationSessions)
        Log.d("PetState", "resolveDisplayState result: ${result.themeKey}")
        return result
    }

    // ======================================================================
    //  WebSocket session collector
    // ======================================================================

    private suspend fun collectSessions(scope: CoroutineScope) {
        val collectJob = scope.launch {
            sessionsFlow.collect { sessions ->
                updateSessions(sessions, scope)
            }
        }

        // Watchdog: force idle if non-idle but no visible sessions (connection issue safety net)
        val watchdogJob = scope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                val hasActiveSessions = if (sessionMutex.tryLock()) {
                    try {
                        sessionsFlow.value.values.any { it.isVisible }
                    } finally {
                        sessionMutex.unlock()
                    }
                } else {
                    // tryLock failed — updateSessions is running, skip this cycle
                    // (don't return false — that would incorrectly trigger idle fallback)
                    continue
                }
                if (!currentState.isIdleLike && !hasActiveSessions) {
                    Log.d(TAG, "Watchdog: state=${currentState.themeKey} but no visible sessions, forcing idle")
                    emitState(PetState.Idle)
                }
            }
        }

        try {
            collectJob.join()
        } finally {
            watchdogJob.cancel()
            timerManager.cancelSleepSequence()
        }
    }

    // ======================================================================
    //  Helpers
    // ======================================================================

    /**
     * Emit a state change through the unified command pipe.
     * Also updates [currentState] for internal conditional logic.
     *
     * @param resolvedSvg Optional server-resolved SVG filename from displayHintMap.
     */
    private fun emitState(state: PetState, resolvedSvg: String? = null, force: Boolean = false) {
        // Same-state short circuit: skip redundant emissions.
        // Allow through when resolvedSvg is non-null (tier/SVG may have changed for same state).
        // Allow through when force=true (e.g. restoring from drag reaction).
        if (currentState == state && resolvedSvg == null && !force) return
        if (currentState != state) {
            Log.d(TAG, "State → ${state.themeKey}")
        }

        // Oneshot precise restore: save the state being interrupted
        if (state in PetState.ONESHOT_STATES && state != PetState.Notification) {
            if (currentState !in PetState.ONESHOT_STATES && !currentState.isIdleLike && !currentState.isSleepSequence) {
                if (pendingRestoreState == null) {
                    pendingRestoreState = currentState
                    Log.d(TAG, "Oneshot: saved restore state = ${currentState.themeKey}")
                }
            }
            scheduleOneshotRestore(state)
        } else if (state !in PetState.ONESHOT_STATES) {
            // New non-oneshot state (active or sleep sequence) — clear any pending restore
            if (pendingRestoreState != null) {
                Log.d(TAG, "Oneshot: cleared restore state (new state: ${state.themeKey})")
                pendingRestoreState = null
            }
            oneshotRestoreJob?.cancel()
            oneshotRestoreJob = null
        }

        currentState = state
        val sessionCount = countSessionsForTier(state, sessionsFlow.value.values)
        commandFlowEmit(StateCommand.StateChanged(state, sessionCount, resolvedSvg))
    }

    /**
     * Emit a command to the unified [commandFlow].
     * Each call produces a new data class instance, so even consecutive
     * identical values (same resId, same force) are emitted and not
     * deduplicated by [MutableStateFlow].
     */
    private fun commandFlowEmit(command: StateCommand) {
        _commandFlow.value = command
    }

    // ── Oneshot auto-return ─────────────────────────────────────────────

    /**
     * Schedule an auto-return timer for a oneshot state.
     * Uses per-state timing from [ONESHOT_AUTO_RETURN_MS], falling back to [REACTION_DISPLAY_MS].
     * Only schedules if [activeScope] is available (service is running).
     */
    private fun scheduleOneshotRestore(state: PetState) {
        oneshotRestoreJob?.cancel()
        val delayMs = ONESHOT_AUTO_RETURN_MS[state] ?: REACTION_DISPLAY_MS
        val scope = activeScope ?: return
        Log.d(TAG, "Oneshot: scheduled restore in ${delayMs}ms for ${state.themeKey}")
        oneshotRestoreJob = scope.launch {
            delay(delayMs)
            oneshotRestoreJob = null
            restoreAfterOneshot()
        }
    }

    /**
     * Restore the pet state after a oneshot animation completes.
     * If [pendingRestoreState] is still valid (session still active), restores it.
     * Otherwise, falls back to [resolveBestState].
     * Called by the oneshot auto-return timer.
     */
    private fun restoreAfterOneshot() {
        val target = pendingRestoreState
        pendingRestoreState = null

        // Re-resolve the best state from current session data
        val bestState = resolveBestState()

        if (target != null && target.isActive && !target.isSleepSequence) {
            // If the target state is still the best (or better), restore it.
            // If sessions moved to a higher-priority state, use that instead.
            val restoreTo = if (bestState.priority >= target.priority) bestState else target
            Log.d(TAG, "Oneshot: restoring to ${restoreTo.themeKey} (saved=${target.themeKey}, best=${bestState.themeKey})")
            emitState(restoreTo)
        } else {
            // No saved state or it expired — use best from sessions
            Log.d(TAG, "Oneshot: fallback restore to ${bestState.themeKey}")
            emitState(bestState)
        }
    }

    /** Snapshot the best visible session's state, falling back to Idle. */
    internal fun resolveBestState(): PetState {
        val visible = sessionsFlow.value.values.filter { it.isVisible }
        return if (visible.isEmpty()) PetState.Idle
        else resolveDisplayState(visible)
    }

    // ======================================================================
    //  Reaction triggers (gesture + SSE)
    // ======================================================================

    /**
     * Trigger a click/double-tap reaction for the current character.
     * Picks a random SVG from [CLICK_REACTIONS], plays for [REACTION_DISPLAY_MS], then restores.
     * Guard: skipped during sleep sequence (aligns PC canPlayReactionNow).
     */
    fun triggerClickReaction() {
        if (currentState.isSleepSequence) return
        val reactions = CLICK_REACTIONS[character] ?: return
        if (reactions.isEmpty()) return
        val svg = reactions.random()
        val path = "svg/$character/$svg"
        Log.d(TAG, "Click reaction: $path")
        activeScope?.let { timerManager.loadReactionAndRestore(path, REACTION_DISPLAY_MS, it) }
    }

    /**
     * Trigger a triple-tap Easter egg: plays the attention (happy) SVG for 3 seconds.
     * Guard: skipped during sleep sequence.
     */
    fun triggerEasterEgg() {
        if (currentState.isSleepSequence) return
        val path = SvgLoader.resolveSvgAsset(PetState.Attention, 0, character) ?: return
        Log.d(TAG, "Easter egg: $path")
        activeScope?.let { timerManager.loadReactionAndRestore(path, 3000L, it) }
    }

    /**
     * Trigger a drag-start reaction (looping SVG, no auto-restore).
     * Call [restoreFromDragReaction] when drag ends.
     * Guard: skipped during sleep sequence.
     */
    fun triggerDragReaction() {
        if (currentState.isSleepSequence) return
        val svg = DRAG_REACTIONS[character] ?: return
        val path = "svg/$character/$svg"
        Log.d(TAG, "Drag reaction start: $path")
        commandFlowEmit(StateCommand.SvgLoad(path, force = true))
    }

    /**
     * Restore pet state after a drag reaction ends.
     * Resolves the best current state and emits it.
     */
    fun restoreFromDragReaction() {
        val restoreState = resolveBestState()
        Log.d(TAG, "Drag reaction end → ${restoreState.themeKey}")
        emitState(restoreState, null, force = true)
    }

    /**
     * Load a reaction SVG by asset path (for SSE-triggered reactions).
     * Plays for [REACTION_DISPLAY_MS], then restores.
     * Guard: skipped during sleep sequence.
     */
    fun loadReaction(assetPath: String) {
        if (currentState.isSleepSequence) return
        Log.d(TAG, "SSE reaction: $assetPath")
        activeScope?.let { timerManager.loadReactionAndRestore(assetPath, REACTION_DISPLAY_MS, it) }
    }
}

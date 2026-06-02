package com.clawd.mobile.overlay

import android.util.Log
import com.clawd.mobile.data.SessionData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicInteger

/**
 * Centralised state decision engine extracted from [FloatingPetService].
 *
 * Owns all session-filtering, best-state selection (priority-based, PC-aligned),
 * badge transition detection, the 1.5 s happy interlude, the 3 s attention recheck,
 * the sleep sequence (yawning→dozing→collapsing→sleeping→waking), and random
 * idle animation variants during deep sleep.
 *
 * **Single-pipe architecture**: All state transitions AND one-shot GIF load
 * requests are unified into a single [stateFlow] of [StateCommand] objects.
 * The Service collects this one flow to drive all view mutations — no separate
 * Channel, no dual-pipeline race window.
 *
 * **Multi-session handling**: When ≥2 sessions are active, automatically maps to
 * Juggling (clawd) or Conducting (calico/cloudling) via priority comparison.
 * Higher-priority states (Error, Attention) always win over the mapping.
 *
 * Thread safety contract:
 * - [updateSessions] runs under [sessionMutex], protecting all state reads/writes within.
 * - [gifGeneration] is AtomicInteger, safe for cross-coroutine increment/check.
 * - [reset] is called only from Service lifecycle (onDestroy/onStartCommand), which is serialized by Android.
 * - [emitState] and [commandFlowEmit] write to [MutableStateFlow] which is thread-safe by design.
 */
class PetStateManager(
    var character: String,
    private val sessionsFlow: StateFlow<Map<String, SessionData>>,
) {

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
            val resolvedSvg: String? = null
        ) : StateCommand
        /** One-shot SVG load (reaction, idle animation variant). Does not change [currentState]. */
        data class SvgLoad(val assetPath: String?, val force: Boolean) : StateCommand
        /** Reaction SVG overlay — load immediately, then auto-restore after delay. */
        data class ReactionSvg(val assetPath: String?) : StateCommand
    }

    companion object {
        private const val TAG = "PetStateManager"

        // --- Timing constants (ms) ---
        const val STALE_THRESHOLD_MS       = 30_000L
        const val ATTENTION_RECHECK_MS     = 3_000L
        const val REACTION_DISPLAY_MS      = 4_000L
        const val IDLE_ANIM_INTERVAL_MS    = 30_000L
        const val IDLE_ANIM_DISPLAY_MS     = 5_000L
        const val STATE_COLLECTOR_RETRY_MS = 3_000L
        const val WS_POLL_INTERVAL_MS     = 3_000L
        const val WATCHDOG_INTERVAL_MS     = 10_000L
        const val WATCHDOG_TIMEOUT_MS      = 60_000L
        const val IDLE_RECHECK_SETTLE_MS   = 200L
        const val IDLE_SLEEP_TIMEOUT_MS    = 60_000L  // 对齐 PC 端 MOUSE_SLEEP_TIMEOUT
        const val DONE_SESSION_TTL_MS      = 5 * 60 * 1000L  // 5 minutes — expired done-session IDs are cleaned up

        // --- Per-character sleep sequence timings (from PC theme.json) ---
        data class SleepConfig(
            val yawnMs: Long,
            val collapseMs: Long,
            val wakeMs: Long,
            val deepSleepMs: Long
        )

        val SLEEP_TIMINGS: Map<String, SleepConfig> = mapOf(
            "clawd"     to SleepConfig(yawnMs = 3_000, collapseMs = 0,     wakeMs = 1_500, deepSleepMs = 600_000),
            "calico"    to SleepConfig(yawnMs = 8_000, collapseMs = 5_200, wakeMs = 5_800, deepSleepMs = 600_000),
            "cloudling" to SleepConfig(yawnMs = 9_030, collapseMs = 4_700, wakeMs = 3_650, deepSleepMs = 600_000)
        )

        /**
         * Auto-return delays for oneshot states (ms).
         * Aligned with PC-side `theme.timings.autoReturn` (theme-schema.js DEFAULT_TIMINGS).
         * After this delay the pet returns to the resolved display state.
         */
        val AUTO_RETURN_MS: Map<PetState, Long> = mapOf(
            PetState.Attention   to 4_000L,
            PetState.Error       to 5_000L,
            PetState.Sweeping    to 300_000L,
            PetState.Notification to 5_000L,
            PetState.Carrying    to 3_000L,
        )

        // ── Extracted for testing ─────────────────────────────────────────

        /** Remove entries from [consumedDoneSessions] older than [DONE_SESSION_TTL_MS]. */
        internal fun cleanupExpiredDoneSessions(consumedDoneSessions: java.util.concurrent.ConcurrentHashMap<String, Long>) {
            val now = System.currentTimeMillis()
            val expired = consumedDoneSessions.entries
                .filter { now - it.value > DONE_SESSION_TTL_MS }
                .map { it.key }
            expired.forEach { consumedDoneSessions.remove(it) }
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
            consumedDoneSessions: java.util.concurrent.ConcurrentHashMap<String, Long>
        ): PetState {
            var best: PetState = PetState.Idle
            for (session in visible) {
                val state = when {
                    session.displayState != null && session.displayState != "idle" ->
                        PetState.fromString(session.displayState)
                    session.badge == "interrupted" -> PetState.Error
                    session.badge == "done" -> {
                        val sid = session.sessionId
                        if (sid != null && !consumedDoneSessions.containsKey(sid)) {
                            consumedDoneSessions[sid] = System.currentTimeMillis()
                            cleanupExpiredDoneSessions(consumedDoneSessions)
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
    private var currentState: PetState = PetState.Idle

    private var lastNonIdleState: PetState = PetState.Idle
    private var prevBadge: MutableMap<String, String> = mutableMapOf()
    private val consumedDoneSessions = java.util.concurrent.ConcurrentHashMap<String, Long>()  // sessionId → consumedAt (epoch ms)
    private val gifGeneration = AtomicInteger(0)
    private var idleSince: Long = 0L  // idle 状态开始时间，用于 60s 超时对齐 PC 端
    private var sleepSequenceJob: Job? = null
    private var autoReturnJob: Job? = null
    private var wsCollectorJob: Job? = null
    private val sessionMutex = Mutex()
    private val sleepConfig: SleepConfig get() = SLEEP_TIMINGS[character] ?: SLEEP_TIMINGS["clawd"]!!

    // ======================================================================
    //  Public lifecycle
    // ======================================================================

    /** Start the session collector loop. Collects from the injected [sessionsFlow]. */
    fun start(scope: CoroutineScope) {
        wsCollectorJob?.cancel()
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
        cancelSleepSequence()
        cancelAutoReturn()
        gifGeneration.set(0)
        lastNonIdleState = PetState.Idle
        prevBadge.clear()
        consumedDoneSessions.clear()
        currentState = PetState.Idle
        idleSince = 0L
        // Reset the command flow so new subscribers start from a clean Idle state
        _commandFlow.value = StateCommand.StateChanged(PetState.Idle)
    }

    /** Remove entries from consumedDoneSessions that are older than [DONE_SESSION_TTL_MS]. */
    private fun cleanupExpiredDoneSessions() {
        cleanupExpiredDoneSessions(consumedDoneSessions)
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
            handleIdleTimeout(scope)
            return@withLock
        }
        if (allSleeping && !currentState.isSleepSequence) {
            // SessionEnd 场景：对齐 PC 端，立即进入睡眠序列（不等 60s 超时）
            startSleepSequence(scope)
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

        // Badge transition detection (happy interlude)
        checkBadgeTransitions(sessions.values, scope)
        sessions.values.forEach { s ->
            val sid = s.sessionId ?: return@forEach
            prevBadge[sid] = s.badge
        }

        if (bestState.isActive) {
            // Active state — wake from sleep or update directly
            cancelSleepSequence()
            idleSince = 0L  // 活跃状态重置 idle 计时
            if (currentState.isSleepSequence) {
                playWakingAndRestore(bestState, scope)
            } else {
                lastNonIdleState = bestState
                Log.d("PetState", "emitState: ${bestState.themeKey}")
                Log.d(TAG, "State update: resolved=${bestState.themeKey}, activeCount=${visible.size}")
                emitState(bestState, resolvedSvg)
                // Schedule auto-return for oneshot states (aligns with PC autoReturn timer)
                if (bestState in PetState.ONESHOT_STATES) {
                    scheduleAutoReturn(bestState, scope)
                }
            }
        } else {
            // Idle — 等待超时后进入睡眠序列（对齐 PC 端 60s MOUSE_SLEEP_TIMEOUT）
            handleIdleTimeout(scope)
        }
    }

    /**
     * Idle timeout handler: starts timer on first idle, enters sleep sequence after 60s.
     * Aligns with PC MOUSE_SLEEP_TIMEOUT.
     *
     * Note: this is only called from [updateSessions] (driven by sessionFlow.collect).
     * On SSE disconnect, [collectSessions]'s connectionState collector cancels the collectJob,
     * so idleSince won't be checked indefinitely after disconnection.
     */
    private fun handleIdleTimeout(scope: CoroutineScope) {
        val now = System.currentTimeMillis()
        if (idleSince == 0L) {
            idleSince = now  // 首次 idle，开始计时
            Log.d(TAG, "Idle timeout started")
        }
        if (now - idleSince >= IDLE_SLEEP_TIMEOUT_MS) {
            if (!currentState.isSleepSequence) {
                Log.d(TAG, "Idle timeout reached (${IDLE_SLEEP_TIMEOUT_MS}ms), starting sleep sequence")
                startSleepSequence(scope)
            }
        }
        // else: 还没到 60 秒，保持 idle 状态等待
    }

    /**
     * Resolve the dominant display state from visible sessions.
     * Delegates to [companion object][Companion.resolveDisplayState] with instance state.
     */
    private fun resolveDisplayState(visible: List<SessionData>): PetState {
        Log.d("PetState", "resolveDisplayState input sessions: ${visible.map { "${it.sessionId}:state=${it.state}:displayState=${it.displayState}:badge=${it.badge}:isVisible=${it.isVisible}" }}")
        val result = resolveDisplayState(visible, consumedDoneSessions)
        Log.d("PetState", "resolveDisplayState result: ${result.themeKey}")
        return result
    }

    // ======================================================================
    //  Sleep sequence (yawning → [dozing →] collapsing → sleeping)
    // ======================================================================

    /**
     * Start the sleep animation sequence as a coroutine.
     * Skips states that have no dedicated SVG (falls back through SvgLoader).
     */
    private fun startSleepSequence(scope: CoroutineScope) {
        if (sleepSequenceJob?.isActive == true) return
        sleepSequenceJob = scope.launch {
            val cfg = sleepConfig

            // Yawning phase
            emitState(PetState.Yawning)
            delay(cfg.yawnMs)
            if (!isActive) return@launch

            // Collapsing phase (skip if collapseMs <= 0, e.g. clawd)
            if (cfg.collapseMs > 0) {
                emitState(PetState.Collapsing)
                delay(cfg.collapseMs)
                if (!isActive) return@launch
            }

            // Deep sleep
            emitState(PetState.Sleeping)

            // Idle animation loop while sleeping — random variant each tick
            while (isActive) {
                delay(IDLE_ANIM_INTERVAL_MS)
                if (!isActive) break
                val idlePath = pickIdleAnimPath()
                if (idlePath != null) {
                    commandFlowEmit(StateCommand.SvgLoad(idlePath, force = false))
                    delay(IDLE_ANIM_DISPLAY_MS)
                }
            }
        }
    }

    /**
     * Play waking animation then restore to [targetState].
     * If no dedicated waking GIF exists, skips straight to target.
     */
    private fun playWakingAndRestore(targetState: PetState, scope: CoroutineScope) {
        cancelSleepSequence()
        val gen = gifGeneration.incrementAndGet()

        if (SvgLoader.hasSvgForState(PetState.Waking, character)) {
            emitState(PetState.Waking)
            scope.launch {
                delay(sleepConfig.wakeMs)
                if (gifGeneration.get() != gen) return@launch
                if (targetState.isActive) lastNonIdleState = targetState
                Log.d(TAG, "Waking complete → ${targetState.themeKey}")
                emitState(targetState)
            }
        } else {
            // No waking GIF — go straight to target
            if (targetState.isActive) lastNonIdleState = targetState
            Log.d(TAG, "No waking GIF, direct → ${targetState.themeKey}")
            emitState(targetState)
        }
    }

    private fun cancelSleepSequence() {
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
    private fun scheduleAutoReturn(state: PetState, scope: CoroutineScope) {
        cancelAutoReturn()
        val delayMs = AUTO_RETURN_MS[state] ?: return
        autoReturnJob = scope.launch {
            delay(delayMs)
            autoReturnJob = null
            val resolved = resolveBestState()
            Log.d(TAG, "Auto-return from ${state.themeKey} → ${resolved.themeKey}")
            emitState(resolved)
        }
    }

    private fun cancelAutoReturn() {
        autoReturnJob?.cancel()
        autoReturnJob = null
    }

    // ======================================================================
    //  Badge transition detection (1.5 s happy interlude)
    // ======================================================================

    private fun checkBadgeTransitions(
        sessions: Collection<SessionData>,
        scope: CoroutineScope
    ) {
        for (s in sessions) {
            val sid = s.sessionId ?: continue
            val prev = prevBadge[sid] ?: continue
            val curr = s.badge
            if (prev in PetState.RUNNING_BADGES && curr == "done") {
                Log.d(TAG, "Badge transition: $prev → done for session $sid, playing happy")
                val happyPath = getSvgAssetPath(PetState.Attention)
                if (happyPath != null) {
                    loadReactionAndRestore(happyPath, REACTION_DISPLAY_MS, scope)
                }
            }
        }
    }

    /**
     * Play a reaction SVG, then restore the previous state.
     * Uses [gifGeneration] to discard stale restore callbacks.
     */
    private fun loadReactionAndRestore(assetPath: String, delayMs: Long, scope: CoroutineScope) {
        val gen = gifGeneration.incrementAndGet()
        // Emit reaction through the unified command pipe — no separate callback needed
        commandFlowEmit(StateCommand.ReactionSvg(assetPath))

        scope.launch {
            delay(delayMs)
            if (gifGeneration.get() != gen) return@launch
            val restoreState = resolveBestState()
            emitState(restoreState)
        }
    }

    // ======================================================================
    //  Idle animation variant picker (aligns with PC idleAnimations)
    // ======================================================================

    /**
     * Pick a random idle animation SVG for the current character.
     * Uses [SvgLoader.pickIdleAnimation] which aligns with PC theme.json
     * idleAnimations (clawd: look/bubble/reading, cloudling: reading, calico: idle).
     * Returns an asset path or null if no variants exist.
     */
    private fun pickIdleAnimPath(): String? {
        return SvgLoader.pickIdleAnimation(character)
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
                if (!currentState.isIdleLike) {
                    val hasActiveSessions = sessionsFlow.value.values.any { it.isVisible }
                    if (!hasActiveSessions) {
                        Log.d(TAG, "Watchdog: state=${currentState.themeKey} but no visible sessions, forcing idle")
                        emitState(PetState.Idle)
                    }
                }
            }
        }

        try {
            collectJob.join()
        } finally {
            watchdogJob.cancel()
            cancelSleepSequence()
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
    private fun emitState(state: PetState, resolvedSvg: String? = null) {
        if (currentState != state) {
            Log.d(TAG, "State → ${state.themeKey}")
        }
        currentState = state
        // Cancel any pending auto-return — new state supersedes it.
        cancelAutoReturn()
        val sessionCount = sessionsFlow.value.values.count { it.isVisible }
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

    private fun getSvgAssetPath(state: PetState): String? {
        return SvgLoader.resolveSvgAsset(state.themeKey, 1, character)
    }

    /** Snapshot the best visible session's state, falling back to Idle. */
    private fun resolveBestState(): PetState {
        val visible = sessionsFlow.value.values.filter { it.isVisible }
        return if (visible.isEmpty()) PetState.Idle
        else resolveDisplayState(visible)
    }
}

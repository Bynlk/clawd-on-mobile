package com.clawd.mobile.overlay

import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for [PetStateConfig] static data: timing constants, reaction maps,
 * sleep configs, and ONESHOT_AUTO_RETURN_MS completeness.
 */
class PetStateConfigTest {

    // ── Timing constants ────────────────────────────────────────────

    @Test
    fun `timing constants are positive`() {
        assertTrue(PetStateConfig.STALE_THRESHOLD_MS > 0)
        assertTrue(PetStateConfig.ATTENTION_RECHECK_MS > 0)
        assertTrue(PetStateConfig.REACTION_DISPLAY_MS > 0)
        assertTrue(PetStateConfig.IDLE_ANIM_INTERVAL_MS > 0)
        assertTrue(PetStateConfig.IDLE_ANIM_DISPLAY_MS > 0)
        assertTrue(PetStateConfig.STATE_COLLECTOR_RETRY_MS > 0)
        assertTrue(PetStateConfig.WS_POLL_INTERVAL_MS > 0)
        assertTrue(PetStateConfig.WATCHDOG_INTERVAL_MS > 0)
        assertTrue(PetStateConfig.WATCHDOG_TIMEOUT_MS > 0)
        assertTrue(PetStateConfig.IDLE_RECHECK_SETTLE_MS > 0)
        assertTrue(PetStateConfig.IDLE_SLEEP_TIMEOUT_MS > 0)
        assertTrue(PetStateConfig.DONE_SESSION_TTL_MS > 0)
    }

    @Test
    fun `watchdog timeout is greater than interval`() {
        assertTrue(PetStateConfig.WATCHDOG_TIMEOUT_MS > PetStateConfig.WATCHDOG_INTERVAL_MS)
    }

    @Test
    fun `done session TTL is 5 minutes`() {
        assertEquals(5 * 60 * 1000L, PetStateConfig.DONE_SESSION_TTL_MS)
    }

    @Test
    fun `idle sleep timeout is 60 seconds`() {
        assertEquals(60_000L, PetStateConfig.IDLE_SLEEP_TIMEOUT_MS)
    }

    // ── ONESHOT_AUTO_RETURN_MS ──────────────────────────────────────

    @Test
    fun `oneshot auto return contains expected states`() {
        val map = PetStateConfig.ONESHOT_AUTO_RETURN_MS
        assertTrue(map.containsKey(PetState.Attention))
        assertTrue(map.containsKey(PetState.Error))
        assertTrue(map.containsKey(PetState.Sweeping))
        assertTrue(map.containsKey(PetState.Notification))
        assertTrue(map.containsKey(PetState.Carrying))
    }

    @Test
    fun `oneshot auto return values are positive`() {
        PetStateConfig.ONESHOT_AUTO_RETURN_MS.values.forEach { delay ->
            assertTrue("Auto-return delay $delay should be positive", delay > 0)
        }
    }

    @Test
    fun `sweeping auto return is 5 minutes`() {
        assertEquals(300_000L, PetStateConfig.ONESHOT_AUTO_RETURN_MS[PetState.Sweeping])
    }

    @Test
    fun `notification auto return is 2_5 seconds`() {
        assertEquals(2_500L, PetStateConfig.ONESHOT_AUTO_RETURN_MS[PetState.Notification])
    }

    // ── Reaction SVG maps ───────────────────────────────────────────

    @Test
    fun `click reactions contain all three characters`() {
        val map = PetStateConfig.CLICK_REACTIONS
        assertTrue(map.containsKey("clawd"))
        assertTrue(map.containsKey("cloudling"))
        assertTrue(map.containsKey("calico"))
    }

    @Test
    fun `clawd has three click reactions`() {
        assertEquals(3, PetStateConfig.CLICK_REACTIONS["clawd"]?.size)
    }

    @Test
    fun `drag reactions contain all three characters`() {
        val map = PetStateConfig.DRAG_REACTIONS
        assertTrue(map.containsKey("clawd"))
        assertTrue(map.containsKey("cloudling"))
        assertTrue(map.containsKey("calico"))
    }

    @Test
    fun `clawd drag reaction is not null`() {
        assertNotNull(PetStateConfig.DRAG_REACTIONS["clawd"])
    }

    @Test
    fun `calico drag reaction is null`() {
        assertNull(PetStateConfig.DRAG_REACTIONS["calico"])
    }

    @Test
    fun `notification reactions contain all three characters`() {
        val map = PetStateConfig.NOTIFICATION_REACTIONS
        assertTrue(map.containsKey("clawd"))
        assertTrue(map.containsKey("cloudling"))
        assertTrue(map.containsKey("calico"))
    }

    @Test
    fun `calico notification reaction is apng`() {
        assertTrue(PetStateConfig.NOTIFICATION_REACTIONS["calico"]?.endsWith(".apng") == true)
    }

    @Test
    fun `clawd notification reaction is svg`() {
        assertTrue(PetStateConfig.NOTIFICATION_REACTIONS["clawd"]?.endsWith(".svg") == true)
    }

    // ── SleepConfig ─────────────────────────────────────────────────

    @Test
    fun `sleep timings contain all three characters`() {
        val map = PetStateConfig.SLEEP_TIMINGS
        assertTrue(map.containsKey("clawd"))
        assertTrue(map.containsKey("calico"))
        assertTrue(map.containsKey("cloudling"))
    }

    @Test
    fun `clawd sleep config has zero collapse`() {
        val cfg = PetStateConfig.SLEEP_TIMINGS["clawd"]!!
        assertEquals(0L, cfg.collapseMs)
    }

    @Test
    fun `all sleep configs have positive dozing`() {
        PetStateConfig.SLEEP_TIMINGS.values.forEach { cfg ->
            assertTrue("dozingMs should be positive", cfg.dozingMs > 0)
        }
    }

    @Test
    fun `all sleep configs have positive wake`() {
        PetStateConfig.SLEEP_TIMINGS.values.forEach { cfg ->
            assertTrue("wakeMs should be positive", cfg.wakeMs > 0)
        }
    }

    @Test
    fun `all sleep configs have positive deepSleep`() {
        PetStateConfig.SLEEP_TIMINGS.values.forEach { cfg ->
            assertTrue("deepSleepMs should be positive", cfg.deepSleepMs > 0)
        }
    }

    @Test
    fun `sleep config data class equality`() {
        val cfg1 = PetStateConfig.SleepConfig(1000, 2000, 3000, 4000, 5000)
        val cfg2 = PetStateConfig.SleepConfig(1000, 2000, 3000, 4000, 5000)
        assertEquals(cfg1, cfg2)
    }

    @Test
    fun `sleep config data class inequality`() {
        val cfg1 = PetStateConfig.SleepConfig(1000, 2000, 3000, 4000, 5000)
        val cfg2 = PetStateConfig.SleepConfig(1000, 2000, 3000, 4000, 9999)
        assertNotEquals(cfg1, cfg2)
    }

    @Test
    fun `sleep config copy works`() {
        val cfg = PetStateConfig.SleepConfig(1000, 2000, 3000, 4000, 5000)
        val copy = cfg.copy(wakeMs = 9999)
        assertEquals(9999, copy.wakeMs)
        assertEquals(1000, copy.yawnMs)
    }

    // ── PetStateManager companion re-exports ────────────────────────

    @Test
    fun `companion re-exports match PetStateConfig`() {
        assertEquals(PetStateConfig.STALE_THRESHOLD_MS, PetStateManager.STALE_THRESHOLD_MS)
        assertEquals(PetStateConfig.IDLE_SLEEP_TIMEOUT_MS, PetStateManager.IDLE_SLEEP_TIMEOUT_MS)
        assertEquals(PetStateConfig.DONE_SESSION_TTL_MS, PetStateManager.DONE_SESSION_TTL_MS)
    }

    @Test
    fun `companion re-exports maps`() {
        assertEquals(PetStateConfig.ONESHOT_AUTO_RETURN_MS, PetStateManager.ONESHOT_AUTO_RETURN_MS)
        assertEquals(PetStateConfig.CLICK_REACTIONS, PetStateManager.CLICK_REACTIONS)
        assertEquals(PetStateConfig.DRAG_REACTIONS, PetStateManager.DRAG_REACTIONS)
        assertEquals(PetStateConfig.NOTIFICATION_REACTIONS, PetStateManager.NOTIFICATION_REACTIONS)
        assertEquals(PetStateConfig.SLEEP_TIMINGS, PetStateManager.SLEEP_TIMINGS)
    }
}

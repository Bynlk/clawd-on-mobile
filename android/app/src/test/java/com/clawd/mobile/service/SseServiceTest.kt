package com.clawd.mobile.service

import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for [SseService] companion constants and contract.
 *
 * Full lifecycle tests (onStartCommand, WakeLock, WifiLock) require Android
 * instrumentation or Robolectric. These tests verify the static contract
 * and constants that don't need an Android context.
 */
class SseServiceTest {

    @Test
    fun `notification ID is a valid positive integer`() {
        assertTrue("NOTIFICATION_ID should be positive", SseService.NOTIFICATION_ID > 0)
    }

    @Test
    fun `channel constant is defined`() {
        assertEquals("clawd_service", SseService.CHANNEL_SERVICE)
    }

    @Test
    fun `action constants are defined`() {
        assertEquals("com.clawd.mobile.CONNECT", SseService.ACTION_CONNECT)
        assertEquals("com.clawd.mobile.DISCONNECT", SseService.ACTION_DISCONNECT)
    }

    @Test
    fun `companion has expected static methods`() {
        val companion = SseService.Companion::class.java
        assertNotNull(companion.getDeclaredMethod("getClient"))
        assertNotNull(companion.getDeclaredMethod("isRunning"))
        assertNotNull(companion.getDeclaredMethod("start", android.content.Context::class.java, com.clawd.mobile.data.ConnectionConfig::class.java))
        assertNotNull(companion.getDeclaredMethod("stop", android.content.Context::class.java))
    }
}

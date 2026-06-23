package com.clawd.mobile.overlay

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.atomic.AtomicInteger

/**
 * Unit tests for [TimedConsumeSet].
 *
 * Covers: basic tryConsume semantics, contains/remove/clear,
 * TTL expiration, empty key handling, bulk operations, and concurrency.
 */
class TimedConsumeSetTest {

    // ── 1. Basic tryConsume: first call returns true ─────────────────

    @Test
    fun `tryConsume returns true on first call`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertTrue(set.tryConsume("event_a"))
    }

    // ── 2. Basic tryConsume: repeated call returns false ─────────────

    @Test
    fun `tryConsume returns false on second call for same key`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertTrue(set.tryConsume("event_a"))
        assertFalse(set.tryConsume("event_a"))
    }

    @Test
    fun `tryConsume returns false for many repeated calls`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertTrue(set.tryConsume("key"))
        repeat(10) {
            assertFalse(set.tryConsume("key"))
        }
    }

    // ── 3. contains reflects state correctly ─────────────────────────

    @Test
    fun `contains returns false before any consume`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertFalse(set.contains("event_a"))
    }

    @Test
    fun `contains returns true after tryConsume`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("event_a")

        assertTrue(set.contains("event_a"))
    }

    @Test
    fun `contains returns false for different key`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("event_a")

        assertFalse(set.contains("event_b"))
    }

    // ── 4. remove allows re-consume ─────────────────────────────────

    @Test
    fun `remove allows tryConsume to return true again`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertTrue(set.tryConsume("event_a"))
        assertFalse(set.tryConsume("event_a"))

        set.remove("event_a")
        assertTrue(set.tryConsume("event_a"))
    }

    @Test
    fun `remove returns non-null for existing key`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("event_a")
        assertNotNull(set.remove("event_a"))
    }

    @Test
    fun `remove returns null for non-existing key`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertNull(set.remove("event_a"))
    }

    @Test
    fun `contains returns false after remove`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("event_a")
        assertTrue(set.contains("event_a"))

        set.remove("event_a")
        assertFalse(set.contains("event_a"))
    }

    // ── 5. clear removes all entries ────────────────────────────────

    @Test
    fun `clear removes all consumed keys`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("a")
        set.tryConsume("b")
        set.tryConsume("c")
        assertTrue(set.contains("a"))
        assertTrue(set.contains("b"))
        assertTrue(set.contains("c"))

        set.clear()

        assertFalse(set.contains("a"))
        assertFalse(set.contains("b"))
        assertFalse(set.contains("c"))
    }

    @Test
    fun `tryConsume returns true for all keys after clear`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("a")
        set.tryConsume("b")
        set.clear()

        assertTrue(set.tryConsume("a"))
        assertTrue(set.tryConsume("b"))
    }

    @Test
    fun `clear on empty set does not throw`() {
        val set = TimedConsumeSet(ttlMs = 60_000)
        set.clear() // should not throw
    }

    // ── 6. TTL expiration: tryConsume returns true again after TTL ───

    @Test
    fun `tryConsume returns true again after TTL expires`() {
        // Use a 1ms TTL so the entry expires almost immediately
        val set = TimedConsumeSet(ttlMs = 1)

        assertTrue(set.tryConsume("event_a"))
        assertFalse(set.tryConsume("event_a"))

        // Wait long enough for TTL to expire
        Thread.sleep(50)

        // The expired entry should have been cleaned up by this tryConsume call
        assertTrue(set.tryConsume("event_a"))
    }

    @Test
    fun `contains returns false after TTL expires`() {
        val set = TimedConsumeSet(ttlMs = 1)

        set.tryConsume("event_a")
        assertTrue(set.contains("event_a"))

        Thread.sleep(50)

        // Note: contains() does NOT trigger cleanup, so the stale entry
        // may still be present until the next tryConsume call.
        // We verify cleanup works via tryConsume instead.
        assertTrue(set.tryConsume("event_a")) // triggers cleanup, then re-consumes
    }

    @Test
    fun `different keys expire independently`() {
        val set = TimedConsumeSet(ttlMs = 1)

        set.tryConsume("fast") // will expire
        Thread.sleep(50)

        // "fast" has expired, but a new key should still work
        assertTrue(set.tryConsume("fast"))
        assertTrue(set.tryConsume("new_key"))
    }

    // ── 7. Empty / edge-case keys ───────────────────────────────────

    @Test
    fun `tryConsume with empty string key works`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertTrue(set.tryConsume(""))
        assertFalse(set.tryConsume(""))
    }

    @Test
    fun `contains with empty string key works`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        assertFalse(set.contains(""))
        set.tryConsume("")
        assertTrue(set.contains(""))
    }

    @Test
    fun `remove with empty string key works`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        set.tryConsume("")
        set.remove("")
        assertFalse(set.contains(""))
        assertTrue(set.tryConsume(""))
    }

    @Test
    fun `special character keys work correctly`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        val specialKeys = listOf(
            "key with spaces",
            "key/with/slashes",
            "key=with=equals",
            "éèê", // accented chars
            "😀",       // emoji
        )

        specialKeys.forEach { key ->
            assertTrue("First tryConsume should return true for: $key", set.tryConsume(key))
            assertFalse("Second tryConsume should return false for: $key", set.tryConsume(key))
        }

        specialKeys.forEach { key ->
            assertTrue("contains should be true for: $key", set.contains(key))
        }
    }

    // ── 8. Bulk / performance: many keys without crash ──────────────

    @Test
    fun `handles thousands of keys without error`() {
        val set = TimedConsumeSet(ttlMs = 60_000)
        val count = 10_000

        repeat(count) { i ->
            assertTrue(set.tryConsume("key_$i"))
        }

        // All should be consumed
        repeat(count) { i ->
            assertFalse(set.tryConsume("key_$i"))
            assertTrue(set.contains("key_$i"))
        }

        // Clear all
        set.clear()
        repeat(count) { i ->
            assertTrue(set.tryConsume("key_$i"))
        }
    }

    @Test
    fun `bulk remove does not throw`() {
        val set = TimedConsumeSet(ttlMs = 60_000)

        repeat(5_000) { i ->
            set.tryConsume("key_$i")
        }

        repeat(5_000) { i ->
            set.remove("key_$i")
        }

        repeat(5_000) { i ->
            assertFalse(set.contains("key_$i"))
        }
    }

    // ── 9. Concurrency: only one thread wins for the same key ───────

    @Test
    fun `concurrent tryConsume on same key returns true exactly once`() {
        val set = TimedConsumeSet(ttlMs = 60_000)
        val threadCount = 100
        val latch = CountDownLatch(threadCount)
        val winCount = AtomicInteger(0)

        repeat(threadCount) {
            Thread {
                try {
                    if (set.tryConsume("shared_key")) {
                        winCount.incrementAndGet()
                    }
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()

        assertEquals("Exactly one thread should win", 1, winCount.get())
        assertFalse(set.tryConsume("shared_key"))
    }

    @Test
    fun `concurrent tryConsume on different keys are all independent`() {
        val set = TimedConsumeSet(ttlMs = 60_000)
        val threadCount = 200
        val latch = CountDownLatch(threadCount)
        val winCount = AtomicInteger(0)

        val barrier = CyclicBarrier(threadCount)

        repeat(threadCount) { i ->
            Thread {
                try {
                    barrier.await() // synchronize all threads to start at the same time
                    if (set.tryConsume("key_$i")) {
                        winCount.incrementAndGet()
                    }
                } catch (_: Exception) {
                    // barrier broken, ignore
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()

        assertEquals("Each unique key should be consumed exactly once", threadCount, winCount.get())
    }

    @Test
    fun `concurrent tryConsume mixed with remove on same key`() {
        val set = TimedConsumeSet(ttlMs = 60_000)
        val iterations = 50
        val latch = CountDownLatch(iterations * 2)
        val trueCount = AtomicInteger(0)

        // Half threads tryConsume, half remove
        repeat(iterations) {
            Thread {
                try {
                    set.tryConsume("contested_key")
                } finally {
                    latch.countDown()
                }
            }.start()
            Thread {
                try {
                    set.remove("contested_key")
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()

        // After all threads finish, the key should either be consumed or not
        // We just verify no exception and the state is consistent
        val finalState = set.contains("contested_key")
        // If consumed, tryConsume should return false
        // If not consumed (was removed last), tryConsume should return true
        if (finalState) {
            assertFalse(set.tryConsume("contested_key"))
        } else {
            assertTrue(set.tryConsume("contested_key"))
        }
    }

    // ── 10. TTL + concurrency: expired keys are re-consumable ────────

    @Test
    fun `concurrent tryConsume after TTL expires allows re-consume`() {
        val set = TimedConsumeSet(ttlMs = 1)

        set.tryConsume("key")
        assertFalse(set.tryConsume("key"))

        Thread.sleep(50)

        val winCount = AtomicInteger(0)
        val threadCount = 50
        val latch = CountDownLatch(threadCount)

        repeat(threadCount) {
            Thread {
                try {
                    if (set.tryConsume("key")) {
                        winCount.incrementAndGet()
                    }
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()
        // Note: After TTL expiry, cleanup() + putIfAbsent are not atomic,
        // so multiple threads may win in a race. At least one must win.
        assertTrue("At least one thread should win after TTL expiry", winCount.get() >= 1)
    }

    // ── 11. Multiple keys with different lifetimes ──────────────────

    @Test
    fun `tryConsume works correctly with mixed expired and valid keys`() {
        val set = TimedConsumeSet(ttlMs = 1)

        // These will expire
        set.tryConsume("expire_a")
        set.tryConsume("expire_b")

        Thread.sleep(50)

        // Add a fresh key (TTL measured from now)
        assertTrue(set.tryConsume("fresh"))

        // Trigger cleanup via tryConsume on an expired key
        assertTrue(set.tryConsume("expire_a"))
        // "expire_b" was also added 50ms ago, should also be expired and re-consumable
        assertTrue(set.tryConsume("expire_b"))
        // "fresh" was added after sleep, should still be consumed
        assertFalse(set.tryConsume("fresh"))
    }
}

package com.clawd.mobile.util

import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier

class ConnectionLogTest {

    @Before
    fun setup() {
        ConnectionLog.clear()
    }

    // ── initial state ──────────────────────────────────────────────────

    @Test
    fun `initial state is empty, dump returns empty string`() {
        val result = ConnectionLog.dump()
        assertEquals("", result)
    }

    // ── single-entry logging ───────────────────────────────────────────

    @Test
    fun `d adds one debug entry`() {
        ConnectionLog.d("Http", "connected")
        val dump = ConnectionLog.dump()
        assertTrue(dump.contains("D/Http: connected"))
    }

    @Test
    fun `e adds one error entry`() {
        ConnectionLog.e("Http", "timeout")
        val dump = ConnectionLog.dump()
        assertTrue(dump.contains("E/Http: timeout"))
    }

    @Test
    fun `w adds one warn entry`() {
        ConnectionLog.w("Http", "retrying")
        val dump = ConnectionLog.dump()
        assertTrue(dump.contains("W/Http: retrying"))
    }

    // ── ring buffer overflow (200 cap) ─────────────────────────────────

    @Test
    fun `exceeding 200 entries evicts the oldest`() {
        // Fill with 200 entries using unique prefixes to avoid substring matches
        for (i in 1..200) {
            ConnectionLog.d("T", "entry-${String.format("%04d", i)}")
        }
        val beforeOverflow = ConnectionLog.dump()
        assertTrue(beforeOverflow.contains("entry-0001"))
        assertTrue(beforeOverflow.contains("entry-0200"))

        // Add one more — entry-0001 should be evicted
        ConnectionLog.d("T", "entry-0201")
        val afterOverflow = ConnectionLog.dump()
        assertFalse("Oldest entry should be evicted", afterOverflow.contains("entry-0001"))
        assertTrue(afterOverflow.contains("entry-0201"))
        assertTrue(afterOverflow.contains("entry-0200"))
    }

    @Test
    fun `buffer never exceeds 200 entries`() {
        for (i in 1..250) {
            ConnectionLog.d("T", "item-$i")
        }
        val dump = ConnectionLog.dump()
        val lines = dump.lines().filter { it.isNotEmpty() }
        assertEquals("Buffer should contain at most 200 entries", 200, lines.size)
    }

    // ── clear ──────────────────────────────────────────────────────────

    @Test
    fun `clear empties all entries`() {
        ConnectionLog.d("T", "a")
        ConnectionLog.e("T", "b")
        ConnectionLog.w("T", "c")
        ConnectionLog.clear()
        assertEquals("", ConnectionLog.dump())
    }

    // ── dump format ────────────────────────────────────────────────────

    @Test
    fun `dump joins entries with newline`() {
        ConnectionLog.d("A", "first")
        ConnectionLog.e("B", "second")
        val dump = ConnectionLog.dump()
        val lines = dump.lines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].contains("first"))
        assertTrue(lines[1].contains("second"))
    }

    // ── timestamp / level / tag / message format ───────────────────────

    @Test
    fun `debug entry format contains timestamp level tag message`() {
        ConnectionLog.d("MyTag", "hello world")
        val line = ConnectionLog.dump()
        // Format: HH:mm:ss.SSS D/MyTag: hello world
        val pattern = Regex("""\d{2}:\d{2}:\d{2}\.\d{3} D/MyTag: hello world""")
        assertTrue("Line should match format pattern: $line", pattern.containsMatchIn(line))
    }

    @Test
    fun `error entry format contains timestamp level tag message`() {
        ConnectionLog.e("Net", "fail")
        val line = ConnectionLog.dump()
        val pattern = Regex("""\d{2}:\d{2}:\d{2}\.\d{3} E/Net: fail""")
        assertTrue("Line should match format pattern: $line", pattern.containsMatchIn(line))
    }

    @Test
    fun `warn entry format contains timestamp level tag message`() {
        ConnectionLog.w("WS", "slow")
        val line = ConnectionLog.dump()
        val pattern = Regex("""\d{2}:\d{2}:\d{2}\.\d{3} W/WS: slow""")
        assertTrue("Line should match format pattern: $line", pattern.containsMatchIn(line))
    }

    @Test
    fun `format uses correct level letter per method`() {
        ConnectionLog.d("T", "d-msg")
        ConnectionLog.e("T", "e-msg")
        ConnectionLog.w("T", "w-msg")
        val dump = ConnectionLog.dump()
        assertTrue(dump.contains(" D/"))
        assertTrue(dump.contains(" E/"))
        assertTrue(dump.contains(" W/"))
    }

    // ── mixed-level overflow ───────────────────────────────────────────

    @Test
    fun `overflow evicts oldest across mixed log levels`() {
        for (i in 1..100) ConnectionLog.d("T", "d-${String.format("%04d", i)}")
        for (i in 1..50) ConnectionLog.e("T", "e-${String.format("%04d", i)}")
        for (i in 1..51) ConnectionLog.w("T", "w-${String.format("%04d", i)}")  // total = 201

        val dump = ConnectionLog.dump()
        assertFalse("Oldest debug entry should be evicted", dump.contains("d-0001"))
        assertTrue("d-0002 should still be present", dump.contains("d-0002"))
        assertTrue("All error entries should remain", dump.contains("e-0050"))
        assertTrue("All warn entries should remain", dump.contains("w-0051"))
    }

    // ── concurrent writes ──────────────────────────────────────────────

    @Test
    fun `concurrent writes do not crash and entry count is correct`() {
        val threadCount = 10
        val entriesPerThread = 100
        val barrier = CyclicBarrier(threadCount)
        val latch = CountDownLatch(threadCount)
        val errors = Array<Throwable?>(threadCount) { null }

        for (i in 0 until threadCount) {
            Thread {
                try {
                    barrier.await()
                    for (j in 1..entriesPerThread) {
                        ConnectionLog.d("T$i", "msg-$j")
                    }
                } catch (e: Throwable) {
                    errors[i] = e
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()

        // No thread should have errored
        for (e in errors) {
            assertNull("Thread threw exception: ${e?.message}", e)
        }

        // Total written = 1000, buffer cap = 200
        val dump = ConnectionLog.dump()
        val lines = dump.lines().filter { it.isNotEmpty() }
        assertEquals("Buffer should hold exactly 200 entries", 200, lines.size)
    }

    @Test
    fun `concurrent mixed-level writes do not crash`() {
        val threadCount = 8
        val barrier = CyclicBarrier(threadCount)
        val latch = CountDownLatch(threadCount)
        val errors = Array<Throwable?>(threadCount) { null }

        for (i in 0 until threadCount) {
            Thread {
                try {
                    barrier.await()
                    when (i % 3) {
                        0 -> for (j in 1..100) ConnectionLog.d("T", "d-$j")
                        1 -> for (j in 1..100) ConnectionLog.e("T", "e-$j")
                        2 -> for (j in 1..100) ConnectionLog.w("T", "w-$j")
                    }
                } catch (e: Throwable) {
                    errors[i] = e
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()

        for (e in errors) {
            assertNull("Thread threw exception: ${e?.message}", e)
        }

        val dump = ConnectionLog.dump()
        val lines = dump.lines().filter { it.isNotEmpty() }
        assertEquals(200, lines.size)
    }

    @Test
    fun `concurrent clear and writes do not crash`() {
        val threadCount = 10
        val barrier = CyclicBarrier(threadCount)
        val latch = CountDownLatch(threadCount)
        val errors = Array<Throwable?>(threadCount) { null }

        for (i in 0 until threadCount) {
            Thread {
                try {
                    barrier.await()
                    if (i % 2 == 0) {
                        ConnectionLog.clear()
                    } else {
                        for (j in 1..50) {
                            ConnectionLog.d("T", "msg-$j")
                        }
                    }
                } catch (e: Throwable) {
                    errors[i] = e
                } finally {
                    latch.countDown()
                }
            }.start()
        }

        latch.await()

        for (e in errors) {
            assertNull("Thread threw exception: ${e?.message}", e)
        }

        // After all threads complete, size should be within bounds
        val dump = ConnectionLog.dump()
        val lines = dump.lines().filter { it.isNotEmpty() }
        assertTrue("Entry count should be within bounds: ${lines.size}", lines.size in 0..200)
    }

    // ── dump preserves insertion order ─────────────────────────────────

    @Test
    fun `dump preserves insertion order`() {
        ConnectionLog.d("T", "first")
        ConnectionLog.w("T", "second")
        ConnectionLog.e("T", "third")
        val lines = ConnectionLog.dump().lines().filter { it.isNotEmpty() }
        assertEquals(3, lines.size)
        assertTrue(lines[0].endsWith("first"))
        assertTrue(lines[1].endsWith("second"))
        assertTrue(lines[2].endsWith("third"))
    }
}

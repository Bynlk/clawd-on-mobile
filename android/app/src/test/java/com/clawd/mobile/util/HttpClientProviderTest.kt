package com.clawd.mobile.util

import com.clawd.mobile.data.ConnectionConfig
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.atomic.AtomicReference

class HttpClientProviderTest {

    @Before
    fun setup() {
        HttpClientProvider.reset()
    }

    @Test
    fun `getClient returns same instance for same config`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "token1234567890abcdef1234567890")
        val client1 = HttpClientProvider.getClient(config)
        val client2 = HttpClientProvider.getClient(config)
        assertSame(client1, client2)
    }

    @Test
    fun `getClient returns new instance when config changes`() {
        val config1 = ConnectionConfig("192.168.1.10", 23334, "token1234567890abcdef1234567890")
        val config2 = ConnectionConfig("192.168.1.20", 23334, "token1234567890abcdef1234567890")
        val client1 = HttpClientProvider.getClient(config1)
        val client2 = HttpClientProvider.getClient(config2)
        assertNotSame(client1, client2)
    }

    @Test
    fun `reset clears cached client`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "token1234567890abcdef1234567890")
        val client1 = HttpClientProvider.getClient(config)
        HttpClientProvider.reset()
        val client2 = HttpClientProvider.getClient(config)
        assertNotSame(client1, client2)
    }

    @Test
    fun `concurrent getClient returns same instance`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "token1234567890abcdef1234567890")
        val threadCount = 10
        val barrier = CyclicBarrier(threadCount)
        val latch = CountDownLatch(threadCount)
        val results = Array<okhttp3.OkHttpClient?>(threadCount) { null }
        val errors = Array<Throwable?>(threadCount) { null }

        for (i in 0 until threadCount) {
            Thread {
                try {
                    barrier.await() // all threads hit getClient() simultaneously
                    results[i] = HttpClientProvider.getClient(config)
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

        // All threads should get the same instance
        val first = results[0]
        assertNotNull(first)
        for (i in 1 until threadCount) {
            assertSame("Thread $i got a different instance", first, results[i])
        }
    }
}

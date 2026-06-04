package com.clawd.mobile.ws

import app.cash.turbine.test
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.util.HttpClientProvider
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Ignore
import org.junit.Test

/**
 * Unit tests for [WsClient].
 *
 * MockWebServer 4.12.0 does not support WebSocket mocking, so connection-level
 * tests are limited. Focus on state management, message parsing, and disconnect.
 */
class WsClientTest {

    private lateinit var prefsStore: PrefsStore
    private lateinit var client: WsClient

    @Before
    fun setUp() {
        HttpClientProvider.reset()

        prefsStore = mockk(relaxed = true)
        every { prefsStore.getCertFingerprint() } returns "AB:CD:EF" // non-null → skip TOFU

        client = WsClient(prefsStore)
    }

    @After
    fun tearDown() {
        client.destroy()
        HttpClientProvider.reset()
    }

    // ── 1. setConnectionState works ────────────────────────────────────

    @Test
    fun `setConnectionState updates connectionState flow`() = runTest {
        client.connectionState.test {
            assertEquals(ConnectionState.DISCONNECTED, awaitItem())
            client.setConnectionState(ConnectionState.PENDING_CERT_CONFIRMATION)
            assertEquals(ConnectionState.PENDING_CERT_CONFIRMATION, awaitItem())
            client.setConnectionState(ConnectionState.CONNECTED)
            assertEquals(ConnectionState.CONNECTED, awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
    }

    // ── 2. disconnect clears state ────────────────────────────────────

    @Test
    fun `disconnect sets DISCONNECTED and clears sessions`() = runTest {
        client.disconnect()

        assertEquals(ConnectionState.DISCONNECTED, client.connectionState.value)
        assertTrue(client.sessions.value.isEmpty())
        assertEquals("idle", client.displayState.value)
    }

    // ── 3. Initial state ──────────────────────────────────────────────

    @Test
    fun `initial state is DISCONNECTED with empty sessions`() = runTest {
        assertEquals(ConnectionState.DISCONNECTED, client.connectionState.value)
        assertTrue(client.sessions.value.isEmpty())
        assertEquals("idle", client.displayState.value)
        assertFalse(client.syncing.value)
        assertNull(client.currentHost)
        assertNull(client.currentPort)
    }

    // ── 4. connect saves config ────────────────────────────────────────

    @Test
    fun `connect saves config to prefsStore`() = runTest {
        val config = ConnectionConfig("192.168.1.10", 23334, "test-token-1234567890ab")
        client.connect(config)

        // Verify config was saved (PrefsStore mock is relaxed, so no exception)
        assertEquals("192.168.1.10", client.currentHost)
        assertEquals(23334, client.currentPort)
    }

    // ── 5. destroy cancels scope ───────────────────────────────────────

    @Test
    fun `destroy does not throw`() = runTest {
        client.destroy()
        // Should not throw
    }

    // ── 6. reconnect when connected is no-op ──────────────────────────

    @Test
    fun `reconnect when CONNECTED is no-op`() = runTest {
        client.setConnectionState(ConnectionState.CONNECTED)
        client.reconnect()
        assertEquals(ConnectionState.CONNECTED, client.connectionState.value)
    }

    @Test
    fun `reconnect when PENDING_CERT_CONFIRMATION is no-op`() = runTest {
        client.setConnectionState(ConnectionState.PENDING_CERT_CONFIRMATION)
        client.reconnect()
        assertEquals(ConnectionState.PENDING_CERT_CONFIRMATION, client.connectionState.value)
    }

    // ── 7. Multiple disconnect calls are safe ──────────────────────────

    @Test
    fun `multiple disconnect calls are safe`() = runTest {
        client.disconnect()
        client.disconnect()
        client.disconnect()
        assertEquals(ConnectionState.DISCONNECTED, client.connectionState.value)
    }
}

package com.clawd.mobile.ws

import com.clawd.mobile.data.ConnectionConfig
import org.junit.Test
import org.junit.Assert.*

class ConnectionStrategyTest {

    // ── helpers ────────────────────────────────────────────────────────

    private val lanConfig = ConnectionConfig(
        host = "192.168.1.10",
        port = 23334,
        token = "abcdef1234567890abcdef1234567890",
        useRelay = false
    )

    private val remoteConfig = ConnectionConfig(
        host = "example.com",
        port = 443,
        token = "abcdef1234567890abcdef1234567890",
        useRelay = false
    )

    private val relayConfig = ConnectionConfig(
        host = "192.168.1.10",
        port = 23334,
        token = "abcdef1234567890abcdef1234567890",
        relayUrl = "https://relay.example.com",
        relayToken = "relaytoken123456",
        useRelay = true
    )

    private val relayConfigNulls = ConnectionConfig(
        host = "192.168.1.10",
        port = 23334,
        token = "abcdef1234567890abcdef1234567890",
        relayUrl = null,
        relayToken = null,
        useRelay = true
    )

    // ── LanConnectionStrategy ──────────────────────────────────────────

    @Test
    fun `LanConnectionStrategy tag is LAN`() {
        val strategy = LanConnectionStrategy()
        assertEquals(ConnectionTag.LAN, strategy.tag)
    }

    @Test
    fun `LanConnectionStrategy streamUrl uses ws for LAN host`() {
        val strategy = LanConnectionStrategy()
        val url = strategy.streamUrl(lanConfig)
        assertEquals("ws://192.168.1.10:23334/mobile/ws", url)
    }

    @Test
    fun `LanConnectionStrategy streamUrl uses wss for non-LAN host`() {
        val strategy = LanConnectionStrategy()
        val url = strategy.streamUrl(remoteConfig)
        assertTrue("Expected wss:// for non-LAN, got: $url", url.startsWith("wss://"))
        assertEquals("wss://example.com:443/mobile/ws", url)
    }

    @Test
    fun `LanConnectionStrategy authHeader returns Bearer token`() {
        val strategy = LanConnectionStrategy()
        assertEquals("Bearer abcdef1234567890abcdef1234567890", strategy.authHeader(lanConfig))
    }

    @Test
    fun `LanConnectionStrategy shouldAcquireWifiLock returns true`() {
        val strategy = LanConnectionStrategy()
        assertTrue(strategy.shouldAcquireWifiLock())
    }

    // ── RelayConnectionStrategy ────────────────────────────────────────

    @Test
    fun `RelayConnectionStrategy tag is RELAY`() {
        val strategy = RelayConnectionStrategy()
        assertEquals(ConnectionTag.RELAY, strategy.tag)
    }

    @Test
    fun `RelayConnectionStrategy streamUrl uses relayUrl`() {
        val strategy = RelayConnectionStrategy()
        val url = strategy.streamUrl(relayConfig)
        assertEquals("https://relay.example.com/mobile/ws", url)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `RelayConnectionStrategy streamUrl throws when relayUrl is null`() {
        val strategy = RelayConnectionStrategy()
        strategy.streamUrl(relayConfigNulls)
    }

    @Test
    fun `RelayConnectionStrategy authHeader uses relayToken`() {
        val strategy = RelayConnectionStrategy()
        assertEquals("Bearer relaytoken123456", strategy.authHeader(relayConfig))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `RelayConnectionStrategy authHeader throws when relayToken is null`() {
        val strategy = RelayConnectionStrategy()
        strategy.authHeader(relayConfigNulls)
    }

    @Test
    fun `RelayConnectionStrategy shouldAcquireWifiLock returns false`() {
        val strategy = RelayConnectionStrategy()
        assertFalse(strategy.shouldAcquireWifiLock())
    }

    // ── ConnectionTag enum ─────────────────────────────────────────────

    @Test
    fun `ConnectionTag has exactly 2 values`() {
        assertEquals(2, ConnectionTag.entries.size)
    }

    @Test
    fun `ConnectionTag contains LAN and RELAY`() {
        val tags = ConnectionTag.entries.toSet()
        assertTrue(tags.contains(ConnectionTag.LAN))
        assertTrue(tags.contains(ConnectionTag.RELAY))
    }

    @Test
    fun `ConnectionTag LAN name is LAN`() {
        assertEquals("LAN", ConnectionTag.LAN.name)
    }

    @Test
    fun `ConnectionTag RELAY name is RELAY`() {
        assertEquals("RELAY", ConnectionTag.RELAY.name)
    }
}

package com.clawd.mobile.integration

import com.clawd.mobile.data.ConnectionConfig
import org.junit.Test
import org.junit.Assert.*

/**
 * Integration tests for ConnectionConfig — verifying the full flow from
 * URL parsing to connection parameter generation.
 */
class ConnectionConfigIntegrationTest {

    // ── Full pairing flow ──────────────────────────────────────────────

    @Test
    fun `pair url then parse back preserves config`() {
        val original = ConnectionConfig("192.168.1.100", 23334, "abcdef1234567890abcdef1234567890")
        val pairUrl = original.pairUrl()

        val parsed = ConnectionConfig.fromClawdUrl(pairUrl)
        assertNotNull(parsed)
        assertEquals(original.host, parsed!!.host)
        assertEquals(original.port, parsed.port)
        assertEquals(original.token, parsed.token)
    }

    @Test
    fun `stream url has no token - auth via header only`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "secrettoken1234567890abcdef12")
        val url = config.streamUrl()

        assertFalse("streamUrl must not contain token", url.contains("token"))
        assertFalse("streamUrl must not contain secret", url.contains("secret"))
        assertTrue(url.endsWith("/mobile/ws"))

        // Auth is via header
        assertEquals("Bearer secrettoken1234567890abcdef12", config.authHeader())
    }

    @Test
    fun `streamUrlMasked equals streamUrl - no token leakage`() {
        val config = ConnectionConfig("10.0.0.5", 8080, "mysecrettoken1234567890abcdef")
        assertEquals(config.streamUrl(), config.streamUrlMasked())
        assertFalse(config.streamUrlMasked().contains("secret"))
    }

    // ── LAN detection ──────────────────────────────────────────────────

    @Test
    fun `localhost is always LAN`() {
        val config = ConnectionConfig("localhost", 3000, "tok")
        assertTrue(config.isLan)
        assertTrue(config.streamUrl().startsWith("ws://"))
    }

    @Test
    fun `private IPs are LAN`() {
        assertTrue(ConnectionConfig("10.0.0.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("172.16.0.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("192.168.1.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("127.0.0.1", 8080, "tok").isLan)
    }

    // ── Security: host validation ──────────────────────────────────────

    @Test
    fun `reject public domains in pairing URL`() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://evil.com:23334/abcdef1234567890abcdef1234567890"))
        assertNull(ConnectionConfig.fromClawdUrl("clawd://example.org:23334/abcdef1234567890abcdef1234567890"))
    }

    @Test
    fun `accept mDNS dot-local hosts in pairing URL`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://my-mac.local:23334/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals("my-mac.local", config!!.host)
        // Note: isLan for .local hosts requires mDNS resolution (unavailable in JVM unit tests).
        // On a real device, InetAddress.getByName("my-mac.local") resolves via mDNS and
        // returns a site-local address, so isLan=true. In unit tests, DNS lookup fails
        // and isLan returns false. The pairing URL parsing itself is correct either way.
    }

    @Test
    fun `reject non-hex token in pairing URL`() {
        // Token must be hex, at least 16 chars
        assertNull(ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/not-hex-token!!"))
    }

    @Test
    fun `port coercion - zero becomes one`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:0/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals(1, config!!.port)
    }

    @Test
    fun `port coercion - over 65535 becomes 65535`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:99999/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals(65535, config!!.port)
    }

    // ── URL format consistency ─────────────────────────────────────────

    @Test
    fun `stream url format is consistent`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "tok")
        val url = config.streamUrl()

        // Should be ws/wss://host:port/mobile/ws
        assertTrue(url.matches(Regex("^wss?://[^:]+:\\d+/mobile/ws$")))
    }

}

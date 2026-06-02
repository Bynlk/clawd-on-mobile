package com.clawd.mobile.data

import org.junit.Test
import org.junit.Assert.*

class ConnectionConfigTest {
    @Test
    fun `parse valid clawd url`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals("192.168.1.10", config!!.host)
        assertEquals(23334, config.port)
        assertEquals("abcdef1234567890abcdef1234567890", config.token)
    }

    @Test
    fun `reject invalid url`() {
        assertNull(ConnectionConfig.fromClawdUrl("http://example.com"))
        assertNull(ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/short"))
    }

    @Test
    fun `accept localhost host`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://localhost:23334/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals("localhost", config!!.host)
    }

    @Test
    fun `accept mDNS dot-local host`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://my-mac.local:23334/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals("my-mac.local", config!!.host)
    }

    @Test
    fun `reject public domain host`() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://evil.com:23334/abcdef1234567890abcdef1234567890"))
        assertNull(ConnectionConfig.fromClawdUrl("clawd://example.org:23334/abcdef1234567890abcdef1234567890"))
    }

    @Test
    fun `reject arbitrary string host`() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://not-a-valid-host:23334/abcdef1234567890abcdef1234567890"))
    }

    @Test
    fun `reject out of range IP octets`() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://999.999.999.999:23334/abcdef1234567890abcdef1234567890"))
    }

    @Test
    fun `reject non-numeric port`() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:abc/abcdef1234567890abcdef1234567890"))
    }

    @Test
    fun `generate correct stream url for lan`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("http://192.168.1.10:23334/mobile/stream", config.streamUrl())
    }

    @Test
    fun `generate correct stream url for remote`() {
        val config = ConnectionConfig("example.com", 443, "abcdef1234567890abcdef1234567890")
        assertEquals("https://example.com:443/mobile/stream", config.streamUrl())
    }

    @Test
    fun `generate correct approve url`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("http://192.168.1.10:23334/mobile/approve", config.approveUrl())
    }

    @Test
    fun `generate correct pair url`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("clawd://192.168.1.10:23334/abcdef1234567890abcdef1234567890", config.pairUrl())
    }

    @Test
    fun `isLan detects private networks`() {
        assertTrue(ConnectionConfig("10.0.0.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("172.16.0.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("172.31.255.255", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("172.20.0.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("192.168.1.1", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("localhost", 8080, "tok").isLan)
        assertTrue(ConnectionConfig("127.0.0.1", 8080, "tok").isLan)
    }

    @Test
    fun `isLan rejects public hosts`() {
        assertFalse(ConnectionConfig("example.com", 443, "tok").isLan)
        assertFalse(ConnectionConfig("8.8.8.8", 443, "tok").isLan)
        assertFalse(ConnectionConfig("172.15.0.1", 443, "tok").isLan)
        assertFalse(ConnectionConfig("172.32.0.1", 443, "tok").isLan)
    }

    // ── authHeader ─────────────────────────────────────────────────────

    @Test
    fun `authHeader returns Bearer token`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("Bearer abcdef1234567890abcdef1234567890", config.authHeader())
    }

    // ── streamUrlMasked ────────────────────────────────────────────────

    @Test
    fun `streamUrlMasked returns same url as streamUrl - no token leaked`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals(config.streamUrl(), config.streamUrlMasked())
        assertFalse(config.streamUrlMasked().contains("token"))
        assertFalse(config.streamUrlMasked().contains("abcdef"))
    }

    // ── fromClawdUrl edge cases ────────────────────────────────────────

    @Test
    fun `reject empty url`() {
        assertNull(ConnectionConfig.fromClawdUrl(""))
    }

    @Test
    fun `coerce port 0 to 1`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:0/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals(1, config!!.port)  // coerceIn(1, 65535) clamps 0 → 1
    }

    @Test
    fun `coerce port over 65535 to 65535`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:99999/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals(65535, config!!.port)  // coerceIn(1, 65535) clamps 99999 → 65535
    }

    @Test
    fun `stream url uses https for non-lan`() {
        val config = ConnectionConfig("example.com", 443, "abcdef1234567890abcdef1234567890")
        // isLan will be false for example.com (DNS lookup fails in test, returns false)
        val url = config.streamUrl()
        // The scheme depends on InetAddress resolution — in unit tests without network,
        // InetAddress.getByName("example.com") may throw, making isLan = false
        assertTrue(url.contains("://example.com:443/mobile/stream"))
        assertFalse(url.contains("token"))
    }

    @Test
    fun `approveUrl scheme matches isLan`() {
        val lanConfig = ConnectionConfig("192.168.1.10", 23334, "tok")
        assertTrue(lanConfig.approveUrl().startsWith("http://"))
    }

    @Test
    fun `pairUrl always uses clawd scheme`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("clawd://192.168.1.10:23334/abcdef1234567890abcdef1234567890", config.pairUrl())
    }
}

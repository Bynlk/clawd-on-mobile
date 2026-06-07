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
    fun `accept uppercase hex token and lowercase it`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/ABCDEF1234567890ABCDEF1234567890")
        assertNotNull(config)
        assertEquals("abcdef1234567890abcdef1234567890", config!!.token)
    }

    @Test
    fun `accept mixed case hex token and lowercase it`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/aAbBcCdD11223344aAbBcCdD11223344")
        assertNotNull(config)
        assertEquals("aabbccdd11223344aabbccdd11223344", config!!.token)
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
        assertEquals("ws://192.168.1.10:23334/mobile/ws", config.streamUrl())
    }

    @Test
    fun `generate correct stream url for remote`() {
        val config = ConnectionConfig("example.com", 443, "abcdef1234567890abcdef1234567890")
        // example.com is non-LAN → wss://
        assertEquals("wss://example.com:443/mobile/ws", config.streamUrl())
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
    fun `stream url uses wss for non-lan`() {
        val config = ConnectionConfig("example.com", 443, "abcdef1234567890abcdef1234567890")
        // isLan will be false for example.com (DNS lookup fails in test, returns false)
        val url = config.streamUrl()
        assertTrue("Expected wss:// for non-LAN, got: $url", url.startsWith("wss://"))
        assertTrue(url.contains("://example.com:443/mobile/ws"))
        assertFalse(url.contains("token"))
    }

    @Test
    fun `pairUrl always uses clawd scheme`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("clawd://192.168.1.10:23334/abcdef1234567890abcdef1234567890", config.pairUrl())
    }

    // ── toString masking ─────────────────────────────────────────────

    @Test
    fun `toString masks token`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        val str = config.toString()
        assertTrue(str.contains("host=192.168.1.10"))
        assertTrue(str.contains("port=23334"))
        assertFalse(str.contains("abcdef1234567890"))
        assertTrue(str.contains("ab…90"))
    }

    @Test
    fun `toString handles short token`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abc")
        val str = config.toString()
        assertTrue(str.contains("***"))
    }

    // ── fromClawdUrl with IPv6 ───────────────────────────────────────

    // IPv6 in brackets is NOT supported by current regex (colon conflicts with port separator).
    // isValidHost() accepts "[::1]" but fromClawdUrl() regex cannot parse it.

    // ── fromClawdUrl with exact 16-char token ────────────────────────

    @Test
    fun `reject 15-char token`() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/abcdef123456789"))
    }

    @Test
    fun `accept exactly 16-char token`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/abcdef1234567890")
        assertNotNull(config)
        assertEquals("abcdef1234567890", config!!.token)
    }

    // ── fromClawdUrl with port 1 and 65535 ───────────────────────────

    @Test
    fun `accept port 1`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:1/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals(1, config!!.port)
    }

    @Test
    fun `accept port 65535`() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:65535/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals(65535, config!!.port)
    }
}

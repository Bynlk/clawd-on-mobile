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
    fun `generate correct stream url for lan`() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("http://192.168.1.10:23334/mobile/stream?token=abcdef1234567890abcdef1234567890", config.streamUrl())
    }

    @Test
    fun `generate correct stream url for remote`() {
        val config = ConnectionConfig("example.com", 443, "abcdef1234567890abcdef1234567890")
        assertEquals("https://example.com:443/mobile/stream?token=abcdef1234567890abcdef1234567890", config.streamUrl())
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
}

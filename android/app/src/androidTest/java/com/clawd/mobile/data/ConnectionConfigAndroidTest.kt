package com.clawd.mobile.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith

/**
 * Instrumented tests for [ConnectionConfig] that require Android runtime.
 * Tests isLan with real DNS resolution (InetAddress.getByName).
 */
@RunWith(AndroidJUnit4::class)
class ConnectionConfigAndroidTest {

    @Test
    fun isLanDetectsLocalhost() {
        assertTrue(ConnectionConfig("localhost", 8080, "tok").isLan)
    }

    @Test
    fun isLanDetects127() {
        assertTrue(ConnectionConfig("127.0.0.1", 8080, "tok").isLan)
    }

    @Test
    fun isLanDetects192() {
        assertTrue(ConnectionConfig("192.168.1.1", 8080, "tok").isLan)
    }

    @Test
    fun isLanDetects10() {
        assertTrue(ConnectionConfig("10.0.0.1", 8080, "tok").isLan)
    }

    @Test
    fun isLanRejectsPublicIp() {
        // 8.8.8.8 is Google DNS — not LAN
        assertFalse(ConnectionConfig("8.8.8.8", 443, "tok").isLan)
    }

    @Test
    fun streamUrlUsesWsForLan() {
        val config = ConnectionConfig("192.168.1.10", 23334, "tok")
        assertTrue(config.streamUrl().startsWith("ws://"))
    }

    @Test
    fun pairUrlUsesClawdScheme() {
        val config = ConnectionConfig("192.168.1.10", 23334, "abcdef1234567890abcdef1234567890")
        assertEquals("clawd://192.168.1.10:23334/abcdef1234567890abcdef1234567890", config.pairUrl())
    }

    @Test
    fun authHeaderFormat() {
        val config = ConnectionConfig("192.168.1.10", 23334, "mytoken1234567890abcdef12345678")
        assertEquals("Bearer mytoken1234567890abcdef12345678", config.authHeader())
    }

    @Test
    fun fromClawdUrlParsesValidLanUrl() {
        val config = ConnectionConfig.fromClawdUrl("clawd://192.168.1.10:23334/abcdef1234567890abcdef1234567890")
        assertNotNull(config)
        assertEquals("192.168.1.10", config!!.host)
        assertEquals(23334, config.port)
        assertEquals("abcdef1234567890abcdef1234567890", config.token)
        assertTrue(config.isLan)
    }

    @Test
    fun fromClawdUrlRejectsPublicHost() {
        assertNull(ConnectionConfig.fromClawdUrl("clawd://evil.com:23334/abcdef1234567890abcdef1234567890"))
    }
}

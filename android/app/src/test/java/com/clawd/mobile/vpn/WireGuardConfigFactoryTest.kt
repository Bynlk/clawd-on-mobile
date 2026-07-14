package com.clawd.mobile.vpn

import com.clawd.mobile.data.RelayWireGuardConfig
import com.wireguard.android.backend.Tunnel
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WireGuardConfigFactoryTest {
    private val privateKey = Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
    private val serverPublicKey = Base64.getEncoder().encodeToString(ByteArray(32) { 8 })

    private fun pairingConfig() = RelayWireGuardConfig(
        privateKey = privateKey,
        address = "10.8.0.3/32",
        serverPublicKey = serverPublicKey,
        endpoint = "198.51.100.7:51820",
        allowedIps = listOf("10.8.0.0/24"),
        persistentKeepalive = 25,
    )

    @Test
    fun `builds one app scoped peer for the private subnet without DNS or a default route`() {
        val config = WireGuardConfigFactory.create(pairingConfig())

        assertEquals(setOf("com.clawd.mobile"), config.`interface`.includedApplications)
        assertTrue(config.`interface`.excludedApplications.isEmpty())
        assertTrue(config.`interface`.dnsServers.isEmpty())
        assertTrue(config.`interface`.dnsSearchDomains.isEmpty())
        assertEquals(setOf("10.8.0.3/32"), config.`interface`.addresses.map { it.toString() }.toSet())

        val peer = config.peers.single()
        val allowedIp = peer.allowedIps.single()
        assertEquals(24, allowedIp.mask)
        assertTrue(allowedIp.address.isSiteLocalAddress)
        assertEquals("10.8.0.0/24", allowedIp.toString())
        assertFalse(peer.allowedIps.any { it.mask == 0 })
        assertEquals(25, peer.persistentKeepalive.orElseThrow())
        assertEquals("198.51.100.7:51820", peer.endpoint.orElseThrow().toString())

        val rendered = config.toWgQuickString()
        assertFalse(rendered.contains("DNS ="))
        assertFalse(rendered.contains("0.0.0.0/0"))
        assertFalse(rendered.contains("::/0"))
    }

    @Test
    fun `uses one stable tunnel name and forwards backend state without configuration text`() {
        val observedStates = mutableListOf<Tunnel.State>()
        val tunnel = ClawdWireGuardTunnel(observedStates::add)

        assertEquals("clawd-remote", tunnel.name)
        tunnel.onStateChange(Tunnel.State.UP)

        assertEquals(listOf(Tunnel.State.UP), observedStates)
        assertFalse(tunnel.toString().contains(privateKey))
        assertFalse(tunnel.toString().contains(serverPublicKey))
    }
}

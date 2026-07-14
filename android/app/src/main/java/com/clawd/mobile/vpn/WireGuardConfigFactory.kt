package com.clawd.mobile.vpn

import com.clawd.mobile.data.RelayWireGuardConfig
import com.wireguard.config.Config
import com.wireguard.config.InetEndpoint
import com.wireguard.config.InetNetwork
import com.wireguard.config.Interface
import com.wireguard.config.Peer

object WireGuardConfigFactory {
    const val INCLUDED_APPLICATION = "com.clawd.mobile"
    private const val REQUIRED_KEEPALIVE_SECONDS = 25

    fun create(source: RelayWireGuardConfig): Config {
        val allowedIp = InetNetwork.parse(source.allowedIps.singleOrNull() ?: invalidTopology())
        require(allowedIp.mask == 24 && allowedIp.address.isSiteLocalAddress) {
            "WireGuard route must be one private /24"
        }
        require(source.persistentKeepalive == REQUIRED_KEEPALIVE_SECONDS) {
            "WireGuard keepalive must be $REQUIRED_KEEPALIVE_SECONDS seconds"
        }

        val tunnelInterface = Interface.Builder()
            .parsePrivateKey(source.privateKey)
            .addAddress(InetNetwork.parse(source.address))
            .includeApplication(INCLUDED_APPLICATION)
            .build()
        val peer = Peer.Builder()
            .parsePublicKey(source.serverPublicKey)
            .setEndpoint(InetEndpoint.parse(source.endpoint))
            .addAllowedIp(allowedIp)
            .setPersistentKeepalive(REQUIRED_KEEPALIVE_SECONDS)
            .build()

        return Config.Builder()
            .setInterface(tunnelInterface)
            .addPeer(peer)
            .build()
    }

    private fun invalidTopology(): Nothing =
        throw IllegalArgumentException("WireGuard route must be one private /24")
}

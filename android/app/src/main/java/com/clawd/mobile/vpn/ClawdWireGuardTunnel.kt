package com.clawd.mobile.vpn

import com.wireguard.android.backend.Tunnel

class ClawdWireGuardTunnel(
    private val stateChanged: (Tunnel.State) -> Unit = {},
) : Tunnel {
    override fun getName(): String = NAME

    override fun onStateChange(newState: Tunnel.State) {
        stateChanged(newState)
    }

    override fun toString(): String = "ClawdWireGuardTunnel(name=$NAME)"

    companion object {
        const val NAME = "clawd-remote"
    }
}

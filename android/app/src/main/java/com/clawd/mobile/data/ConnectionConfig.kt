package com.clawd.mobile.data

import android.util.Log
import kotlinx.serialization.Serializable

@Serializable
data class ConnectionConfig(
    val host: String,
    val port: Int,
    val token: String
) {
    /** Whether the host is on a local network (no TLS required). */
    val isLan: Boolean get() {
        if (host == "localhost") return true
        return try {
            val addr = java.net.InetAddress.getByName(host)
            addr.isLoopbackAddress || addr.isSiteLocalAddress || addr.isLinkLocalAddress
        } catch (_: Exception) {
            false
        }
    }

    fun streamUrl(): String {
        val scheme = if (isLan) "http" else "https"
        return "$scheme://$host:$port/mobile/stream?token=$token"
    }

    fun approveUrl(): String {
        val scheme = if (isLan) "http" else "https"
        return "$scheme://$host:$port/mobile/approve"
    }

    /** URL with token masked for logging — never log raw token. */
    fun streamUrlMasked(): String {
        val scheme = if (isLan) "http" else "https"
        val masked = if (token.length > 8) "${token.take(4)}****${token.takeLast(4)}" else "****"
        return "$scheme://$host:$port/mobile/stream?token=$masked"
    }

    fun pairUrl(): String = "clawd://$host:$port/$token"

    /** Authorization header value for Bearer token auth. */
    fun authHeader(): String = "Bearer $token"

    companion object {
        fun fromClawdUrl(url: String): ConnectionConfig? {
            val regex = Regex("^clawd://([^:]+):(\\d+)/([a-f0-9]{16,})$")
            val match = regex.matchEntire(url) ?: return null
            val host = match.groupValues[1]

            if (!isValidHost(host)) {
                Log.w("ConnectionConfig", "Rejected non-LAN host: $host")
                return null
            }

            val port = match.groupValues[2].toIntOrNull()?.coerceIn(1, 65535) ?: return null

            return ConnectionConfig(host, port, match.groupValues[3])
        }

        private fun isValidHost(host: String): Boolean {
            if (host == "localhost") return true
            // IPv4
            val ipv4Regex = Regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$")
            if (ipv4Regex.matches(host)) {
                return host.split(".").all { it.toIntOrNull()?.let { v -> v in 0..255 } == true }
            }
            // mDNS .local
            if (host.endsWith(".local")) return true
            // IPv6 in brackets
            if (host.startsWith("[") && host.endsWith("]")) return true
            return false
        }
    }
}

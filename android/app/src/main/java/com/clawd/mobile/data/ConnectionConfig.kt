package com.clawd.mobile.data

import kotlinx.serialization.Serializable

@Serializable
data class ConnectionConfig(
    val host: String,
    val port: Int,
    val token: String
) {
    /** Whether the host is on a local network (no TLS required). */
    val isLan: Boolean get() = host.matches(Regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.|localhost|127\\.).*"))

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

    companion object {
        fun fromClawdUrl(url: String): ConnectionConfig? {
            val regex = Regex("^clawd://([^:]+):(\\d+)/([a-f0-9]{16,})$")
            val match = regex.matchEntire(url) ?: return null
            return ConnectionConfig(
                host = match.groupValues[1],
                port = match.groupValues[2].toInt(),
                token = match.groupValues[3]
            )
        }
    }
}

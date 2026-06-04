package com.clawd.mobile.data

import android.util.Log
import kotlinx.serialization.Serializable

@Serializable
data class ConnectionConfig(
    val host: String,
    val port: Int,
    val token: String
) {
    /** Whether the host is on a local network (no TLS required). Cached per host. */
    val isLan: Boolean get() = isLanCached(host)

    private val scheme get() = if (isLan) "http" else "https"
    private val wsScheme get() = if (isLan) "ws" else "wss"

    fun streamUrl(): String = "$wsScheme://$host:$port/mobile/ws"

    fun approveUrl(): String = "$scheme://$host:$port/mobile/approve"

    /** URL safe for logging — no token included. */
    fun streamUrlMasked(): String = streamUrl()  // already no token in URL

    fun pairUrl(): String = "clawd://$host:$port/$token"

    /** Authorization header value for Bearer token auth. */
    fun authHeader(): String = "Bearer $token"

    override fun toString(): String {
        val masked = if (token.length > 4) token.take(2) + "…" + token.takeLast(2) else "***"
        return "ConnectionConfig(host=$host, port=$port, token=$masked)"
    }

    companion object {
        private data class CacheEntry(val isLan: Boolean, val timestamp: Long)
        private const val CACHE_TTL_MS = 5 * 60 * 1000L // 5 minutes
        private val lanCache = java.util.concurrent.ConcurrentHashMap<String, CacheEntry>()

        /** Cached [InetAddress.getByName] → isLan check to avoid repeated DNS lookups. */
        private fun isLanCached(host: String): Boolean {
            if (host == "localhost") return true
            val now = System.currentTimeMillis()
            val cached = lanCache[host]
            if (cached != null && now - cached.timestamp < CACHE_TTL_MS) return cached.isLan
            val isLan = try {
                val addr = java.net.InetAddress.getByName(host)
                addr.isLoopbackAddress || addr.isSiteLocalAddress || addr.isLinkLocalAddress
            } catch (_: Exception) {
                false
            }
            lanCache[host] = CacheEntry(isLan, now)
            return isLan
        }

        fun fromClawdUrl(url: String): ConnectionConfig? {
            val regex = Regex("^clawd://([^:]+):(\\d+)/([a-fA-F0-9]{16,})$")
            val match = regex.matchEntire(url) ?: return null
            val host = match.groupValues[1]

            if (!isValidHost(host)) {
                Log.w("ConnectionConfig", "Rejected non-LAN host: $host")
                return null
            }

            val port = match.groupValues[2].toIntOrNull()?.coerceIn(1, 65535) ?: return null

            return ConnectionConfig(host, port, match.groupValues[3].lowercase())
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

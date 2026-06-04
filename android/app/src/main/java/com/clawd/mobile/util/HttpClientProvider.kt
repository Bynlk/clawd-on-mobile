package com.clawd.mobile.util

import android.util.Log
import com.clawd.mobile.data.ConnectionConfig
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext

/**
 * Shared OkHttpClient provider.
 * Reuses a single client instance per [ConnectionConfig] to share connection pools
 * and consistent timeout/TLS settings across the app (WebSocket, ApprovalReceiver, etc.).
 *
 * LAN connections use [TofuTrustManager] for Trust-On-First-Use certificate pinning
 * instead of accepting all certificates.
 */
object HttpClientProvider {

    private const val TAG = "HttpClientProvider"

    /** Singleton TOFU trust manager shared by all LAN-mode OkHttpClients. */
    val tofuTrustManager = TofuTrustManager()

    @Volatile
    private var _client: OkHttpClient? = null

    @Volatile
    private var _streamingClient: OkHttpClient? = null

    @Volatile
    private var _config: ConnectionConfig? = null

    @Volatile
    private var _fingerprint: String? = null

    /**
     * Set the SHA-256 certificate fingerprint for certificate pinning.
     * For LAN: updates [tofuTrustManager]'s pinned fingerprint.
     * For non-LAN: updates OkHttp [CertificatePinner].
     * Pass null to clear. Clients are rebuilt on next [getClient]/[getStreamingClient] call.
     */
    fun setCertFingerprint(sha256: String?) {
        synchronized(this) {
            if (_fingerprint != sha256) {
                _fingerprint = sha256
                tofuTrustManager.pinFingerprint(sha256)
                // Invalidate cached clients so they get rebuilt with new pinning
                _client = null
                _streamingClient = null
            }
        }
    }

    /**
     * Returns an [OkHttpClient] configured for the given [config].
     * Reuses the existing client if the config hasn't changed.
     * Use for short-lived requests (approval POST, etc.).
     */
    fun getClient(config: ConnectionConfig): OkHttpClient {
        return synchronized(this) {
            if (_client == null || config != _config) {
                Log.d(TAG, "Building new OkHttpClient for ${config.host}:${config.port} (isLan=${config.isLan})")
                _client = buildClient(config, readTimeout = 30)
                _streamingClient = buildClient(config, readTimeout = 0)
                _config = config
            }
            _client!!
        }
    }

    /**
     * Returns an [OkHttpClient] for streaming (SSE/WebSocket) with [config].
     * readTimeout=0 (no timeout on streaming responses).
     */
    fun getStreamingClient(config: ConnectionConfig): OkHttpClient {
        return synchronized(this) {
            if (_streamingClient == null || config != _config) {
                Log.d(TAG, "Building new streaming OkHttpClient for ${config.host}:${config.port} (isLan=${config.isLan})")
                _client = buildClient(config, readTimeout = 30)
                _streamingClient = buildClient(config, readTimeout = 0)
                _config = config
            }
            _streamingClient!!
        }
    }

    private fun buildClient(config: ConnectionConfig, readTimeout: Long): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .readTimeout(readTimeout, TimeUnit.SECONDS)

        if (config.isLan) {
            // LAN: TOFU certificate pinning via TofuTrustManager.
            // First connection accepts any cert (stores fingerprint for user confirmation).
            // Subsequent connections require fingerprint match.
            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(null, arrayOf(tofuTrustManager), SecureRandom())
            builder.sslSocketFactory(sslContext.socketFactory, tofuTrustManager)
            // LAN: disable hostname verification (TOFU trust model — user confirms fingerprint)
            builder.hostnameVerifier(HostnameVerifier { _, _ -> true })
        } else {
            // Non-LAN: apply certificate pinning if fingerprint is configured
            val fp = _fingerprint
            if (fp != null) {
                Log.d(TAG, "Applying cert pinning for ${config.host}")
                val pinner = CertificatePinner.Builder()
                    .add(config.host, "sha256/$fp")
                    .build()
                builder.certificatePinner(pinner)
            } else {
                Log.w(TAG, "Non-LAN connection to ${config.host} without cert pinning")
            }
        }

        return builder.build()
    }

    /**
     * Reset cached clients — call when connection config changes or app disconnects.
     * Does NOT clear the certificate fingerprint, which is managed explicitly via
     * [setCertFingerprint]. This prevents a race where [disconnect][com.clawd.mobile.ws.SseClient.disconnect]
     * clears the fingerprint while [ApprovalWorker] may still need it for in-flight requests.
     */
    fun reset() = synchronized(this) {
        _client = null
        _streamingClient = null
        _config = null
    }
}

package com.clawd.mobile.util

import android.util.Log
import com.clawd.mobile.data.ConnectionConfig
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Shared OkHttpClient provider.
 * Reuses a single client instance per [ConnectionConfig] to share connection pools
 * and consistent timeout/TLS settings across the app (WebSocket, ApprovalReceiver, etc.).
 */
object HttpClientProvider {

    private const val TAG = "HttpClientProvider"

    @Volatile
    private var _client: OkHttpClient? = null

    @Volatile
    private var _sseClient: OkHttpClient? = null

    @Volatile
    private var _config: ConnectionConfig? = null

    @Volatile
    private var _fingerprint: String? = null

    /**
     * Set the SHA-256 certificate fingerprint for non-LAN certificate pinning.
     * Pass null to clear. Clients are rebuilt on next [getClient]/[getSseClient] call.
     */
    fun setCertFingerprint(sha256: String?) {
        synchronized(this) {
            if (_fingerprint != sha256) {
                _fingerprint = sha256
                // Invalidate cached clients so they get rebuilt with new pinning
                _client = null
                _sseClient = null
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
                _sseClient = buildClient(config, readTimeout = 0)
                _config = config
            }
            _client!!
        }
    }

    /**
     * Returns an [OkHttpClient] for SSE long-polling with [config].
     * readTimeout=0 (no timeout on streaming responses).
     */
    fun getSseClient(config: ConnectionConfig): OkHttpClient {
        return synchronized(this) {
            if (_sseClient == null || config != _config) {
                Log.d(TAG, "Building new SSE OkHttpClient for ${config.host}:${config.port} (isLan=${config.isLan})")
                _client = buildClient(config, readTimeout = 30)
                _sseClient = buildClient(config, readTimeout = 0)
                _config = config
            }
            _sseClient!!
        }
    }

    private fun buildClient(config: ConnectionConfig, readTimeout: Long): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .readTimeout(readTimeout, TimeUnit.SECONDS)

        // Non-LAN: apply certificate pinning if fingerprint is configured
        if (!config.isLan) {
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

    /** Reset client — call when connection config changes or app disconnects. */
    fun reset() {
        _client = null
        _sseClient = null
        _config = null
    }
}

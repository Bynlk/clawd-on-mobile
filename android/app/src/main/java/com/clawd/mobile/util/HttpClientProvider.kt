package com.clawd.mobile.util

import android.util.Log
import com.clawd.mobile.data.ConnectionConfig
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
    private var _config: ConnectionConfig? = null

    /**
     * Returns an [OkHttpClient] configured for the given [config].
     * Reuses the existing client if the config hasn't changed.
     */
    fun getClient(config: ConnectionConfig): OkHttpClient {
        return synchronized(this) {
            if (_client == null || config != _config) {
                Log.d(TAG, "Building new OkHttpClient for ${config.host}:${config.port} (isLan=${config.isLan})")
                val builder = OkHttpClient.Builder()
                    .connectTimeout(5, TimeUnit.SECONDS)
                    .writeTimeout(5, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                // 非局域网连接可在此添加 CertificatePinner（需要实际指纹）
                // if (!config.isLan) { builder.certificatePinner(...) }
                _client = builder.build()
                _config = config
            }
            _client!!
        }
    }

    /** Reset client — call when connection config changes or app disconnects. */
    fun reset() {
        _client = null
        _config = null
    }
}

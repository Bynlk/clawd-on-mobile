package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.serialization.json.*
import android.util.Log
import com.clawd.mobile.util.ConnectionLog
import com.clawd.mobile.util.HttpClientProvider
import okhttp3.*
import okio.ByteString

/**
 * WebSocket transport using OkHttp.
 * Delegates shared logic to [AbstractStreamingClient].
 */
class WsClient(prefsStore: PrefsStore) : AbstractStreamingClient(prefsStore) {

    override val tag = "WsClient"
    override val watchdogTimeoutMs = 90_000L

    @Volatile
    private var ws: WebSocket? = null
    private var currentUrl: String? = null

    override fun doConnect() {
        val cfg = config ?: return
        doConnectPreamble()
        closeTransport()

        val url = cfg.streamUrl()
        currentUrl = url
        Log.d(tag, "doConnect → ${cfg.streamUrlMasked()}")
        ConnectionLog.d(tag, "doConnect → ${cfg.streamUrlMasked()}")

        try {
            val httpClient = HttpClientProvider.getStreamingClient(cfg)
            val request = Request.Builder()
                .url(url)
                .addHeader("Authorization", cfg.authHeader())
                .build()

            val socket = httpClient.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.d(tag, "onOpen code=${response.code}")
                    ConnectionLog.d(tag, "OkHttp onOpen code=${response.code}")
                    onTransportOpen(response)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    ConnectionLog.d(tag, "OkHttp onMessage len=${text.length}")
                    onTransportMessage(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    // Binary frames — treat as text if possible
                    val text = bytes.utf8()
                    ConnectionLog.d(tag, "OkHttp onMessage(binary) len=${text.length}")
                    onTransportMessage(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(tag, "WS onClosing code=$code reason=$reason")
                    ConnectionLog.d(tag, "OkHttp onClosing code=$code reason=$reason")
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(tag, "WS onClosed code=$code reason=$reason")
                    ConnectionLog.d(tag, "OkHttp onClosed code=$code reason=$reason")
                    onTransportClosed()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.e(tag, "WS onFailure: ${t.javaClass.simpleName}: ${t.message}")
                    ConnectionLog.e(tag, "OkHttp onFailure code=${response?.code} err=${t.javaClass.simpleName}: ${t.message}")
                    onTransportFailure(t, response)
                }
            })
            ws = socket
        } catch (e: Exception) {
            Log.e(tag, "doConnect failed: ${e.message}")
            ConnectionLog.e(tag, "doConnect exception: ${e.javaClass.simpleName}: ${e.message}")
            onTransportFailure(e, null)
        }
    }

    override fun closeTransport() {
        try {
            ws?.close(1000, "Client disconnect")
        } catch (_: Exception) {}
        ws = null
    }

    override fun cancelTransport() {
        try {
            ws?.cancel()
        } catch (_: Exception) {}
        ws = null
    }

    /** Send a command via WebSocket (upstream message). WS-specific, not on [StreamingClient].
     *  @return true if sent, false if dropped (not connected or buffer full). */
    fun sendCommand(type: String, payload: JsonObject): Boolean {
        val socket = ws
        if (socket == null || connectionState.value != ConnectionState.CONNECTED) {
            Log.w(tag, "sendCommand skipped: not connected (state=${connectionState.value})")
            return false
        }
        val msg = buildJsonObject {
            put("type", type)
            for ((k, v) in payload) put(k, v)
        }.toString()
        return try {
            socket.send(msg)
            true
        } catch (e: Exception) {
            Log.w(tag, "sendCommand failed: ${e.message}")
            false
        }
    }

    /** @return true if sent, false if not connected or send failed. */
    override fun sendMessage(json: String): Boolean {
        val socket = ws
        if (socket == null || connectionState.value != ConnectionState.CONNECTED) {
            Log.w(tag, "sendMessage skipped: not connected (state=${connectionState.value})")
            return false
        }
        return try {
            socket.send(json)
            true
        } catch (e: Exception) {
            Log.w(tag, "sendMessage failed: ${e.message}")
            false
        }
    }
}

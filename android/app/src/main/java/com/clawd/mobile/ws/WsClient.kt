package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import kotlinx.serialization.json.*
import okhttp3.*
import android.util.Log
import com.clawd.mobile.util.HttpClientProvider

/** WebSocket transport implementation. Delegates shared logic to [AbstractStreamingClient]. */
class WsClient(prefsStore: PrefsStore) : AbstractStreamingClient(prefsStore) {

    override val tag = "WsClient"
    override val watchdogTimeoutMs = 90_000L

    @Volatile
    private var webSocket: WebSocket? = null

    override fun doConnect() {
        val cfg = config ?: return
        doConnectPreamble()
        webSocket?.close(1000, "")

        val url = cfg.streamUrl()
        Log.d(tag, "doConnect → ${cfg.streamUrlMasked()}")

        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", cfg.authHeader())
            .build()

        webSocket = HttpClientProvider.getStreamingClient(cfg)
            .newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) = onTransportOpen(response)

                override fun onMessage(ws: WebSocket, text: String) = onTransportMessage(text)

                override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                    Log.d(tag, "WS onClosing code=$code reason=$reason")
                    ws.close(1000, "")
                }

                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    Log.d(tag, "WS onClosed code=$code reason=$reason")
                    onTransportClosed()
                }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    onTransportFailure(t, response)
                }
            })
    }

    override fun closeTransport() {
        webSocket?.close(1000, "")
        webSocket = null
    }

    override fun cancelTransport() {
        webSocket?.close(1000, "")
        webSocket = null
    }

    /** Send a command via WebSocket (upstream message). WS-specific, not on [StreamingClient]. */
    fun sendCommand(type: String, payload: JsonObject) {
        val ws = webSocket
        if (ws == null || connectionState.value != ConnectionState.CONNECTED) {
            Log.w(tag, "sendCommand skipped: not connected (state=${connectionState.value})")
            return
        }
        val msg = buildJsonObject {
            put("type", type)
            for ((k, v) in payload) put(k, v)
        }.toString()
        ws.send(msg)
    }

    override fun sendMessage(json: String) {
        val ws = webSocket
        if (ws == null || connectionState.value != ConnectionState.CONNECTED) {
            Log.w(tag, "sendMessage skipped: not connected (state=${connectionState.value})")
            return
        }
        val sent = ws.send(json)
        if (!sent) Log.w(tag, "sendMessage: WebSocket buffer full, message dropped")
    }
}

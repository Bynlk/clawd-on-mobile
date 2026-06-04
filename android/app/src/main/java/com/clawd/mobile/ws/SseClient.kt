package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import okhttp3.*
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import android.util.Log
import com.clawd.mobile.util.HttpClientProvider

/** SSE transport implementation. Delegates shared logic to [AbstractStreamingClient]. */
class SseClient(prefsStore: PrefsStore) : AbstractStreamingClient(prefsStore) {

    override val tag = "SseClient"
    override val watchdogTimeoutMs = 30_000L

    private var eventSource: EventSource? = null

    private val sseFactory: EventSource.Factory
        get() {
            val cfg = config ?: return EventSources.createFactory(HttpClientProvider.getClient(ConnectionConfig("", 0, "")))
            return EventSources.createFactory(HttpClientProvider.getStreamingClient(cfg))
        }

    override fun doConnect() {
        val cfg = config ?: return
        doConnectPreamble()
        eventSource?.cancel()

        val url = cfg.sseUrl()
        Log.d(tag, "doConnect → ${cfg.streamUrlMasked()}")

        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", cfg.authHeader())
            .build()

        eventSource = sseFactory.newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                // Content-Type validation: reject non-SSE responses
                val contentType = response.header("Content-Type") ?: ""
                if (!contentType.contains("text/event-stream", ignoreCase = true)) {
                    Log.w(tag, "SSE rejected: Content-Type '$contentType' is not text/event-stream")
                    eventSource.cancel()
                    scheduleReconnect()
                    return
                }
                onTransportOpen(response)
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                onTransportMessage(data)
            }

            override fun onClosed(eventSource: EventSource) = onTransportClosed()

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                onTransportFailure(t, response)
            }
        })
    }

    override fun closeTransport() {
        eventSource?.cancel()
        eventSource = null
    }

    override fun cancelTransport() {
        eventSource?.cancel()
        eventSource = null
    }
}

package com.clawd.mobile.console

import com.clawd.mobile.ws.StreamingClient
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun bootstrapConsoleConnection(
    client: StreamingClient,
    enabled: Boolean,
    deviceId: String,
) {
    val messages = mutableListOf(buildJsonObject {
        put("type", "managed_content_sync_set")
        put("deviceId", deviceId)
        put("enabled", enabled)
    })
    if (enabled) messages += listOf(
        buildJsonObject {
            put("type", "managed_capabilities_request")
            put("deviceId", deviceId)
        },
        buildJsonObject {
            put("type", "managed_sessions_request")
            put("deviceId", deviceId)
        },
    )
    messages.forEach { client.sendMessage(it.toString()) }
}

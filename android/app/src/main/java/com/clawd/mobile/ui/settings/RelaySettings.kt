package com.clawd.mobile.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ws.StreamingClient

/**
 * Relay 设置区域 — AccordionSection 内容。
 * 支持配置远程 relay 服务器地址和 token。
 */
@Composable
fun RelaySettings(
    prefsStore: PrefsStore,
    streamingClient: StreamingClient?,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var relayUrl by remember { mutableStateOf(prefsStore.getRelayUrl()) }
    var relayToken by remember { mutableStateOf(prefsStore.getRelayToken()) }
    var useRelay by remember { mutableStateOf(prefsStore.isRelayEnabled()) }
    var statusText by remember { mutableStateOf("") }
    val colorScheme = MaterialTheme.colorScheme
    var statusColor by remember { mutableStateOf(colorScheme.onSurface) }

    // Pre-compute strings for use in non-@Composable contexts (onClick, Thread)
    val strRelayEnabled = stringResource(R.string.relay_enabled)
    val strRelayDisconnected = stringResource(R.string.relay_disconnected)
    val strRelayEnterAddress = stringResource(R.string.relay_enter_address)
    val strRelayChecking = stringResource(R.string.relay_checking)
    val strRelayRunning = stringResource(R.string.relay_running)
    val strRelayConnectFailed = stringResource(R.string.relay_connect_failed)

    Column(modifier = modifier.padding(vertical = 8.dp)) {
        OutlinedTextField(
            value = relayUrl,
            onValueChange = { relayUrl = it },
            label = { Text(stringResource(R.string.relay_address)) },
            placeholder = { Text("wss://your-vps-ip:7891") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            enabled = !useRelay
        )

        Spacer(modifier = Modifier.height(8.dp))

        OutlinedTextField(
            value = relayToken,
            onValueChange = { relayToken = it },
            label = { Text(stringResource(R.string.relay_token)) },
            placeholder = { Text(stringResource(R.string.relay_token_placeholder)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            enabled = !useRelay
        )

        Spacer(modifier = Modifier.height(12.dp))

        if (statusText.isNotEmpty()) {
            Text(
                text = statusText,
                color = statusColor,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Button(
                onClick = {
                    if (!useRelay) {
                        prefsStore.setRelayUrl(relayUrl.trim())
                        prefsStore.setRelayToken(relayToken.trim())
                        prefsStore.setRelayEnabled(true)
                        useRelay = true
                        statusText = strRelayEnabled
                        statusColor = colorScheme.primary
                    } else {
                        prefsStore.setRelayEnabled(false)
                        useRelay = false
                        statusText = strRelayDisconnected
                        statusColor = colorScheme.onSurface
                    }
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (useRelay) colorScheme.error else colorScheme.primary
                )
            ) {
                Text(if (useRelay) stringResource(R.string.relay_disconnect) else stringResource(R.string.relay_connect))
            }

            OutlinedButton(
                onClick = {
                    val url = relayUrl.trim()
                    val token = relayToken.trim()
                    if (url.isBlank()) {
                        statusText = strRelayEnterAddress
                        statusColor = colorScheme.error
                        return@OutlinedButton
                    }
                    statusText = strRelayChecking
                    statusColor = colorScheme.onSurface
                    Thread {
                        try {
                            val apiUrl = "$url/api/status"
                            val conn = java.net.URL(apiUrl).openConnection() as java.net.HttpURLConnection
                            conn.setRequestProperty("Authorization", "Bearer $token")
                            conn.connectTimeout = 5000
                            conn.readTimeout = 5000
                            val response = conn.inputStream.bufferedReader().readText()
                            conn.disconnect()
                            val pcMatch = Regex("\"pc\":(\\d+)").find(response)
                            val phoneMatch = Regex("\"phone\":(\\d+)").find(response)
                            val pc = pcMatch?.groupValues?.get(1) ?: "0"
                            val phone = phoneMatch?.groupValues?.get(1) ?: "0"
                            statusText = String.format(strRelayRunning, pc, phone)
                            statusColor = colorScheme.primary
                        } catch (e: Exception) {
                            statusText = String.format(strRelayConnectFailed, e.message?.take(30) ?: "")
                            statusColor = colorScheme.error
                        }
                    }.start()
                }
            ) {
                Text(stringResource(R.string.relay_check_status))
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.relay_description),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

package com.clawd.mobile.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
    var relayUrl by remember { mutableStateOf(prefsStore.getRelayUrl()) }
    var relayToken by remember { mutableStateOf(prefsStore.getRelayToken()) }
    var useRelay by remember { mutableStateOf(prefsStore.isRelayEnabled()) }
    var statusText by remember { mutableStateOf("") }
    val colorScheme = MaterialTheme.colorScheme
    var statusColor by remember { mutableStateOf(colorScheme.onSurface) }

    Column(modifier = modifier.padding(vertical = 8.dp)) {
        // Relay URL
        OutlinedTextField(
            value = relayUrl,
            onValueChange = { relayUrl = it },
            label = { Text("Relay 地址") },
            placeholder = { Text("wss://your-vps-ip:7891") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            enabled = !useRelay
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Relay Token
        OutlinedTextField(
            value = relayToken,
            onValueChange = { relayToken = it },
            label = { Text("连接 Token") },
            placeholder = { Text("输入 Connection Token") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            enabled = !useRelay
        )

        Spacer(modifier = Modifier.height(12.dp))

        // 状态显示
        if (statusText.isNotEmpty()) {
            Text(
                text = statusText,
                color = statusColor,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        // 操作按钮行
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // 启用/禁用按钮
            Button(
                onClick = {
                    if (!useRelay) {
                        // 保存配置并启用
                        prefsStore.setRelayUrl(relayUrl.trim())
                        prefsStore.setRelayToken(relayToken.trim())
                        prefsStore.setRelayEnabled(true)
                        useRelay = true
                        statusText = "已启用"
                        statusColor = colorScheme.primary
                    } else {
                        // 禁用
                        prefsStore.setRelayEnabled(false)
                        useRelay = false
                        statusText = "已断开"
                        statusColor = colorScheme.onSurface
                    }
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (useRelay) colorScheme.error else colorScheme.primary
                )
            ) {
                Text(if (useRelay) "断开 Relay" else "连接 Relay")
            }

            // 检查状态按钮
            OutlinedButton(
                onClick = {
                    val url = relayUrl.trim()
                    if (url.isBlank()) {
                        statusText = "请输入 Relay 地址"
                        statusColor = colorScheme.error
                        return@OutlinedButton
                    }
                    statusText = "检查中..."
                    statusColor = colorScheme.onSurface
                    // TODO: 实际检查 relay API 状态
                    statusText = "功能开发中"
                }
            ) {
                Text("检查状态")
            }
        }

        // 说明文字
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "通过远程服务器中继连接，支持非局域网环境。需要在 Linux VPS 上部署 relay 服务器。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

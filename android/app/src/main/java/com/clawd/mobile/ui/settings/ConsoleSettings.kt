package com.clawd.mobile.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ws.StreamingClient
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun ConsoleSettings(
    prefsStore: PrefsStore,
    streamingClient: StreamingClient,
) {
    var enabled by remember { mutableStateOf(prefsStore.isConsoleSyncEnabled()) }
    var confirmEnable by remember { mutableStateOf(false) }

    fun apply(value: Boolean) {
        prefsStore.setConsoleSyncEnabled(value)
        enabled = value
        streamingClient.sendMessage(buildJsonObject {
            put("type", "managed_content_sync_set")
            put("deviceId", prefsStore.getOrCreateConsoleDeviceId())
            put("enabled", value)
        }.toString())
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(stringResource(R.string.console_sync_title), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.console_sync_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = enabled,
                onCheckedChange = { value ->
                    if (value) confirmEnable = true else apply(false)
                },
            )
        }
        Text(
            stringResource(R.string.console_sync_vps_notice),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.error,
        )
    }

    if (confirmEnable) {
        AlertDialog(
            onDismissRequest = { confirmEnable = false },
            title = { Text(stringResource(R.string.console_sync_confirm_title)) },
            text = { Text(stringResource(R.string.console_sync_confirm_body)) },
            confirmButton = {
                TextButton(onClick = { confirmEnable = false; apply(true) }) {
                    Text(stringResource(R.string.console_sync_enable))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmEnable = false }) {
                    Text(stringResource(R.string.sessions_cancel))
                }
            },
        )
    }
}

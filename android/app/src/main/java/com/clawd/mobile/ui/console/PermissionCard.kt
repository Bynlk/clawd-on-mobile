package com.clawd.mobile.ui.console

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.clawd.mobile.R
import com.clawd.mobile.console.ConsoleRecord

@Composable
fun PermissionCard(record: ConsoleRecord, modifier: Modifier = Modifier) {
    val value = record.text ?: record.raw.orEmpty()
    val status = when {
        record.permissionState?.startsWith("suggestion:") == true -> stringResource(R.string.console_permission_allow)
        else -> when (record.permissionState) {
        "pending" -> stringResource(R.string.console_permission_pending)
        "allow" -> stringResource(R.string.console_permission_allow)
        "deny" -> stringResource(R.string.console_permission_deny)
        "timed_out" -> stringResource(R.string.console_permission_timed_out)
        else -> stringResource(R.string.console_permission_resolved)
        }
    }
    Card(modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Text(
                    record.toolName ?: stringResource(R.string.console_permission),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Text(status, style = MaterialTheme.typography.labelMedium)
            }
            if (value.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(value, fontFamily = FontFamily.Monospace)
                ConsoleCopyButton(value)
            }
        }
    }
}

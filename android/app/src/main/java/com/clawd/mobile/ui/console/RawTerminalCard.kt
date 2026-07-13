package com.clawd.mobile.ui.console

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.console.ConsoleRecord
import com.clawd.mobile.R
import androidx.compose.ui.res.stringResource

@Composable
fun RawTerminalCard(record: ConsoleRecord, modifier: Modifier = Modifier) {
    val value = record.text ?: record.raw.orEmpty()
    var expanded by remember { mutableStateOf(value.length <= 2000) }
    val shown = if (expanded) value else value.take(2000) + "…"
    Card(modifier = modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFF11131A))) {
        Column(Modifier.padding(12.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Text(
                    stringResource(R.string.console_terminal_output),
                    color = Color(0xFF9CA3AF),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.weight(1f),
                )
                ConsoleCopyButton(value)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                shown,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = Color(0xFFE5E7EB),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            )
            if (value.length > 2000) TextButton(onClick = { expanded = !expanded }) {
                Text(stringResource(if (expanded) R.string.console_show_less else R.string.console_show_more))
            }
        }
    }
}

package com.clawd.mobile.ui.console

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.clawd.mobile.console.ConsoleRecord
import com.clawd.mobile.R
import androidx.compose.ui.res.stringResource

@Composable
fun ToolCallCard(record: ConsoleRecord, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(record.kind == "tool_result") }
    val value = record.text ?: record.raw.orEmpty()
    Card(modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
                val title = if (record.kind == "tool_call") {
                    stringResource(R.string.console_tool_call)
                } else {
                    stringResource(R.string.console_tool_result)
                }
                Text("${record.toolName ?: title} ${if (expanded) "⌃" else "⌄"}")
            }
            if (expanded) {
                Text(value, fontFamily = FontFamily.Monospace)
                ConsoleCopyButton(value)
            }
        }
    }
}

package com.clawd.mobile.ui.console

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.clawd.mobile.console.ConsoleRecord
import com.clawd.mobile.R
import androidx.compose.ui.res.stringResource

fun parseSimpleMarkdown(value: String): AnnotatedString = buildAnnotatedString {
    val token = Regex("```[^\\n]*\\n[\\s\\S]*?```|\\*\\*.+?\\*\\*|`[^`\\n]+`")
    var cursor = 0
    token.findAll(value).forEach { match ->
        append(value.substring(cursor, match.range.first))
        val raw = match.value
        if (raw.startsWith("```")) {
            val code = raw.substringAfter('\n').removeSuffix("```")
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x2210B981))) {
                append(code)
            }
        } else if (raw.startsWith("**")) {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(raw.removeSurrounding("**")) }
        } else {
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x332563EB))) {
                append(raw.removeSurrounding("`"))
            }
        }
        cursor = match.range.last + 1
    }
    append(value.substring(cursor))
}

@Composable
fun ConsoleMessageCard(record: ConsoleRecord, modifier: Modifier = Modifier) {
    when (record.kind) {
        "diff" -> DiffCard(record, modifier)
        "tool_call", "tool_result" -> ToolCallCard(record, modifier)
        "permission" -> PermissionCard(record, modifier)
        "terminal_delta", "control", "exit" -> RawTerminalCard(record, modifier)
        else -> {
            val user = record.kind == "user_input"
            var expanded by remember { mutableStateOf(record.kind != "thinking") }
            Card(
                modifier = modifier.fillMaxWidth(if (user) 0.84f else 1f),
                colors = CardDefaults.cardColors(
                    containerColor = if (user) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
                ),
            ) {
                Column(Modifier.padding(12.dp)) {
                    if (record.kind == "thinking") {
                        TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
                            Text("${stringResource(R.string.console_thinking)} ${if (expanded) "⌃" else "⌄"}")
                        }
                    }
                    if (expanded) {
                        Text(
                            text = parseSimpleMarkdown(record.text ?: record.raw.orEmpty()),
                            fontFamily = if (record.kind == "code") FontFamily.Monospace else FontFamily.Default,
                        )
                        val value = record.text ?: record.raw.orEmpty()
                        if (record.kind == "code" && value.isNotEmpty()) ConsoleCopyButton(value)
                    }
                }
            }
        }
    }
}

package com.clawd.mobile.ui.console

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
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

enum class DiffLineKind { Added, Deleted, Header, Context }
data class DiffLine(val text: String, val kind: DiffLineKind)
data class DiffFileSection(
    val file: String,
    val text: String,
    val lines: List<DiffLine>,
    val additions: Int,
    val deletions: Int,
)

fun parseDiffLines(text: String): List<DiffLine> = text.lines().map { line ->
    val kind = when {
        line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff --git") -> DiffLineKind.Header
        line.startsWith("+") -> DiffLineKind.Added
        line.startsWith("-") -> DiffLineKind.Deleted
        else -> DiffLineKind.Context
    }
    DiffLine(line, kind)
}

fun parseDiffFiles(text: String): List<DiffFileSection> {
    val lines = text.lines()
    val starts = lines.indices.filter { lines[it].startsWith("diff --git ") }
    val ranges = if (starts.isEmpty()) listOf(0 until lines.size) else starts.mapIndexed { index, start ->
        start until (starts.getOrNull(index + 1) ?: lines.size)
    }
    return ranges.map { range ->
        val sectionLines = range.map(lines::get)
        val file = sectionLines.firstOrNull { it.startsWith("+++ b/") }
            ?.removePrefix("+++ b/")
            ?: sectionLines.firstOrNull()?.substringAfterLast(" b/", "Diff")
            ?: "Diff"
        val sectionText = sectionLines.joinToString("\n")
        DiffFileSection(
            file = file,
            text = sectionText,
            lines = parseDiffLines(sectionText),
            additions = sectionLines.count { it.startsWith("+") && !it.startsWith("+++") },
            deletions = sectionLines.count { it.startsWith("-") && !it.startsWith("---") },
        )
    }
}

@Composable
fun DiffCard(record: ConsoleRecord, modifier: Modifier = Modifier) {
    val value = record.text.orEmpty()
    val sections = remember(value) { parseDiffFiles(value) }
    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(vertical = 10.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                Spacer(Modifier.weight(1f))
                ConsoleCopyButton(value)
            }
            sections.forEach { section -> DiffFileBlock(section) }
        }
    }
}

@Composable
private fun DiffFileBlock(section: DiffFileSection) {
    var expanded by remember(section.text) { mutableStateOf(section.lines.size <= 40) }
    val visible = if (expanded) section.lines else section.lines.take(30)
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
            Text(section.file, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            Text("+${section.additions}", color = Color(0xFF4ADE80))
            Spacer(Modifier.width(8.dp))
            Text("-${section.deletions}", color = Color(0xFFF87171))
        }
        Spacer(Modifier.height(8.dp))
        Column(modifier = Modifier.horizontalScroll(rememberScrollState())) {
            visible.forEach { line ->
                val background = when (line.kind) {
                    DiffLineKind.Added -> Color(0x3322C55E)
                    DiffLineKind.Deleted -> Color(0x33EF4444)
                    DiffLineKind.Header -> Color(0x332563EB)
                    DiffLineKind.Context -> Color.Transparent
                }
                Text(
                    text = line.text.ifEmpty { " " },
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.fillMaxWidth().background(background)
                        .padding(horizontal = 12.dp, vertical = 1.dp),
                )
            }
        }
        if (section.lines.size > 30) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.padding(start = 4.dp)) {
                Text(stringResource(if (expanded) R.string.console_show_less else R.string.console_show_more))
            }
        }
    }
}

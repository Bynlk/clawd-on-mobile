package com.clawd.mobile.ui.console

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.*
import org.junit.Test
import com.clawd.mobile.console.ConsoleRecord

class ConsoleFormattingTest {
    @Test
    fun `markdown parser preserves text and styles bold and code`() {
        val parsed = parseSimpleMarkdown("Use **care** with `rm -rf`")
        assertEquals("Use care with rm -rf", parsed.text)
        assertTrue(parsed.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertTrue(parsed.spanStyles.any { it.item.fontFamily == FontFamily.Monospace })
    }

    @Test
    fun `markdown parser renders fenced code without fence markers`() {
        val parsed = parseSimpleMarkdown("Before\n```kotlin\nval answer = 42\n```\nAfter")

        assertEquals("Before\nval answer = 42\n\nAfter", parsed.text)
        assertTrue(parsed.spanStyles.any {
            it.item.fontFamily == FontFamily.Monospace &&
                parsed.text.substring(it.start, it.end).contains("val answer")
        })
    }

    @Test
    fun `diff parser distinguishes headers additions deletions and context`() {
        val lines = parseDiffLines("@@ -1 +1 @@\n-old\n+new\n same")
        assertEquals(DiffLineKind.Header, lines[0].kind)
        assertEquals(DiffLineKind.Deleted, lines[1].kind)
        assertEquals(DiffLineKind.Added, lines[2].kind)
        assertEquals(DiffLineKind.Context, lines[3].kind)
    }

    @Test
    fun `resolved permission updates earlier pending card state`() {
        val records = listOf(
            ConsoleRecord("s1", 1, "permission", permissionId = "p1", permissionState = "pending"),
            ConsoleRecord("s1", 2, "permission", permissionId = "p1", permissionState = "allow"),
        )

        val resolved = resolvePermissionCardStates(records)

        assertEquals("allow", resolved[0].permissionState)
        assertEquals("allow", resolved[1].permissionState)
    }

    @Test
    fun `multi file diff is split with per file statistics`() {
        val sections = parseDiffFiles(
            """diff --git a/a.kt b/a.kt
--- a/a.kt
+++ b/a.kt
@@ -1 +1 @@
-old
+new
diff --git a/b.kt b/b.kt
--- a/b.kt
+++ b/b.kt
@@ -0,0 +1 @@
+added"""
        )

        assertEquals(listOf("a.kt", "b.kt"), sections.map { it.file })
        assertEquals(1, sections[0].additions)
        assertEquals(1, sections[0].deletions)
        assertEquals(1, sections[1].additions)
        assertEquals(0, sections[1].deletions)
    }
}

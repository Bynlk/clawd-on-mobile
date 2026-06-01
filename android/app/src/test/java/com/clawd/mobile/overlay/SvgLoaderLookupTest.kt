package com.clawd.mobile.overlay

import org.junit.Test
import org.junit.Assert.*

/**
 * Tests for SvgLoader lookup tables and data integrity.
 * Verifies all characters have complete state mappings and tier configurations.
 */
class SvgLoaderLookupTest {

    private val allStates = listOf(
        "idle", "yawning", "dozing", "collapsing", "thinking",
        "working", "juggling", "sweeping", "error", "attention",
        "notification", "carrying", "sleeping", "waking",
        "conducting", "debugger"
    )

    private val characters = listOf("clawd", "cloudling", "calico")

    // ── All states resolve for all characters ────────────────────────

    @Test
    fun `all 16 states resolve for clawd`() {
        for (state in allStates) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "clawd")
            assertNotNull("clawd should resolve state '$state'", result)
            assertTrue("clawd path should start with svg/clawd/", result!!.startsWith("svg/clawd/"))
        }
    }

    @Test
    fun `all 16 states resolve for cloudling`() {
        for (state in allStates) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "cloudling")
            assertNotNull("cloudling should resolve state '$state'", result)
            assertTrue("cloudling path should start with svg/cloudling/", result!!.startsWith("svg/cloudling/"))
        }
    }

    @Test
    fun `all 16 states resolve for calico`() {
        for (state in allStates) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "calico")
            assertNotNull("calico should resolve state '$state'", result)
            assertTrue("calico path should start with svg/calico/", result!!.startsWith("svg/calico/"))
        }
    }

    // ── Working tiers ────────────────────────────────────────────────

    @Test
    fun `clawd working tier 1 returns typing`() {
        val result = SvgLoader.resolveSvgAsset("working", 1, "clawd")
        assertTrue(result!!.contains("typing"))
    }

    @Test
    fun `clawd working tier 2 returns groove`() {
        val result = SvgLoader.resolveSvgAsset("working", 2, "clawd")
        assertTrue(result!!.contains("groove"))
    }

    @Test
    fun `clawd working tier 3 returns building`() {
        val result = SvgLoader.resolveSvgAsset("working", 3, "clawd")
        assertTrue(result!!.contains("building"))
    }

    @Test
    fun `cloudling working tier 1 returns typing`() {
        val result = SvgLoader.resolveSvgAsset("working", 1, "cloudling")
        assertTrue(result!!.contains("typing"))
    }

    @Test
    fun `cloudling working tier 3 returns building`() {
        val result = SvgLoader.resolveSvgAsset("working", 3, "cloudling")
        assertTrue(result!!.contains("building"))
    }

    @Test
    fun `calico working tier 1 returns typing apng`() {
        val result = SvgLoader.resolveSvgAsset("working", 1, "calico")
        assertTrue(result!!.contains("typing"))
        assertTrue(result.endsWith(".apng"))
    }

    // ── Juggling tiers ───────────────────────────────────────────────

    @Test
    fun `clawd juggling tier 1 returns groove`() {
        val result = SvgLoader.resolveSvgAsset("juggling", 1, "clawd")
        assertTrue(result!!.contains("groove"))
    }

    @Test
    fun `clawd juggling tier 2 returns juggling`() {
        val result = SvgLoader.resolveSvgAsset("juggling", 2, "clawd")
        assertTrue(result!!.contains("juggling"))
    }

    // ── File extensions ──────────────────────────────────────────────

    @Test
    fun `clawd files are SVG`() {
        for (state in allStates) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "clawd")
            assertTrue("clawd '$state' should be .svg", result!!.endsWith(".svg"))
        }
    }

    @Test
    fun `cloudling files are SVG`() {
        for (state in allStates) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "cloudling")
            assertTrue("cloudling '$state' should be .svg", result!!.endsWith(".svg"))
        }
    }

    @Test
    fun `calico idle is SVG`() {
        val result = SvgLoader.resolveSvgAsset("idle", 1, "calico")
        assertTrue(result!!.endsWith(".svg"))
    }

    @Test
    fun `calico non-idle files are APNG`() {
        // debugger has no calico-specific file, falls back to clawd .svg
        val apngStates = allStates.filter { it != "idle" && it != "debugger" }
        for (state in apngStates) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "calico")
            assertTrue("calico '$state' should be .apng", result!!.endsWith(".apng"))
        }
    }

    // ── pickIdleAnimation ────────────────────────────────────────────

    @Test
    fun `clawd has idle animations`() {
        val result = SvgLoader.pickIdleAnimation("clawd")
        assertNotNull(result)
        assertTrue(result!!.startsWith("svg/clawd/"))
    }

    @Test
    fun `cloudling has idle animations`() {
        val result = SvgLoader.pickIdleAnimation("cloudling")
        assertNotNull(result)
        assertTrue(result!!.startsWith("svg/cloudling/"))
    }

    @Test
    fun `calico has idle animations`() {
        val result = SvgLoader.pickIdleAnimation("calico")
        assertNotNull(result)
        assertTrue(result!!.startsWith("svg/calico/"))
    }

    @Test
    fun `unknown character returns null for idle animation`() {
        assertNull(SvgLoader.pickIdleAnimation("unknown"))
    }

    // ── getViewBox ───────────────────────────────────────────────────

    @Test
    fun `clawd viewBox is 45x45`() {
        val vb = SvgLoader.getViewBox("clawd")
        assertEquals(45, vb.width)
        assertEquals(45, vb.height)
    }

    @Test
    fun `cloudling viewBox is 88x72`() {
        val vb = SvgLoader.getViewBox("cloudling")
        assertEquals(88, vb.width)
        assertEquals(72, vb.height)
    }

    @Test
    fun `calico viewBox is 266x200`() {
        val vb = SvgLoader.getViewBox("calico")
        assertEquals(266, vb.width)
        assertEquals(200, vb.height)
    }

    @Test
    fun `unknown character falls back to clawd viewBox`() {
        val vb = SvgLoader.getViewBox("unknown")
        assertEquals(45, vb.width)
        assertEquals(45, vb.height)
    }

    // ── PetState overload ────────────────────────────────────────────

    @Test
    fun `resolveSvgAsset with PetState object works`() {
        for (state in PetState.ALL) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "clawd")
            assertNotNull("PetState.${state.themeKey} should resolve", result)
        }
    }

    // ── Edge cases ───────────────────────────────────────────────────

    @Test
    fun `unknown character falls back to clawd mapping`() {
        val result = SvgLoader.resolveSvgAsset("idle", 1, "nonexistent")
        assertNotNull(result)
        // Should use clawd's idle file name
        assertTrue(result!!.contains("clawd"))
    }

    @Test
    fun `0 sessions falls through to direct lookup for working`() {
        val result = SvgLoader.resolveSvgAsset("working", 0, "clawd")
        assertNotNull(result)
        assertTrue(result!!.contains("typing"))
    }

    @Test
    fun `0 sessions falls through to direct lookup for juggling`() {
        val result = SvgLoader.resolveSvgAsset("juggling", 0, "clawd")
        assertNotNull(result)
    }

    @Test
    fun `large session count uses highest tier`() {
        val result = SvgLoader.resolveSvgAsset("working", 100, "clawd")
        assertTrue(result!!.contains("building"))
    }
}

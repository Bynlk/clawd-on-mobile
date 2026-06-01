package com.clawd.mobile.overlay

import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for SvgLoader pure logic.
 *
 * When appContext is null (not initialized), assetExists() returns true,
 * so resolveSvgAsset() returns the first candidate. This lets us test
 * the resolution logic without Android framework.
 */
class SvgLoaderTest {

    // ── resolveSvgAsset: direct state lookup ───────────────────────────

    @Test
    fun `resolveSvgAsset returns clawd idle for idle state`() {
        val result = SvgLoader.resolveSvgAsset("idle", 0, "clawd")
        assertEquals("svg/clawd/clawd-idle-follow.svg", result)
    }

    @Test
    fun `resolveSvgAsset returns clawd working for working state with 0 sessions`() {
        // With 0 sessions, no tier matches (minSessions >= 1), falls through to direct lookup
        val result = SvgLoader.resolveSvgAsset("working", 0, "clawd")
        assertEquals("svg/clawd/clawd-working-typing.svg", result)
    }

    @Test
    fun `resolveSvgAsset returns clawd error for error state`() {
        val result = SvgLoader.resolveSvgAsset("error", 0, "clawd")
        assertEquals("svg/clawd/clawd-error.svg", result)
    }

    @Test
    fun `resolveSvgAsset returns clawd thinking for thinking state`() {
        val result = SvgLoader.resolveSvgAsset("thinking", 0, "clawd")
        assertEquals("svg/clawd/clawd-working-thinking.svg", result)
    }

    @Test
    fun `resolveSvgAsset returns clawd sleeping for sleeping state`() {
        val result = SvgLoader.resolveSvgAsset("sleeping", 0, "clawd")
        assertEquals("svg/clawd/clawd-sleeping.svg", result)
    }

    // ── resolveSvgAsset: working tier logic ────────────────────────────

    @Test
    fun `working tier 1 session returns typing`() {
        val result = SvgLoader.resolveSvgAsset("working", 1, "clawd")
        assertEquals("svg/clawd/clawd-working-typing.svg", result)
    }

    @Test
    fun `working tier 2 sessions returns groove`() {
        val result = SvgLoader.resolveSvgAsset("working", 2, "clawd")
        assertEquals("svg/clawd/clawd-headphones-groove.svg", result)
    }

    @Test
    fun `working tier 3 sessions returns building`() {
        val result = SvgLoader.resolveSvgAsset("working", 3, "clawd")
        assertEquals("svg/clawd/clawd-working-building.svg", result)
    }

    @Test
    fun `working tier 5 sessions returns building (highest tier)`() {
        val result = SvgLoader.resolveSvgAsset("working", 5, "clawd")
        assertEquals("svg/clawd/clawd-working-building.svg", result)
    }

    // ── resolveSvgAsset: juggling tier logic ───────────────────────────

    @Test
    fun `juggling tier 1 session returns groove`() {
        val result = SvgLoader.resolveSvgAsset("juggling", 1, "clawd")
        assertEquals("svg/clawd/clawd-headphones-groove.svg", result)
    }

    @Test
    fun `juggling tier 2 sessions returns juggling`() {
        val result = SvgLoader.resolveSvgAsset("juggling", 2, "clawd")
        assertEquals("svg/clawd/clawd-working-juggling.svg", result)
    }

    // ── resolveSvgAsset: cloudling character ───────────────────────────

    @Test
    fun `cloudling idle returns cloudling idle`() {
        val result = SvgLoader.resolveSvgAsset("idle", 0, "cloudling")
        assertEquals("svg/cloudling/cloudling-idle.svg", result)
    }

    @Test
    fun `cloudling working tier 1 returns typing`() {
        val result = SvgLoader.resolveSvgAsset("working", 1, "cloudling")
        assertEquals("svg/cloudling/cloudling-typing.svg", result)
    }

    @Test
    fun `cloudling working tier 3 returns building`() {
        val result = SvgLoader.resolveSvgAsset("working", 3, "cloudling")
        assertEquals("svg/cloudling/cloudling-building.svg", result)
    }

    // ── resolveSvgAsset: calico character ──────────────────────────────

    @Test
    fun `calico idle returns calico idle`() {
        val result = SvgLoader.resolveSvgAsset("idle", 0, "calico")
        assertEquals("svg/calico/calico-idle-follow.svg", result)
    }

    @Test
    fun `calico working tier 1 returns typing apng`() {
        val result = SvgLoader.resolveSvgAsset("working", 1, "calico")
        assertEquals("svg/calico/calico-working-typing.apng", result)
    }

    // ── resolveSvgAsset: PetState overload ─────────────────────────────

    @Test
    fun `resolveSvgAsset with PetState object`() {
        val result = SvgLoader.resolveSvgAsset(PetState.Error, 0, "clawd")
        assertEquals("svg/clawd/clawd-error.svg", result)
    }

    @Test
    fun `resolveSvgAsset with PetState Working applies tier`() {
        val result = SvgLoader.resolveSvgAsset(PetState.Working, 3, "clawd")
        assertEquals("svg/clawd/clawd-working-building.svg", result)
    }

    // ── resolveSvgAsset: unknown character falls back to clawd ─────────

    @Test
    fun `unknown character falls back to clawd`() {
        val result = SvgLoader.resolveSvgAsset("idle", 0, "unknown")
        assertEquals("svg/unknown/clawd-idle-follow.svg", result)
    }

    // ── resolveSvgAsset: all clawd states have mappings ────────────────

    @Test
    fun `all 16 clawd states resolve to non-null paths`() {
        val states = listOf(
            "idle", "yawning", "dozing", "collapsing", "thinking",
            "working", "juggling", "sweeping", "error", "attention",
            "notification", "carrying", "sleeping", "waking",
            "conducting", "debugger"
        )
        for (state in states) {
            val result = SvgLoader.resolveSvgAsset(state, 1, "clawd")
            assertNotNull("State '$state' should resolve to a path", result)
            assertTrue("Path should start with svg/clawd/", result!!.startsWith("svg/clawd/"))
        }
    }

    // ── pickIdleAnimation ──────────────────────────────────────────────

    @Test
    fun `pickIdleAnimation returns clawd variant`() {
        val result = SvgLoader.pickIdleAnimation("clawd")
        assertNotNull(result)
        assertTrue(result!!.startsWith("svg/clawd/"))
        assertTrue(result.endsWith(".svg"))
    }

    @Test
    fun `pickIdleAnimation returns cloudling variant`() {
        val result = SvgLoader.pickIdleAnimation("cloudling")
        assertNotNull(result)
        assertTrue(result!!.startsWith("svg/cloudling/"))
    }

    @Test
    fun `pickIdleAnimation returns null for unknown character`() {
        val result = SvgLoader.pickIdleAnimation("unknown")
        assertNull(result)
    }

    // ── getViewBox ─────────────────────────────────────────────────────

    @Test
    fun `getViewBox returns correct dimensions for clawd`() {
        val vb = SvgLoader.getViewBox("clawd")
        assertEquals(45, vb.width)
        assertEquals(45, vb.height)
    }

    @Test
    fun `getViewBox returns correct dimensions for cloudling`() {
        val vb = SvgLoader.getViewBox("cloudling")
        assertEquals(88, vb.width)
        assertEquals(72, vb.height)
    }

    @Test
    fun `getViewBox returns correct dimensions for calico`() {
        val vb = SvgLoader.getViewBox("calico")
        assertEquals(266, vb.width)
        assertEquals(200, vb.height)
    }

    @Test
    fun `getViewBox falls back to clawd for unknown character`() {
        val vb = SvgLoader.getViewBox("unknown")
        assertEquals(45, vb.width)
        assertEquals(45, vb.height)
    }

    // ── hasSvgForState ─────────────────────────────────────────────────

    @Test
    fun `hasSvgForState returns true for mapped clawd states`() {
        // When not initialized, assetExists returns true
        assertTrue(SvgLoader.hasSvgForState(PetState.Idle, "clawd"))
        assertTrue(SvgLoader.hasSvgForState(PetState.Error, "clawd"))
        assertTrue(SvgLoader.hasSvgForState(PetState.Working, "clawd"))
    }

    @Test
    fun `hasSvgForState returns false for unknown character`() {
        assertFalse(SvgLoader.hasSvgForState(PetState.Idle, "unknown"))
    }
}

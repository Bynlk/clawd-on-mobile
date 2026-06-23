package com.clawd.mobile.ws

import com.clawd.mobile.data.SessionData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [SessionMerger].
 *
 * Covers: initial state, register/unregister, multi-tag merge,
 * same-session across tags, getSessionsByTag, clear, and
 * re-registration replacing old collector.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionMergerTest {

    private lateinit var scope: CoroutineScope
    private lateinit var merger: SessionMerger

    @Before
    fun setUp() {
        scope = CoroutineScope(UnconfinedTestDispatcher())
        merger = SessionMerger(scope)
    }

    // ── Helper ──────────────────────────────────────────────────────────

    private fun session(
        sessionId: String,
        state: String = "idle",
        badge: String = "idle"
    ) = SessionData(
        sessionId = sessionId,
        state = state,
        badge = badge
    )

    // ── 1. Initial state is empty ───────────────────────────────────────

    @Test
    fun `initial state is empty`() = runTest {
        assertTrue(merger.mergedSessions.value.isEmpty())
        assertTrue(merger.getSessionsByTag(ConnectionTag.LAN).isEmpty())
        assertTrue(merger.getSessionsByTag(ConnectionTag.RELAY).isEmpty())
    }

    // ── 2. register merges sessions into mergedSessions ─────────────────

    @Test
    fun `register LAN merges sessions into mergedSessions`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
        merger.register(ConnectionTag.LAN, lanSessions)

        lanSessions.value = mapOf(
            "s1" to session("s1", state = "working"),
            "s2" to session("s2", state = "idle")
        )

        val merged = merger.mergedSessions.value
        assertEquals(2, merged.size)
        assertTrue(merged.containsKey("s1"))
        assertTrue(merged.containsKey("s2"))
        assertEquals(ConnectionTag.LAN, merged["s1"]?.first()?.tag)
    }

    // ── 3. Multiple tags merge ──────────────────────────────────────────

    @Test
    fun `multiple tags LAN and RELAY merge into unified view`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
        val relaySessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())

        merger.register(ConnectionTag.LAN, lanSessions)
        merger.register(ConnectionTag.RELAY, relaySessions)

        lanSessions.value = mapOf("s1" to session("s1"))
        relaySessions.value = mapOf("s2" to session("s2"))

        val merged = merger.mergedSessions.value
        assertEquals(2, merged.size)
        assertEquals(ConnectionTag.LAN, merged["s1"]?.first()?.tag)
        assertEquals(ConnectionTag.RELAY, merged["s2"]?.first()?.tag)
    }

    // ── 4. unregister removes sessions ──────────────────────────────────

    @Test
    fun `unregister LAN removes LAN sessions from merged view`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())
        merger.register(ConnectionTag.LAN, lanSessions)
        lanSessions.value = mapOf("s1" to session("s1"))

        merger.unregister(ConnectionTag.LAN)

        assertTrue(merger.mergedSessions.value.isEmpty())
    }

    // ── 5. register same tag replaces old collector ─────────────────────

    @Test
    fun `register same tag replaces old collector`() = runTest {
        val flow1 = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1")))
        val flow2 = MutableStateFlow<Map<String, SessionData>>(mapOf("s2" to session("s2")))

        merger.register(ConnectionTag.LAN, flow1)
        assertEquals(1, merger.mergedSessions.value.size)

        // Re-register same tag with new flow
        merger.register(ConnectionTag.LAN, flow2)
        val merged = merger.mergedSessions.value
        assertTrue(merged.containsKey("s2"))
        assertFalse(merged.containsKey("s1"))
    }

    // ── 6. getSessionsByTag ─────────────────────────────────────────────

    @Test
    fun `getSessionsByTag returns correct sessions per tag`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1")))
        val relaySessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s2" to session("s2")))

        merger.register(ConnectionTag.LAN, lanSessions)
        merger.register(ConnectionTag.RELAY, relaySessions)

        val lan = merger.getSessionsByTag(ConnectionTag.LAN)
        val relay = merger.getSessionsByTag(ConnectionTag.RELAY)

        assertEquals(1, lan.size)
        assertEquals(1, relay.size)
        assertTrue(lan.containsKey("s1"))
        assertTrue(relay.containsKey("s2"))
    }

    // ── 7. clear removes all ────────────────────────────────────────────

    @Test
    fun `clear removes all sessions and resets mergedSessions`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1")))
        merger.register(ConnectionTag.LAN, lanSessions)

        merger.clear()

        assertTrue(merger.mergedSessions.value.isEmpty())
        assertTrue(merger.getSessionsByTag(ConnectionTag.LAN).isEmpty())
    }

    // ── 8. Same sessionId under multiple tags ───────────────────────────

    @Test
    fun `same sessionId under LAN and RELAY appears as separate tagged entries`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1", state = "working")))
        val relaySessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1", state = "idle")))

        merger.register(ConnectionTag.LAN, lanSessions)
        merger.register(ConnectionTag.RELAY, relaySessions)

        val merged = merger.mergedSessions.value
        assertEquals(1, merged.size) // same sessionId
        assertEquals(2, merged["s1"]?.size) // two tagged entries
        val tags = merged["s1"]?.map { it.tag }?.toSet()
        assertTrue(tags?.contains(ConnectionTag.LAN) == true)
        assertTrue(tags?.contains(ConnectionTag.RELAY) == true)
    }

    // ── 9. Removing session from source removes from merged ─────────────

    @Test
    fun `removing session from source flow removes it from merged`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(
            mapOf("s1" to session("s1"), "s2" to session("s2"))
        )
        merger.register(ConnectionTag.LAN, lanSessions)
        assertEquals(2, merger.mergedSessions.value.size)

        // Remove s1 from source
        lanSessions.value = mapOf("s2" to session("s2"))
        assertEquals(1, merger.mergedSessions.value.size)
        assertFalse(merger.mergedSessions.value.containsKey("s1"))
    }

    // ── 10. unregister RELAY doesn't affect LAN ─────────────────────────

    @Test
    fun `unregister RELAY does not affect LAN sessions`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1")))
        val relaySessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s2" to session("s2")))

        merger.register(ConnectionTag.LAN, lanSessions)
        merger.register(ConnectionTag.RELAY, relaySessions)

        merger.unregister(ConnectionTag.RELAY)

        assertEquals(1, merger.mergedSessions.value.size)
        assertTrue(merger.mergedSessions.value.containsKey("s1"))
        assertFalse(merger.mergedSessions.value.containsKey("s2"))
    }

    // ── 11. clear then register works ───────────────────────────────────

    @Test
    fun `clear then register works normally`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1")))
        merger.register(ConnectionTag.LAN, lanSessions)
        merger.clear()

        val newSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s3" to session("s3")))
        merger.register(ConnectionTag.LAN, newSessions)

        assertEquals(1, merger.mergedSessions.value.size)
        assertTrue(merger.mergedSessions.value.containsKey("s3"))
    }

    // ── 12. Empty emission cleans up ────────────────────────────────────

    @Test
    fun `emitting empty map from source removes that tag sessions`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1")))
        merger.register(ConnectionTag.LAN, lanSessions)
        assertEquals(1, merger.mergedSessions.value.size)

        lanSessions.value = emptyMap()
        assertTrue(merger.mergedSessions.value.isEmpty())
    }

    // ── 13. getSessionsByTag for unregistered tag ────────────────────────

    @Test
    fun `getSessionsByTag for unregistered tag returns empty`() = runTest {
        assertTrue(merger.getSessionsByTag(ConnectionTag.RELAY).isEmpty())
    }

    // ── 14. unregister never-registered tag ──────────────────────────────

    @Test
    fun `unregister on never-registered tag does not throw`() = runTest {
        merger.unregister(ConnectionTag.RELAY) // should not throw
    }

    // ── 15. State update propagation ─────────────────────────────────────

    @Test
    fun `updating session state in source propagates to merged`() = runTest {
        val lanSessions = MutableStateFlow<Map<String, SessionData>>(mapOf("s1" to session("s1", state = "idle")))
        merger.register(ConnectionTag.LAN, lanSessions)

        assertEquals("idle", merger.mergedSessions.value["s1"]?.first()?.session?.state)

        lanSessions.value = mapOf("s1" to session("s1", state = "working"))
        assertEquals("working", merger.mergedSessions.value["s1"]?.first()?.session?.state)
    }
}

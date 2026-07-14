package com.clawd.mobile.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import io.mockk.*
import java.util.Base64
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [PrefsStore].
 *
 * Mocks [EncryptedSharedPreferences.create] to return an in-memory
 * [SharedPreferences] implementation, avoiding Android Keystore dependencies.
 */
class PrefsStoreTest {

    private lateinit var inMemoryPrefs: MutableMap<String, Any?>
    private lateinit var fakePrefs: StagingSharedPreferences
    private lateinit var context: Context

    private class SimulatedProcessCrash : Error("simulated process crash")

    private class StagingSharedPreferences(
        val durableValues: MutableMap<String, Any?> = mutableMapOf(),
    ) : SharedPreferences {
        val memoryValues: MutableMap<String, Any?> = durableValues.toMutableMap()
        data class CommitBehavior(
            val result: Boolean,
            val failureAfterPersist: Throwable? = null,
        )

        private object Removed
        private val commitBehaviors = ArrayDeque<CommitBehavior>()
        var stringReader: ((String, String?) -> String?)? = null

        fun enqueueCommit(vararg behaviors: CommitBehavior) {
            commitBehaviors.addAll(behaviors)
        }

        fun storedString(key: String, defaultValue: String? = null): String? =
            memoryValues[key] as? String ?: defaultValue

        fun simulateProcessRestart() {
            memoryValues.clear()
            memoryValues.putAll(durableValues)
            stringReader = null
        }

        fun putMemoryAndDisk(key: String, value: Any?) {
            if (value == null) {
                memoryValues.remove(key)
                durableValues.remove(key)
            } else {
                memoryValues[key] = value
                durableValues[key] = value
            }
        }

        fun clearMemoryAndDisk() {
            memoryValues.clear()
            durableValues.clear()
        }

        override fun getAll(): MutableMap<String, *> =
            memoryValues.filterValues { it != null }.toMutableMap()

        override fun getString(key: String, defValue: String?): String? =
            stringReader?.invoke(key, defValue) ?: storedString(key, defValue)

        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
            @Suppress("UNCHECKED_CAST")
            ((memoryValues[key] as? Set<String>)?.toMutableSet() ?: defValues)

        override fun getInt(key: String, defValue: Int): Int =
            memoryValues[key] as? Int ?: defValue

        override fun getLong(key: String, defValue: Long): Long =
            memoryValues[key] as? Long ?: defValue

        override fun getFloat(key: String, defValue: Float): Float =
            memoryValues[key] as? Float ?: defValue

        override fun getBoolean(key: String, defValue: Boolean): Boolean =
            memoryValues[key] as? Boolean ?: defValue

        override fun contains(key: String): Boolean = memoryValues.containsKey(key)

        override fun edit(): SharedPreferences.Editor = StagingEditor()

        override fun registerOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?,
        ) = Unit

        override fun unregisterOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?,
        ) = Unit

        private inner class StagingEditor : SharedPreferences.Editor {
            private val staged = linkedMapOf<String, Any?>()
            private var clearRequested = false

            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply {
                staged[key] = value ?: Removed
            }

            override fun putStringSet(
                key: String,
                values: MutableSet<String>?,
            ): SharedPreferences.Editor = apply {
                staged[key] = values?.toSet() ?: Removed
            }

            override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply {
                staged[key] = value
            }

            override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply {
                staged[key] = value
            }

            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply {
                staged[key] = value
            }

            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply {
                staged[key] = value
            }

            override fun remove(key: String): SharedPreferences.Editor = apply {
                staged[key] = Removed
            }

            override fun clear(): SharedPreferences.Editor = apply {
                clearRequested = true
            }

            override fun commit(): Boolean {
                val behavior = if (commitBehaviors.isEmpty()) {
                    CommitBehavior(result = true)
                } else {
                    commitBehaviors.removeFirst()
                }
                persistStaged(memoryValues)
                // SharedPreferences.commit() returns true only when values were
                // successfully written to persistent storage. A false result may
                // still leave this process's memory map updated, but not disk.
                if (behavior.result) persistStaged(durableValues)
                behavior.failureAfterPersist?.let { throw it }
                return behavior.result
            }

            override fun apply() {
                persistStaged(memoryValues)
                persistStaged(durableValues)
            }

            private fun persistStaged(target: MutableMap<String, Any?>) {
                if (clearRequested) target.clear()
                staged.forEach { (key, value) ->
                    if (value === Removed) target.remove(key)
                    else target[key] = value
                }
            }
        }
    }

    @Before
    fun setUp() {
        PrefsStore.resetForTesting()

        fakePrefs = StagingSharedPreferences()
        inMemoryPrefs = fakePrefs.memoryValues

        // Mock context
        context = mockk(relaxed = true)
        every { context.applicationContext } returns context

        // Mock legacy prefs (empty by default)
        val legacyPrefs = mockk<SharedPreferences>(relaxed = true)
        every { legacyPrefs.all } returns emptyMap()
        every { legacyPrefs.edit() } returns mockk(relaxed = true) {
            every { clear() } returns this
            every { apply() } just Runs
        }
        every { context.getSharedPreferences("clawd_prefs", Context.MODE_PRIVATE) } returns legacyPrefs

        // Mock MasterKey
        mockkConstructor(MasterKey.Builder::class)
        every { anyConstructed<MasterKey.Builder>().setKeyScheme(any()) } returns mockk(relaxed = true)
        every { anyConstructed<MasterKey.Builder>().build() } returns mockk(relaxed = true)

        // Mock EncryptedSharedPreferences.create
        mockkStatic(EncryptedSharedPreferences::class)
        every {
            EncryptedSharedPreferences.create(any(), any(), any<MasterKey>(), any(), any())
        } returns fakePrefs
    }

    @After
    fun tearDown() {
        PrefsStore.resetForTesting()
        unmockkAll()
    }

    private fun createPrefsStore(): PrefsStore {
        return PrefsStore.getInstance(context)
    }

    private fun restartPrefsStore(): PrefsStore {
        PrefsStore.resetForTesting()
        fakePrefs.simulateProcessRestart()
        return createPrefsStore()
    }

    private fun relayPairing(name: String = "Stored fixture", tokenByte: String = "ab"): RelayPairingConfig {
        val privateKey = Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
        val publicKey = Base64.getEncoder().encodeToString(ByteArray(32) { 8 })
        val payload = """{"version":1,"name":"$name","wireGuard":{"privateKey":"$privateKey","address":"10.8.0.3/32","serverPublicKey":"$publicKey","endpoint":"192.0.2.7:51820","allowedIps":["10.8.0.0/24"],"persistentKeepalive":25},"relay":{"url":"ws://10.8.0.1:7891","token":"${tokenByte.repeat(32)}"},"issuedAt":1783900800000}"""
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray())
        return RelayPairingConfig.parse("clawd://relay-pair?v=1&data=$encoded")
    }

    @Test
    fun `failed commit updates process memory but not durable storage`() {
        fakePrefs.enqueueCommit(StagingSharedPreferences.CommitBehavior(result = false))

        assertFalse(fakePrefs.edit().putString("probe", "memory-only").commit())
        assertEquals("memory-only", fakePrefs.getString("probe", null))
        assertFalse(fakePrefs.durableValues.containsKey("probe"))

        fakePrefs.simulateProcessRestart()
        assertNull(fakePrefs.getString("probe", null))
    }

    @Test
    fun `console content sync defaults off and persists opt in`() {
        val store = createPrefsStore()
        assertFalse(store.isConsoleSyncEnabled())
        store.setConsoleSyncEnabled(true)
        assertTrue(store.isConsoleSyncEnabled())
    }

    @Test
    fun `console device id is stable`() {
        val store = createPrefsStore()
        val first = store.getOrCreateConsoleDeviceId()
        val second = store.getOrCreateConsoleDeviceId()
        assertTrue(first.isNotBlank())
        assertEquals(first, second)
    }

    // ── 1. saveConfig + loadConfig round-trip ───────────────────────────

    @Test
    fun `saveConfig and loadConfig round-trip`() {
        val store = createPrefsStore()
        val config = ConnectionConfig("192.168.1.100", 8080, "abcdef1234567890")

        store.saveConfig(config)
        val loaded = store.loadConfig()

        assertNotNull(loaded)
        assertEquals("192.168.1.100", loaded!!.host)
        assertEquals(8080, loaded.port)
        assertEquals("abcdef1234567890", loaded.token)
    }

    @Test
    fun `loadConfig returns null when no config saved`() {
        val store = createPrefsStore()
        assertNull(store.loadConfig())
    }

    @Test
    fun `clearConfig removes saved config`() {
        val store = createPrefsStore()
        store.saveConfig(ConnectionConfig("host", 80, "token"))
        store.clearConfig()
        assertNull(store.loadConfig())
    }

    // ── 2. addToHistory deduplication and 5-item limit ──────────────────

    @Test
    fun `saveConfig adds to history`() {
        val store = createPrefsStore()
        store.saveConfig(ConnectionConfig("host1", 80, "t1"))

        val history = store.getHistory()
        assertEquals(1, history.size)
        assertEquals("host1", history[0].host)
    }

    @Test
    fun `saveConfig deduplicates by host and port`() {
        val store = createPrefsStore()
        store.saveConfig(ConnectionConfig("host1", 80, "t1"))
        store.saveConfig(ConnectionConfig("host1", 80, "t2")) // same host:port

        val history = store.getHistory()
        assertEquals(1, history.size)
        assertEquals("t2", history[0].token) // updated token
    }

    @Test
    fun `history is capped at 5 entries`() {
        val store = createPrefsStore()
        for (i in 1..7) {
            store.saveConfig(ConnectionConfig("host$i", 80, "t$i"))
        }

        val history = store.getHistory()
        assertEquals(5, history.size)
        assertEquals("host7", history[0].host) // most recent first
        assertEquals("host3", history[4].host) // oldest kept
    }

    @Test
    fun `most recent config is first in history`() {
        val store = createPrefsStore()
        store.saveConfig(ConnectionConfig("old", 80, "t1"))
        store.saveConfig(ConnectionConfig("new", 80, "t2"))

        val history = store.getHistory()
        assertEquals("new", history[0].host)
        assertEquals("old", history[1].host)
    }

    // ── 3. removeFromHistory boundary checks ───────────────────────────

    @Test
    fun `removeFromHistory removes entry at index`() {
        val store = createPrefsStore()
        store.saveConfig(ConnectionConfig("h1", 80, "t1"))
        store.saveConfig(ConnectionConfig("h2", 80, "t2"))
        store.saveConfig(ConnectionConfig("h3", 80, "t3"))

        store.removeFromHistory(1) // remove h2

        val history = store.getHistory()
        assertEquals(2, history.size)
        assertEquals("h3", history[0].host)
        assertEquals("h1", history[1].host)
    }

    @Test
    fun `removeFromHistory ignores out-of-bounds index`() {
        val store = createPrefsStore()
        store.saveConfig(ConnectionConfig("h1", 80, "t1"))

        store.removeFromHistory(5) // out of bounds
        store.removeFromHistory(-1) // negative

        assertEquals(1, store.getHistory().size)
    }

    @Test
    fun `removeFromHistory on empty history does nothing`() {
        val store = createPrefsStore()
        store.removeFromHistory(0) // no crash
        assertTrue(store.getHistory().isEmpty())
    }

    // ── 4. Session name CRUD + blank returns null ──────────────────────

    @Test
    fun `save and get session name`() {
        val store = createPrefsStore()
        store.saveSessionName("s1", "My Session")

        assertEquals("My Session", store.getSessionName("s1"))
    }

    @Test
    fun `getSessionName returns null for unknown session`() {
        val store = createPrefsStore()
        assertNull(store.getSessionName("unknown"))
    }

    @Test
    fun `getSessionName returns null for blank name`() {
        val store = createPrefsStore()
        store.saveSessionName("s1", "   ") // blank after trim

        assertNull(store.getSessionName("s1"))
    }

    @Test
    fun `getSessionName returns null for empty name`() {
        val store = createPrefsStore()
        store.saveSessionName("s1", "")

        assertNull(store.getSessionName("s1"))
    }

    @Test
    fun `saveSessionName trims whitespace`() {
        val store = createPrefsStore()
        store.saveSessionName("s1", "  My Session  ")

        assertEquals("My Session", store.getSessionName("s1"))
    }

    @Test
    fun `clearSessionName removes session name`() {
        val store = createPrefsStore()
        store.saveSessionName("s1", "Name")
        store.clearSessionName("s1")

        assertNull(store.getSessionName("s1"))
    }

    @Test
    fun `different sessions have independent names`() {
        val store = createPrefsStore()
        store.saveSessionName("s1", "Session A")
        store.saveSessionName("s2", "Session B")

        assertEquals("Session A", store.getSessionName("s1"))
        assertEquals("Session B", store.getSessionName("s2"))
    }

    // ── 5. Cert fingerprint get/set/clear ───────────────────────────────

    @Test
    fun `set and get cert fingerprint`() {
        val store = createPrefsStore()
        store.setCertFingerprint("AB:CD:EF:12:34")

        assertEquals("AB:CD:EF:12:34", store.getCertFingerprint())
    }

    @Test
    fun `getCertFingerprint returns null when not set`() {
        val store = createPrefsStore()
        assertNull(store.getCertFingerprint())
    }

    @Test
    fun `setCertFingerprint with null clears fingerprint`() {
        val store = createPrefsStore()
        store.setCertFingerprint("AB:CD:EF")
        store.setCertFingerprint(null)

        assertNull(store.getCertFingerprint())
    }

    @Test
    fun `setCertFingerprint with blank clears fingerprint`() {
        val store = createPrefsStore()
        store.setCertFingerprint("AB:CD:EF")
        store.setCertFingerprint("   ")

        assertNull(store.getCertFingerprint())
    }

    // ── 6. Migration logic (legacy → encrypted) ────────────────────────

    @Test
    fun `migration copies legacy data to encrypted prefs`() {
        // Set up legacy prefs with data
        val legacyData = mutableMapOf<String, Any?>(
            "connection_config" to """{"host":"old-host","port":9090,"token":"old-token"}""",
            "cert_fingerprint" to "OLD:FP:12"
        )
        val legacyPrefs = mockk<SharedPreferences>(relaxed = true)
        every { legacyPrefs.all } returns legacyData
        val legacyEditor = mockk<SharedPreferences.Editor>(relaxed = true)
        every { legacyPrefs.edit() } returns legacyEditor
        every { legacyEditor.clear() } returns legacyEditor
        every { legacyEditor.apply() } just Runs
        every { context.getSharedPreferences("clawd_prefs", Context.MODE_PRIVATE) } returns legacyPrefs

        val store = createPrefsStore()

        // Legacy data should have been copied
        val loaded = store.loadConfig()
        assertNotNull(loaded)
        assertEquals("old-host", loaded!!.host)
        assertEquals(9090, loaded.port)
        assertEquals("old-token", loaded.token)

        assertEquals("OLD:FP:12", store.getCertFingerprint())

        // Legacy prefs should have been cleared
        verify { legacyEditor.clear() }
    }

    @Test
    fun `migration skipped when already migrated`() {
        // Set the migrated flag in encrypted prefs
        inMemoryPrefs["_migrated_v1"] = true

        val legacyPrefs = mockk<SharedPreferences>(relaxed = true)
        every { legacyPrefs.all } returns mapOf("some_key" to "some_value")
        every { context.getSharedPreferences("clawd_prefs", Context.MODE_PRIVATE) } returns legacyPrefs

        createPrefsStore()

        // Legacy prefs should NOT have been accessed (migration skipped)
        verify(exactly = 0) { legacyPrefs.edit() }
    }

    @Test
    fun `migration marks as migrated when no legacy data`() {
        // Legacy prefs are empty (default from setUp)
        val store = createPrefsStore()

        // The migrated flag should be set
        assertTrue(inMemoryPrefs.containsKey("_migrated_v1"))
    }

    // ── Additional: Notification settings ──────────────────────────────

    @Test
    fun `notify settings defaults`() {
        val store = createPrefsStore()
        assertTrue(store.isNotifyEnabled())
        assertTrue(store.isNotifyApproval())
        assertTrue(store.isNotifyStatus())
        assertTrue(store.isNotifyAlert())
    }

    @Test
    fun `set and get notify approval`() {
        val store = createPrefsStore()
        store.setNotifyApproval(false)
        assertFalse(store.isNotifyApproval())
    }

    // ── Additional: Floating pet settings ──────────────────────────────

    @Test
    fun `floating pet defaults`() {
        val store = createPrefsStore()
        assertFalse(store.isFloatingPetEnabled())
        assertEquals(96, store.getPetSizeDp())
        assertEquals("clawd", store.getPetCharacter())
    }

    @Test
    fun `set and get pet character`() {
        val store = createPrefsStore()
        store.setPetCharacter("calico")
        assertEquals("calico", store.getPetCharacter())
    }

    @Test
    fun `set and get pet content position`() {
        val store = createPrefsStore()
        store.setPetContentPosition(100.5f, 200.3f)

        assertEquals(100.5f, store.getPetContentCx(0f), 0.01f)
        assertEquals(200.3f, store.getPetContentCy(0f), 0.01f)
    }

    // ── Relay pairing encrypted atomic blob ───────────────────────────

    @Test
    fun `relay pairing saves as one versioned blob and round trips`() {
        val store = createPrefsStore()
        val pairing = relayPairing()

        assertTrue(store.saveRelayPairing(pairing))

        assertEquals(pairing, store.loadRelayPairing())
        assertTrue(store.hasRelayPairing())
        assertTrue(inMemoryPrefs["relay_pairing"] is String)
        assertEquals(1, inMemoryPrefs.keys.count { it.startsWith("relay_pairing") })
    }

    @Test
    fun `relay pairing never enters ordinary config history or manual relay fields`() {
        val store = createPrefsStore()
        val pairing = relayPairing()

        assertTrue(store.saveRelayPairing(pairing))

        assertNull(store.loadConfig())
        assertTrue(store.getHistory().isEmpty())
        for (key in listOf("connection_config", "connection_history", "relay_url", "relay_token")) {
            val ordinaryValue = inMemoryPrefs[key]?.toString().orEmpty()
            assertFalse(ordinaryValue.contains(pairing.wireGuard.privateKey))
            assertFalse(ordinaryValue.contains(pairing.relay.token))
        }
    }

    @Test
    fun `successful relay pairing atomically replaces old pairing then clears manual relay`() {
        val store = createPrefsStore()
        val first = relayPairing("First", "ab")
        val replacement = relayPairing("Replacement", "cd")
        assertTrue(store.saveRelayPairing(first))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")

        assertTrue(store.saveRelayPairing(replacement))

        assertEquals(replacement, store.loadRelayPairing())
        assertEquals("", store.getRelayUrl())
        assertEquals("", store.getRelayToken())
    }

    @Test
    fun `failed relay pairing commit restores old pairing and manual relay`() {
        val store = createPrefsStore()
        val first = relayPairing("First", "ab")
        assertTrue(store.saveRelayPairing(first))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = false),
            StagingSharedPreferences.CommitBehavior(result = true),
        )

        assertFalse(store.saveRelayPairing(relayPairing("Rejected", "cd")))

        assertEquals(first, store.loadRelayPairing())
        assertEquals("wss://legacy.example.test", store.getRelayUrl())
        assertEquals("legacy-manual-token", store.getRelayToken())
    }

    @Test
    fun `failed readback restores old pairing and manual relay`() {
        val store = createPrefsStore()
        val first = relayPairing("First", "ab")
        assertTrue(store.saveRelayPairing(first))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        var pairingReads = 0
        fakePrefs.stringReader = reader@{ key, defaultValue ->
            if (key != "relay_pairing") return@reader fakePrefs.storedString(key, defaultValue)
            pairingReads++
            if (pairingReads == 2) "{corrupt-readback"
            else fakePrefs.storedString("relay_pairing", defaultValue)
        }

        assertFalse(store.saveRelayPairing(relayPairing("Rejected", "cd")))

        assertEquals(first, store.loadRelayPairing())
        assertEquals("wss://legacy.example.test", store.getRelayUrl())
        assertEquals("legacy-manual-token", store.getRelayToken())
    }

    @Test
    fun `manual relay is retained until replacement pairing passes readback`() {
        val store = createPrefsStore()
        assertTrue(store.saveRelayPairing(relayPairing("First", "ab")))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        var pairingReads = 0
        fakePrefs.stringReader = reader@{ key, defaultValue ->
            if (key != "relay_pairing") return@reader fakePrefs.storedString(key, defaultValue)
            pairingReads++
            if (pairingReads == 2) {
                assertEquals("wss://legacy.example.test", inMemoryPrefs["relay_url"])
                assertEquals("legacy-manual-token", inMemoryPrefs["relay_token"])
            }
            fakePrefs.storedString("relay_pairing", defaultValue)
        }

        assertTrue(store.saveRelayPairing(relayPairing("Replacement", "cd")))
        assertEquals("", store.getRelayUrl())
        assertEquals("", store.getRelayToken())
    }

    @Test
    fun `manual cleanup failure rolls back pairing and preserves manual relay`() {
        val store = createPrefsStore()
        val first = relayPairing("First", "ab")
        assertTrue(store.saveRelayPairing(first))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = false),
            StagingSharedPreferences.CommitBehavior(result = true),
        )

        assertFalse(store.saveRelayPairing(relayPairing("Rejected", "cd")))

        assertEquals(first, store.loadRelayPairing())
        assertEquals("wss://legacy.example.test", store.getRelayUrl())
        assertEquals("legacy-manual-token", store.getRelayToken())
    }

    @Test
    fun `manual relay values never synthesize a WireGuard pairing`() {
        val store = createPrefsStore()
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")

        assertFalse(store.hasRelayPairing())
        assertFalse(store.hasRelayPairingBlob())
        assertNull(store.loadRelayPairing())
        assertEquals("wss://legacy.example.test", store.getRelayUrl())
        assertEquals("legacy-manual-token", store.getRelayToken())
    }

    @Test
    fun `corrupt and unknown storage versions fail closed without touching LAN history`() {
        val store = createPrefsStore()
        val lan = ConnectionConfig("192.168.1.7", 23334, "abcdef1234567890")
        store.saveConfig(lan)
        assertTrue(store.saveRelayPairing(relayPairing()))
        val validBlob = inMemoryPrefs["relay_pairing"] as String

        inMemoryPrefs["relay_pairing"] = validBlob.replaceFirst("\"storageVersion\":1", "\"storageVersion\":2")
        assertNull(store.loadRelayPairing())
        assertFalse(store.hasRelayPairing())
        assertTrue(store.hasRelayPairingBlob())
        assertEquals(lan, store.loadConfig())
        assertEquals(listOf(lan), store.getHistory())

        inMemoryPrefs["relay_pairing"] = "{corrupt"
        assertNull(store.loadRelayPairing())
        assertTrue(store.hasRelayPairingBlob())
        assertEquals(lan, store.loadConfig())
        assertEquals(listOf(lan), store.getHistory())
    }

    @Test
    fun `decrypt failure fails closed without clearing other preferences`() {
        val store = createPrefsStore()
        val lan = ConnectionConfig("192.168.1.7", 23334, "abcdef1234567890")
        store.saveConfig(lan)
        assertTrue(store.saveRelayPairing(relayPairing()))
        fakePrefs.stringReader = { key, defaultValue ->
            if (key == "relay_pairing") throw SecurityException("decrypt failed")
            fakePrefs.storedString(key, defaultValue)
        }

        assertNull(store.loadRelayPairing())
        assertFalse(store.hasRelayPairing())
        assertTrue(store.hasRelayPairingBlob())
        assertEquals(lan, store.loadConfig())
        assertEquals(listOf(lan), store.getHistory())
    }

    @Test
    fun `clear relay pairing is idempotent and preserves LAN history`() {
        val store = createPrefsStore()
        val lan = ConnectionConfig("192.168.1.7", 23334, "abcdef1234567890")
        store.saveConfig(lan)
        assertTrue(store.saveRelayPairing(relayPairing()))

        assertTrue(store.clearRelayPairing())
        assertTrue(store.clearRelayPairing())

        assertFalse(store.hasRelayPairing())
        assertEquals(lan, store.loadConfig())
        assertEquals(listOf(lan), store.getHistory())
    }

    @Test
    fun `candidate commit failure plus rollback failure never activates rejected pairing after restart`() {
        val store = createPrefsStore()
        val previous = relayPairing("Previous", "ab")
        val rejected = relayPairing("Rejected", "cd")
        assertTrue(store.saveRelayPairing(previous))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = false),
            StagingSharedPreferences.CommitBehavior(result = false),
        )

        assertFalse(store.saveRelayPairing(rejected))

        val restarted = restartPrefsStore()
        assertNotEquals(rejected, restarted.loadRelayPairing())
        assertEquals(previous, restarted.loadRelayPairing())
        assertEquals("wss://legacy.example.test", restarted.getRelayUrl())
        assertEquals("legacy-manual-token", restarted.getRelayToken())
    }

    @Test
    fun `cleanup failure keeps committed journal and returns success for deterministic restart recovery`() {
        val store = createPrefsStore()
        val previous = relayPairing("Previous", "ab")
        val replacement = relayPairing("Replacement", "cd")
        assertTrue(store.saveRelayPairing(previous))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = false),
        )

        assertTrue(store.saveRelayPairing(replacement))
        assertTrue(fakePrefs.durableValues.containsKey("relay_pairing_transaction"))

        val restarted = restartPrefsStore()
        assertEquals(replacement, restarted.loadRelayPairing())
        assertEquals("", restarted.getRelayUrl())
        assertEquals("", restarted.getRelayToken())
        assertFalse(inMemoryPrefs.containsKey("relay_pairing_transaction"))
    }

    @Test
    fun `rollback cleanup failure leaves recoverable journal without activating candidate`() {
        val store = createPrefsStore()
        val previous = relayPairing("Previous", "ab")
        val rejected = relayPairing("Rejected", "cd")
        assertTrue(store.saveRelayPairing(previous))
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = false),
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = false),
        )

        assertFalse(store.saveRelayPairing(rejected))
        assertTrue(fakePrefs.durableValues.containsKey("relay_pairing_transaction"))

        val restarted = restartPrefsStore()
        assertEquals(previous, restarted.loadRelayPairing())
        assertFalse(inMemoryPrefs.containsKey("relay_pairing_transaction"))
    }

    @Test
    fun `rollback commit false retains journal even when current memory still shows previous state`() {
        val store = createPrefsStore()
        val previous = relayPairing("Previous", "ab")
        val rejected = relayPairing("Rejected", "cd")
        assertTrue(store.saveRelayPairing(previous))
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = false),
            StagingSharedPreferences.CommitBehavior(result = false),
        )

        assertFalse(store.saveRelayPairing(rejected))

        assertEquals(previous, RelayPairingConfig.decodeStorage(inMemoryPrefs["relay_pairing"] as String))
        assertTrue(inMemoryPrefs.containsKey("relay_pairing_transaction"))
        assertEquals(previous, restartPrefsStore().loadRelayPairing())
    }

    @Test
    fun `memory only committed marker cannot report durable pairing success`() {
        val store = createPrefsStore()
        val previous = relayPairing("Previous", "ab")
        val replacement = relayPairing("Replacement", "cd")
        assertTrue(store.saveRelayPairing(previous))
        store.setRelayUrl("wss://legacy.example.test")
        store.setRelayToken("legacy-manual-token")
        fakePrefs.enqueueCommit(
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = true),
            StagingSharedPreferences.CommitBehavior(result = true),
            // Android may update its process-memory map before disk persistence fails.
            StagingSharedPreferences.CommitBehavior(result = false),
            StagingSharedPreferences.CommitBehavior(result = false),
        )

        assertFalse(store.saveRelayPairing(replacement))
        assertEquals(previous, restartPrefsStore().loadRelayPairing())
        assertEquals("wss://legacy.example.test", store.getRelayUrl())
        assertEquals("legacy-manual-token", store.getRelayToken())
    }

    @Test
    fun `restart recovers deterministically after every durable transaction stage crash`() {
        for (crashCommit in 1..5) {
            val store = createPrefsStore()
            val previous = relayPairing("Previous $crashCommit", "ab")
            val replacement = relayPairing("Replacement $crashCommit", "cd")
            assertTrue(store.saveRelayPairing(previous))
            store.setRelayUrl("wss://legacy.example.test")
            store.setRelayToken("legacy-manual-token")
            repeat(crashCommit - 1) {
                fakePrefs.enqueueCommit(StagingSharedPreferences.CommitBehavior(result = true))
            }
            fakePrefs.enqueueCommit(
                StagingSharedPreferences.CommitBehavior(
                    result = true,
                    failureAfterPersist = SimulatedProcessCrash(),
                ),
            )

            assertThrows(SimulatedProcessCrash::class.java) {
                store.saveRelayPairing(replacement)
            }

            val restarted = restartPrefsStore()
            val expected = if (crashCommit <= 3) previous else replacement
            assertEquals("crash after transaction commit $crashCommit", expected, restarted.loadRelayPairing())
            if (crashCommit <= 3) {
                assertEquals("wss://legacy.example.test", restarted.getRelayUrl())
                assertEquals("legacy-manual-token", restarted.getRelayToken())
            } else {
                assertEquals("", restarted.getRelayUrl())
                assertEquals("", restarted.getRelayToken())
            }

            fakePrefs.clearMemoryAndDisk()
            PrefsStore.resetForTesting()
        }
    }

    @Test
    fun `corrupt transaction journal fails closed across new store instances`() {
        val store = createPrefsStore()
        val pairing = relayPairing()
        assertTrue(store.saveRelayPairing(pairing))
        fakePrefs.putMemoryAndDisk("relay_pairing_transaction", "{corrupt")

        val restarted = restartPrefsStore()
        assertNull(restarted.loadRelayPairing())
        assertFalse(restarted.hasRelayPairing())
        assertTrue(restarted.hasRelayPairingBlob())
        assertEquals(pairing, RelayPairingConfig.decodeStorage(inMemoryPrefs["relay_pairing"] as String))
    }
}

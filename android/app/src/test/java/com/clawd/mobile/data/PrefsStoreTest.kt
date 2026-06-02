package com.clawd.mobile.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import io.mockk.*
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
    private lateinit var mockPrefs: SharedPreferences
    private lateinit var mockEditor: SharedPreferences.Editor
    private lateinit var context: Context

    @Before
    fun setUp() {
        PrefsStore.resetForTesting()

        inMemoryPrefs = mutableMapOf()

        // Build a mock Editor that writes to inMemoryPrefs
        mockEditor = mockk(relaxed = true)
        every { mockEditor.putString(any(), any()) } answers {
            inMemoryPrefs[firstArg()] = secondArg()
            mockEditor
        }
        every { mockEditor.putBoolean(any(), any()) } answers {
            inMemoryPrefs[firstArg()] = secondArg()
            mockEditor
        }
        every { mockEditor.putInt(any(), any()) } answers {
            inMemoryPrefs[firstArg()] = secondArg()
            mockEditor
        }
        every { mockEditor.putFloat(any(), any()) } answers {
            inMemoryPrefs[firstArg()] = secondArg()
            mockEditor
        }
        every { mockEditor.putLong(any(), any()) } answers {
            inMemoryPrefs[firstArg()] = secondArg()
            mockEditor
        }
        every { mockEditor.remove(any()) } answers {
            inMemoryPrefs.remove(firstArg())
            mockEditor
        }
        every { mockEditor.clear() } answers {
            inMemoryPrefs.clear()
            mockEditor
        }
        every { mockEditor.apply() } just Runs
        every { mockEditor.commit() } returns true

        // Build a mock SharedPreferences backed by inMemoryPrefs
        mockPrefs = mockk(relaxed = true)
        every { mockPrefs.edit() } returns mockEditor
        every { mockPrefs.getString(any(), any()) } answers {
            inMemoryPrefs[firstArg()] as? String ?: secondArg()
        }
        every { mockPrefs.getBoolean(any(), any()) } answers {
            (inMemoryPrefs[firstArg()] as? Boolean) ?: secondArg()
        }
        every { mockPrefs.getInt(any(), any()) } answers {
            (inMemoryPrefs[firstArg()] as? Int) ?: secondArg()
        }
        every { mockPrefs.getFloat(any(), any()) } answers {
            (inMemoryPrefs[firstArg()] as? Float) ?: secondArg()
        }
        every { mockPrefs.getLong(any(), any()) } answers {
            (inMemoryPrefs[firstArg()] as? Long) ?: secondArg()
        }
        every { mockPrefs.all } answers { inMemoryPrefs.toMap() }

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
        } returns mockPrefs
    }

    @After
    fun tearDown() {
        PrefsStore.resetForTesting()
        unmockkAll()
    }

    private fun createPrefsStore(): PrefsStore {
        return PrefsStore.getInstance(context)
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
}

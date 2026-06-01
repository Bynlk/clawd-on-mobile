package com.clawd.mobile.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class PrefsStore(context: Context) {

    companion object {
        private const val TAG = "PrefsStore"
        private const val KEY_CONFIG = "connection_config"
        private const val KEY_HISTORY = "connection_history"
        private const val KEY_MAX_HISTORY = 5
        private const val KEY_NOTIFY_APPROVAL = "notify_approval"
        private const val KEY_NOTIFY_STATUS = "notify_status"
        private const val KEY_NOTIFY_ALERT = "notify_alert"
        private const val KEY_NOTIFY_ENABLED = "notify_enabled"
        private const val KEY_FLOATING_PET = "floating_pet_enabled"
        private const val PREFS_ENCRYPTED = "clawd_prefs_encrypted"
        private const val PREFS_LEGACY = "clawd_prefs"
        private const val KEY_MIGRATED = "_migrated_v1"
    }

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        PREFS_ENCRYPTED,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private val json = Json { ignoreUnknownKeys = true }

    init {
        migrateIfNeeded(context)
    }

    /**
     * One-time migration from legacy plaintext SharedPreferences.
     * Copies all key-value pairs to encrypted prefs, then clears the old store.
     */
    private fun migrateIfNeeded(context: Context) {
        if (prefs.getBoolean(KEY_MIGRATED, false)) return
        val oldPrefs = context.getSharedPreferences(PREFS_LEGACY, Context.MODE_PRIVATE)
        if (oldPrefs.all.isEmpty()) {
            // No legacy data — just mark as migrated
            prefs.edit().putBoolean(KEY_MIGRATED, true).apply()
            return
        }
        Log.i(TAG, "Migrating ${oldPrefs.all.size} keys from legacy prefs to EncryptedSharedPreferences")
        val editor = prefs.edit()
        oldPrefs.all.forEach { (key, value) ->
            when (value) {
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Float -> editor.putFloat(key, value)
                is Long -> editor.putLong(key, value)
            }
        }
        editor.putBoolean(KEY_MIGRATED, true)
        editor.apply()
        oldPrefs.edit().clear().apply()
        Log.i(TAG, "Migration complete, legacy prefs cleared")
    }

    fun saveConfig(config: ConnectionConfig) {
        prefs.edit().putString(KEY_CONFIG, json.encodeToString(config)).apply()
        addToHistory(config)
    }

    fun loadConfig(): ConnectionConfig? {
        val str = prefs.getString(KEY_CONFIG, null) ?: return null
        return try { json.decodeFromString(str) } catch (_: Exception) { null }
    }

    fun clearConfig() {
        prefs.edit().remove(KEY_CONFIG).apply()
    }

    fun getHistory(): List<ConnectionConfig> {
        val str = prefs.getString(KEY_HISTORY, null) ?: return emptyList()
        return try { json.decodeFromString(str) } catch (_: Exception) { emptyList() }
    }

    private fun addToHistory(config: ConnectionConfig) {
        val history = getHistory().toMutableList()
        history.removeAll { it.host == config.host && it.port == config.port }
        history.add(0, config)
        val trimmed = history.take(KEY_MAX_HISTORY)
        prefs.edit().putString(KEY_HISTORY, json.encodeToString(trimmed)).apply()
    }

    fun removeFromHistory(index: Int) {
        val history = getHistory().toMutableList()
        if (index in history.indices) {
            history.removeAt(index)
            prefs.edit().putString(KEY_HISTORY, json.encodeToString(history)).apply()
        }
    }

    // Notification settings
    fun isNotifyEnabled(): Boolean = prefs.getBoolean(KEY_NOTIFY_ENABLED, true)
    fun setNotifyEnabled(v: Boolean) { prefs.edit().putBoolean(KEY_NOTIFY_ENABLED, v).apply() }

    fun isNotifyApproval(): Boolean = prefs.getBoolean(KEY_NOTIFY_APPROVAL, true)
    fun setNotifyApproval(v: Boolean) { prefs.edit().putBoolean(KEY_NOTIFY_APPROVAL, v).apply() }

    fun isNotifyStatus(): Boolean = prefs.getBoolean(KEY_NOTIFY_STATUS, true)
    fun setNotifyStatus(v: Boolean) { prefs.edit().putBoolean(KEY_NOTIFY_STATUS, v).apply() }

    fun isNotifyAlert(): Boolean = prefs.getBoolean(KEY_NOTIFY_ALERT, true)
    fun setNotifyAlert(v: Boolean) { prefs.edit().putBoolean(KEY_NOTIFY_ALERT, v).apply() }

    // Floating pet
    fun isFloatingPetEnabled(): Boolean = prefs.getBoolean(KEY_FLOATING_PET, false)
    fun setFloatingPetEnabled(v: Boolean) { prefs.edit().putBoolean(KEY_FLOATING_PET, v).apply() }

    // Session name overrides
    fun saveSessionName(sessionId: String, name: String) {
        prefs.edit().putString("session_name_$sessionId", name.trim()).apply()
    }

    fun getSessionName(sessionId: String): String? {
        val name = prefs.getString("session_name_$sessionId", null)
        return if (name.isNullOrBlank()) null else name
    }

    fun clearSessionName(sessionId: String) {
        prefs.edit().remove("session_name_$sessionId").apply()
    }
}

package com.clawd.mobile.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class PrefsStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("clawd_prefs", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        private const val KEY_CONFIG = "connection_config"
        private const val KEY_HISTORY = "connection_history"
        private const val KEY_MAX_HISTORY = 5
        private const val KEY_NOTIFY_APPROVAL = "notify_approval"
        private const val KEY_NOTIFY_STATUS = "notify_status"
        private const val KEY_NOTIFY_ALERT = "notify_alert"
        private const val KEY_NOTIFY_ENABLED = "notify_enabled"
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

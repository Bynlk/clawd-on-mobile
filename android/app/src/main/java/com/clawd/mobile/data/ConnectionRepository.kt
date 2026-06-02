package com.clawd.mobile.data

import com.clawd.mobile.ws.ConnectionState
import kotlinx.coroutines.flow.StateFlow

/**
 * Unified access point for connection configuration and state.
 * Encapsulates PrefsStore connection operations and live connection state.
 */
class ConnectionRepository(
    private val prefsStore: PrefsStore,
    private val connectionState: StateFlow<ConnectionState>,
) {
    val isConnected: Boolean get() = connectionState.value == ConnectionState.CONNECTED

    fun saveConfig(config: ConnectionConfig) = prefsStore.saveConfig(config)
    fun loadConfig(): ConnectionConfig? = prefsStore.loadConfig()
    fun getHistory(): List<ConnectionConfig> = prefsStore.getHistory()
    fun removeFromHistory(index: Int) = prefsStore.removeFromHistory(index)
    fun clearConfig() = prefsStore.clearConfig()
    fun getCertFingerprint(): String? = prefsStore.getCertFingerprint()
    fun setCertFingerprint(v: String?) = prefsStore.setCertFingerprint(v)
}

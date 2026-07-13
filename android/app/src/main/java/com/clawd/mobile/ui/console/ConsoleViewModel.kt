package com.clawd.mobile.ui.console

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.clawd.mobile.console.*
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ws.StreamingClient
import kotlinx.coroutines.flow.StateFlow

class ConsoleViewModel(
    private val client: StreamingClient,
    private val prefsStore: PrefsStore,
) : ViewModel() {
    private val repository = ConsoleRepository(
        client = client,
        scope = viewModelScope,
        deviceId = prefsStore.getOrCreateConsoleDeviceId(),
    )

    val syncEnabled: StateFlow<Boolean> = repository.syncEnabled
    val capabilities: StateFlow<ConsoleCapabilities> = repository.capabilities
    val sessions: StateFlow<List<ManagedSession>> = repository.sessions
    val records: StateFlow<Map<String, List<ConsoleRecord>>> = repository.records
    val leases: StateFlow<Map<String, ConsoleLease>> = repository.leases
    val selectedSessionId: StateFlow<String?> = repository.selectedSessionId
    val lastError: StateFlow<ConsoleServerMessage.Error?> = repository.lastError
    val commandResults = repository.commandResults
    val connectionState = client.connectionState

    fun onVisible() {
        repository.setVisible(true)
        if (prefsStore.isConsoleSyncEnabled()) {
            repository.setSyncEnabled(true)
            repository.requestCapabilities()
            repository.requestSessions()
            selectedSessionId.value?.let(repository::selectSession)
        }
    }

    fun onHidden() {
        repository.setVisible(false)
    }

    fun selectSession(id: String) = repository.selectSession(id)
    fun createSession(agentId: String, cwd: String) = repository.createSession(agentId, cwd)
    fun acquireLease(sessionId: String) = repository.acquireLease(sessionId)
    fun send(sessionId: String, text: String) = repository.sendInput(sessionId, text)
    fun raw(sessionId: String, data: String) = repository.sendInput(sessionId, data, raw = true, submit = false)
    fun interrupt(sessionId: String) = repository.interrupt(sessionId)

    override fun onCleared() {
        selectedSessionId.value?.let(repository::releaseLease)
        repository.close()
    }

    class Factory(
        private val client: StreamingClient,
        private val prefsStore: PrefsStore,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return ConsoleViewModel(client, prefsStore) as T
        }
    }
}

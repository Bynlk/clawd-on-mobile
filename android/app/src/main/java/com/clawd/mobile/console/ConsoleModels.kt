package com.clawd.mobile.console

import kotlinx.serialization.Serializable

@Serializable
data class ManagedAgent(
    val id: String,
    val name: String = id,
    val command: String = "",
    val args: List<String> = emptyList(),
)

@Serializable
data class ManagedSession(
    val id: String,
    val agentId: String,
    val cwd: String,
    val title: String = agentId,
    val status: String = "running",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val latestSequence: Long = 0,
    val oldestSequence: Long = 0,
    val exitCode: Int? = null,
    val signal: Int? = null,
)

@Serializable
data class ConsoleRecord(
    val sessionId: String,
    val sequence: Long,
    val kind: String,
    val text: String? = null,
    val raw: String? = null,
    val language: String? = null,
    val toolName: String? = null,
    val event: String? = null,
    val permissionId: String? = null,
    val permissionState: String? = null,
    val file: String? = null,
    val additions: Int = 0,
    val deletions: Int = 0,
    val control: String? = null,
    val submitted: Boolean = false,
    val exitCode: Int? = null,
    val signal: Int? = null,
    val timestamp: Long = 0,
)

data class ConsoleCapabilities(
    val agents: List<ManagedAgent> = emptyList(),
    val directories: List<String> = emptyList(),
)

data class ConsoleLease(
    val sessionId: String,
    val owner: String? = null,
    val granted: Boolean = false,
)

sealed class ConsoleServerMessage {
    data class SyncState(val enabled: Boolean) : ConsoleServerMessage()
    data class Capabilities(
        val agents: List<ManagedAgent>,
        val directories: List<String>,
    ) : ConsoleServerMessage()
    data class SessionsSnapshot(val sessions: List<ManagedSession>) : ConsoleServerMessage()
    data class SessionCreated(val session: ManagedSession) : ConsoleServerMessage()
    data class HistoryChunk(
        val sessionId: String,
        val records: List<ConsoleRecord>,
        val resetRequired: Boolean = false,
        val oldestSequence: Long = 0,
        val latestSequence: Long = 0,
        val hasMore: Boolean = false,
        val chunkIndex: Int = 0,
        val chunkCount: Int = 1,
    ) : ConsoleServerMessage()
    data class Delta(val record: ConsoleRecord) : ConsoleServerMessage()
    data class LeaseChanged(
        val sessionId: String,
        val owner: String? = null,
        val granted: Boolean = false,
    ) : ConsoleServerMessage()
    data class Error(
        val code: String,
        val requestId: String? = null,
        val sessionId: String? = null,
    ) : ConsoleServerMessage()
    data class CommandResult(
        val requestId: String,
        val sessionId: String,
        val command: String,
        val sequence: Long? = null,
    ) : ConsoleServerMessage()
    data class Unknown(val type: String) : ConsoleServerMessage()
}

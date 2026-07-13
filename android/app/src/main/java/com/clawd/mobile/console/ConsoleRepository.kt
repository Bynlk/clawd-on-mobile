package com.clawd.mobile.console

import com.clawd.mobile.ws.StreamingClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID
import java.util.TreeMap

fun consoleRecordApproxBytes(record: ConsoleRecord): Int = 256 + listOf(
    record.text,
    record.raw,
    record.toolName,
    record.file,
    record.event,
    record.permissionId,
    record.permissionState,
).sumOf { it?.toByteArray(Charsets.UTF_8)?.size ?: 0 }

class ConsoleRepository(
    private val client: StreamingClient,
    private val scope: CoroutineScope,
    val deviceId: String,
    private val maxRecordsPerSession: Int = 10_000,
    private val maxBytesPerSession: Int = 16 * 1024 * 1024,
) {
    private val _syncEnabled = MutableStateFlow(false)
    val syncEnabled: StateFlow<Boolean> = _syncEnabled.asStateFlow()

    private val _capabilities = MutableStateFlow(ConsoleCapabilities())
    val capabilities: StateFlow<ConsoleCapabilities> = _capabilities.asStateFlow()

    private val _sessions = MutableStateFlow<List<ManagedSession>>(emptyList())
    val sessions: StateFlow<List<ManagedSession>> = _sessions.asStateFlow()

    private val _records = MutableStateFlow<Map<String, List<ConsoleRecord>>>(emptyMap())
    val records: StateFlow<Map<String, List<ConsoleRecord>>> = _records.asStateFlow()

    private val _leases = MutableStateFlow<Map<String, ConsoleLease>>(emptyMap())
    val leases: StateFlow<Map<String, ConsoleLease>> = _leases.asStateFlow()

    private val _selectedSessionId = MutableStateFlow<String?>(null)
    val selectedSessionId: StateFlow<String?> = _selectedSessionId.asStateFlow()

    private val _lastError = MutableStateFlow<ConsoleServerMessage.Error?>(null)
    val lastError: StateFlow<ConsoleServerMessage.Error?> = _lastError.asStateFlow()
    private val _commandResults = MutableSharedFlow<ConsoleServerMessage.CommandResult>(extraBufferCapacity = 16)
    val commandResults: SharedFlow<ConsoleServerMessage.CommandResult> = _commandResults.asSharedFlow()

    private val pendingRecords = mutableMapOf<String, TreeMap<Long, ConsoleRecord>>()
    private val contiguousSequences = mutableMapOf<String, Long>()
    private val lastHistoryRequests = mutableMapOf<String, Long>()
    private val pendingAcknowledgements = mutableMapOf<String, Long>()
    private val acknowledgementJobs = mutableMapOf<String, Job>()
    private var visible = true

    private val collector: Job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        client.consoleMessages.collect(::handle)
    }
    private val connectionCollector: Job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        client.connectionState.collect { state ->
            if (state != com.clawd.mobile.ws.ConnectionState.CONNECTED) {
                _leases.value = emptyMap()
                lastHistoryRequests.clear()
                acknowledgementJobs.values.forEach { it.cancel() }
                acknowledgementJobs.clear()
                pendingAcknowledgements.clear()
            }
        }
    }

    fun close() {
        collector.cancel()
        connectionCollector.cancel()
        acknowledgementJobs.values.forEach { it.cancel() }
    }

    fun setVisible(value: Boolean) {
        visible = value
        if (!value) pendingRecords.clear()
    }

    fun setSyncEnabled(enabled: Boolean): Boolean = send("managed_content_sync_set") {
        put("enabled", enabled)
    }

    fun requestCapabilities(): Boolean = send("managed_capabilities_request")

    fun requestSessions(): Boolean = send("managed_sessions_request")

    fun selectSession(sessionId: String): Boolean {
        val previous = _selectedSessionId.value
        if (previous != null && previous != sessionId && _leases.value[previous]?.granted == true) {
            releaseLease(previous)
            _leases.update { it - previous }
        }
        _selectedSessionId.value = sessionId
        _lastError.value = null
        return requestHistory(sessionId)
    }

    fun createSession(agentId: String, cwd: String, cols: Int = 100, rows: Int = 30): Boolean =
        send("managed_session_create") {
            put("agentId", agentId)
            put("cwd", cwd)
            put("cols", cols)
            put("rows", rows)
        }

    fun acquireLease(sessionId: String): Boolean = send("managed_session_input_lease_acquire") {
        put("sessionId", sessionId)
    }

    fun releaseLease(sessionId: String): Boolean = send("managed_session_input_lease_release") {
        put("sessionId", sessionId)
    }

    fun sendInput(sessionId: String, text: String, raw: Boolean = false, submit: Boolean = true): String? {
        val requestId = UUID.randomUUID().toString()
        val sent = send(
            type = "managed_session_input",
            requestId = requestId,
            maxBytes = 60 * 1024,
            tooLargeCode = "input_too_large",
        ) {
            put("sessionId", sessionId)
            put("data", text)
            put("raw", raw)
            put("submit", submit)
        }
        return requestId.takeIf { sent }
    }

    fun resize(sessionId: String, cols: Int, rows: Int): Boolean = send("managed_session_resize") {
        put("sessionId", sessionId)
        put("cols", cols)
        put("rows", rows)
    }

    fun interrupt(sessionId: String): Boolean = send("managed_session_interrupt") {
        put("sessionId", sessionId)
    }

    private fun handle(message: ConsoleServerMessage) {
        when (message) {
            is ConsoleServerMessage.SyncState -> _syncEnabled.value = message.enabled
            is ConsoleServerMessage.Capabilities -> {
                _capabilities.value = ConsoleCapabilities(message.agents, message.directories)
            }
            is ConsoleServerMessage.SessionsSnapshot -> {
                _sessions.value = message.sessions.sortedByDescending { it.updatedAt }
                pruneMissingSessions(message.sessions.mapTo(mutableSetOf()) { it.id })
                val selected = _selectedSessionId.value
                    ?.takeIf { id -> message.sessions.any { it.id == id } }
                    ?: message.sessions.firstOrNull()?.id
                if (selected != _selectedSessionId.value) {
                    if (selected == null) _selectedSessionId.value = null else selectSession(selected)
                } else if (selected != null) {
                    requestHistory(selected)
                }
            }
            is ConsoleServerMessage.SessionCreated -> {
                _lastError.value = null
                _sessions.value = (_sessions.value.filterNot { it.id == message.session.id } + message.session)
                selectSession(message.session.id)
            }
            is ConsoleServerMessage.HistoryChunk -> {
                if (!visible) return
                if (_lastError.value?.sessionId == message.sessionId) _lastError.value = null
                mergeRecords(
                    sessionId = message.sessionId,
                    incoming = message.records,
                    reset = message.resetRequired,
                    oldestSequence = message.oldestSequence,
                )
                acknowledge(message.sessionId)
                val batchComplete = message.chunkIndex + 1 >= message.chunkCount
                if (batchComplete) {
                    lastHistoryRequests.remove(message.sessionId)
                    if (message.hasMore || hasSequenceGap(message.sessionId)) {
                        requestHistory(message.sessionId)
                    }
                }
            }
            is ConsoleServerMessage.Delta -> {
                if (!visible) return
                if (_lastError.value?.sessionId == message.record.sessionId) _lastError.value = null
                mergeRecords(message.record.sessionId, listOf(message.record), false)
                acknowledge(message.record.sessionId)
                if (hasSequenceGap(message.record.sessionId)) requestHistory(message.record.sessionId)
            }
            is ConsoleServerMessage.LeaseChanged -> {
                if (message.granted && _lastError.value?.sessionId == message.sessionId) {
                    _lastError.value = null
                }
                _leases.update { current ->
                    current + (message.sessionId to ConsoleLease(
                        sessionId = message.sessionId,
                        owner = message.owner,
                        granted = message.granted || message.owner == deviceId,
                    ))
                }
            }
            is ConsoleServerMessage.Error -> _lastError.value = message
            is ConsoleServerMessage.CommandResult -> {
                _lastError.value = null
                _commandResults.tryEmit(message)
            }
            is ConsoleServerMessage.Unknown -> Unit
        }
    }

    private fun mergeRecords(
        sessionId: String,
        incoming: List<ConsoleRecord>,
        reset: Boolean,
        oldestSequence: Long = 0,
    ) {
        val currentCursor = contiguousSequences[sessionId] ?: 0L
        val implicitReset = currentCursor == 0L && oldestSequence > 1L
        if (reset || implicitReset) {
            val baseline = incoming.minOfOrNull { it.sequence }?.minus(1)
                ?: (oldestSequence - 1).coerceAtLeast(0)
            contiguousSequences[sessionId] = baseline
            pendingRecords.remove(sessionId)
            _records.update { it + (sessionId to emptyList()) }
        }

        val pending = pendingRecords.getOrPut(sessionId) { TreeMap() }
        val cursor = contiguousSequences[sessionId] ?: 0L
        incoming.asSequence()
            .filter { it.sequence > cursor }
            .forEach { pending[it.sequence] = it }

        var next = contiguousSequences[sessionId] ?: 0L
        val applied = mutableListOf<ConsoleRecord>()
        while (true) {
            val record = pending.remove(next + 1) ?: break
            applied += record
            next = record.sequence
        }
        trimPending(pending)
        if (applied.isEmpty()) return

        contiguousSequences[sessionId] = next
        _records.update { current ->
            val bounded = boundMaterialized(current[sessionId].orEmpty() + applied)
            current + (sessionId to bounded)
        }
    }

    private fun acknowledge(sessionId: String) {
        val sequence = contiguousSequences[sessionId] ?: return
        if (sequence <= 0) return
        pendingAcknowledgements[sessionId] = maxOf(pendingAcknowledgements[sessionId] ?: 0L, sequence)
        if (acknowledgementJobs[sessionId]?.isActive == true) return
        acknowledgementJobs[sessionId] = scope.launch {
            kotlinx.coroutines.delay(350L)
            val latest = pendingAcknowledgements.remove(sessionId) ?: return@launch
            send("managed_session_ack", includeRequestId = false) {
                put("sessionId", sessionId)
                put("sequence", latest)
            }
            acknowledgementJobs.remove(sessionId)
            if (pendingAcknowledgements.containsKey(sessionId)) acknowledge(sessionId)
        }
    }

    private fun requestHistory(sessionId: String): Boolean {
        val sequence = contiguousSequences[sessionId] ?: 0L
        if (lastHistoryRequests.containsKey(sessionId)) return false
        val sent = send("managed_session_history_request") {
            put("sessionId", sessionId)
            put("afterSequence", sequence)
        }
        if (sent) lastHistoryRequests[sessionId] = sequence
        return sent
    }

    private fun hasSequenceGap(sessionId: String): Boolean {
        val pending = pendingRecords[sessionId] ?: return false
        val firstPending = pending.firstKeyOrNull() ?: return false
        return firstPending > (contiguousSequences[sessionId] ?: 0L) + 1
    }

    private fun pruneMissingSessions(validIds: Set<String>) {
        _records.update { current -> current.filterKeys(validIds::contains) }
        _leases.update { current -> current.filterKeys(validIds::contains) }
        pendingRecords.keys.retainAll(validIds)
        contiguousSequences.keys.retainAll(validIds)
        lastHistoryRequests.keys.retainAll(validIds)
        pendingAcknowledgements.keys.retainAll(validIds)
        acknowledgementJobs.keys.filterNot(validIds::contains).forEach { id ->
            acknowledgementJobs.remove(id)?.cancel()
        }
    }

    private fun boundMaterialized(records: List<ConsoleRecord>): List<ConsoleRecord> {
        val kept = ArrayDeque<ConsoleRecord>()
        var bytes = 0
        for (record in records.asReversed()) {
            val recordBytes = consoleRecordApproxBytes(record)
            if (kept.isNotEmpty() &&
                (kept.size >= maxRecordsPerSession || bytes + recordBytes > maxBytesPerSession)
            ) break
            kept.addFirst(record)
            bytes += recordBytes
        }
        return kept.toList()
    }

    private fun trimPending(pending: TreeMap<Long, ConsoleRecord>) {
        var bytes = pending.values.sumOf(::consoleRecordApproxBytes)
        while (pending.size > maxRecordsPerSession || bytes > maxBytesPerSession) {
            val removed = pending.pollLastEntry()?.value ?: break
            bytes -= consoleRecordApproxBytes(removed)
        }
    }

    private fun <K, V> TreeMap<K, V>.firstKeyOrNull(): K? = if (isEmpty()) null else firstKey()

    private fun send(
        type: String,
        includeRequestId: Boolean = true,
        requestId: String? = null,
        maxBytes: Int? = null,
        tooLargeCode: String = "managed_payload_too_large",
        body: JsonObjectBuilder.() -> Unit = {},
    ): Boolean {
        val json = buildJsonObject {
            put("type", type)
            put("deviceId", deviceId)
            if (includeRequestId) put("requestId", requestId ?: UUID.randomUUID().toString())
            body()
        }
        val encoded = json.toString()
        if (maxBytes != null && encoded.toByteArray(Charsets.UTF_8).size > maxBytes) {
            _lastError.value = ConsoleServerMessage.Error(
                code = tooLargeCode,
                requestId = requestId,
                sessionId = json["sessionId"]?.jsonPrimitive?.contentOrNull,
            )
            return false
        }
        return client.sendMessage(encoded)
    }
}

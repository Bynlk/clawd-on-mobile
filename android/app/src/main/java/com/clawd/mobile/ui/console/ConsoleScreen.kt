package com.clawd.mobile.ui.console

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.navigation.NavController
import com.clawd.mobile.R
import com.clawd.mobile.console.ManagedSession
import com.clawd.mobile.console.ConsoleRecord
import com.clawd.mobile.ui.theme.ClawdBackgroundDark
import kotlinx.coroutines.launch
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.sessions.ApprovalSheet

fun resolvePermissionCardStates(records: List<ConsoleRecord>): List<ConsoleRecord> {
    val latestStates = records.asSequence()
        .filter { it.kind == "permission" && it.permissionId != null && it.permissionState != "pending" }
        .associate { it.permissionId!! to it.permissionState }
    return records.map { record ->
        val state = record.permissionId?.let(latestStates::get)
        if (record.kind == "permission" && state != null) record.copy(permissionState = state) else record
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConsoleScreen(
    navController: NavController,
    viewModel: ConsoleViewModel,
    approvalViewModel: ApprovalViewModel,
) {
    val syncEnabled by viewModel.syncEnabled.collectAsState()
    val capabilities by viewModel.capabilities.collectAsState()
    val sessions by viewModel.sessions.collectAsState()
    val records by viewModel.records.collectAsState()
    val leases by viewModel.leases.collectAsState()
    val selectedId by viewModel.selectedSessionId.collectAsState()
    val error by viewModel.lastError.collectAsState()
    val connectionState by viewModel.connectionState.collectAsState()
    val pendingApprovals by approvalViewModel.pendingRequests.collectAsState()
    val approvalCountdowns by approvalViewModel.countdowns.collectAsState()
    val selected = sessions.firstOrNull { it.id == selectedId }
    val rawTimeline = selectedId?.let { records[it] }.orEmpty()
    val timeline = remember(rawTimeline) { resolvePermissionCardStates(rawTimeline) }
    val lease = selectedId?.let { leases[it] }
    var message by remember { mutableStateOf("") }
    var pendingMessage by remember { mutableStateOf<String?>(null) }
    var pendingSessionId by remember { mutableStateOf<String?>(null) }
    var pendingRequestId by remember { mutableStateOf<String?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var rawControls by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.onVisible()
            if (event == Lifecycle.Event.ON_PAUSE) viewModel.onHidden()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            viewModel.onHidden()
        }
    }
    LaunchedEffect(timeline.size) {
        if (timeline.isNotEmpty() && (!listState.canScrollForward || pendingMessage != null)) {
            listState.animateScrollToItem(timeline.lastIndex)
        }
    }
    LaunchedEffect(viewModel) {
        viewModel.commandResults.collect { result ->
            if (result.requestId == pendingRequestId && result.command == "input") {
                if (message == pendingMessage) message = ""
                pendingMessage = null
                pendingRequestId = null
            }
        }
    }
    LaunchedEffect(error) {
        val currentError = error
        if (currentError != null &&
            (currentError.requestId == null || currentError.requestId == pendingRequestId) &&
            (currentError.sessionId == null || currentError.sessionId == pendingSessionId)
        ) {
            pendingMessage = null
            pendingRequestId = null
        }
    }
    LaunchedEffect(connectionState) {
        if (!connectionState.isConnected) {
            pendingMessage = null
            pendingRequestId = null
        }
    }

    Scaffold(
        containerColor = ClawdBackgroundDark,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.console_title)) },
                navigationIcon = { TextButton(onClick = { navController.popBackStack() }) { Text("‹") } },
                actions = {
                    if (selected != null && lease?.granted == true) {
                        TextButton(onClick = { viewModel.interrupt(selected.id) }) {
                            Text(stringResource(R.string.console_interrupt))
                        }
                    }
                    if (syncEnabled) TextButton(onClick = { showCreate = true }) { Text("+") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (!syncEnabled) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.console_disabled))
                }
                return@Column
            }

            SessionPicker(sessions, selectedId) { viewModel.selectSession(it) }
            error?.takeIf { it.sessionId == null || it.sessionId == selectedId }?.let {
                val message = if (it.code == "input_too_large") {
                    stringResource(R.string.console_error_input_too_large)
                } else it.code
                Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            if (selected == null) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.console_no_sessions))
                        Button(onClick = { showCreate = true }) {
                            Text(stringResource(R.string.console_new_session))
                        }
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(timeline, key = { it.sequence }) { record ->
                        Box(
                            modifier = Modifier.fillMaxWidth(),
                            contentAlignment = if (record.kind == "user_input") Alignment.CenterEnd else Alignment.CenterStart,
                        ) { ConsoleMessageCard(record) }
                    }
                }

                if (lease?.granted != true) {
                    Surface(tonalElevation = 2.dp) {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                stringResource(
                                    if (lease?.owner == null) R.string.console_acquire_control else R.string.console_read_only
                                ),
                                modifier = Modifier.weight(1f),
                                fontSize = 12.sp,
                            )
                            Button(onClick = { viewModel.acquireLease(selected.id) }) {
                                Text(stringResource(R.string.console_acquire_control))
                            }
                        }
                    }
                }

                if (rawControls && lease?.granted == true) {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        listOf("Ctrl+C" to "\u0003", "↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C", "Tab" to "\t")
                            .forEach { (label, data) -> OutlinedButton(onClick = { viewModel.raw(selected.id, data) }) { Text(label) } }
                    }
                }

                Row(
                    Modifier.fillMaxWidth().imePadding().padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    TextButton(onClick = { rawControls = !rawControls }) { Text(">_") }
                    OutlinedTextField(
                        value = message,
                        onValueChange = { message = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text(stringResource(R.string.console_message_hint)) },
                        enabled = lease?.granted == true,
                        maxLines = 4,
                    )
                    Button(
                        enabled = lease?.granted == true && message.isNotBlank() && pendingMessage == null,
                        onClick = {
                            val value = message.trim()
                            val requestId = viewModel.send(selected.id, value)
                            if (requestId != null) {
                                pendingMessage = value
                                pendingSessionId = selected.id
                                pendingRequestId = requestId
                                scope.launch { listState.animateScrollToItem((timeline.size - 1).coerceAtLeast(0)) }
                            }
                        },
                    ) { Text(stringResource(R.string.console_send)) }
                }
            }
        }
    }

    if (showCreate) {
        CreateSessionSheet(
            agents = capabilities.agents,
            directories = capabilities.directories,
            onDismiss = { showCreate = false },
            onCreate = { agentId, cwd -> viewModel.createSession(agentId, cwd) },
        )
    }

    pendingApprovals.firstOrNull()?.let { request ->
        ModalBottomSheet(
            onDismissRequest = { request.requestId?.let(approvalViewModel::dismissRequest) },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            ApprovalSheet(
                request = request,
                sessionName = sessions.firstOrNull { it.id == request.sessionId }?.title ?: request.sessionId,
                remainingSeconds = approvalCountdowns[request.requestId] ?: 0,
                onApprove = approvalViewModel::approve,
                onDeny = approvalViewModel::deny,
                onSuggestion = approvalViewModel::approveWithSuggestion,
                onElicitation = approvalViewModel::submitElicitation,
            )
        }
    }
}

@Composable
private fun SessionPicker(
    sessions: List<ManagedSession>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(sessions, key = { it.id }) { session ->
            FilterChip(
                selected = session.id == selectedId,
                onClick = { onSelect(session.id) },
                label = {
                    Column {
                        Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(session.agentId, fontSize = 10.sp)
                    }
                },
            )
        }
    }
}

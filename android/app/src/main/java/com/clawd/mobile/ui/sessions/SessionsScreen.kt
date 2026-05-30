package com.clawd.mobile.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.util.Log
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.RecentEvent
import com.clawd.mobile.data.Session
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.data.parseHexColor
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.ClawdWebSocket

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    navController: NavController,
    webSocket: ClawdWebSocket,
    approvalViewModel: ApprovalViewModel,
    prefsStore: PrefsStore
) {
    val connectionState by webSocket.connectionState.collectAsState()
    val sessionsMap by webSocket.sessions.collectAsState()
    val syncing by webSocket.syncing.collectAsState()
    val pendingRequests by approvalViewModel.pendingRequests.collectAsState()
    val countdowns by approvalViewModel.countdowns.collectAsState()
    val notificationRequestId by approvalViewModel.notificationRequestId.collectAsState()

    val sessions = remember(sessionsMap) {
        sessionsMap.map { (id, data) -> Session(id, data) }
            .filter { it.data.isVisible }
            .sortedWith(compareBy<Session> { Session.STATE_PRIORITY[it.data.state] ?: 6 }
                .thenByDescending { it.data.updatedAt ?: 0L })
    }

    val isConnected = connectionState == ConnectionState.CONNECTED

    LaunchedEffect(syncing, sessionsMap.size) {
        Log.d("SessionsScreen", "syncing=$syncing sessions=${sessionsMap.size} connected=$isConnected")
    }

    val currentRequest = pendingRequests.firstOrNull()
    var showSheet by remember { mutableStateOf(false) }

    LaunchedEffect(pendingRequests.size) {
        Log.d("SessionsScreen", "autoShowSheet pendingSize=${pendingRequests.size} currentRid=${pendingRequests.firstOrNull()?.requestId}")
        showSheet = pendingRequests.isNotEmpty()
    }

    // Auto-show sheet when user taps a notification
    // Trigger on both notificationRequestId and pendingRequests changes
    // Only consume requestId when we actually show the sheet
    LaunchedEffect(notificationRequestId, pendingRequests.size) {
        val rid = notificationRequestId
        Log.d("SessionsScreen", "notificationLaunchedEffect rid=$rid pendingSize=${pendingRequests.size}")
        if (rid != null && pendingRequests.any { it.requestId == rid }) {
            Log.d("SessionsScreen", "Exact match found, showing sheet")
            showSheet = true
            approvalViewModel.consumeNotificationRequestId()
        } else if (rid != null && pendingRequests.isNotEmpty()) {
            Log.d("SessionsScreen", "Fallback: showing first pending request")
            showSheet = true
            approvalViewModel.consumeNotificationRequestId()
        }
        // If rid != null but pendingRequests is empty, don't consume —
        // wait for SSE to deliver the permission request
    }

    // Bottom nav selected tab
    var selectedTab by remember { mutableStateOf(0) }

    // Devices placeholder dialog
    var showDevicesPlaceholder by remember { mutableStateOf(false) }

    // Reset tab to "会话" when screen resumes
    LaunchedEffect(Unit) {
        navController.currentBackStackEntryFlow.collect {
            selectedTab = 0
        }
    }

    Scaffold(
        containerColor = ClawdBgDark
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // Fixed TopBar with connection status
            FixedTopBar(isConnected = isConnected)

            // Main content
            if (syncing && sessions.isEmpty()) {
                Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(32.dp),
                            color = ClawdAccent,
                            strokeWidth = 3.dp
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Text("正在同步...", fontSize = 14.sp, color = ClawdFaintDark)
                    }
                }
            } else if (connectionState == ConnectionState.DISCONNECTED && sessions.isEmpty()) {
                Box(modifier = Modifier.weight(1f)) {
                    EmptyState(
                        onScan = { navController.navigate("settings") },
                        onManual = { navController.navigate("settings") }
                    )
                }
            } else {
                Column(modifier = Modifier.weight(1f)) {
                    SectionLabel(title = "活跃会话", count = sessions.size)

                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(0.dp)
                    ) {
                        items(sessions, key = { it.id }) { session ->
                            SessionCard(
                                session = session,
                                prefsStore = prefsStore,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)
                            )
                        }
                    }
                }
            }

            // Bottom navigation
            BottomNav(
                selectedTab = selectedTab,
                onTabSelected = { tab ->
                    selectedTab = tab
                    when (tab) {
                        1 -> { showDevicesPlaceholder = true }
                        2 -> navController.navigate("settings")
                    }
                }
            )
        }

        // Devices placeholder dialog
        if (showDevicesPlaceholder) {
            AlertDialog(
                onDismissRequest = {
                    showDevicesPlaceholder = false
                    selectedTab = 0
                },
                containerColor = ClawdCardDark,
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(ClawdIcons.DeviceDesktop, null, tint = ClawdAccent, modifier = Modifier.size(20.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("设备", color = ClawdTextDark)
                    }
                },
                text = {
                    Text(
                        "未来中继服务，敬请期待。\n\n中继服务将支持通过云端中继连接 PC 端，无需处于同一局域网。",
                        fontSize = 13.sp,
                        color = ClawdFaintDark
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        showDevicesPlaceholder = false
                        selectedTab = 0
                    }) {
                        Text("知道了", color = ClawdAccent)
                    }
                }
            )
        }

        // Approval bottom sheet
        if (showSheet && currentRequest != null) {
            ModalBottomSheet(
                onDismissRequest = {
                    showSheet = false
                    currentRequest.requestId?.let { approvalViewModel.dismissRequest(it) }
                },
                containerColor = ClawdCardDark,
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
            ) {
                ApprovalSheet(
                    request = currentRequest,
                    sessionName = resolveSessionName(currentRequest.sessionId, sessionsMap, prefsStore),
                    remainingSeconds = countdowns[currentRequest.requestId] ?: 0,
                    onApprove = { requestId -> approvalViewModel.approve(requestId) },
                    onDeny = { requestId -> approvalViewModel.deny(requestId) },
                    onSuggestion = { requestId, index -> approvalViewModel.approveWithSuggestion(requestId, index) },
                    onElicitation = { requestId, value -> approvalViewModel.submitElicitation(requestId, value) }
                )
            }
        }
    }
}

// ─── Fixed TopBar ─────────────────────────────────────────────────

@Composable
private fun FixedTopBar(isConnected: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Brand
        Text(
            text = "CLAWD",
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = ClawdAccent,
            letterSpacing = 0.6.sp
        )
        Text(
            text = " Mobile",
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = ClawdTextDark
        )

        Spacer(modifier = Modifier.weight(1f))

        // Connection status dot + text
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(if (isConnected) ClawdGreenBright else ClawdFaintDark)
        )
        Text(
            text = if (isConnected) "已连接" else "未连接",
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = if (isConnected) ClawdGreenBright else ClawdFaintDark,
            modifier = Modifier.padding(start = 6.dp)
        )
    }
}

// ─── Section Label ────────────────────────────────────────────────

@Composable
private fun SectionLabel(title: String, count: Int) {
    Text(
        text = "$title · $count",
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = ClawdMuted,
        letterSpacing = 0.5.sp,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 0.dp)
            .padding(bottom = 8.dp)
    )
}

// ─── Session Card ─────────────────────────────────────────────────

@Composable
private fun SessionCard(session: Session, prefsStore: PrefsStore, modifier: Modifier = Modifier) {
    val data = session.data
    var expanded by remember { mutableStateOf(false) }
    val hasEvents = data.recentEvents.isNotEmpty()

    // Rename state
    var showRenameDialog by remember { mutableStateOf(false) }
    var customName by remember { mutableStateOf(prefsStore.getSessionName(session.id) ?: "") }

    // Display name: custom > desktop-provided displayTitle > agentId
    val displayName = customName.ifBlank { null }
        ?: data.displayTitle
        ?: data.agentId
        ?: ""

    // All visual state from desktop — zero inference
    val chipText = data.chipText
    val chipColor = parseHexColor(data.chipColor) ?: ClawdMutedDark
    val dotColor = parseHexColor(data.dotColor) ?: ClawdSubtleDark

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = ClawdCardDark),
        border = BorderStroke(0.5.dp, ClawdCardBorderDark)
    ) {
        Column(modifier = Modifier.padding(14.dp, 12.dp, 14.dp, 10.dp)) {
            // Header row: [status-dot] [title] [chip] [elapsed] — matches PC HUD
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Status dot (badge-colored, matches PC HUD)
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(dotColor)
                )
                // Title
                Text(
                    text = displayName,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = ClawdTextDark,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .padding(start = 8.dp)
                        .weight(1f, fill = false)
                )
                // State chip — from desktop, direct mapping
                if (chipText != null) {
                    Text(
                        text = chipText,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        color = chipColor,
                        modifier = Modifier
                            .padding(start = 6.dp)
                            .border(0.5.dp, chipColor.copy(alpha = 0.3f), RoundedCornerShape(4.dp))
                            .background(chipColor.copy(alpha = 0.12f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }
                // Elapsed time (matches PC HUD)
                Text(
                    text = formatAgo(data.updatedAt),
                    fontSize = 11.sp,
                    color = ClawdFaintDark,
                    modifier = Modifier.padding(start = 6.dp)
                )
                // Rename icon
                Icon(
                    ClawdIcons.Pencil,
                    "重命名",
                    tint = ClawdFaintDark,
                    modifier = Modifier
                        .padding(start = 4.dp)
                        .size(13.dp)
                        .clickable { showRenameDialog = true }
                )
            }

            // Rename dialog
            if (showRenameDialog) {
                var editName by remember { mutableStateOf(customName) }
                AlertDialog(
                    onDismissRequest = { showRenameDialog = false },
                    containerColor = ClawdCardDark,
                    title = { Text("重命名会话", color = ClawdTextDark) },
                    text = {
                        OutlinedTextField(
                            value = editName,
                            onValueChange = { editName = it },
                            placeholder = { Text(data.displayTitle ?: data.agentId ?: "", color = ClawdFaintDark) },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = ClawdTextDark,
                                unfocusedTextColor = ClawdTextDark,
                                focusedBorderColor = ClawdAccent,
                                unfocusedBorderColor = ClawdBorderDark,
                                cursorColor = ClawdAccent,
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            customName = editName.trim()
                            if (customName.isBlank()) {
                                prefsStore.clearSessionName(session.id)
                            } else {
                                prefsStore.saveSessionName(session.id, customName)
                            }
                            showRenameDialog = false
                        }) {
                            Text("保存", color = ClawdAccent)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showRenameDialog = false }) {
                            Text("取消", color = ClawdMutedDark)
                        }
                    }
                )
            }

            // Meta row: agent icon + agentId divider folder + cwd
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (data.agentId != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        Icon(ClawdIcons.Robot, null, tint = ClawdFaintDark, modifier = Modifier.size(11.dp))
                        Text(
                            "Agent",
                            fontSize = 11.sp,
                            color = ClawdFaintDark
                        )
                    }
                }
                if (!data.cwd.isNullOrBlank()) {
                    // Divider
                    Box(modifier = Modifier.size(1.dp, 10.dp).background(ClawdDividerDark))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        Icon(ClawdIcons.Folder, null, tint = ClawdFaintDark, modifier = Modifier.size(11.dp))
                        Text(
                            shortPath(data.cwd),
                            fontSize = 11.sp,
                            color = ClawdFaintDark,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }

            // Last output preview
            val lastOut = data.lastOutput
            if (lastOut != null && lastOut.output.isNotBlank()) {
                Text(
                    text = lastOut.output,
                    fontSize = 12.sp,
                    color = ClawdMutedDark,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    lineHeight = 16.sp,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }

            // Divider
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp)
                    .height(0.5.dp)
                    .background(ClawdCardBorderDark)
            )

            // Footer: events label + count + chevron
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = hasEvents) { expanded = !expanded }
                    .padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(ClawdIcons.Activity, null, tint = ClawdFaintDark, modifier = Modifier.size(12.dp))
                    Text("最近事件", fontSize = 11.sp, color = ClawdFaintDark)
                    if (hasEvents) {
                        Text(
                            text = "${data.recentEvents.size}",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = ClawdMutedDark,
                            modifier = Modifier
                                .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(5.dp))
                                .background(Color(0xFF232330), RoundedCornerShape(5.dp))
                                .padding(horizontal = 7.dp, vertical = 2.dp)
                        )
                    }
                }
                if (hasEvents) {
                    Icon(
                        ClawdIcons.ChevronRight,
                        null,
                        tint = Color(0xFF3E3E46),
                        modifier = Modifier.size(14.dp)
                    )
                }
            }

            // Expandable event timeline
            AnimatedVisibility(
                visible = expanded && hasEvents,
                enter = expandVertically(),
                exit = shrinkVertically()
            ) {
                EventTimeline(events = data.recentEvents)
            }
        }
    }
}

// ─── Event Timeline ───────────────────────────────────────────────

private val EVENT_STATE_COLORS = mapOf(
    "error" to Color(0xFFEF4444),
    "attention" to Color(0xFFB45309),
    "working" to Color(0xFF16A34A),
    "juggling" to Color(0xFFB45309),
    "thinking" to Color(0xFF6366F1),
    "notification" to Color(0xFFB45309),
    "sweeping" to Color(0xFF71717A),
    "carrying" to Color(0xFF71717A),
    "idle" to Color(0xFF71717A),
    "sleeping" to Color(0xFFA1A1AA),
)

@Composable
private fun EventTimeline(events: List<RecentEvent>) {
    Column(
        modifier = Modifier.padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        events.forEach { event ->
            val eventColor = EVENT_STATE_COLORS[event.state] ?: EVENT_STATE_COLORS["idle"]!!
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(vertical = 3.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(eventColor)
                )
                Text(
                    Session.eventLabel(event.event),
                    fontSize = 11.sp,
                    color = ClawdFaintDark,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    formatAgo(event.at),
                    fontSize = 11.sp,
                    color = ClawdFaintDark
                )
            }
        }
    }
}

// ─── Bottom Navigation ────────────────────────────────────────────

@Composable
private fun BottomNav(selectedTab: Int, onTabSelected: (Int) -> Unit, modifier: Modifier = Modifier) {
    val tabs = listOf(
        Triple(ClawdIcons.LayoutList, "会话", 0),
        Triple(ClawdIcons.DeviceDesktop, "设备", 1),
        Triple(ClawdIcons.Settings, "设置", 2)
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 16.dp)
            .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(14.dp))
            .background(ClawdCardDark.copy(alpha = 0.95f), RoundedCornerShape(14.dp))
            .padding(vertical = 10.dp, horizontal = 8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly
    ) {
        tabs.forEachIndexed { _, (icon, label, index) ->
            val isActive = selectedTab == index
            Column(
                modifier = Modifier
                    .weight(1f)
                    .clickable { onTabSelected(index) }
                    .padding(vertical = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(
                    icon,
                    label,
                    tint = if (isActive) ClawdAccent else ClawdFaintDark,
                    modifier = Modifier.size(20.dp)
                )
                Text(
                    label,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (isActive) ClawdAccent else ClawdFaintDark,
                    letterSpacing = 0.2.sp
                )
            }
        }
    }
}

// ─── Approval Sheet ───────────────────────────────────────────────

@Composable
private fun ApprovalSheet(
    request: PermissionRequestData,
    sessionName: String?,
    remainingSeconds: Int,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onSuggestion: (String, Int) -> Unit,
    onElicitation: (String, String) -> Unit
) {
    val isElicitation = request.toolName == "elicitation"
    val requestId = request.requestId ?: return

    // Timeout for progress bar
    val timeoutMs = request.timeout.coerceIn(10_000, 300_000)
    val totalSec = (timeoutMs / 1000).toInt()
    val progress = if (totalSec > 0) remainingSeconds.toFloat() / totalSec else 0f

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 24.dp)
    ) {
        // Session name
        if (!sessionName.isNullOrBlank()) {
            Text(
                sessionName,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = ClawdTextDark,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(bottom = 12.dp)
        ) {
            Icon(
                ClawdIcons.Shield, null,
                modifier = Modifier.size(20.dp),
                tint = ClawdAccent
            )
            Text(
                request.agentId ?: "Agent",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClawdMutedDark,
                modifier = Modifier
                    .background(ClawdSurfaceAltDark, RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            )
            Spacer(modifier = Modifier.weight(1f))
            Text(
                if (isElicitation) "选择" else "权限",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClawdAccentLight
            )
        }

        // Countdown progress bar
        if (remainingSeconds > 0) {
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .padding(bottom = 8.dp)
                    .clip(RoundedCornerShape(2.dp)),
                color = if (remainingSeconds <= 10) ClawdError else ClawdAccent,
                trackColor = ClawdSurfaceAltDark,
            )
            Text(
                "${remainingSeconds}s",
                fontSize = 11.sp,
                color = if (remainingSeconds <= 10) ClawdError else ClawdFaintDark,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        if (!isElicitation && !request.toolName.isNullOrBlank()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(bottom = 8.dp)
            ) {
                Icon(ClawdIcons.Tool, null, modifier = Modifier.size(14.dp), tint = ClawdSubtleDark)
                Text(request.toolName, fontSize = 14.sp, color = ClawdTextDark)
            }
        }

        if (!request.toolInputSummary.isNullOrBlank()) {
            Text(
                request.toolInputSummary,
                fontSize = 12.sp,
                color = ClawdTextDark,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        color = ClawdSurfaceAltDark,
                        shape = RoundedCornerShape(8.dp)
                    )
                    .padding(8.dp)
                    .padding(bottom = 8.dp)
            )
        }

        if (isElicitation && request.elicitationOptions.isNotEmpty()) {
            request.elicitationOptions.forEach { option ->
                Button(
                    onClick = { onElicitation(requestId, option.value) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ClawdAccent.copy(alpha = 0.15f),
                        contentColor = ClawdAccentLight
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(option.label, modifier = Modifier.padding(vertical = 4.dp))
                }
            }
        }

        val hasSuggestions = request.suggestions.isNotEmpty() && request.suggestions.all { it.label.isNotBlank() }

        if (hasSuggestions) {
            request.suggestions.forEachIndexed { index, suggestion ->
                val isAutoAccept = suggestion.mode == "acceptEdits" || suggestion.label.contains("accept", ignoreCase = true)
                val isAllow = suggestion.behavior == "allow"
                Button(
                    onClick = { onSuggestion(requestId, index) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = when {
                            isAutoAccept -> Color(0xFF52525B).copy(alpha = 0.15f)
                            isAllow -> ClawdGreenBright.copy(alpha = 0.15f)
                            else -> ClawdError.copy(alpha = 0.15f)
                        },
                        contentColor = when {
                            isAutoAccept -> Color(0xFF71717A)
                            isAllow -> ClawdGreenBright
                            else -> ClawdError
                        }
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(suggestion.label, modifier = Modifier.padding(vertical = 4.dp))
                }
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Button(
                    onClick = { onDeny(requestId) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ClawdError.copy(alpha = 0.15f),
                        contentColor = ClawdError
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text("拒绝", modifier = Modifier.padding(vertical = 4.dp))
                }
                Button(
                    onClick = { onApprove(requestId) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ClawdGreenBright.copy(alpha = 0.15f),
                        contentColor = ClawdGreenBright
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text("允许", modifier = Modifier.padding(vertical = 4.dp))
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
    }
}

// ─── Empty State ──────────────────────────────────────────────────

@Composable
private fun EmptyState(onScan: () -> Unit, onManual: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize().background(ClawdBgDark),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                ClawdIcons.Paw, null,
                modifier = Modifier.size(64.dp),
                tint = ClawdFaintDark
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text("扫码配对开始监控", fontSize = 15.sp, color = ClawdMutedDark)
            Spacer(modifier = Modifier.height(8.dp))
            Text("前往「设置」扫码或手动连接", fontSize = 12.sp, color = ClawdFaintDark)
            Spacer(modifier = Modifier.height(24.dp))
            Button(
                onClick = onScan,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ClawdAccent,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(10.dp)
            ) {
                Text("前往设置")
            }
        }
    }
}

// ─── Utils ────────────────────────────────────────────────────────

private fun shortPath(p: String): String {
    val parts = p.split("/", "\\")
    return if (parts.size > 3) ".../${parts.takeLast(2).joinToString("/")}" else p
}

private fun resolveSessionName(
    sessionId: String?,
    sessionsMap: Map<String, com.clawd.mobile.data.SessionData>,
    prefsStore: PrefsStore
): String? {
    if (sessionId == null) return null
    prefsStore.getSessionName(sessionId)?.let { return it }
    sessionsMap[sessionId]?.let { data ->
        data.displayTitle?.let { return it }
        data.agentId?.let { return it }
    }
    return sessionId
}

private fun formatAgo(ts: Long?): String {
    if (ts == null) return ""
    val sec = (System.currentTimeMillis() - ts) / 1000
    return when {
        sec < 5 -> "刚刚"
        sec < 60 -> "${sec}秒前"
        sec < 3600 -> "${sec / 60}分钟前"
        else -> "${sec / 3600}小时前"
    }
}

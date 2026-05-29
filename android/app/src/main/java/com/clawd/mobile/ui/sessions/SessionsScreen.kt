package com.clawd.mobile.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.RecentEvent
import com.clawd.mobile.data.Session
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.ClawdWebSocket

/** Resolve iconKey to ImageVector */
private fun iconFor(key: String): ImageVector = when (key) {
    "error" -> ClawdIcons.Error
    "attention" -> ClawdIcons.Attention
    "working" -> ClawdIcons.Working
    "juggling" -> ClawdIcons.Juggling
    "thinking" -> ClawdIcons.Thinking
    "notification" -> ClawdIcons.Notification
    "sweeping" -> ClawdIcons.Sweeping
    "carrying" -> ClawdIcons.Carrying
    "idle" -> ClawdIcons.Idle
    "sleeping" -> ClawdIcons.Sleeping
    else -> ClawdIcons.Idle
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    navController: NavController,
    webSocket: ClawdWebSocket,
    approvalViewModel: ApprovalViewModel
) {
    val connectionState by webSocket.connectionState.collectAsState()
    val sessionsMap by webSocket.sessions.collectAsState()
    val pendingRequests by approvalViewModel.pendingRequests.collectAsState()

    val sessions = remember(sessionsMap) {
        sessionsMap.map { (id, data) -> Session(id, data) }
            .sortedWith(compareBy<Session> { it.stateConfig.priority }
                .thenByDescending { it.data.updatedAt ?: 0 })
    }

    val isConnected = connectionState == ConnectionState.CONNECTED
    val hostLabel = if (isConnected) {
        webSocket.currentHost?.let { host ->
            webSocket.currentPort?.let { port -> "$host:$port" }
        } ?: ""
    } else ""

    val currentRequest = pendingRequests.firstOrNull()
    var showSheet by remember { mutableStateOf(false) }

    LaunchedEffect(pendingRequests.size) {
        showSheet = pendingRequests.isNotEmpty()
    }

    // Bottom nav selected tab
    var selectedTab by remember { mutableStateOf(0) }

    // Reset tab to "会话" when screen resumes (e.g. returning from scan/manual)
    LaunchedEffect(Unit) {
        navController.currentBackStackEntryFlow.collect {
            selectedTab = 0
        }
    }

    Scaffold(
        containerColor = ClawdBgDark
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            if (connectionState == ConnectionState.DISCONNECTED && sessions.isEmpty()) {
                EmptyState(
                    onScan = { navController.navigate("scan") },
                    onManual = { navController.navigate("manual") }
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 100.dp),
                    verticalArrangement = Arrangement.spacedBy(0.dp)
                ) {
                    // TopBar
                    item { TopBar(onScan = { navController.navigate("scan") }, onSettings = { navController.navigate("manual") }) }

                    // Connection badge
                    item {
                        ConnectionBadge(isConnected = isConnected, hostLabel = hostLabel)
                    }

                    // Section label
                    item {
                        SectionLabel(title = "活跃会话", count = sessions.size)
                    }

                    // Session cards
                    items(sessions, key = { it.id }) { session ->
                        SessionCard(
                            session = session,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)
                        )
                    }

                    // Action row
                    item {
                        ActionRow(modifier = Modifier.padding(top = 10.dp))
                    }
                }
            }

            // Bottom navigation
            BottomNav(
                selectedTab = selectedTab,
                onTabSelected = { tab ->
                    selectedTab = tab
                    when (tab) {
                        1 -> { /* 通知 — 暂无功能 */ }
                        2 -> navController.navigate("scan")
                        3 -> navController.navigate("manual")
                    }
                },
                modifier = Modifier.align(Alignment.BottomCenter)
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
                    onApprove = { requestId -> approvalViewModel.approve(requestId) },
                    onDeny = { requestId -> approvalViewModel.deny(requestId) },
                    onSuggestion = { requestId, index -> approvalViewModel.approveWithSuggestion(requestId, index) },
                    onElicitation = { requestId, value -> approvalViewModel.submitElicitation(requestId, value) }
                )
            }
        }
    }
}

// ─── TopBar ───────────────────────────────────────────────────────────

@Composable
private fun TopBar(onScan: () -> Unit, onSettings: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 20.dp, end = 12.dp, top = 18.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Left: brand
        Column {
            Text(
                text = "CLAWD",
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                color = ClawdAccent,
                letterSpacing = 0.6.sp
            )
            Text(
                text = "Mobile",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = ClawdTextDark,
                modifier = Modifier.padding(top = 1.dp)
            )
        }

        // Right: QR + Settings buttons
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconButton(
                onClick = onScan,
                modifier = Modifier
                    .size(36.dp)
                    .border(0.5.dp, ClawdBorderDark, RoundedCornerShape(10.dp))
                    .clip(RoundedCornerShape(10.dp))
                    .background(ClawdIconBtnBg)
            ) {
                Icon(
                    ClawdIcons.QrCode,
                    "扫码",
                    tint = ClawdMutedDark,
                    modifier = Modifier.size(16.dp)
                )
            }
            IconButton(
                onClick = onSettings,
                modifier = Modifier
                    .size(36.dp)
                    .border(0.5.dp, ClawdBorderDark, RoundedCornerShape(10.dp))
                    .clip(RoundedCornerShape(10.dp))
                    .background(ClawdIconBtnBg)
            ) {
                Icon(
                    ClawdIcons.Settings,
                    "设置",
                    tint = ClawdMutedDark,
                    modifier = Modifier.size(16.dp)
                )
            }
        }
    }
}

// ─── Connection Badge ─────────────────────────────────────────────────

@Composable
private fun ConnectionBadge(isConnected: Boolean, hostLabel: String) {
    // Breathing dot animation (matches HTML mockup: 2s pulse, opacity 1→0.4)
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val dotAlpha by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = if (isConnected) 0.4f else 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2000),
            repeatMode = RepeatMode.Reverse
        ),
        label = "dotAlpha"
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 0.dp)
            .padding(bottom = 14.dp)
            .border(0.5.dp, if (isConnected) ClawdGreenBorder else ClawdBorderDark, RoundedCornerShape(8.dp))
            .background(
                if (isConnected) ClawdGreenBg else ClawdCardDark.copy(alpha = 0.5f),
                RoundedCornerShape(8.dp)
            )
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Status dot with breathing animation
        Box(
            modifier = Modifier
                .size(7.dp)
                .graphicsLayer { alpha = dotAlpha }
                .clip(CircleShape)
                .background(if (isConnected) ClawdGreenBright else ClawdFaintDark)
        )
        // Text
        Text(
            text = if (isConnected) "已连接" else "未连接",
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = if (isConnected) ClawdGreenBright else ClawdFaintDark,
            modifier = Modifier.padding(start = 6.dp)
        )
        // Host:port
        if (hostLabel.isNotEmpty()) {
            Text(
                text = hostLabel,
                fontSize = 11.sp,
                color = ClawdMuted,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(start = 8.dp)
            )
        }
    }
}

// ─── Section Label ────────────────────────────────────────────────────

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

// ─── Session Card ─────────────────────────────────────────────────────

@Composable
private fun SessionCard(session: Session, modifier: Modifier = Modifier) {
    val config = session.stateConfig
    val data = session.data
    var expanded by remember { mutableStateOf(false) }
    val hasEvents = data.recentEvents.isNotEmpty()

    // Badge style based on state
    val badgeText = config.label
    val badgeBg = when (data.state) {
        "working", "juggling" -> ClawdGreenBright.copy(alpha = 0.18f)
        "notification" -> ClawdAccent.copy(alpha = 0.15f)
        "thinking" -> ClawdBlue.copy(alpha = 0.15f)
        else -> ClawdFaintDark.copy(alpha = 0.12f)
    }
    val badgeFg = when (data.state) {
        "working", "juggling" -> ClawdGreenBright
        "notification" -> ClawdAccent
        "thinking" -> ClawdBlue
        else -> ClawdMutedDark
    }
    val badgeBorder = when (data.state) {
        "working", "juggling" -> ClawdGreenBright.copy(alpha = 0.25f)
        "notification" -> ClawdAccent.copy(alpha = 0.3f)
        "thinking" -> ClawdBlue.copy(alpha = 0.3f)
        else -> ClawdBorderDark
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = ClawdCardDark),
        border = BorderStroke(0.5.dp, ClawdCardBorderDark)
    ) {
        Column(modifier = Modifier.padding(14.dp, 12.dp, 14.dp, 10.dp)) {
            // Card header: agent-dot + agent name + badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // Agent dot (5dp, accent color)
                    Box(
                        modifier = Modifier
                            .size(5.dp)
                            .clip(CircleShape)
                            .background(ClawdAccent)
                    )
                    // Agent name
                    Text(
                        text = (data.agentId ?: "agent").uppercase(),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = ClawdMuted,
                        letterSpacing = 0.4.sp,
                        modifier = Modifier.padding(start = 5.dp)
                    )
                }
                // Badge
                Text(
                    text = badgeText,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = badgeFg,
                    letterSpacing = 0.3.sp,
                    modifier = Modifier
                        .border(0.5.dp, badgeBorder, RoundedCornerShape(5.dp))
                        .background(badgeBg, RoundedCornerShape(5.dp))
                        .padding(horizontal = 8.dp, vertical = 3.dp)
                )
            }

            // Card title
            Text(
                text = data.sessionTitle ?: data.agentId ?: "",
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClawdTextDark,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
            )

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

// ─── Event Timeline ───────────────────────────────────────────────────

@Composable
private fun EventTimeline(events: List<RecentEvent>) {
    Column(
        modifier = Modifier.padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        events.forEach { event ->
            val eventConfig = Session.STATE_CONFIG[event.state] ?: Session.STATE_CONFIG["idle"]!!
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(vertical = 3.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(Color(eventConfig.color))
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

// ─── Action Row ───────────────────────────────────────────────────────

@Composable
private fun ActionRow(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        ActionButton(icon = ClawdIcons.Checks, label = "批量审批", modifier = Modifier.weight(1f))
        ActionButton(icon = ClawdIcons.Refresh, label = "刷新", modifier = Modifier.weight(1f))
        ActionButton(icon = ClawdIcons.History, label = "历史", modifier = Modifier.weight(1f))
    }
}

@Composable
private fun ActionButton(icon: ImageVector, label: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(12.dp))
            .background(ClawdCardDark, RoundedCornerShape(12.dp))
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Icon(icon, label, tint = ClawdMutedDark, modifier = Modifier.size(18.dp))
        Text(
            label,
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            color = ClawdMuted,
            letterSpacing = 0.3.sp
        )
    }
}

// ─── Bottom Navigation ────────────────────────────────────────────────

@Composable
private fun BottomNav(selectedTab: Int, onTabSelected: (Int) -> Unit, modifier: Modifier = Modifier) {
    val tabs = listOf(
        Triple(ClawdIcons.LayoutList, "会话", 0),
        Triple(ClawdIcons.Bell, "通知", 1),
        Triple(ClawdIcons.DeviceDesktop, "设备", 2),
        Triple(ClawdIcons.UserCircle, "我的", 3)
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 16.dp)
            .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(14.dp))
            .background(ClawdCardDark, RoundedCornerShape(14.dp))
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

// ─── Approval Sheet ───────────────────────────────────────────────────

@Composable
private fun ApprovalSheet(
    request: PermissionRequestData,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onSuggestion: (String, Int) -> Unit,
    onElicitation: (String, String) -> Unit
) {
    val isElicitation = request.toolName == "elicitation"
    val requestId = request.requestId ?: return

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 24.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(bottom = 16.dp)
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
                fontSize = 13.sp,
                color = ClawdMutedDark,
                modifier = Modifier.padding(bottom = 16.dp)
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
        } else if (request.suggestions.isNotEmpty()) {
            request.suggestions.forEachIndexed { index, suggestion ->
                val isAllow = suggestion.behavior == "allow"
                Button(
                    onClick = { onSuggestion(requestId, index) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isAllow) ClawdGreenBright.copy(alpha = 0.15f) else ClawdError.copy(alpha = 0.15f),
                        contentColor = if (isAllow) ClawdGreenBright else ClawdError
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

// ─── Empty State ──────────────────────────────────────────────────────

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
            Spacer(modifier = Modifier.height(24.dp))
            Button(
                onClick = onScan,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ClawdAccent,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(10.dp)
            ) {
                Icon(ClawdIcons.QrCode, null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("扫码配对")
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedButton(
                onClick = onManual,
                border = BorderStroke(0.5.dp, ClawdCardBorderDark),
                shape = RoundedCornerShape(10.dp)
            ) {
                Text("手动连接", color = ClawdMutedDark)
            }
        }
    }
}

// ─── Utils ────────────────────────────────────────────────────────────

private fun shortPath(p: String): String {
    val parts = p.split("/", "\\")
    return if (parts.size > 3) ".../${parts.takeLast(2).joinToString("/")}" else p
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

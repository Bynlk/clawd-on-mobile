package com.clawd.mobile.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.RecentEvent
import com.clawd.mobile.data.Session
import com.clawd.mobile.data.SessionData
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

    // Convert to sorted list
    val sessions = remember(sessionsMap) {
        sessionsMap.map { (id, data) -> Session(id, data) }
            .sortedWith(compareBy<Session> { it.stateConfig.priority }
                .thenByDescending { it.data.updatedAt ?: 0 })
    }

    // Connection dot color
    val connectionColor = when (connectionState) {
        ConnectionState.CONNECTED -> ClawdSuccess
        ConnectionState.CONNECTING, ConnectionState.RECONNECTING -> ClawdWarning
        else -> ClawdSubtleDark
    }

    // Host label
    val hostLabel = if (connectionState == ConnectionState.CONNECTED) {
        webSocket.currentHost?.let { host ->
            webSocket.currentPort?.let { port -> "$host:$port" }
        } ?: ""
    } else ""

    // Current request to show in bottom sheet (one at a time)
    val currentRequest = pendingRequests.firstOrNull()
    var showSheet by remember { mutableStateOf(false) }

    LaunchedEffect(pendingRequests.size) {
        showSheet = pendingRequests.isNotEmpty()
    }

    Scaffold { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            // Session list
            if (connectionState == ConnectionState.DISCONNECTED && sessions.isEmpty()) {
                EmptyState(
                    onScan = { navController.navigate("scan") },
                    onManual = { navController.navigate("manual") }
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 56.dp + WindowInsets.statusBars.asPaddingValues().calculateTopPadding(),
                        bottom = 16.dp
                    ),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(sessions, key = { it.id }) { session ->
                        SessionCard(session = session)
                    }
                }
            }

            // Floating header (top-right)
            Row(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 12.dp, end = 12.dp)
                    .statusBarsPadding(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Connection dot
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(connectionColor)
                )
                // Host label
                if (hostLabel.isNotEmpty()) {
                    Text(
                        text = hostLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = ClawdSubtleDark,
                        fontFamily = FontFamily.Monospace
                    )
                }
                // Scan button
                IconButton(
                    onClick = { navController.navigate("scan") },
                    modifier = Modifier
                        .size(36.dp)
                        .border(1.dp, ClawdBorderDark, RoundedCornerShape(8.dp))
                        .clip(RoundedCornerShape(8.dp))
                        .background(ClawdSurfaceDark)
                ) {
                    Icon(
                        Icons.Default.QrCodeScanner,
                        "扫码",
                        tint = ClawdMutedDark,
                        modifier = Modifier.size(18.dp)
                    )
                }
                // Settings button
                IconButton(
                    onClick = { navController.navigate("manual") },
                    modifier = Modifier
                        .size(36.dp)
                        .border(1.dp, ClawdBorderDark, RoundedCornerShape(8.dp))
                        .clip(RoundedCornerShape(8.dp))
                        .background(ClawdSurfaceDark)
                ) {
                    Icon(
                        ClawdIcons.Working, // gear icon
                        "设置",
                        tint = ClawdMutedDark,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }

        // Approval bottom sheet
        if (showSheet && currentRequest != null) {
            ModalBottomSheet(
                onDismissRequest = {
                    showSheet = false
                    currentRequest.requestId?.let { approvalViewModel.dismissRequest(it) }
                },
                containerColor = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
            ) {
                ApprovalSheet(
                    request = currentRequest,
                    onApprove = { requestId ->
                        approvalViewModel.approve(requestId)
                    },
                    onDeny = { requestId ->
                        approvalViewModel.deny(requestId)
                    },
                    onSuggestion = { requestId, index ->
                        approvalViewModel.approveWithSuggestion(requestId, index)
                    },
                    onElicitation = { requestId, value ->
                        approvalViewModel.submitElicitation(requestId, value)
                    }
                )
            }
        }
    }
}

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
        // Header
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(bottom = 16.dp)
        ) {
            Icon(
                imageVector = ClawdIcons.Shield,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = ClawdAccent
            )
            Text(
                request.agentId ?: "Agent",
                style = MaterialTheme.typography.labelMedium,
                color = ClawdMutedDark,
                modifier = Modifier
                    .background(ClawdSurfaceAltDark, RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            )
            Spacer(modifier = Modifier.weight(1f))
            Text(
                if (isElicitation) "选择" else "权限",
                style = MaterialTheme.typography.labelSmall,
                color = ClawdAccentLight
            )
        }

        // Tool / prompt info
        if (!isElicitation && !request.toolName.isNullOrBlank()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(bottom = 8.dp)
            ) {
                Icon(ClawdIcons.Tool, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawdSubtleDark)
                Text(request.toolName, style = MaterialTheme.typography.bodyMedium, color = ClawdTextDark)
            }
        }

        // Summary / prompt
        if (!request.toolInputSummary.isNullOrBlank()) {
            Text(
                request.toolInputSummary,
                style = MaterialTheme.typography.bodySmall,
                color = ClawdMutedDark,
                modifier = Modifier.padding(bottom = 16.dp),
                lineHeight = MaterialTheme.typography.bodySmall.lineHeight
            )
        }

        // Action buttons
        if (isElicitation && request.elicitationOptions.isNotEmpty()) {
            request.elicitationOptions.forEachIndexed { index, option ->
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
                val containerColor = if (isAllow) ClawdSuccess.copy(alpha = 0.15f) else ClawdError.copy(alpha = 0.15f)
                val contentColor = if (isAllow) ClawdSuccess else ClawdError

                Button(
                    onClick = { onSuggestion(requestId, index) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = containerColor,
                        contentColor = contentColor
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(
                        suggestion.label,
                        modifier = Modifier.padding(vertical = 4.dp),
                        style = MaterialTheme.typography.bodyMedium
                    )
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
                        containerColor = ClawdSuccess.copy(alpha = 0.15f),
                        contentColor = ClawdSuccess
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

@Composable
private fun EmptyState(onScan: () -> Unit, onManual: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                imageVector = ClawdIcons.Paw,
                contentDescription = null,
                modifier = Modifier.size(64.dp),
                tint = ClawdSubtleDark
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text("扫码配对开始监控", style = MaterialTheme.typography.bodyLarge, color = ClawdMutedDark)
            Spacer(modifier = Modifier.height(24.dp))
            Button(onClick = onScan) {
                Icon(Icons.Default.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("扫码配对")
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedButton(onClick = onManual) {
                Text("手动连接")
            }
        }
    }
}

@Composable
private fun SessionCard(session: Session) {
    val config = session.stateConfig
    val data = session.data
    var expanded by remember { mutableStateOf(false) }
    val hasEvents = data.recentEvents.isNotEmpty()
    val isActive = data.state == "working" || data.state == "thinking" || data.state == "juggling"

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, ClawdBorderDark)
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Status dot (7dp)
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(Color(config.color))
            )

            // Main content
            Column(modifier = Modifier.weight(1f)) {
                // Title
                Text(
                    text = data.sessionTitle ?: data.agentId ?: "",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )

                // Meta row
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (data.agentId != null) {
                        Text(
                            text = data.agentId,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = ClawdMutedDark,
                            modifier = Modifier
                                .background(ClawdSurfaceAltDark, RoundedCornerShape(4.dp))
                                .padding(horizontal = 4.dp, vertical = 1.dp)
                        )
                    }
                    Text(
                        text = config.label,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = Color(config.color)
                    )
                }

                // Tool info
                if (!data.toolName.isNullOrBlank()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(ClawdIcons.Tool, null, tint = ClawdMutedDark, modifier = Modifier.size(14.dp))
                        Text(data.toolName, style = MaterialTheme.typography.labelSmall, color = ClawdMutedDark)
                    }
                }

                // CWD
                if (!data.cwd.isNullOrBlank()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(ClawdIcons.Folder, null, tint = ClawdMutedDark, modifier = Modifier.size(14.dp))
                        Text(
                            shortPath(data.cwd),
                            style = MaterialTheme.typography.labelSmall,
                            color = ClawdSubtleDark,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }

                // Expand trigger
                if (hasEvents) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { expanded = !expanded }
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(
                            imageVector = if (expanded) ClawdIcons.Collapse else ClawdIcons.Expand,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = ClawdSubtleDark
                        )
                        Text(
                            "最近事件 (${data.recentEvents.size})",
                            style = MaterialTheme.typography.labelSmall,
                            color = ClawdSubtleDark
                        )
                    }

                    AnimatedVisibility(
                        visible = expanded,
                        enter = expandVertically(),
                        exit = shrinkVertically()
                    ) {
                        EventTimeline(events = data.recentEvents)
                    }
                }

                // Updated time
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Icon(ClawdIcons.Clock, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawdSubtleDark)
                    Text(formatAgo(data.updatedAt), style = MaterialTheme.typography.labelSmall, color = ClawdSubtleDark)
                }
            }
        }
    }
}

@Composable
private fun EventTimeline(events: List<RecentEvent>) {
    Column(
        modifier = Modifier.padding(start = 4.dp, top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        events.forEach { event ->
            val eventConfig = Session.STATE_CONFIG[event.state] ?: Session.STATE_CONFIG["idle"]!!

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(vertical = 3.dp)
            ) {
                // Dot
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(Color(eventConfig.color))
                )
                // Label
                Text(
                    Session.eventLabel(event.event),
                    style = MaterialTheme.typography.bodySmall,
                    color = ClawdMutedDark,
                    modifier = Modifier.weight(1f)
                )
                // Time
                Text(
                    formatAgo(event.at),
                    style = MaterialTheme.typography.labelSmall,
                    color = ClawdSubtleDark
                )
            }
        }
    }
}

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

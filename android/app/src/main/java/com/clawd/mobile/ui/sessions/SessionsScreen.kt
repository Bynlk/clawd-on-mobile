package com.clawd.mobile.ui.sessions

import androidx.compose.foundation.background
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import android.util.Log
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.Session
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.SseClient

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    navController: NavController,
    webSocket: SseClient,
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
            .sortedWith(compareByDescending<Session> { Session.statePriority(it.data.state) }
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
                        Text(stringResource(R.string.status_syncing), fontSize = 14.sp, color = ClawdFaintDark)
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
                    SectionLabel(title = stringResource(R.string.sessions_active_title), count = sessions.size)

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
                        Text(stringResource(R.string.sessions_tab_devices), color = ClawdTextDark)
                    }
                },
                text = {
                    Text(
                        stringResource(R.string.sessions_relay_title),
                        fontSize = 13.sp,
                        color = ClawdFaintDark
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        showDevicesPlaceholder = false
                        selectedTab = 0
                    }) {
                        Text(stringResource(R.string.sessions_relay_ok), color = ClawdAccent)
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
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
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
                    onElicitation = { requestId, answers -> approvalViewModel.submitElicitation(requestId, answers) }
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
            text = if (isConnected) stringResource(R.string.status_connected) else stringResource(R.string.status_not_connected),
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
            Text(stringResource(R.string.sessions_empty_title), fontSize = 15.sp, color = ClawdMutedDark)
            Spacer(modifier = Modifier.height(8.dp))
            Text(stringResource(R.string.sessions_empty_subtitle), fontSize = 12.sp, color = ClawdFaintDark)
            Spacer(modifier = Modifier.height(24.dp))
            Button(
                onClick = onScan,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ClawdAccent,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(10.dp)
            ) {
                Text(stringResource(R.string.sessions_go_settings))
            }
        }
    }
}

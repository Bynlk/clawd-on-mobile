package com.clawd.mobile.ui.navigation

import android.util.Log
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.clawd.mobile.data.ConnectionRepository
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionRepository
import com.clawd.mobile.notification.StatusNotifier
import com.clawd.mobile.service.SseService
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.sessions.SessionsScreen
import com.clawd.mobile.ui.scan.ScanScreen
import com.clawd.mobile.ui.manual.ManualScreen
import com.clawd.mobile.ui.settings.SettingsScreen
import com.clawd.mobile.util.HttpClientProvider
import com.clawd.mobile.ws.CertFingerprintInfo
import com.clawd.mobile.ws.SseClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

@Composable
fun ClawdNavGraph() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val prefsStore = remember { PrefsStore.getInstance(context) }
    val statusNotifier = remember { StatusNotifier(context, prefsStore) }

    // Start foreground service
    LaunchedEffect(Unit) {
        SseService.start(context)
    }

    // Wait for service to provide SseClient, fallback to local instance
    var sseClient by remember { mutableStateOf<SseClient?>(null) }
    var wsRefreshKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(wsRefreshKey) {
        // Fast path: already available
        SseService.getClient()?.let {
            sseClient = it
            return@LaunchedEffect
        }
        // Wait for service to create SseClient (event-driven, no polling)
        val ws = withTimeoutOrNull(5_000L) {
            SseService.clientReady.first()
        }
        if (ws != null) {
            sseClient = ws
        } else if (sseClient == null) {
            // Fallback if service didn't start
            sseClient = SseClient(prefsStore)
        }
    }

    val ws = sseClient ?: return

    // Repositories — unified data access layer
    val sessionRepository = remember(ws) { SessionRepository(ws.sessions, prefsStore) }
    val connectionRepository = remember(ws) { ConnectionRepository(prefsStore, ws.connectionState) }

    // TOFU certificate confirmation dialog
    var pendingCert by remember { mutableStateOf<CertFingerprintInfo?>(null) }
    LaunchedEffect(ws) {
        ws.certFingerprintPending.collect { info ->
            pendingCert = info
        }
    }

    pendingCert?.let { cert ->
        AlertDialog(
            onDismissRequest = {
                pendingCert = null
                ws.disconnect()
            },
            title = { Text("证书确认") },
            text = {
                Text(
                    "正在连接到 ${cert.host}\n\n" +
                    "服务器证书指纹 (SHA-256):\n${cert.fingerprint}\n\n" +
                    "确认此指纹与服务器一致？"
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    prefsStore.setCertFingerprint(cert.fingerprint)
                    HttpClientProvider.setCertFingerprint(cert.fingerprint)
                    pendingCert = null
                }) { Text("信任并连接") }
            },
            dismissButton = {
                TextButton(onClick = {
                    pendingCert = null
                    ws.disconnect()
                }) { Text("取消") }
            }
        )
    }

    val approvalViewModel: ApprovalViewModel = viewModel(
        factory = ApprovalViewModel.Factory(context.applicationContext as android.app.Application, ws)
    )

    // Wire up pending approval check for StatusNotifier
    statusNotifier.hasPendingApprovals = { approvalViewModel.pendingRequests.value.isNotEmpty() }

    // Collect approval requests from notification taps via ClawdApp Channel
    LaunchedEffect(approvalViewModel) {
        for (request in com.clawd.mobile.ClawdApp.approvalChannel) {
            Log.d("NavGraph", "Received approval request from channel: id=${request.requestId}")
            approvalViewModel.restoreRequestFromNotification(request)
        }
    }

    // Try auto-reconnect to last connection
    LaunchedEffect(ws) {
        ws.reconnect()
    }

    // Unified notification: triggers on displayState OR sessions change
    val displayState by ws.displayState.collectAsState()
    val sessionsMap by ws.sessions.collectAsState()
    LaunchedEffect(displayState, sessionsMap) {
        statusNotifier.updateNotifications(displayState, sessionsMap)
    }

    NavHost(navController = navController, startDestination = "sessions") {
        composable("sessions") {
            SessionsScreen(
                navController = navController,
                sseClient = ws,
                approvalViewModel = approvalViewModel,
                prefsStore = prefsStore
            )
        }
        composable("scan") {
            ScanScreen(
                onBack = { navController.popBackStack() },
                onScanned = { config ->
                    SseService.start(context, config)
                    wsRefreshKey++
                    navController.navigate("sessions") {
                        popUpTo("sessions") { inclusive = true }
                    }
                }
            )
        }
        composable("manual") {
            ManualScreen(
                prefsStore = prefsStore,
                onBack = { navController.popBackStack() },
                onConnect = { config ->
                    SseService.start(context, config)
                    wsRefreshKey++
                    navController.navigate("sessions") {
                        popUpTo("sessions") { inclusive = true }
                    }
                }
            )
        }
        composable("settings") {
            SettingsScreen(
                navController = navController,
                sseClient = ws,
                prefsStore = prefsStore
            )
        }
    }
}

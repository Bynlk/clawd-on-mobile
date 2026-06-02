package com.clawd.mobile.ui.navigation

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.clawd.mobile.R
import com.clawd.mobile.data.ConnectionRepository
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionRepository
import com.clawd.mobile.notification.StatusNotifier
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.sessions.SessionsScreen
import com.clawd.mobile.ui.scan.ScanScreen
import com.clawd.mobile.ui.manual.ManualScreen
import com.clawd.mobile.ui.settings.SettingsScreen

@Composable
fun ClawdNavGraph() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val prefsStore = remember { PrefsStore.getInstance(context) }
    val statusNotifier = remember { StatusNotifier(context, prefsStore) }

    val serviceManager = remember { ServiceManager(context, kotlinx.coroutines.MainScope(), prefsStore, statusNotifier) }

    // Initialize: start service + acquire client + auto-reconnect
    LaunchedEffect(Unit) { serviceManager.initialize() }

    // Re-acquire client when refreshKey changes (QR/manual scan)
    var refreshKey by remember { mutableIntStateOf(0) }
    LaunchedEffect(refreshKey) { if (refreshKey > 0) serviceManager.refresh() }

    val ws = serviceManager.sseClient.collectAsState().value ?: return

    // Repositories
    val sessionRepository = remember(ws) { SessionRepository(ws.sessions, prefsStore) }
    val connectionRepository = remember(ws) { ConnectionRepository(prefsStore, ws.connectionState) }

    // TOFU certificate dialog
    val pendingCert by serviceManager.pendingCert.collectAsState()
    pendingCert?.let { cert ->
        AlertDialog(
            onDismissRequest = { serviceManager.rejectCert(ws) },
            title = { Text(stringResource(R.string.cert_confirm_title)) },
            text = {
                Text(
                    stringResource(R.string.cert_confirm_connecting_to, cert.host) + "\n\n" +
                    stringResource(R.string.cert_confirm_fingerprint, cert.fingerprint)
                )
            },
            confirmButton = {
                TextButton(onClick = { serviceManager.trustCert(cert) }) {
                    Text(stringResource(R.string.cert_confirm_trust))
                }
            },
            dismissButton = {
                TextButton(onClick = { serviceManager.rejectCert(ws) }) {
                    Text(stringResource(R.string.cert_confirm_cancel))
                }
            }
        )
    }

    // ViewModel
    val approvalViewModel: ApprovalViewModel = viewModel(
        factory = ApprovalViewModel.Factory(context.applicationContext as android.app.Application, ws)
    )

    // Wire up pending approval check + notification-tap routing
    statusNotifier.hasPendingApprovals = { approvalViewModel.pendingRequests.value.isNotEmpty() }
    serviceManager.onApprovalFromNotification = { request ->
        approvalViewModel.restoreRequestFromNotification(request)
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
                    serviceManager.startService(config)
                    refreshKey++
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
                    serviceManager.startService(config)
                    refreshKey++
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

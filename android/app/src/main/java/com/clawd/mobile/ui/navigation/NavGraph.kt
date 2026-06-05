package com.clawd.mobile.ui.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
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

    val scope = rememberCoroutineScope()
    val serviceManager = remember { ServiceManager(context, scope, prefsStore, statusNotifier) }

    // Initialize: start service + acquire client + auto-reconnect
    LaunchedEffect(Unit) { serviceManager.initialize() }

    // Clean up collectors when NavGraph leaves composition
    DisposableEffect(Unit) {
        onDispose { serviceManager.destroy() }
    }

    // Re-acquire client when refreshKey changes (QR/manual scan)
    var refreshKey by remember { mutableIntStateOf(0) }
    LaunchedEffect(refreshKey) { if (refreshKey > 0) serviceManager.refresh() }

    val ws = serviceManager.sseClient.collectAsState().value
    if (ws == null) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

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

    // Scaffold with SnackbarHost for error feedback
    val snackbarHostState = remember { SnackbarHostState() }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = "sessions",
            modifier = Modifier.padding(innerPadding)
        ) {
            composable("sessions") {
                val approvalViewModel: ApprovalViewModel = viewModel(
                    key = "approval_$refreshKey",
                    factory = ApprovalViewModel.Factory(context.applicationContext as android.app.Application, ws)
                )

                // Collect error events and show Snackbar
                LaunchedEffect(approvalViewModel) {
                    approvalViewModel.errorEvents.collect { message ->
                        snackbarHostState.showSnackbar(
                            message = message,
                            duration = SnackbarDuration.Short
                        )
                    }
                }

                // Wire up pending approval check + notification-tap routing
                statusNotifier.hasPendingApprovals = { approvalViewModel.pendingRequests.value.isNotEmpty() }
                serviceManager.onApprovalFromNotification = { request ->
                    approvalViewModel.restoreRequestFromNotification(request)
                }

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
                    prefsStore = prefsStore,
                    snackbarHostState = snackbarHostState
                )
            }
        }
    }
}

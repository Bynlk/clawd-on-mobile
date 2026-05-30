package com.clawd.mobile.ui.navigation

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.clawd.mobile.MainActivity
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.notification.StatusNotifier
import com.clawd.mobile.service.WebSocketService
import com.clawd.mobile.ui.approval.ApprovalViewModel
import com.clawd.mobile.ui.sessions.SessionsScreen
import com.clawd.mobile.ui.scan.ScanScreen
import com.clawd.mobile.ui.manual.ManualScreen
import com.clawd.mobile.ui.settings.SettingsScreen
import com.clawd.mobile.ws.ClawdWebSocket

@Composable
fun ClawdNavGraph() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val prefsStore = remember { PrefsStore(context) }
    val statusNotifier = remember { StatusNotifier(context, prefsStore) }

    // Start foreground service
    LaunchedEffect(Unit) {
        WebSocketService.start(context)
    }

    // Wait for service to provide WebSocket, fallback to local instance
    var webSocket by remember { mutableStateOf<ClawdWebSocket?>(null) }
    var wsRefreshKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(wsRefreshKey) {
        // Poll for service WebSocket
        repeat(50) { // 5 seconds max
            WebSocketService.getWebSocket()?.let {
                webSocket = it
                return@LaunchedEffect
            }
            kotlinx.coroutines.delay(100)
        }
        // Fallback if service didn't start
        if (webSocket == null) {
            webSocket = ClawdWebSocket(prefsStore)
        }
    }

    val ws = webSocket ?: return

    val approvalViewModel: ApprovalViewModel = viewModel(
        factory = ApprovalViewModel.Factory(context.applicationContext as android.app.Application, ws)
    )

    // Forward notification tap request ID to ViewModel (consumed by SessionsScreen)
    MainActivity.pendingApprovalRequestId?.let {
        approvalViewModel.setNotificationRequestId(it)
        MainActivity.pendingApprovalRequestId = null
    }

    // Try auto-reconnect to last connection
    LaunchedEffect(ws) {
        ws.reconnect()
    }

    // Monitor session changes for notifications
    LaunchedEffect(ws) {
        ws.sessions.collect { sessionsMap ->
            sessionsMap.forEach { (id, data) ->
                statusNotifier.onSessionUpdate(id, data)
            }
        }
    }

    NavHost(navController = navController, startDestination = "sessions") {
        composable("sessions") {
            SessionsScreen(
                navController = navController,
                webSocket = ws,
                approvalViewModel = approvalViewModel,
                prefsStore = prefsStore
            )
        }
        composable("scan") {
            ScanScreen(
                onBack = { navController.popBackStack() },
                onScanned = { config ->
                    WebSocketService.start(context, config)
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
                    WebSocketService.start(context, config)
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
                webSocket = ws,
                prefsStore = prefsStore
            )
        }
    }
}

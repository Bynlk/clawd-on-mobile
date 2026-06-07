package com.clawd.mobile.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ws.StreamingClient
import com.clawd.mobile.ws.ConnectionState

@Composable
fun SettingsScreen(
    navController: NavController,
    sseClient: StreamingClient,
    prefsStore: PrefsStore,
    snackbarHostState: SnackbarHostState? = null
) {
    val connectionState by sseClient.connectionState.collectAsState()
    val isConnected = connectionState == ConnectionState.CONNECTED

    Scaffold(
        containerColor = ClawdBackgroundDark,
        topBar = {
            SettingsTopBar(onBack = { navController.popBackStack() })
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 32.dp)
        ) {
            // Connection status card (always visible)
            ConnectionStatusCard(
                isConnected = isConnected,
                sseClient = sseClient,
                onScan = { navController.navigate("scan") },
                onManual = { navController.navigate("manual") }
            )
            Spacer(modifier = Modifier.height(8.dp))

            // Accordion sections
            AccordionSection(
                title = stringResource(R.string.settings_language),
                icon = ClawdIcons.Activity,
                defaultExpanded = false
            ) {
                LanguageSection(prefsStore = prefsStore)
            }

            AccordionSection(
                title = stringResource(R.string.settings_notification),
                icon = ClawdIcons.Bell,
                defaultExpanded = false
            ) {
                NotificationSection(prefsStore = prefsStore)
            }

            AccordionSection(
                title = stringResource(R.string.settings_pet),
                icon = ClawdIcons.Pet,
                defaultExpanded = true
            ) {
                FloatingPetSection(prefsStore = prefsStore, snackbarHostState = snackbarHostState)
            }

            AccordionSection(
                title = stringResource(R.string.settings_about),
                icon = ClawdIcons.Activity,
                defaultExpanded = false
            ) {
                AboutSection()
            }

            AccordionSection(
                title = stringResource(R.string.settings_debug_log),
                icon = ClawdIcons.Activity,
                defaultExpanded = false
            ) {
                DebugLogSection()
            }
        }
    }
}

// ─── Top Bar ──────────────────────────────────────────────────────

@Composable
private fun SettingsTopBar(onBack: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 8.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = onBack) {
            Icon(
                ClawdIcons.ChevronRight,
                stringResource(R.string.settings_back),
                tint = ClawdMutedDark,
                modifier = Modifier.size(20.dp).graphicsLayer(rotationZ = 180f)
            )
        }
        Text(
            stringResource(R.string.settings_title),
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            color = ClawdTextDark
        )
    }
}

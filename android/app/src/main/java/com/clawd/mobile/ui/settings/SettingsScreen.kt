package com.clawd.mobile.ui.settings

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import com.clawd.mobile.overlay.FloatingPetService
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ws.SseClient
import com.clawd.mobile.ws.StreamingClient
import com.clawd.mobile.ws.ConnectionState

@Composable
fun SettingsScreen(
    navController: NavController,
    sseClient: StreamingClient,
    prefsStore: PrefsStore
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
            // Connection info (when connected)
            if (isConnected) {
                ConnectionInfoCard(sseClient)
                Spacer(modifier = Modifier.height(12.dp))
            }

            // Accordion sections
            AccordionSection(
                title = stringResource(R.string.settings_scan_connect),
                icon = ClawdIcons.QrCode,
                defaultExpanded = false
            ) {
                ScanSection(onScan = { navController.navigate("scan") })
            }

            AccordionSection(
                title = stringResource(R.string.settings_manual_connect),
                icon = ClawdIcons.DeviceDesktop,
                defaultExpanded = false
            ) {
                ManualSection(onManual = { navController.navigate("manual") })
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
                defaultExpanded = false
            ) {
                FloatingPetSection(prefsStore = prefsStore)
            }

            AccordionSection(
                title = stringResource(R.string.settings_about),
                icon = ClawdIcons.Activity,
                defaultExpanded = false
            ) {
                AboutSection()
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

// ─── Connection Info Card ─────────────────────────────────────────

@Composable
private fun ConnectionInfoCard(sseClient: StreamingClient) {
    val clipboard = LocalClipboardManager.current
    val host = sseClient.currentHost ?: ""
    val port = sseClient.currentPort?.toString() ?: ""

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = ClawdSurfaceDark),
        border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdGreenBorder)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(androidx.compose.foundation.shape.CircleShape)
                        .background(ClawdGreenBright)
                )
                Text(
                    stringResource(R.string.status_connected),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = ClawdGreenBright,
                    modifier = Modifier.padding(start = 6.dp)
                )
            }
            Spacer(modifier = Modifier.height(10.dp))
            CopyableRow(stringResource(R.string.settings_ip_address), host) { clipboard.setText(AnnotatedString(host)) }
            CopyableRow(stringResource(R.string.settings_port), port) { clipboard.setText(AnnotatedString(port)) }
        }
    }
}

@Composable
private fun CopyableRow(label: String, value: String, onCopy: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, fontSize = 12.sp, color = ClawdFaintDark, modifier = Modifier.width(60.dp))
        Text(
            value,
            fontSize = 13.sp,
            color = ClawdTextDark,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.weight(1f)
        )
        IconButton(onClick = onCopy, modifier = Modifier.size(28.dp)) {
            Icon(
                ClawdIcons.Checks,
                stringResource(R.string.settings_copy),
                tint = ClawdMutedDark,
                modifier = Modifier.size(14.dp)
            )
        }
    }
}

// ─── Accordion Section ────────────────────────────────────────────

@Composable
private fun AccordionSection(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    defaultExpanded: Boolean = false,
    content: @Composable ColumnScope.() -> Unit
) {
    var expanded by remember { mutableStateOf(defaultExpanded) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .border(0.5.dp, ClawdBorderDark, RoundedCornerShape(14.dp))
            .background(ClawdSurfaceDark, RoundedCornerShape(14.dp))
    ) {
        // Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(icon, null, tint = ClawdAccent, modifier = Modifier.size(18.dp))
            Text(
                title,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClawdTextDark,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 10.dp)
            )
            val rotation by androidx.compose.animation.core.animateFloatAsState(
                if (expanded) 90f else 0f, label = "chevron"
            )
            Icon(
                ClawdIcons.ChevronRight,
                null,
                tint = ClawdFaintDark,
                modifier = Modifier
                    .size(16.dp)
                    .graphicsLayer(rotationZ = rotation)
            )
        }

        // Content
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically()
        ) {
            Column {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                        .height(0.5.dp)
                        .background(ClawdBorderDark)
                )
                Column(modifier = Modifier.padding(16.dp)) {
                    content()
                }
            }
        }
    }
}

// ─── Scan Section ─────────────────────────────────────────────────

@Composable
private fun ScanSection(onScan: () -> Unit) {
    Text(
        stringResource(R.string.settings_scan_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )
    Button(
        onClick = onScan,
        colors = ButtonDefaults.buttonColors(
            containerColor = ClawdAccent,
            contentColor = Color.White
        ),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Icon(ClawdIcons.QrCode, null, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(8.dp))
        Text(stringResource(R.string.settings_scan_open))
    }
}

// ─── Manual Section ───────────────────────────────────────────────

@Composable
private fun ManualSection(onManual: () -> Unit) {
    Text(
        stringResource(R.string.settings_manual_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )
    OutlinedButton(
        onClick = onManual,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(stringResource(R.string.settings_manual_open), color = ClawdMutedDark)
    }
}

// ─── Notification Section ─────────────────────────────────────────

@Composable
private fun NotificationSection(prefsStore: PrefsStore) {
    var enabled by remember { mutableStateOf(prefsStore.isNotifyEnabled()) }
    var approval by remember { mutableStateOf(prefsStore.isNotifyApproval()) }
    var status by remember { mutableStateOf(prefsStore.isNotifyStatus()) }
    var alert by remember { mutableStateOf(prefsStore.isNotifyAlert()) }
    Text(
        stringResource(R.string.settings_notification_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    NotifyToggle(stringResource(R.string.settings_notify_master), stringResource(R.string.settings_notify_master_desc), enabled) {
        enabled = it; prefsStore.setNotifyEnabled(it)
    }
    NotifyToggle(stringResource(R.string.settings_notify_approval), stringResource(R.string.settings_notify_approval_desc), approval && enabled, enabled) {
        approval = it; prefsStore.setNotifyApproval(it)
    }
    NotifyToggle(stringResource(R.string.settings_notify_status), stringResource(R.string.settings_notify_status_desc), status && enabled, enabled) {
        status = it; prefsStore.setNotifyStatus(it)
    }
    NotifyToggle(stringResource(R.string.settings_notify_alert), stringResource(R.string.settings_notify_alert_desc), alert && enabled, enabled) {
        alert = it; prefsStore.setNotifyAlert(it)
    }

}

// ─── Floating Pet Section ─────────────────────────────────────────

@Composable
private fun FloatingPetSection(prefsStore: PrefsStore) {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(prefsStore.isFloatingPetEnabled()) }
    var hasOverlayPermission by remember { mutableStateOf(Settings.canDrawOverlays(context)) }

    var sizeDp by remember { mutableIntStateOf(prefsStore.getPetSizeDp()) }
    var character by remember { mutableStateOf(prefsStore.getPetCharacter()) }

    Text(
        stringResource(R.string.settings_pet_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    // Enable toggle
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(stringResource(R.string.settings_pet_enable), fontSize = 13.sp, color = ClawdTextDark)
            Text(
                if (hasOverlayPermission) stringResource(R.string.settings_pet_overlay_granted) else stringResource(R.string.settings_pet_overlay_needed),
                fontSize = 11.sp,
                color = if (hasOverlayPermission) ClawdGreenBright else ClawdFaintDark
            )
        }
        Switch(
            checked = enabled,
            onCheckedChange = { newValue ->
                if (newValue) {
                    if (Settings.canDrawOverlays(context)) {
                        enabled = true
                        prefsStore.setFloatingPetEnabled(true)
                        val intent = Intent(context, FloatingPetService::class.java)
                        context.startForegroundService(intent)
                    } else {
                        val intent = Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:${context.packageName}")
                        )
                        context.startActivity(intent)
                    }
                } else {
                    enabled = false
                    prefsStore.setFloatingPetEnabled(false)
                    val intent = Intent(context, FloatingPetService::class.java)
                    context.stopService(intent)
                }
            },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = ClawdAccent,
                uncheckedThumbColor = ClawdFaintDark,
                uncheckedTrackColor = ClawdSurfaceAltDark
            )
        )
    }

    // Disconnect button
    if (enabled) {
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                enabled = false
                prefsStore.setFloatingPetEnabled(false)
                context.startService(
                    Intent(context, FloatingPetService::class.java)
                        .setAction(FloatingPetService.ACTION_DISCONNECT)
                )
            },
            border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(R.string.settings_disconnect), color = ClawdFaintDark, fontSize = 13.sp)
        }
    }

    // Size slider
    if (enabled) {
        Spacer(modifier = Modifier.height(12.dp))
        var sizeText by remember { mutableStateOf(sizeDp.toString()) }

        // Size slider + input field
        Text(stringResource(R.string.settings_pet_size), fontSize = 13.sp, color = ClawdTextDark)
        Spacer(modifier = Modifier.height(4.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Slider(
                value = sizeDp.toFloat(),
                onValueChange = { sizeDp = it.toInt() },
                onValueChangeFinished = {
                    sizeText = sizeDp.toString()
                    prefsStore.setPetSizeDp(sizeDp)
                    context.sendBroadcast(
                        Intent(FloatingPetService.ACTION_PET_SIZE)
                            .putExtra(FloatingPetService.EXTRA_SIZE_DP, sizeDp)
                    )
                },
                valueRange = 32f..128f,
                modifier = Modifier.weight(1f),
                colors = SliderDefaults.colors(
                    thumbColor = ClawdAccent,
                    activeTrackColor = ClawdAccent
                )
            )
            Spacer(modifier = Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .width(60.dp)
                    .height(36.dp)
                    .border(0.5.dp, ClawdBorderDark, RoundedCornerShape(8.dp))
                    .background(ClawdSurfaceAltDark, RoundedCornerShape(8.dp))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center
            ) {
                BasicTextField(
                    value = sizeText,
                    onValueChange = { newValue ->
                        sizeText = newValue.filter { it.isDigit() }
                        val parsed = sizeText.toIntOrNull()
                        if (parsed != null) {
                            val clamped = parsed.coerceIn(32, 128)
                            sizeDp = clamped
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = LocalTextStyle.current.copy(
                        fontSize = 13.sp,
                        color = ClawdTextDark,
                        fontFamily = FontFamily.Monospace
                    ),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Number,
                        imeAction = ImeAction.Done
                    ),
                    singleLine = true
                )
            }
            Spacer(modifier = Modifier.width(4.dp))
            Text("dp", fontSize = 12.sp, color = ClawdFaintDark)
        }

        Text(
            text = stringResource(R.string.settings_pet_resize_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp)
        )

        // Sync slider → text field
        LaunchedEffect(sizeDp) {
            sizeText = sizeDp.toString()
        }

        // Character selector
        Spacer(modifier = Modifier.height(8.dp))
        Text(stringResource(R.string.settings_pet_character), fontSize = 13.sp, color = ClawdTextDark)
        Spacer(modifier = Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("clawd" to "Clawd", "calico" to "Calico", "cloudling" to "Cloudling").forEach { (key, label) ->
                FilterChip(
                    selected = character == key,
                    onClick = {
                        character = key
                        prefsStore.setPetCharacter(key)
                        context.sendBroadcast(
                            Intent(FloatingPetService.ACTION_PET_CHARACTER)
                                .putExtra(FloatingPetService.EXTRA_CHARACTER, key)
                                .setPackage(context.packageName)
                        )
                    },
                    label = { Text(label, fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = ClawdAccent,
                        selectedLabelColor = Color.White
                    )
                )
            }
        }
    }

    // Re-check permission and auto-start service if needed
    LaunchedEffect(Unit) {
        hasOverlayPermission = Settings.canDrawOverlays(context)
        // Auto-start service if pref says enabled but service is not running
        // Covers: process death, returning from permission screen
        if (hasOverlayPermission && prefsStore.isFloatingPetEnabled() && !FloatingPetService.isRunning) {
            enabled = true
            val intent = Intent(context, FloatingPetService::class.java)
            context.startForegroundService(intent)
        }
    }
}

@Composable
private fun NotifyToggle(
    label: String,
    desc: String,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, fontSize = 13.sp, color = if (enabled) ClawdTextDark else ClawdFaintDark)
            Text(desc, fontSize = 11.sp, color = ClawdFaintDark)
        }
        Switch(
            checked = checked,
            onCheckedChange = { onCheckedChange(it) },
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = ClawdAccent,
                uncheckedThumbColor = ClawdFaintDark,
                uncheckedTrackColor = ClawdSurfaceAltDark
            )
        )
    }
}

// ─── About Section ────────────────────────────────────────────────

@Composable
private fun AboutSection() {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    Text(
        stringResource(R.string.about_subtitle),
        fontSize = 14.sp,
        fontWeight = FontWeight.Medium,
        color = ClawdTextDark,
        modifier = Modifier.padding(bottom = 4.dp)
    )
    Text(
        "A mobile companion for your AI coding journey.",
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    val versionName = try {
        com.clawd.mobile.BuildConfig.VERSION_NAME
    } catch (e: Exception) {
        android.util.Log.w("Settings", "BuildConfig access failed", e)
        "?"
    }
    AboutRow(stringResource(R.string.about_version), "v$versionName")
    AboutRow(stringResource(R.string.about_repo), "https://github.com/rullerzhou-afk/clawd-on-desk")
    AboutRow(stringResource(R.string.about_fork), "https://github.com/Bynlk/clawd-on-desk")
    AboutRow(stringResource(R.string.about_license), "AGPL-3.0 · © 2026 Ruller_Lulu")
    AboutRow(stringResource(R.string.about_author), stringResource(R.string.about_author_name))
    AboutRow(stringResource(R.string.about_maintainer), "@rullerzhou-afk, @YOIMIYA66")
    AboutRow(stringResource(R.string.about_mobile_maintainer), "@Bynlk")

    Spacer(modifier = Modifier.height(12.dp))
    OutlinedButton(
        onClick = {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/Bynlk/clawd-on-desk/releases/latest"))
            context.startActivity(intent)
        },
        border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Icon(ClawdIcons.Refresh, null, modifier = Modifier.size(16.dp), tint = ClawdMutedDark)
        Spacer(modifier = Modifier.width(6.dp))
        Text(stringResource(R.string.about_check_update), color = ClawdMutedDark)
    }
}

@Composable
private fun AboutRow(label: String, value: String) {
    val clipboard = LocalClipboardManager.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { clipboard.setText(AnnotatedString(value)) }
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, fontSize = 12.sp, color = ClawdFaintDark, modifier = Modifier.width(100.dp))
        Text(value, fontSize = 12.sp, color = ClawdTextDark, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
        Icon(ClawdIcons.Checks, null, tint = ClawdFaintDark.copy(alpha = 0.5f), modifier = Modifier.size(12.dp))
    }
}

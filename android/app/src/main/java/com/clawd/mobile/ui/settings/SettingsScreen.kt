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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
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
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ws.ClawdWebSocket
import com.clawd.mobile.ws.ConnectionState

@Composable
fun SettingsScreen(
    navController: NavController,
    webSocket: ClawdWebSocket,
    prefsStore: PrefsStore
) {
    val connectionState by webSocket.connectionState.collectAsState()
    val isConnected = connectionState == ConnectionState.CONNECTED

    Scaffold(
        containerColor = ClawdBgDark,
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
                ConnectionInfoCard(webSocket)
                Spacer(modifier = Modifier.height(12.dp))
            }

            // Accordion sections
            AccordionSection(
                title = "扫码连接",
                icon = ClawdIcons.QrCode,
                defaultExpanded = false
            ) {
                ScanSection(onScan = { navController.navigate("scan") })
            }

            AccordionSection(
                title = "手动连接",
                icon = ClawdIcons.DeviceDesktop,
                defaultExpanded = false
            ) {
                ManualSection(onManual = { navController.navigate("manual") })
            }

            AccordionSection(
                title = "通知设置",
                icon = ClawdIcons.Bell,
                defaultExpanded = false
            ) {
                NotificationSection(prefsStore = prefsStore)
            }

            AccordionSection(
                title = "桌宠",
                icon = ClawdIcons.Pet,
                defaultExpanded = false
            ) {
                FloatingPetSection(prefsStore = prefsStore)
            }

            AccordionSection(
                title = "关于",
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
                "返回",
                tint = ClawdMutedDark,
                modifier = Modifier.size(20.dp)
            )
        }
        Text(
            "设置",
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            color = ClawdTextDark
        )
    }
}

// ─── Connection Info Card ─────────────────────────────────────────

@Composable
private fun ConnectionInfoCard(webSocket: ClawdWebSocket) {
    val clipboard = LocalClipboardManager.current
    val host = webSocket.currentHost ?: ""
    val port = webSocket.currentPort?.toString() ?: ""

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = ClawdCardDark),
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
                    "已连接",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = ClawdGreenBright,
                    modifier = Modifier.padding(start = 6.dp)
                )
            }
            Spacer(modifier = Modifier.height(10.dp))
            CopyableRow("IP 地址", host) { clipboard.setText(AnnotatedString(host)) }
            CopyableRow("端口", port) { clipboard.setText(AnnotatedString(port)) }
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
                "复制",
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
            .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(14.dp))
            .background(ClawdCardDark, RoundedCornerShape(14.dp))
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
            Icon(
                ClawdIcons.ChevronRight,
                null,
                tint = ClawdFaintDark,
                modifier = Modifier
                    .size(16.dp)
                    .then(if (expanded) Modifier else Modifier)
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
                        .background(ClawdCardBorderDark)
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
        "扫描 PC 端显示的二维码，自动建立连接。",
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
        Text("打开扫码")
    }
}

// ─── Manual Section ───────────────────────────────────────────────

@Composable
private fun ManualSection(onManual: () -> Unit) {
    Text(
        "手动输入 PC 端的 IP 地址、端口和 Token 进行连接。",
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )
    OutlinedButton(
        onClick = onManual,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdCardBorderDark),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text("手动输入连接", color = ClawdMutedDark)
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
        "控制 App 各类通知的开关。关闭后将不再收到对应类型的通知推送。",
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    NotifyToggle("通知总开关", "启用后 App 可发送通知", enabled) {
        enabled = it; prefsStore.setNotifyEnabled(it)
    }
    NotifyToggle("权限审批通知", "Claude 请求执行权限时通知你", approval && enabled, enabled) {
        approval = it; prefsStore.setNotifyApproval(it)
    }
    NotifyToggle("会话状态通知", "会话状态变化（完成、错误等）时通知", status && enabled, enabled) {
        status = it; prefsStore.setNotifyStatus(it)
    }
    NotifyToggle("告警通知", "需要立即关注的事件通知", alert && enabled, enabled) {
        alert = it; prefsStore.setNotifyAlert(it)
    }

}

// ─── Floating Pet Section ─────────────────────────────────────────

@Composable
private fun FloatingPetSection(prefsStore: PrefsStore) {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(prefsStore.isFloatingPetEnabled()) }
    var hasOverlayPermission by remember { mutableStateOf(Settings.canDrawOverlays(context)) }

    val petPrefs = remember { context.getSharedPreferences("clawd_prefs", Context.MODE_PRIVATE) }
    var sizeDp by remember { mutableIntStateOf(petPrefs.getInt("pet_size_dp", 96)) }
    var character by remember { mutableStateOf(petPrefs.getString("pet_character", "clawd") ?: "clawd") }

    Text(
        "在屏幕上显示一个可爱的桌宠小螃蟹。",
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
            Text("启用桌宠", fontSize = 13.sp, color = ClawdTextDark)
            Text(
                if (hasOverlayPermission) "需要悬浮窗权限（已授予）" else "需要悬浮窗权限（未授予）",
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
            border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdCardBorderDark),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("断开连接并关闭桌宠", color = ClawdFaintDark, fontSize = 13.sp)
        }
    }

    // Size slider
    if (enabled) {
        Spacer(modifier = Modifier.height(12.dp))
        var sizeText by remember { mutableStateOf(sizeDp.toString()) }

        // Size slider + input field
        Text("大小", fontSize = 13.sp, color = ClawdTextDark)
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
                    petPrefs.edit().putInt("pet_size_dp", sizeDp).apply()
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
                    .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(8.dp))
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

        // Sync slider → text field
        LaunchedEffect(sizeDp) {
            sizeText = sizeDp.toString()
        }

        // Character selector
        Spacer(modifier = Modifier.height(8.dp))
        Text("角色", fontSize = 13.sp, color = ClawdTextDark)
        Spacer(modifier = Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("clawd" to "Clawd", "calico" to "Calico", "cloudling" to "Cloudling").forEach { (key, label) ->
                FilterChip(
                    selected = character == key,
                    onClick = {
                        character = key
                        petPrefs.edit().putString("pet_character", key).apply()
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

    // Re-check permission when section is recomposed
    LaunchedEffect(Unit) {
        hasOverlayPermission = Settings.canDrawOverlays(context)
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
        "陪你 AI 编码的移动端伙伴。",
        fontSize = 14.sp,
        fontWeight = FontWeight.Medium,
        color = ClawdTextDark,
        modifier = Modifier.padding(bottom = 4.dp)
    )
    Text(
        "A desktop companion for your AI coding journey.",
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    val versionName = try {
        com.clawd.mobile.BuildConfig.VERSION_NAME
    } catch (_: Exception) {
        "?"
    }
    AboutRow("版本", "v$versionName")
    AboutRow("代码仓库", "https://github.com/rullerzhou-afk/clawd-on-desk")
    AboutRow("Fork 仓库", "https://github.com/Bynlk/clawd-on-desk")
    AboutRow("开源协议", "AGPL-3.0 · © 2026 Ruller_Lulu")
    AboutRow("原作者", "Ruller_Lulu / 鹿鹿")
    AboutRow("维护者", "@rullerzhou-afk, @YOIMIYA66")
    AboutRow("移动端维护者", "@Bynlk")

    Spacer(modifier = Modifier.height(12.dp))
    OutlinedButton(
        onClick = {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/Bynlk/clawd-on-desk/releases/latest"))
            context.startActivity(intent)
        },
        border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdCardBorderDark),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Icon(ClawdIcons.Refresh, null, modifier = Modifier.size(16.dp), tint = ClawdMutedDark)
        Spacer(modifier = Modifier.width(6.dp))
        Text("检查更新", color = ClawdMutedDark)
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

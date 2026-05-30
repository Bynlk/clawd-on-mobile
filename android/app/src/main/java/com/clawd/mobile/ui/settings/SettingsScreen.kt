package com.clawd.mobile.ui.settings

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
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
    var bgKeepalive by remember { mutableStateOf(prefsStore.isBgKeepalive()) }

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

    Spacer(modifier = Modifier.height(12.dp))
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(0.5.dp)
            .background(ClawdCardBorderDark)
    )
    Spacer(modifier = Modifier.height(12.dp))

    Text(
        "后台保活",
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        color = ClawdTextDark,
        modifier = Modifier.padding(bottom = 4.dp)
    )
    Text(
        "App 进入后台时保持 WebSocket 连接，确保实时接收会话更新和通知。",
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 8.dp)
    )
    NotifyToggle("后台保活", "后台运行时保持连接", bgKeepalive) {
        bgKeepalive = it; prefsStore.setBgKeepalive(it)
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

    Text(
        "Clawd Mobile 是 Clawd 桌面宠物的移动端伴侣 App，用于实时监控 PC 端 Claude 会话状态、审批权限请求。",
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    AboutRow("版本", "v1.2.1（对应 PC 端 v1.x）")
    AboutRow("原作者代码仓库", "github.com/clawd-on-desk/clawd-on-desk")
    AboutRow("手机端代码仓库", "github.com/Bynlk/clawd-on-desk")
    AboutRow("开源协议", "AGPL-3.0")
    AboutRow("原作者", "Clawd Team")
    AboutRow("维护者", "Bynlk")

    Spacer(modifier = Modifier.height(12.dp))
    OutlinedButton(
        onClick = { /* TODO: open GitHub releases page */ },
        border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdCardBorderDark),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Icon(ClawdIcons.Refresh, null, modifier = Modifier.size(16.dp), tint = ClawdMutedDark)
        Spacer(modifier = Modifier.width(6.dp))
        Text("检查更新", color = ClawdMutedDark)
    }

    Spacer(modifier = Modifier.height(8.dp))
    Text(
        "Clawd Mobile 通过 WebSocket 与 PC 端通信，支持实时会话监控、权限审批、状态通知等功能。",
        fontSize = 11.sp,
        color = ClawdFaintDark
    )
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

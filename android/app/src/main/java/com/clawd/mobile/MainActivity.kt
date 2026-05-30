package com.clawd.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ui.navigation.ClawdNavGraph

class MainActivity : ComponentActivity() {

    private val permissionQueue = mutableListOf<PermissionRequest>()
    private var currentPermissionIndex = 0
    private var onAllPermissionsDone: (() -> Unit)? = null

    data class PermissionRequest(
        val permission: String,
        val title: String,
        val description: String
    )

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        currentPermissionIndex++
        showNextPermission()
    }

    private val batteryOptLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        setupContent()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Build permission queue
        val permissions = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                add(PermissionRequest(
                    Manifest.permission.POST_NOTIFICATIONS,
                    "通知权限",
                    "用于接收会话状态变化、权限审批请求等通知推送。关闭后将无法收到实时提醒。"
                ))
            }
            if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED
            ) {
                add(PermissionRequest(
                    Manifest.permission.CAMERA,
                    "摄像头权限",
                    "用于扫描 PC 端显示的二维码，快速建立连接。仅在扫码时使用。"
                ))
            }
        }

        if (permissions.isNotEmpty()) {
            permissionQueue.addAll(permissions)
            currentPermissionIndex = 0
            onAllPermissionsDone = { checkAndRequestBatteryOptimization() }
            setContent {
                ClawdMobileTheme {
                    PermissionExplanationDialog(
                        request = permissionQueue.getOrNull(currentPermissionIndex),
                        onConfirm = {
                            permissionLauncher.launch(permissionQueue[currentPermissionIndex].permission)
                        },
                        onSkip = {
                            currentPermissionIndex++
                            showNextPermission()
                        }
                    )
                }
            }
        } else {
            checkAndRequestBatteryOptimization()
        }
    }

    private fun showNextPermission() {
        if (currentPermissionIndex >= permissionQueue.size) {
            onAllPermissionsDone?.invoke()
            return
        }
        // Recompose with new permission
        setContent {
            ClawdMobileTheme {
                PermissionExplanationDialog(
                    request = permissionQueue.getOrNull(currentPermissionIndex),
                    onConfirm = {
                        permissionLauncher.launch(permissionQueue[currentPermissionIndex].permission)
                    },
                    onSkip = {
                        currentPermissionIndex++
                        showNextPermission()
                    }
                )
            }
        }
    }

    private fun setupContent() {
        setContent {
            ClawdMobileTheme {
                ClawdNavGraph()
            }
        }
    }

    private fun checkAndRequestBatteryOptimization() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            setupContent()
            return
        }
        setContent {
            ClawdMobileTheme {
                BatteryOptimizationDialog(
                    onConfirm = {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                        batteryOptLauncher.launch(intent)
                    },
                    onSkip = { setupContent() }
                )
            }
        }
    }
}

@Composable
private fun PermissionExplanationDialog(
    request: MainActivity.PermissionRequest?,
    onConfirm: () -> Unit,
    onSkip: () -> Unit
) {
    if (request == null) return

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ClawdBgDark),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = ClawdCardDark)
        ) {
            Column(
                modifier = Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Icon(
                    ClawdIcons.Bell,
                    null,
                    tint = ClawdAccent,
                    modifier = Modifier.size(40.dp)
                )
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    request.title,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = ClawdTextDark
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    request.description,
                    fontSize = 13.sp,
                    color = ClawdFaintDark,
                    lineHeight = 20.sp
                )
                Spacer(modifier = Modifier.height(24.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(
                        onClick = onSkip,
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("跳过", color = ClawdMutedDark)
                    }
                    Button(
                        onClick = onConfirm,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ClawdAccent,
                            contentColor = Color.White
                        ),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("允许")
                    }
                }
            }
        }
    }
}

@Composable
private fun BatteryOptimizationDialog(
    onConfirm: () -> Unit,
    onSkip: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ClawdBgDark),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = ClawdCardDark)
        ) {
            Column(
                modifier = Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Icon(
                    ClawdIcons.Bell,
                    null,
                    tint = ClawdAccent,
                    modifier = Modifier.size(40.dp)
                )
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    "后台保活权限",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = ClawdTextDark
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    "为确保后台 SSE 连接不被系统杀死，请允许 Clawd Mobile 忽略电池优化。\n\n" +
                        "国产手机（MIUI、ColorOS、EMUI 等）会强制关闭后台应用，此权限可避免 3 秒断连问题。",
                    fontSize = 13.sp,
                    color = ClawdFaintDark,
                    lineHeight = 20.sp
                )
                Spacer(modifier = Modifier.height(24.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(
                        onClick = onSkip,
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("跳过", color = ClawdMutedDark)
                    }
                    Button(
                        onClick = onConfirm,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ClawdAccent,
                            contentColor = Color.White
                        ),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("允许")
                    }
                }
            }
        }
    }
}

package com.clawd.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.util.Log
import android.content.pm.PackageManager
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.service.SseService
import kotlinx.serialization.json.Json
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.clawd.mobile.ui.components.ClawdIcons
import dagger.hilt.android.AndroidEntryPoint
import com.clawd.mobile.ui.components.PermissionDialog
import com.clawd.mobile.R
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ui.navigation.ClawdNavGraph

@AndroidEntryPoint
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
        checkOverlayPermission()
    }

    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        setupContent()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Log.d("MainActivity", "onCreate intent=${intent?.action} data=${intent?.data} extras=${intent?.extras?.keySet()}")
        handleApprovalIntent(intent)
        handleDeepLink(intent)

        // Build permission queue
        val permissions = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                add(PermissionRequest(
                    Manifest.permission.POST_NOTIFICATIONS,
                    getString(R.string.perm_notification_title),
                    getString(R.string.perm_notification_desc)
                ))
            }
            if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED
            ) {
                add(PermissionRequest(
                    Manifest.permission.CAMERA,
                    getString(R.string.perm_camera_title),
                    getString(R.string.perm_camera_desc)
                ))
            }
        }

        if (permissions.isNotEmpty()) {
            permissionQueue.addAll(permissions)
            currentPermissionIndex = 0
            onAllPermissionsDone = { checkAndRequestBatteryOptimization() }
            showCurrentPermission()
        } else {
            checkAndRequestBatteryOptimization()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        Log.d("MainActivity", "onNewIntent action=${intent.action} data=${intent.data}")
        handleApprovalIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleApprovalIntent(intent: Intent?) {
        val requestJson = intent?.getStringExtra("request_json") ?: return
        Log.d("MainActivity", "handleApprovalIntent hasJson=true")
        try {
            val request = Json.decodeFromString<PermissionRequestData>(requestJson)
            Log.d("MainActivity", "Sending approval request to channel: ${request.requestId}")
            ClawdApp.approvalChannel.trySend(request)
        } catch (e: Exception) {
            Log.w("MainActivity", "Failed to deserialize request_json: ${e.message}")
        }
    }

    /**
     * Handle clawd:// deep link.
     * URI format: clawd://host:port/token
     * Parses the URI, saves config, and starts the SseService.
     */
    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "clawd") return

        val url = uri.toString()
        Log.d("MainActivity", "handleDeepLink: $url")

        val config = ConnectionConfig.fromClawdUrl(url)
        if (config == null) {
            Log.w("MainActivity", "Invalid clawd:// URI: $url")
            return
        }

        Log.d("MainActivity", "Deep link parsed: ${config.host}:${config.port}")
        val prefsStore = PrefsStore.getInstance(this)
        prefsStore.saveConfig(config)
        SseService.start(this, config)
    }

    private fun showCurrentPermission() {
        val request = permissionQueue.getOrNull(currentPermissionIndex) ?: return
        setContent {
            ClawdMobileTheme {
                PermissionDialog(
                    icon = ClawdIcons.Bell,
                    title = request.title,
                    description = request.description,
                    onConfirm = { permissionLauncher.launch(request.permission) },
                    onSkip = { currentPermissionIndex++; showNextPermission() }
                )
            }
        }
    }

    private fun showNextPermission() {
        if (currentPermissionIndex >= permissionQueue.size) {
            onAllPermissionsDone?.invoke()
            return
        }
        showCurrentPermission()
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
            checkOverlayPermission()
            return
        }
        setContent {
            ClawdMobileTheme {
                PermissionDialog(
                    icon = ClawdIcons.Bell,
                    title = stringResource(R.string.perm_battery_title),
                    description = stringResource(R.string.perm_battery_desc),
                    onConfirm = {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                        batteryOptLauncher.launch(intent)
                    },
                    onSkip = { checkOverlayPermission() }
                )
            }
        }
    }

    private fun checkOverlayPermission() {
        if (Settings.canDrawOverlays(this)) {
            setupContent()
            return
        }
        setContent {
            ClawdMobileTheme {
                PermissionDialog(
                    icon = ClawdIcons.Bell,
                    title = stringResource(R.string.perm_overlay_title),
                    description = stringResource(R.string.perm_overlay_desc),
                    onConfirm = {
                        val intent = Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:$packageName")
                        )
                        overlayPermissionLauncher.launch(intent)
                    },
                    onSkip = { setupContent() }
                )
            }
        }
    }
}

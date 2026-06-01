package com.clawd.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.util.Log
import android.content.pm.PackageManager
import com.clawd.mobile.data.PermissionRequestData
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
import com.clawd.mobile.ui.components.PermissionDialog
import com.clawd.mobile.R
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.ui.navigation.ClawdNavGraph

class MainActivity : ComponentActivity() {

    companion object {
        /** Set by notification tap, consumed by NavGraph */
        var pendingApprovalRequestId: String? = null
        /** Full request data from notification intent, survives Activity recreation */
        var pendingApprovalRequest: PermissionRequestData? = null
        /** ViewModel reference for onNewIntent forwarding (set by NavGraph) */
        var approvalViewModelRef: com.clawd.mobile.ui.approval.ApprovalViewModel? = null
    }

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
        Log.d("MainActivity", "onCreate intent=${intent?.action} extras=${intent?.extras?.keySet()} request_id=${intent?.getStringExtra("request_id")}")
        handleApprovalIntent(intent)

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
        Log.d("MainActivity", "onNewIntent action=${intent.action} request_id=${intent.getStringExtra("request_id")}")
        handleApprovalIntent(intent)
        // Forward directly to ViewModel if available (Activity already composed)
        pendingApprovalRequest?.let { request ->
            approvalViewModelRef?.restoreRequestFromNotification(request)
            pendingApprovalRequest = null
            pendingApprovalRequestId = null
        }
    }

    private fun handleApprovalIntent(intent: Intent?) {
        val rid = intent?.getStringExtra("request_id")
        val requestJson = intent?.getStringExtra("request_json")
        Log.d("MainActivity", "handleApprovalIntent request_id=$rid hasJson=${requestJson != null}")
        rid?.let {
            pendingApprovalRequestId = it
            Log.d("MainActivity", "pendingApprovalRequestId set to $it")
        }
        if (requestJson != null) {
            try {
                pendingApprovalRequest = Json.decodeFromString<PermissionRequestData>(requestJson)
                Log.d("MainActivity", "pendingApprovalRequest restored from JSON")
            } catch (e: Exception) {
                Log.w("MainActivity", "Failed to deserialize request_json: ${e.message}")
            }
        }
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

package com.clawd.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.util.Log
import android.content.pm.PackageManager
import java.util.Locale
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.service.WsConnectionService
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
import com.clawd.mobile.ui.scan.RelayPairingAcceptance
import com.clawd.mobile.ui.scan.RelayPairingReceiver
import com.clawd.mobile.ui.scan.ScanPayloadResult
import com.clawd.mobile.ui.scan.parseScannedPayload
import java.security.MessageDigest

internal class RelayPairingCoordinator(
    initialFingerprint: String? = null,
    private val save: (RelayPairingConfig) -> Boolean,
    private val navigateToSettings: () -> Unit,
) {
    var lastFingerprint: String? = initialFingerprint
        private set

    @Synchronized
    fun accept(config: RelayPairingConfig): RelayPairingAcceptance {
        val fingerprint = MessageDigest.getInstance("SHA-256")
            .digest(RelayPairingConfig.encodeStorage(config).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        if (fingerprint == lastFingerprint) return RelayPairingAcceptance.DUPLICATE
        val saved = try {
            save(config)
        } catch (_: Exception) {
            false
        }
        if (!saved) return RelayPairingAcceptance.STORAGE_FAILED
        lastFingerprint = fingerprint
        navigateToSettings()
        return RelayPairingAcceptance.SAVED
    }
}

internal enum class RelayDeepLinkRoutingResult {
    RELAY_SAVED,
    RELAY_DUPLICATE,
    RELAY_REJECTED,
    LAN_STARTED,
    REJECTED,
}

internal class RelayDeepLinkRouter(
    private val relayCoordinator: RelayPairingCoordinator,
    private val saveLan: (ConnectionConfig) -> Unit,
    private val startLan: (ConnectionConfig) -> Unit,
) {
    fun route(raw: String): RelayDeepLinkRoutingResult = when (val parsed = parseScannedPayload(raw)) {
        is ScanPayloadResult.Relay -> when (relayCoordinator.accept(parsed.config)) {
            RelayPairingAcceptance.SAVED -> RelayDeepLinkRoutingResult.RELAY_SAVED
            RelayPairingAcceptance.DUPLICATE -> RelayDeepLinkRoutingResult.RELAY_DUPLICATE
            RelayPairingAcceptance.STORAGE_FAILED -> RelayDeepLinkRoutingResult.RELAY_REJECTED
        }
        is ScanPayloadResult.InvalidRelay -> RelayDeepLinkRoutingResult.RELAY_REJECTED
        is ScanPayloadResult.Lan -> {
            saveLan(parsed.config)
            startLan(parsed.config)
            RelayDeepLinkRoutingResult.LAN_STARTED
        }
        null -> RelayDeepLinkRoutingResult.REJECTED
    }
}

@AndroidEntryPoint
class MainActivity : ComponentActivity(), RelayPairingReceiver {

    companion object {
        private const val STATE_RELAY_PAIRING_FINGERPRINT = "relay_pairing_fingerprint"
        private const val STATE_RELAY_PAIRING_NEXT_REQUEST_ID = "relay_pairing_next_request_id"
        private const val STATE_RELAY_PAIRING_PENDING_REQUEST_ID = "relay_pairing_pending_request_id"
    }

    override fun attachBaseContext(newBase: Context) {
        val lang = PrefsStore.getInstance(newBase).getLanguage()
        val locale = Locale.forLanguageTag(lang)
        val config = Configuration(newBase.resources.configuration)
        config.setLocale(locale)
        val context = newBase.createConfigurationContext(config)
        super.attachBaseContext(context)
    }

    private val permissionQueue = mutableListOf<PermissionRequest>()
    private var currentPermissionIndex = 0
    private var onAllPermissionsDone: (() -> Unit)? = null
    private var settingsNavigationRequest by mutableIntStateOf(0)
    private var nextSettingsNavigationRequestId = 1
    private lateinit var relayPairingCoordinator: RelayPairingCoordinator
    private lateinit var relayDeepLinkRouter: RelayDeepLinkRouter

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
        settingsNavigationRequest = savedInstanceState
            ?.getInt(STATE_RELAY_PAIRING_PENDING_REQUEST_ID, 0)
            ?.coerceAtLeast(0)
            ?: 0
        nextSettingsNavigationRequestId = savedInstanceState
            ?.getInt(STATE_RELAY_PAIRING_NEXT_REQUEST_ID, 1)
            ?.coerceAtLeast(1)
            ?: 1
        relayPairingCoordinator = RelayPairingCoordinator(
            initialFingerprint = savedInstanceState?.getString(STATE_RELAY_PAIRING_FINGERPRINT),
            save = { PrefsStore.getInstance(this).saveRelayPairing(it) },
            navigateToSettings = {
                settingsNavigationRequest = nextSettingsNavigationRequestId
                nextSettingsNavigationRequestId =
                    if (nextSettingsNavigationRequestId == Int.MAX_VALUE) 1
                    else nextSettingsNavigationRequestId + 1
            },
        )
        relayDeepLinkRouter = RelayDeepLinkRouter(
            relayCoordinator = relayPairingCoordinator,
            saveLan = { PrefsStore.getInstance(this).saveConfig(it) },
            startLan = { WsConnectionService.start(this, it) },
        )
        Log.d("MainActivity", "onCreate action=${intent?.action}")
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
        setIntent(intent)
        Log.d("MainActivity", "onNewIntent action=${intent.action}")
        handleApprovalIntent(intent)
        handleDeepLink(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        relayPairingCoordinator.lastFingerprint?.let {
            outState.putString(STATE_RELAY_PAIRING_FINGERPRINT, it)
        }
        outState.putInt(STATE_RELAY_PAIRING_NEXT_REQUEST_ID, nextSettingsNavigationRequestId)
        outState.putInt(STATE_RELAY_PAIRING_PENDING_REQUEST_ID, settingsNavigationRequest)
        super.onSaveInstanceState(outState)
    }

    override fun onRelayPairingScanned(config: RelayPairingConfig): RelayPairingAcceptance =
        relayPairingCoordinator.accept(config)

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
     * Handles both legacy LAN links and versioned relay-pair links without logging either raw URI.
     * Relay pairing is persisted and routed to settings, but never starts VPN, WebSocket, or service.
     */
    private fun handleDeepLink(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val raw = intent.data?.toString() ?: return
        when (relayDeepLinkRouter.route(raw)) {
            RelayDeepLinkRoutingResult.RELAY_REJECTED ->
                Log.w("MainActivity", "Relay pairing rejected")
            RelayDeepLinkRoutingResult.REJECTED -> Log.w("MainActivity", "Deep link rejected")
            RelayDeepLinkRoutingResult.LAN_STARTED -> Log.d("MainActivity", "LAN deep link parsed")
            RelayDeepLinkRoutingResult.RELAY_SAVED,
            RelayDeepLinkRoutingResult.RELAY_DUPLICATE -> Unit
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
                ClawdNavGraph(
                    relayPairingNavigationRequest = settingsNavigationRequest,
                    onRelayPairingNavigationConsumed = { consumedRequest ->
                        if (settingsNavigationRequest == consumedRequest) {
                            settingsNavigationRequest = 0
                        }
                    },
                )
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

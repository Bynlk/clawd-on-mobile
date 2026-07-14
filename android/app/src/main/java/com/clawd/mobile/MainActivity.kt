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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
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
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class RelayPairingStoredState(
    val pairing: RelayPairingConfig? = null,
    val storageUnavailable: Boolean = false,
)

internal enum class RelayPairingPreparation {
    CONFIRMATION_REQUIRED,
    DUPLICATE,
    STORAGE_FAILED,
}

internal data class RelayPairingConfirmationMetadata(
    val name: String,
    val endpoint: String,
)

internal enum class RelayPairingConfirmationPhase {
    PREPARING,
    AWAITING_CONFIRMATION,
    CONFIRMING,
}

internal enum class RelayPairingResumeAction {
    SHOW_CONFIRMATION,
    CLEAR,
    RESUME_CONFIRMED_SAVE,
    NAVIGATE_TO_SETTINGS,
    SHOW_STORAGE_FAILURE,
}

internal fun relayPairingResumeAction(
    phase: RelayPairingConfirmationPhase,
    preparation: RelayPairingPreparation,
): RelayPairingResumeAction = when (preparation) {
    RelayPairingPreparation.CONFIRMATION_REQUIRED ->
        if (phase == RelayPairingConfirmationPhase.CONFIRMING) {
            RelayPairingResumeAction.RESUME_CONFIRMED_SAVE
        } else {
            RelayPairingResumeAction.SHOW_CONFIRMATION
        }
    RelayPairingPreparation.DUPLICATE ->
        if (phase == RelayPairingConfirmationPhase.CONFIRMING) {
            RelayPairingResumeAction.NAVIGATE_TO_SETTINGS
        } else {
            RelayPairingResumeAction.CLEAR
        }
    RelayPairingPreparation.STORAGE_FAILED -> RelayPairingResumeAction.SHOW_STORAGE_FAILURE
}

internal fun RelayPairingConfig.toConfirmationMetadata(): RelayPairingConfirmationMetadata =
    RelayPairingConfirmationMetadata(name = name, endpoint = wireGuard.endpoint)

/**
 * Retains a pending external pairing across configuration changes without putting
 * the secret-bearing config in a saved-state Bundle or persistent storage.
 */
internal class RelayPairingConfirmationViewModel : ViewModel() {
    private var attemptGeneration = 0L
    private var activeAttempt = 0L
    var pendingExternalPairing by mutableStateOf<RelayPairingConfig?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var storageFailed by mutableStateOf(false)
        private set
    var phase by mutableStateOf<RelayPairingConfirmationPhase?>(null)
        private set

    val metadata: RelayPairingConfirmationMetadata?
        get() = pendingExternalPairing?.toConfirmationMetadata()

    /** Must run synchronously before the first cancellable storage operation. */
    fun retainForPreparation(config: RelayPairingConfig): Boolean {
        val incomingFingerprint = RelayPairingConfig.semanticFingerprint(config)
        val retainedFingerprint = pendingExternalPairing
            ?.let(RelayPairingConfig::semanticFingerprint)
        if (incomingFingerprint == retainedFingerprint) return false
        nextAttempt()
        pendingExternalPairing = config
        phase = RelayPairingConfirmationPhase.PREPARING
        busy = true
        storageFailed = false
        return true
    }

    fun isCurrent(
        config: RelayPairingConfig,
        expectedPhase: RelayPairingConfirmationPhase,
        attempt: Long? = null,
    ): Boolean = phase == expectedPhase &&
        (attempt == null || attempt == activeAttempt) &&
        pendingExternalPairing?.let(RelayPairingConfig::semanticFingerprint) ==
        RelayPairingConfig.semanticFingerprint(config)

    fun show(config: RelayPairingConfig) {
        pendingExternalPairing = config
        phase = RelayPairingConfirmationPhase.AWAITING_CONFIRMATION
        busy = false
        storageFailed = false
    }

    fun beginRestore(): Long {
        if (pendingExternalPairing != null) busy = true
        storageFailed = false
        return nextAttempt()
    }

    fun beginConfirmation(): Long? {
        if (pendingExternalPairing == null) return null
        phase = RelayPairingConfirmationPhase.CONFIRMING
        busy = true
        storageFailed = false
        return nextAttempt()
    }

    fun showStorageFailure() {
        if (pendingExternalPairing != null) {
            phase = RelayPairingConfirmationPhase.AWAITING_CONFIRMATION
        }
        busy = false
        storageFailed = true
    }

    fun clear() {
        nextAttempt()
        pendingExternalPairing = null
        phase = null
        busy = false
        storageFailed = false
    }

    private fun nextAttempt(): Long {
        attemptGeneration = if (attemptGeneration == Long.MAX_VALUE) 1 else attemptGeneration + 1
        activeAttempt = attemptGeneration
        return activeAttempt
    }
}

internal fun consumeActionViewUri(
    action: String?,
    readUri: () -> String?,
    clearData: () -> Unit,
): String? {
    if (action != Intent.ACTION_VIEW) return null
    val raw = readUri() ?: return null
    clearData()
    return raw
}

internal class RelayPairingCoordinator(
    initialPairing: RelayPairingConfig? = null,
    initialStorageUnavailable: Boolean = false,
    private val load: (() -> RelayPairingStoredState)? = null,
    private val save: (RelayPairingConfig) -> Boolean,
    private val navigateToSettings: () -> Unit = {},
    private val storageDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutex = Mutex()
    private var initialized = load == null
    private var storageUnavailable = initialStorageUnavailable
    private var pendingExternalFingerprint: String? = null

    @Volatile
    var lastFingerprint: String? = initialPairing?.let(RelayPairingConfig::semanticFingerprint)
        private set

    suspend fun accept(config: RelayPairingConfig): RelayPairingAcceptance {
        val result = mutex.withLock {
            initializeLocked()
            acceptLocked(config)
        }
        if (result == RelayPairingAcceptance.SAVED) navigateToSettings()
        return result
    }

    suspend fun prepareExternal(config: RelayPairingConfig): RelayPairingPreparation =
        mutex.withLock {
            initializeLocked()
            if (storageUnavailable) return@withLock RelayPairingPreparation.STORAGE_FAILED
            val fingerprint = RelayPairingConfig.semanticFingerprint(config)
            if (fingerprint == lastFingerprint || fingerprint == pendingExternalFingerprint) {
                return@withLock RelayPairingPreparation.DUPLICATE
            }
            pendingExternalFingerprint = fingerprint
            RelayPairingPreparation.CONFIRMATION_REQUIRED
        }

    suspend fun confirmExternal(config: RelayPairingConfig): RelayPairingAcceptance {
        val result = mutex.withLock {
            initializeLocked()
            val fingerprint = RelayPairingConfig.semanticFingerprint(config)
            if (pendingExternalFingerprint != fingerprint) {
                return@withLock if (fingerprint == lastFingerprint) {
                    RelayPairingAcceptance.DUPLICATE
                } else {
                    RelayPairingAcceptance.STORAGE_FAILED
                }
            }
            val accepted = acceptLocked(config)
            if (accepted != RelayPairingAcceptance.STORAGE_FAILED) {
                pendingExternalFingerprint = null
            }
            accepted
        }
        return result
    }

    suspend fun cancelExternal(config: RelayPairingConfig) {
        val fingerprint = RelayPairingConfig.semanticFingerprint(config)
        mutex.withLock {
            if (pendingExternalFingerprint == fingerprint) pendingExternalFingerprint = null
        }
    }

    private suspend fun initializeLocked() {
        if (initialized) return
        val state = try {
            withContext(storageDispatcher) { requireNotNull(load).invoke() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            RelayPairingStoredState(storageUnavailable = true)
        }
        lastFingerprint = state.pairing?.let(RelayPairingConfig::semanticFingerprint)
        storageUnavailable = state.storageUnavailable
        initialized = true
    }

    private suspend fun acceptLocked(config: RelayPairingConfig): RelayPairingAcceptance {
        if (storageUnavailable) return RelayPairingAcceptance.STORAGE_FAILED
        val fingerprint = RelayPairingConfig.semanticFingerprint(config)
        if (fingerprint == lastFingerprint) return RelayPairingAcceptance.DUPLICATE
        val saved = try {
            withContext(storageDispatcher) { save(config) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        }
        if (!saved) return RelayPairingAcceptance.STORAGE_FAILED
        lastFingerprint = fingerprint
        if (pendingExternalFingerprint == fingerprint) pendingExternalFingerprint = null
        return RelayPairingAcceptance.SAVED
    }
}

internal sealed interface RelayDeepLinkRoutingResult {
    data class RelayConfirmationRequired(
        val config: RelayPairingConfig,
    ) : RelayDeepLinkRoutingResult

    data object RelayRejected : RelayDeepLinkRoutingResult
    data object LanStarted : RelayDeepLinkRoutingResult
    data object Rejected : RelayDeepLinkRoutingResult
}

internal class RelayDeepLinkRouter(
    private val saveLan: (ConnectionConfig) -> Unit,
    private val startLan: (ConnectionConfig) -> Unit,
) {
    fun route(raw: String): RelayDeepLinkRoutingResult = when (val parsed = parseScannedPayload(raw)) {
        is ScanPayloadResult.Relay -> RelayDeepLinkRoutingResult.RelayConfirmationRequired(parsed.config)
        is ScanPayloadResult.InvalidRelay -> RelayDeepLinkRoutingResult.RelayRejected
        is ScanPayloadResult.Lan -> {
            saveLan(parsed.config)
            startLan(parsed.config)
            RelayDeepLinkRoutingResult.LanStarted
        }
        null -> RelayDeepLinkRoutingResult.Rejected
    }
}

@AndroidEntryPoint
class MainActivity : ComponentActivity(), RelayPairingReceiver {

    companion object {
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
    private lateinit var pairingConfirmationState: RelayPairingConfirmationViewModel
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
        pairingConfirmationState =
            ViewModelProvider(this)[RelayPairingConfirmationViewModel::class.java]
        val prefsStore = PrefsStore.getInstance(this)
        relayPairingCoordinator = RelayPairingCoordinator(
            load = {
                val pairing = prefsStore.loadRelayPairing()
                RelayPairingStoredState(
                    pairing = pairing,
                    storageUnavailable = pairing == null && prefsStore.hasRelayPairingBlob(),
                )
            },
            save = prefsStore::saveRelayPairing,
            navigateToSettings = {
                requestSettingsNavigation()
            },
        )
        relayDeepLinkRouter = RelayDeepLinkRouter(
            saveLan = { PrefsStore.getInstance(this).saveConfig(it) },
            startLan = { WsConnectionService.start(this, it) },
        )
        restorePendingRelayPairingConfirmation()
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
        outState.putInt(STATE_RELAY_PAIRING_NEXT_REQUEST_ID, nextSettingsNavigationRequestId)
        outState.putInt(STATE_RELAY_PAIRING_PENDING_REQUEST_ID, settingsNavigationRequest)
        super.onSaveInstanceState(outState)
    }

    override fun onRelayPairingScanned(
        config: RelayPairingConfig,
        onResult: (RelayPairingAcceptance) -> Unit,
    ) {
        lifecycleScope.launch {
            val result = relayPairingCoordinator.accept(config)
            if (result == RelayPairingAcceptance.SAVED &&
                pairingConfirmationState.pendingExternalPairing
                    ?.let(RelayPairingConfig::semanticFingerprint) ==
                RelayPairingConfig.semanticFingerprint(config)
            ) {
                clearPairingConfirmation()
            }
            onResult(result)
        }
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
     * Handles both legacy LAN links and versioned relay-pair links without logging either raw URI.
     * External relay pairing is parsed first and persisted only after explicit confirmation.
     * A successful confirmation routes to settings but never starts VPN, WebSocket, or service.
     */
    private fun handleDeepLink(intent: Intent?) {
        if (intent == null) return
        val raw = consumeActionViewUri(
            action = intent.action,
            readUri = { intent.data?.toString() },
            clearData = { intent.data = null },
        ) ?: return
        when (val routed = relayDeepLinkRouter.route(raw)) {
            is RelayDeepLinkRoutingResult.RelayConfirmationRequired -> {
                val config = routed.config
                if (pairingConfirmationState.retainForPreparation(config)) {
                    restorePendingRelayPairingConfirmation()
                }
            }
            RelayDeepLinkRoutingResult.RelayRejected ->
                Log.w("MainActivity", "Relay pairing rejected")
            RelayDeepLinkRoutingResult.Rejected -> Log.w("MainActivity", "Deep link rejected")
            RelayDeepLinkRoutingResult.LanStarted -> Log.d("MainActivity", "LAN deep link parsed")
        }
    }

    private fun restorePendingRelayPairingConfirmation() {
        val config = pairingConfirmationState.pendingExternalPairing ?: return
        val phase = pairingConfirmationState.phase ?: return
        val attempt = pairingConfirmationState.beginRestore()
        lifecycleScope.launch {
            val preparation = relayPairingCoordinator.prepareExternal(config)
            if (!pairingConfirmationState.isCurrent(config, phase, attempt)) return@launch
            when (relayPairingResumeAction(phase, preparation)) {
                RelayPairingResumeAction.SHOW_CONFIRMATION ->
                    pairingConfirmationState.show(config)
                RelayPairingResumeAction.CLEAR -> pairingConfirmationState.clear()
                RelayPairingResumeAction.RESUME_CONFIRMED_SAVE ->
                    finishConfirmedRelayPairing(config, attempt)
                RelayPairingResumeAction.NAVIGATE_TO_SETTINGS -> {
                    pairingConfirmationState.clear()
                    requestSettingsNavigation()
                }
                RelayPairingResumeAction.SHOW_STORAGE_FAILURE ->
                    pairingConfirmationState.showStorageFailure()
            }
        }
    }

    private fun requestSettingsNavigation() {
        settingsNavigationRequest = nextSettingsNavigationRequestId
        nextSettingsNavigationRequestId =
            if (nextSettingsNavigationRequestId == Int.MAX_VALUE) 1
            else nextSettingsNavigationRequestId + 1
    }

    private fun confirmPendingRelayPairing() {
        val config = pairingConfirmationState.pendingExternalPairing ?: return
        if (pairingConfirmationState.busy) return
        val attempt = pairingConfirmationState.beginConfirmation() ?: return
        lifecycleScope.launch {
            finishConfirmedRelayPairing(config, attempt)
        }
    }

    private suspend fun finishConfirmedRelayPairing(
        config: RelayPairingConfig,
        attempt: Long,
    ) {
        val acceptance = relayPairingCoordinator.confirmExternal(config)
        if (!pairingConfirmationState.isCurrent(
                config,
                RelayPairingConfirmationPhase.CONFIRMING,
                attempt,
            )
        ) {
            return
        }
        when (acceptance) {
            RelayPairingAcceptance.SAVED -> {
                clearPairingConfirmation()
                requestSettingsNavigation()
            }
            RelayPairingAcceptance.DUPLICATE -> {
                clearPairingConfirmation()
                requestSettingsNavigation()
            }
            RelayPairingAcceptance.STORAGE_FAILED ->
                pairingConfirmationState.showStorageFailure()
        }
    }

    private fun dismissPendingRelayPairing() {
        val config = pairingConfirmationState.pendingExternalPairing
        clearPairingConfirmation()
        if (config != null) {
            lifecycleScope.launch { relayPairingCoordinator.cancelExternal(config) }
        }
    }

    private fun clearPairingConfirmation() {
        pairingConfirmationState.clear()
    }

    @Composable
    private fun RelayPairingConfirmationHost(content: @Composable () -> Unit) {
        content()
        val metadata = pairingConfirmationState.metadata ?: return
        AlertDialog(
            onDismissRequest = {
                if (!pairingConfirmationState.busy) dismissPendingRelayPairing()
            },
            title = { Text(stringResource(R.string.relay_pairing_confirm_title)) },
            text = {
                Column {
                    Text(stringResource(R.string.relay_pairing_confirm_name, metadata.name))
                    Spacer(modifier = androidx.compose.ui.Modifier.height(8.dp))
                    Text(stringResource(R.string.relay_pairing_confirm_endpoint, metadata.endpoint))
                    if (pairingConfirmationState.storageFailed) {
                        Spacer(modifier = androidx.compose.ui.Modifier.height(12.dp))
                        Text(stringResource(R.string.scan_pairing_save_failed))
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !pairingConfirmationState.busy,
                    onClick = ::confirmPendingRelayPairing,
                ) {
                    Text(stringResource(R.string.relay_pairing_confirm_action))
                }
            },
            dismissButton = {
                TextButton(
                    enabled = !pairingConfirmationState.busy,
                    onClick = ::dismissPendingRelayPairing,
                ) {
                    Text(stringResource(R.string.relay_pairing_cancel_action))
                }
            },
        )
    }

    private fun setRelayAwareContent(content: @Composable () -> Unit) {
        setContent {
            ClawdMobileTheme {
                RelayPairingConfirmationHost(content)
            }
        }
    }

    private fun showCurrentPermission() {
        val request = permissionQueue.getOrNull(currentPermissionIndex) ?: return
        setRelayAwareContent {
            PermissionDialog(
                icon = ClawdIcons.Bell,
                title = request.title,
                description = request.description,
                onConfirm = { permissionLauncher.launch(request.permission) },
                onSkip = { currentPermissionIndex++; showNextPermission() }
            )
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
        setRelayAwareContent {
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

    private fun checkAndRequestBatteryOptimization() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            checkOverlayPermission()
            return
        }
        setRelayAwareContent {
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

    private fun checkOverlayPermission() {
        if (Settings.canDrawOverlays(this)) {
            setupContent()
            return
        }
        setRelayAwareContent {
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

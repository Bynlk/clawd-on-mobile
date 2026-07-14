package com.clawd.mobile.ui.settings

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.service.RemoteConnectionErrorCode
import com.clawd.mobile.service.RemoteConnectionState
import com.clawd.mobile.service.WsConnectionService
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

enum class RelaySettingsAction { CONNECT, DISCONNECT }

data class RelaySettingsState(
    val showScanPrompt: Boolean,
    val vpsName: String?,
    val endpoint: String?,
    val primaryAction: RelaySettingsAction?,
    val primaryActionEnabled: Boolean,
    val canDelete: Boolean,
    val errorCode: RemoteConnectionErrorCode?,
)

internal class RelayPairingSnapshotLoader(
    private val load: () -> RelayPairingConfig?,
) {
    private var loadedRevision: Int? = null
    private var snapshot: RelayPairingConfig? = null

    fun loadFor(revision: Int): RelayPairingConfig? {
        if (loadedRevision != revision) {
            snapshot = load()
            loadedRevision = revision
        }
        return snapshot
    }
}

fun reduceRelaySettingsState(
    pairing: RelayPairingConfig?,
    connectionState: RemoteConnectionState,
): RelaySettingsState {
    if (pairing == null) {
        return RelaySettingsState(
            showScanPrompt = true,
            vpsName = null,
            endpoint = null,
            primaryAction = null,
            primaryActionEnabled = false,
            canDelete = false,
            errorCode = (connectionState as? RemoteConnectionState.FAILED)?.errorCode,
        )
    }
    val busy = connectionState == RemoteConnectionState.STARTING_VPN ||
        connectionState == RemoteConnectionState.CHECKING_HEALTH ||
        connectionState == RemoteConnectionState.CONNECTING_RELAY ||
        connectionState == RemoteConnectionState.DISCONNECTING
    return RelaySettingsState(
        showScanPrompt = false,
        vpsName = pairing.name,
        endpoint = pairing.wireGuard.endpoint,
        primaryAction = if (connectionState == RemoteConnectionState.CONNECTED) {
            RelaySettingsAction.DISCONNECT
        } else {
            RelaySettingsAction.CONNECT
        },
        primaryActionEnabled = !busy,
        canDelete = !busy,
        errorCode = (connectionState as? RemoteConnectionState.FAILED)?.errorCode,
    )
}

suspend fun disconnectThenClearRelayPairing(
    disconnect: suspend () -> Boolean,
    clearPairing: () -> Boolean,
): Boolean {
    if (!disconnect()) return false
    return clearPairing()
}

@Composable
fun RelaySettings(
    prefsStore: PrefsStore,
    remoteState: RemoteConnectionState,
    pairingRefreshRevision: Int = 0,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pairingLoader = remember(prefsStore) {
        RelayPairingSnapshotLoader(prefsStore::loadRelayPairing)
    }
    var pairing by remember {
        mutableStateOf(pairingLoader.loadFor(pairingRefreshRevision))
    }
    LaunchedEffect(pairingRefreshRevision) {
        pairing = pairingLoader.loadFor(pairingRefreshRevision)
    }
    var deleting by remember { mutableStateOf(false) }
    var deleteFailed by remember { mutableStateOf(false) }
    val model = reduceRelaySettingsState(pairing, remoteState)

    Column(modifier = modifier.padding(vertical = 8.dp)) {
        if (model.showScanPrompt) {
            Text(
                text = stringResource(R.string.remote_scan_prompt),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }

        Text(model.vpsName.orEmpty(), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            text = stringResource(R.string.remote_endpoint, model.endpoint.orEmpty()),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = remoteStateText(remoteState),
            style = MaterialTheme.typography.bodySmall,
            color = if (model.errorCode == null) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.error
            },
        )
        if (model.errorCode != null) {
            Text(
                text = model.errorCode.wireCode,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        if (deleteFailed) {
            Text(
                text = stringResource(R.string.remote_delete_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Spacer(Modifier.height(12.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                enabled = model.primaryActionEnabled && !deleting,
                onClick = {
                    when (model.primaryAction) {
                        RelaySettingsAction.CONNECT -> WsConnectionService.connectRemote(context)
                        RelaySettingsAction.DISCONNECT -> scope.launch {
                            requestRemoteDisconnect(context)
                        }
                        null -> Unit
                    }
                },
            ) {
                Text(
                    if (model.primaryAction == RelaySettingsAction.DISCONNECT) {
                        stringResource(R.string.remote_disconnect)
                    } else {
                        stringResource(R.string.remote_connect)
                    }
                )
            }
            OutlinedButton(
                enabled = model.canDelete && !deleting,
                onClick = {
                    deleting = true
                    deleteFailed = false
                    scope.launch {
                        val cleared = disconnectThenClearRelayPairing(
                            disconnect = { requestRemoteDisconnect(context) },
                            clearPairing = prefsStore::clearRelayPairing,
                        )
                        if (cleared) pairing = null else deleteFailed = true
                        deleting = false
                    }
                },
            ) {
                if (deleting) {
                    CircularProgressIndicator(modifier = Modifier.height(16.dp))
                } else {
                    Text(stringResource(R.string.remote_delete_pairing))
                }
            }
        }
    }
}

@Composable
private fun remoteStateText(state: RemoteConnectionState): String = when (state) {
    RemoteConnectionState.UNPAIRED -> stringResource(R.string.remote_status_unpaired)
    RemoteConnectionState.DISCONNECTED -> stringResource(R.string.remote_status_disconnected)
    RemoteConnectionState.STARTING_VPN -> stringResource(R.string.remote_status_starting_vpn)
    RemoteConnectionState.CHECKING_HEALTH -> stringResource(R.string.remote_status_checking_health)
    RemoteConnectionState.CONNECTING_RELAY -> stringResource(R.string.remote_status_connecting_relay)
    RemoteConnectionState.CONNECTED -> stringResource(R.string.remote_status_connected)
    RemoteConnectionState.DISCONNECTING -> stringResource(R.string.remote_status_disconnecting)
    is RemoteConnectionState.FAILED -> when (state.errorCode) {
        RemoteConnectionErrorCode.VPN_PERMISSION_DENIED -> stringResource(R.string.remote_error_vpn_permission)
        RemoteConnectionErrorCode.VPN_START_FAILED -> stringResource(R.string.remote_error_vpn_start)
        RemoteConnectionErrorCode.HEALTH_CHECK_FAILED -> stringResource(R.string.remote_error_health)
        RemoteConnectionErrorCode.RELAY_AUTH_FAILED -> stringResource(R.string.remote_error_relay_auth)
        RemoteConnectionErrorCode.RELAY_CONNECT_FAILED -> stringResource(R.string.remote_error_relay_connect)
        RemoteConnectionErrorCode.CONNECT_TIMEOUT -> stringResource(R.string.remote_error_timeout)
        RemoteConnectionErrorCode.RELAY_DISCONNECT_FAILED -> stringResource(R.string.remote_error_relay_disconnect)
        RemoteConnectionErrorCode.VPN_STOP_FAILED -> stringResource(R.string.remote_error_vpn_stop)
    }
}

private suspend fun requestRemoteDisconnect(context: Context): Boolean {
    val current = WsConnectionService.remoteConnectionState.value
    if (current == RemoteConnectionState.DISCONNECTED || current == RemoteConnectionState.UNPAIRED) {
        return true
    }
    return awaitRemoteDisconnect(
        states = WsConnectionService.remoteConnectionState,
        request = { WsConnectionService.disconnectRemote(context) },
        timeoutMillis = RemoteConnectionCoordinatorTimeout,
    )
}

internal suspend fun awaitRemoteDisconnect(
    states: StateFlow<RemoteConnectionState>,
    request: () -> Unit,
    timeoutMillis: Long,
): Boolean = coroutineScope {
    val terminal = async(start = CoroutineStart.UNDISPATCHED) {
        withTimeoutOrNull(timeoutMillis) {
            states.drop(1).first { state ->
                state == RemoteConnectionState.DISCONNECTED || state is RemoteConnectionState.FAILED
            }
        }
    }
    request()
    terminal.await() == RemoteConnectionState.DISCONNECTED
}

private const val RemoteConnectionCoordinatorTimeout = 15_000L

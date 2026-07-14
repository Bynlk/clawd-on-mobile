package com.clawd.mobile.vpn

import android.content.Context
import android.content.Intent
import android.net.VpnService
import com.clawd.mobile.data.RelayPairingConfig
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Statistics
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

sealed interface RemoteTunnelState {
    data object UNPAIRED : RemoteTunnelState
    data object PERMISSION_REQUIRED : RemoteTunnelState
    data object STARTING : RemoteTunnelState
    data object UP : RemoteTunnelState
    data class FAILED(val errorCode: RemoteTunnelErrorCode) : RemoteTunnelState
    data object STOPPING : RemoteTunnelState
    data object DOWN : RemoteTunnelState
}

enum class RemoteTunnelErrorCode(val wireCode: String) {
    BACKEND_START_FAILED("vpn_backend_start_failed"),
    BACKEND_STOP_FAILED("vpn_backend_stop_failed"),
}

interface WireGuardBackendAdapter {
    suspend fun setState(
        tunnel: Tunnel,
        state: Tunnel.State,
        config: Config?,
    ): Tunnel.State

    suspend fun statistics(tunnel: Tunnel): Statistics
}

class GoBackendAdapter(
    context: Context,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : WireGuardBackendAdapter {
    private val backend = GoBackend(context.applicationContext)

    override suspend fun setState(
        tunnel: Tunnel,
        state: Tunnel.State,
        config: Config?,
    ): Tunnel.State = withContext(dispatcher) {
        backend.setState(tunnel, state, config)
    }

    override suspend fun statistics(tunnel: Tunnel): Statistics = withContext(dispatcher) {
        backend.getStatistics(tunnel)
    }
}

class WireGuardController(
    private val backend: WireGuardBackendAdapter,
    private val scope: CoroutineScope,
    private val permissionIntentProvider: () -> Intent?,
    private val permissionLauncher: (Intent) -> Unit,
) {
    constructor(
        context: Context,
        scope: CoroutineScope,
        permissionLauncher: (Intent) -> Unit,
    ) : this(
        backend = GoBackendAdapter(context),
        scope = scope,
        permissionIntentProvider = { VpnService.prepare(context) },
        permissionLauncher = permissionLauncher,
    )

    private val _state = MutableStateFlow<RemoteTunnelState>(RemoteTunnelState.UNPAIRED)
    val state: StateFlow<RemoteTunnelState> = _state.asStateFlow()

    private val operationLock = Any()
    private val pendingPermission = AtomicReference<CompletableDeferred<Boolean>?>(null)
    private var activeStart: Deferred<RemoteTunnelState>? = null
    private var activeStop: Deferred<RemoteTunnelState>? = null
    @Volatile
    private var hasPairing = false

    private val tunnel = ClawdWireGuardTunnel { backendState ->
        when (backendState) {
            Tunnel.State.UP -> _state.value = RemoteTunnelState.UP
            Tunnel.State.DOWN -> if (hasPairing) _state.value = RemoteTunnelState.DOWN
            Tunnel.State.TOGGLE -> Unit
        }
    }

    fun prepareIntent(): Intent? = permissionIntentProvider()

    fun onPermissionResult(granted: Boolean) {
        pendingPermission.get()?.complete(granted)
    }

    suspend fun start(pairing: RelayPairingConfig): RemoteTunnelState {
        hasPairing = true
        if (_state.value == RemoteTunnelState.UP) return RemoteTunnelState.UP

        val operation = synchronized(operationLock) {
            activeStart?.takeIf { it.isActive } ?: scope.async {
                performStart(pairing)
            }.also { deferred ->
                activeStart = deferred
                deferred.invokeOnCompletion {
                    synchronized(operationLock) {
                        if (activeStart === deferred) activeStart = null
                    }
                }
            }
        }
        return operation.await()
    }

    suspend fun stop(): RemoteTunnelState {
        if (!hasPairing) return RemoteTunnelState.UNPAIRED
        if (_state.value == RemoteTunnelState.DOWN) return RemoteTunnelState.DOWN

        val operation = synchronized(operationLock) {
            activeStop?.takeIf { it.isActive } ?: scope.async {
                performStop(activeStart)
            }.also { deferred ->
                activeStop = deferred
                deferred.invokeOnCompletion {
                    synchronized(operationLock) {
                        if (activeStop === deferred) activeStop = null
                    }
                }
            }
        }
        return operation.await()
    }

    suspend fun statistics(): Statistics = backend.statistics(tunnel)

    private suspend fun performStart(pairing: RelayPairingConfig): RemoteTunnelState {
        val config = try {
            WireGuardConfigFactory.create(pairing.wireGuard)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return fail(RemoteTunnelErrorCode.BACKEND_START_FAILED)
        }

        val permissionIntent = prepareIntent()
        if (permissionIntent != null) {
            val permissionResult = CompletableDeferred<Boolean>()
            pendingPermission.set(permissionResult)
            _state.value = RemoteTunnelState.PERMISSION_REQUIRED
            try {
                permissionLauncher(permissionIntent)
                if (!permissionResult.await()) {
                    _state.value = RemoteTunnelState.DOWN
                    return RemoteTunnelState.DOWN
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return fail(RemoteTunnelErrorCode.BACKEND_START_FAILED)
            } finally {
                pendingPermission.compareAndSet(permissionResult, null)
            }
        }

        _state.value = RemoteTunnelState.STARTING
        return try {
            if (backend.setState(tunnel, Tunnel.State.UP, config) == Tunnel.State.UP) {
                _state.value = RemoteTunnelState.UP
                RemoteTunnelState.UP
            } else {
                fail(RemoteTunnelErrorCode.BACKEND_START_FAILED)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            fail(RemoteTunnelErrorCode.BACKEND_START_FAILED)
        }
    }

    private suspend fun performStop(startToAwait: Deferred<RemoteTunnelState>?): RemoteTunnelState {
        if (_state.value == RemoteTunnelState.PERMISSION_REQUIRED) {
            pendingPermission.get()?.complete(false)
        }

        if (startToAwait?.isActive == true) {
            val startResult = startToAwait.await()
            if (startResult != RemoteTunnelState.UP) {
                if (startResult !is RemoteTunnelState.FAILED) {
                    _state.value = RemoteTunnelState.DOWN
                    return RemoteTunnelState.DOWN
                }
                return startResult
            }
        }

        if (_state.value == RemoteTunnelState.DOWN) return RemoteTunnelState.DOWN
        _state.value = RemoteTunnelState.STOPPING
        return try {
            if (backend.setState(tunnel, Tunnel.State.DOWN, null) == Tunnel.State.DOWN) {
                _state.value = RemoteTunnelState.DOWN
                RemoteTunnelState.DOWN
            } else {
                fail(RemoteTunnelErrorCode.BACKEND_STOP_FAILED)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            fail(RemoteTunnelErrorCode.BACKEND_STOP_FAILED)
        }
    }

    private fun fail(errorCode: RemoteTunnelErrorCode): RemoteTunnelState.FAILED =
        RemoteTunnelState.FAILED(errorCode).also { _state.value = it }
}

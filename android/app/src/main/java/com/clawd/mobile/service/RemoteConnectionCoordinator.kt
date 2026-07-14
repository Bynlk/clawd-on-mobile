package com.clawd.mobile.service

import com.clawd.mobile.data.RelayConnectionConfig
import com.clawd.mobile.data.RelayPairingConfig
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

private const val MAX_RELAY_HEALTH_RESPONSE_BYTES = 1_024

internal fun validateRelayHealthResponse(
    statusCode: Int,
    contentLength: Long,
    input: InputStream,
): Boolean {
    if (statusCode !in 200..299 || contentLength < -1 ||
        contentLength > MAX_RELAY_HEALTH_RESPONSE_BYTES
    ) {
        return false
    }
    return try {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(256)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > MAX_RELAY_HEALTH_RESPONSE_BYTES) return false
            output.write(buffer, 0, count)
        }
        val root = Json.parseToJsonElement(output.toString(Charsets.UTF_8.name())) as? JsonObject
            ?: return false
        val allowedKeys = setOf("version", "status", "uptimeSeconds")
        if (!root.keys.containsAll(setOf("version", "status")) ||
            root.keys.any { it !in allowedKeys }
        ) {
            return false
        }
        val version = root["version"]?.jsonPrimitive ?: return false
        val status = root["status"]?.jsonPrimitive ?: return false
        val uptime = root["uptimeSeconds"]?.jsonPrimitive
        !version.isString && version.intOrNull == 1 &&
            status.isString && status.content == "ok" &&
            (uptime == null || (!uptime.isString && (uptime.longOrNull ?: -1) >= 0))
    } catch (_: Exception) {
        false
    }
}

sealed interface RemoteConnectionState {
    data object UNPAIRED : RemoteConnectionState
    data object DISCONNECTED : RemoteConnectionState
    data object STARTING_VPN : RemoteConnectionState
    data object CHECKING_HEALTH : RemoteConnectionState
    data object CONNECTING_RELAY : RemoteConnectionState
    data object CONNECTED : RemoteConnectionState
    data object DISCONNECTING : RemoteConnectionState
    data class FAILED(val errorCode: RemoteConnectionErrorCode) : RemoteConnectionState
}

enum class RemoteConnectionErrorCode(val wireCode: String) {
    VPN_PERMISSION_DENIED("remote_vpn_permission_denied"),
    VPN_START_FAILED("remote_vpn_start_failed"),
    HEALTH_CHECK_FAILED("remote_health_check_failed"),
    RELAY_AUTH_FAILED("remote_relay_auth_failed"),
    RELAY_CONNECT_FAILED("remote_relay_connect_failed"),
    CONNECT_TIMEOUT("remote_connect_timeout"),
    RELAY_DISCONNECT_FAILED("remote_relay_disconnect_failed"),
    VPN_STOP_FAILED("remote_vpn_stop_failed"),
}

enum class RemoteVpnStartResult { UP, PERMISSION_DENIED, FAILED }

enum class RemoteRelayConnectResult { CONNECTED, AUTH_FAILED, FAILED }

interface RemoteVpnConnectionAdapter {
    suspend fun start(pairing: RelayPairingConfig): RemoteVpnStartResult
    suspend fun stop(): Boolean
}

fun interface RemoteHealthCheckAdapter {
    suspend fun check(): Boolean
}

interface RemoteRelayConnectionAdapter {
    suspend fun connect(config: RelayConnectionConfig): RemoteRelayConnectResult
    suspend fun disconnect(): Boolean
}

/** Health probe restricted to the fixed WireGuard gateway address. */
class FixedRelayHealthCheckAdapter : RemoteHealthCheckAdapter {
    override suspend fun check(): Boolean = withContext(Dispatchers.IO) {
        val connection = URL(HEALTH_URL).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = IO_TIMEOUT_MS
            connection.readTimeout = IO_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            val statusCode = connection.responseCode
            if (statusCode !in 200..299) return@withContext false
            connection.inputStream.use { input ->
                validateRelayHealthResponse(
                    statusCode = statusCode,
                    contentLength = connection.contentLengthLong,
                    input = input,
                )
            }
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        const val HEALTH_URL = "http://10.8.0.1:7891/health"
        private const val IO_TIMEOUT_MS = 5_000
    }
}

/**
 * Owns the one-click remote connection transaction. Pairing secrets stay in memory and are
 * obtained from encrypted preferences for each explicit user connect attempt.
 */
class RemoteConnectionCoordinator(
    private val scope: CoroutineScope,
    private val pairingProvider: () -> RelayPairingConfig?,
    private val vpn: RemoteVpnConnectionAdapter,
    private val health: RemoteHealthCheckAdapter,
    private val relay: RemoteRelayConnectionAdapter,
    private val timeoutMillis: Long = DEFAULT_TIMEOUT_MS,
) {
    private data class CleanupResult(
        val relayStopped: Boolean,
        val vpnStopped: Boolean,
    )

    private class Attempt(val generation: Long) {
        val cleanupStarted = AtomicBoolean(false)
        val cleanupResult = CompletableDeferred<CleanupResult>()
    }

    private class StepFailure(val code: RemoteConnectionErrorCode) : Exception()

    private val lock = Any()
    private val _state = MutableStateFlow<RemoteConnectionState>(RemoteConnectionState.DISCONNECTED)
    val state: StateFlow<RemoteConnectionState> = _state.asStateFlow()

    private var generation = 0L
    private var manualConnectIntent = false
    private var currentAttempt: Attempt? = null
    private var connectOperation: Deferred<RemoteConnectionState>? = null
    private var disconnectOperation: Deferred<RemoteConnectionState>? = null

    suspend fun connect(): RemoteConnectionState {
        val operation = synchronized(lock) {
            manualConnectIntent = true
            connectOperation?.takeIf { it.isActive } ?: run {
                if (_state.value == RemoteConnectionState.CONNECTED) return@synchronized null
                val waitForDisconnect = disconnectOperation?.takeIf { it.isActive }
                val attempt = Attempt(nextGenerationLocked())
                currentAttempt = attempt
                scope.async {
                    waitForDisconnect?.await()
                    performConnect(attempt)
                }.also(::trackConnectLocked)
            }
        }
        return operation?.await() ?: RemoteConnectionState.CONNECTED
    }

    suspend fun disconnect(): RemoteConnectionState {
        val operation = synchronized(lock) {
            manualConnectIntent = false
            disconnectOperation?.takeIf { it.isActive } ?: run {
                if (currentAttempt == null && _state.value == RemoteConnectionState.DISCONNECTED) {
                    return@synchronized null
                }
                val disconnectGeneration = nextGenerationLocked()
                val attempt = currentAttempt
                connectOperation?.cancel()
                scope.async {
                    publish(disconnectGeneration, RemoteConnectionState.DISCONNECTING)
                    val cleanup = attempt?.let { cleanupOnce(it) }
                        ?: CleanupResult(relayStopped = true, vpnStopped = true)
                    synchronized(lock) {
                        if (currentAttempt === attempt) currentAttempt = null
                    }
                    val result = when {
                        !cleanup.relayStopped -> RemoteConnectionState.FAILED(
                            RemoteConnectionErrorCode.RELAY_DISCONNECT_FAILED,
                        )
                        !cleanup.vpnStopped -> RemoteConnectionState.FAILED(
                            RemoteConnectionErrorCode.VPN_STOP_FAILED,
                        )
                        else -> RemoteConnectionState.DISCONNECTED
                    }
                    publish(disconnectGeneration, result)
                    result
                }.also(::trackDisconnectLocked)
            }
        }
        return operation?.await() ?: RemoteConnectionState.DISCONNECTED
    }

    /** Re-runs the transaction only while the latest user intent is still connected. */
    fun onNetworkChanged(): Job? = synchronized(lock) {
        if (!manualConnectIntent || connectOperation?.isActive == true ||
            disconnectOperation?.isActive == true
        ) {
            return@synchronized null
        }
        val previousAttempt = currentAttempt
        val retryGeneration = nextGenerationLocked()
        scope.async {
            previousAttempt?.let { cleanupOnce(it) }
            val attempt = synchronized(lock) {
                if (!manualConnectIntent || generation != retryGeneration) return@async _state.value
                Attempt(retryGeneration).also { currentAttempt = it }
            }
            performConnect(attempt)
        }.also(::trackConnectLocked)
    }

    private suspend fun performConnect(attempt: Attempt): RemoteConnectionState {
        val pairing = try {
            pairingProvider()
        } catch (_: Exception) {
            null
        }
        if (pairing == null) {
            synchronized(lock) {
                if (generation == attempt.generation) {
                    manualConnectIntent = false
                    currentAttempt = null
                }
            }
            publish(attempt.generation, RemoteConnectionState.UNPAIRED)
            return RemoteConnectionState.UNPAIRED
        }

        return try {
            withTimeout(timeoutMillis) {
                publish(attempt.generation, RemoteConnectionState.STARTING_VPN)
                val vpnResult = try {
                    vpn.start(pairing)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    RemoteVpnStartResult.FAILED
                }
                when (vpnResult) {
                    RemoteVpnStartResult.UP -> Unit
                    RemoteVpnStartResult.PERMISSION_DENIED ->
                        throw StepFailure(RemoteConnectionErrorCode.VPN_PERMISSION_DENIED)
                    RemoteVpnStartResult.FAILED ->
                        throw StepFailure(RemoteConnectionErrorCode.VPN_START_FAILED)
                }

                publish(attempt.generation, RemoteConnectionState.CHECKING_HEALTH)
                val healthy = try {
                    health.check()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    false
                }
                if (!healthy) throw StepFailure(RemoteConnectionErrorCode.HEALTH_CHECK_FAILED)

                publish(attempt.generation, RemoteConnectionState.CONNECTING_RELAY)
                val relayResult = try {
                    relay.connect(pairing.relay)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    RemoteRelayConnectResult.FAILED
                }
                when (relayResult) {
                    RemoteRelayConnectResult.CONNECTED -> Unit
                    RemoteRelayConnectResult.AUTH_FAILED ->
                        throw StepFailure(RemoteConnectionErrorCode.RELAY_AUTH_FAILED)
                    RemoteRelayConnectResult.FAILED ->
                        throw StepFailure(RemoteConnectionErrorCode.RELAY_CONNECT_FAILED)
                }

                RemoteConnectionState.CONNECTED.also { publish(attempt.generation, it) }
            }
        } catch (_: TimeoutCancellationException) {
            failAndCleanup(attempt, RemoteConnectionErrorCode.CONNECT_TIMEOUT)
        } catch (failure: StepFailure) {
            failAndCleanup(attempt, failure.code)
        } catch (cancelled: CancellationException) {
            cleanupOnce(attempt)
            throw cancelled
        }
    }

    private suspend fun failAndCleanup(
        attempt: Attempt,
        code: RemoteConnectionErrorCode,
    ): RemoteConnectionState {
        cleanupOnce(attempt)
        val result = RemoteConnectionState.FAILED(code)
        publish(attempt.generation, result)
        return result
    }

    private suspend fun cleanupOnce(attempt: Attempt): CleanupResult {
        if (attempt.cleanupStarted.compareAndSet(false, true)) {
            val result = withContext(NonCancellable) {
                val relayStopped = try {
                    relay.disconnect()
                } catch (_: Exception) {
                    false
                }
                val vpnStopped = try {
                    vpn.stop()
                } catch (_: Exception) {
                    false
                }
                CleanupResult(relayStopped, vpnStopped)
            }
            attempt.cleanupResult.complete(result)
            return result
        }
        return withContext(NonCancellable) { attempt.cleanupResult.await() }
    }

    private fun publish(expectedGeneration: Long, value: RemoteConnectionState) {
        synchronized(lock) {
            if (generation == expectedGeneration) _state.value = value
        }
    }

    private fun nextGenerationLocked(): Long {
        generation = if (generation == Long.MAX_VALUE) 1L else generation + 1L
        return generation
    }

    private fun trackConnectLocked(operation: Deferred<RemoteConnectionState>) {
        connectOperation = operation
        operation.invokeOnCompletion {
            synchronized(lock) {
                if (connectOperation === operation) connectOperation = null
            }
        }
    }

    private fun trackDisconnectLocked(operation: Deferred<RemoteConnectionState>) {
        disconnectOperation = operation
        operation.invokeOnCompletion {
            synchronized(lock) {
                if (disconnectOperation === operation) disconnectOperation = null
            }
        }
    }

    companion object {
        const val DEFAULT_TIMEOUT_MS = 15_000L
    }
}

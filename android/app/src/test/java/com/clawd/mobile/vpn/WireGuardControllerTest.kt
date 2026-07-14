package com.clawd.mobile.vpn

import android.content.Intent
import com.clawd.mobile.data.RelayConnectionConfig
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.data.RelayWireGuardConfig
import com.wireguard.android.backend.Statistics
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import io.mockk.mockk
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WireGuardControllerTest {
    private val privateKey = Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
    private val serverPublicKey = Base64.getEncoder().encodeToString(ByteArray(32) { 8 })

    private fun pairing() = RelayPairingConfig(
        version = 1,
        name = "Controller fixture",
        wireGuard = RelayWireGuardConfig(
            privateKey = privateKey,
            address = "10.8.0.3/32",
            serverPublicKey = serverPublicKey,
            endpoint = "198.51.100.7:51820",
            allowedIps = listOf("10.8.0.0/24"),
            persistentKeepalive = 25,
        ),
        relay = RelayConnectionConfig(
            url = "ws://10.8.0.1:7891",
            token = "ab".repeat(32),
        ),
        issuedAt = 1_783_900_800_000,
    )

    @Test
    fun `permission grant drives UNPAIRED required starting up stopping and down states`() = runTest {
        val backend = FakeBackend().apply {
            upGate = CompletableDeferred()
            downGate = CompletableDeferred()
        }
        val permissionIntent = mockk<Intent>()
        val launched = mutableListOf<Intent>()
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { permissionIntent },
            permissionLauncher = launched::add,
        )

        assertEquals(RemoteTunnelState.UNPAIRED, controller.state.value)
        assertSame(permissionIntent, controller.prepareIntent())

        val starting = async { controller.start(pairing()) }
        runCurrent()
        assertEquals(RemoteTunnelState.PERMISSION_REQUIRED, controller.state.value)
        assertEquals(listOf(permissionIntent), launched)

        controller.onPermissionResult(granted = true)
        backend.upEntered.await()
        assertEquals(RemoteTunnelState.STARTING, controller.state.value)

        backend.upGate?.complete(Unit)
        assertEquals(RemoteTunnelState.UP, starting.await())
        assertEquals(RemoteTunnelState.UP, controller.state.value)

        val stopping = async { controller.stop() }
        backend.downEntered.await()
        assertEquals(RemoteTunnelState.STOPPING, controller.state.value)

        backend.downGate?.complete(Unit)
        assertEquals(RemoteTunnelState.DOWN, stopping.await())
        assertEquals(RemoteTunnelState.DOWN, controller.state.value)
    }

    @Test
    fun `duplicate starts coalesce into one backend activation`() = runTest {
        val backend = FakeBackend().apply { upGate = CompletableDeferred() }
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { null },
            permissionLauncher = {},
        )

        val first = async { controller.start(pairing()) }
        backend.upEntered.await()
        val second = async { controller.start(pairing()) }
        runCurrent()

        assertEquals(1, backend.upCalls)
        assertEquals(RemoteTunnelState.STARTING, controller.state.value)

        backend.upGate?.complete(Unit)
        assertEquals(RemoteTunnelState.UP, first.await())
        assertEquals(RemoteTunnelState.UP, second.await())
        assertEquals(1, backend.upCalls)
    }

    @Test
    fun `permission denial returns down without touching backend`() = runTest {
        val permissionIntent = mockk<Intent>()
        val backend = FakeBackend()
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { permissionIntent },
            permissionLauncher = {},
        )

        val starting = async { controller.start(pairing()) }
        runCurrent()
        assertEquals(RemoteTunnelState.PERMISSION_REQUIRED, controller.state.value)

        controller.onPermissionResult(granted = false)

        assertEquals(RemoteTunnelState.DOWN, starting.await())
        assertEquals(RemoteTunnelState.DOWN, controller.state.value)
        assertEquals(0, backend.upCalls)
        assertEquals(0, backend.downCalls)
    }

    @Test
    fun `stop is idempotent while stopping and after down`() = runTest {
        val backend = FakeBackend()
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { null },
            permissionLauncher = {},
        )
        assertEquals(RemoteTunnelState.UP, controller.start(pairing()))
        backend.downGate = CompletableDeferred()

        val first = async { controller.stop() }
        backend.downEntered.await()
        val second = async { controller.stop() }
        runCurrent()

        assertEquals(RemoteTunnelState.STOPPING, controller.state.value)
        assertEquals(1, backend.downCalls)

        backend.downGate?.complete(Unit)
        assertEquals(RemoteTunnelState.DOWN, first.await())
        assertEquals(RemoteTunnelState.DOWN, second.await())
        assertEquals(RemoteTunnelState.DOWN, controller.stop())
        assertEquals(1, backend.downCalls)
    }

    @Test
    fun `stop while unpaired is a backend free no-op`() = runTest {
        val backend = FakeBackend()
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { null },
            permissionLauncher = {},
        )

        assertEquals(RemoteTunnelState.UNPAIRED, controller.stop())
        assertEquals(RemoteTunnelState.UNPAIRED, controller.state.value)
        assertEquals(0, backend.downCalls)
    }

    @Test
    fun `backend start failure exposes only a stable error code`() = runTest {
        val backendMessage = "backend rejected private key $privateKey"
        val backend = FakeBackend().apply { upFailure = IllegalStateException(backendMessage) }
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { null },
            permissionLauncher = {},
        )

        val result = controller.start(pairing())

        assertTrue(result is RemoteTunnelState.FAILED)
        result as RemoteTunnelState.FAILED
        assertEquals(RemoteTunnelErrorCode.BACKEND_START_FAILED, result.errorCode)
        assertEquals("vpn_backend_start_failed", result.errorCode.wireCode)
        assertFalse(result.toString().contains(privateKey))
        assertFalse(result.toString().contains(backendMessage))
    }

    @Test
    fun `backend stop failure uses a different stable error code`() = runTest {
        val backend = FakeBackend()
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { null },
            permissionLauncher = {},
        )
        controller.start(pairing())
        backend.downFailure = IllegalStateException("secret backend stop detail")

        val result = controller.stop()

        assertEquals(
            RemoteTunnelState.FAILED(RemoteTunnelErrorCode.BACKEND_STOP_FAILED),
            result,
        )
        assertEquals("vpn_backend_stop_failed", (result as RemoteTunnelState.FAILED).errorCode.wireCode)
        assertFalse(result.toString().contains("secret backend stop detail"))
    }

    @Test
    fun `statistics delegates through the backend adapter`() = runTest {
        val backend = FakeBackend()
        val controller = WireGuardController(
            backend = backend,
            scope = this,
            permissionIntentProvider = { null },
            permissionLauncher = {},
        )

        assertSame(backend.statistics, controller.statistics())
        assertEquals(1, backend.statisticsCalls)
    }

    private class FakeBackend : WireGuardBackendAdapter {
        var upCalls = 0
        var downCalls = 0
        var statisticsCalls = 0
        var upGate: CompletableDeferred<Unit>? = null
        var downGate: CompletableDeferred<Unit>? = null
        val upEntered = CompletableDeferred<Unit>()
        val downEntered = CompletableDeferred<Unit>()
        var upFailure: Exception? = null
        var downFailure: Exception? = null
        val statistics: Statistics = mockk()

        override suspend fun setState(
            tunnel: Tunnel,
            state: Tunnel.State,
            config: Config?,
        ): Tunnel.State = when (state) {
            Tunnel.State.UP -> {
                upCalls += 1
                upEntered.complete(Unit)
                upGate?.await()
                upFailure?.let { throw it }
                Tunnel.State.UP
            }

            Tunnel.State.DOWN -> {
                downCalls += 1
                downEntered.complete(Unit)
                downGate?.await()
                downFailure?.let { throw it }
                Tunnel.State.DOWN
            }

            Tunnel.State.TOGGLE -> error("Controller must not toggle backend state")
        }

        override suspend fun statistics(tunnel: Tunnel): Statistics {
            statisticsCalls += 1
            return statistics
        }
    }
}

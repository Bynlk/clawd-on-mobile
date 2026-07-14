package com.clawd.mobile.service

import com.clawd.mobile.data.RelayConnectionConfig
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.data.RelayWireGuardConfig
import java.io.ByteArrayInputStream
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteConnectionCoordinatorTest {
    @Test
    fun `health response accepts only the exact ready schema`() {
        assertTrue(
            validateRelayHealthResponse(
                statusCode = 200,
                contentLength = -1,
                input = ByteArrayInputStream("{\"version\":1,\"status\":\"ok\"}".toByteArray()),
            ),
        )
        assertTrue(
            validateRelayHealthResponse(
                statusCode = 200,
                contentLength = -1,
                input = ByteArrayInputStream(
                    "{\"version\":1,\"status\":\"ok\",\"uptimeSeconds\":42}".toByteArray(),
                ),
            ),
        )

        for (payload in listOf(
            "{\"version\":2,\"status\":\"ok\"}",
            "{\"version\":1,\"status\":\"down\"}",
            "{\"version\":1,\"status\":\"ok\",\"token\":\"secret\"}",
            "{\"version\":1,\"status\":\"ok\",\"uptimeSeconds\":-1}",
            "{\"version\":\"1\",\"status\":\"ok\"}",
            "not-json",
        )) {
            assertTrue(
                "must reject $payload",
                !validateRelayHealthResponse(
                    statusCode = 200,
                    contentLength = payload.length.toLong(),
                    input = ByteArrayInputStream(payload.toByteArray()),
                ),
            )
        }
    }

    @Test
    fun `health response rejects non-success and bounded oversized bodies`() {
        val valid = "{\"version\":1,\"status\":\"ok\"}".toByteArray()
        assertTrue(
            !validateRelayHealthResponse(
                statusCode = 503,
                contentLength = valid.size.toLong(),
                input = ByteArrayInputStream(valid),
            ),
        )
        val oversized = ByteArray(1_025) { 'x'.code.toByte() }
        assertTrue(
            !validateRelayHealthResponse(
                statusCode = 200,
                contentLength = -1,
                input = ByteArrayInputStream(oversized),
            ),
        )
    }

    @Test
    fun `connect and disconnect use strict forward and reverse order`() = runTest {
        val events = mutableListOf<String>()
        val coordinator = coordinator(scope = this, events = events)

        assertEquals(RemoteConnectionState.CONNECTED, coordinator.connect())
        assertEquals(
            listOf("vpn.start", "health.check", "relay.connect"),
            events,
        )

        assertEquals(RemoteConnectionState.DISCONNECTED, coordinator.disconnect())
        assertEquals(
            listOf(
                "vpn.start", "health.check", "relay.connect",
                "relay.disconnect", "vpn.stop",
            ),
            events,
        )
    }

    @Test
    fun `health failure rolls back once in reverse order`() = runTest {
        val events = mutableListOf<String>()
        val coordinator = coordinator(scope = this, events = events, healthResult = false)

        assertEquals(
            RemoteConnectionState.FAILED(RemoteConnectionErrorCode.HEALTH_CHECK_FAILED),
            coordinator.connect(),
        )
        assertEquals(
            listOf("vpn.start", "health.check", "relay.disconnect", "vpn.stop"),
            events,
        )

        coordinator.disconnect()
        assertEquals(1, events.count { it == "relay.disconnect" })
        assertEquals(1, events.count { it == "vpn.stop" })
    }

    @Test
    fun `hung cleanup is bounded and still attempts vpn stop`() = runTest {
        val events = mutableListOf<String>()
        val neverReturns = CompletableDeferred<Boolean>()
        val coordinator = coordinator(
            scope = this,
            events = events,
            relayDisconnect = { neverReturns.await() },
            cleanupTimeoutMillis = 100,
        )
        coordinator.connect()

        val disconnecting = async { coordinator.disconnect() }
        runCurrent()
        assertEquals(RemoteConnectionState.DISCONNECTING, coordinator.state.value)
        advanceTimeBy(101)
        runCurrent()

        assertEquals(
            RemoteConnectionState.FAILED(RemoteConnectionErrorCode.RELAY_DISCONNECT_FAILED),
            disconnecting.await(),
        )
        assertEquals(1, events.count { it == "relay.disconnect" })
        assertEquals(1, events.count { it == "vpn.stop" })
    }

    @Test
    fun `relay auth failure has stable code and rolls back`() = runTest {
        val events = mutableListOf<String>()
        val coordinator = coordinator(
            scope = this,
            events = events,
            relayResult = RemoteRelayConnectResult.AUTH_FAILED,
        )

        val result = coordinator.connect()

        assertEquals(
            RemoteConnectionState.FAILED(RemoteConnectionErrorCode.RELAY_AUTH_FAILED),
            result,
        )
        assertEquals("remote_relay_auth_failed", (result as RemoteConnectionState.FAILED).errorCode.wireCode)
        assertEquals(
            listOf(
                "vpn.start", "health.check", "relay.connect",
                "relay.disconnect", "vpn.stop",
            ),
            events,
        )
    }

    @Test
    fun `duplicate connect calls coalesce and total timeout cleans up once`() = runTest {
        val events = mutableListOf<String>()
        val gate = CompletableDeferred<RemoteVpnStartResult>()
        val coordinator = coordinator(scope = this, events = events, vpnStart = { gate.await() }, timeoutMillis = 15_000)

        val first = async { coordinator.connect() }
        runCurrent()
        val second = async { coordinator.connect() }
        runCurrent()
        assertEquals(1, events.count { it == "vpn.start" })

        advanceUntilIdle()

        val expected = RemoteConnectionState.FAILED(RemoteConnectionErrorCode.CONNECT_TIMEOUT)
        assertEquals(expected, first.await())
        assertEquals(expected, second.await())
        assertEquals(1, events.count { it == "relay.disconnect" })
        assertEquals(1, events.count { it == "vpn.stop" })
    }

    @Test
    fun `disconnect cancels an in-flight generation and stale completion cannot win`() = runTest {
        val events = mutableListOf<String>()
        val gate = CompletableDeferred<RemoteVpnStartResult>()
        val coordinator = coordinator(scope = this, events = events, vpnStart = { gate.await() })

        val connecting = async { coordinator.connect() }
        runCurrent()
        assertEquals(RemoteConnectionState.STARTING_VPN, coordinator.state.value)

        assertEquals(RemoteConnectionState.DISCONNECTED, coordinator.disconnect())
        gate.complete(RemoteVpnStartResult.UP)
        runCurrent()

        assertTrue(connecting.isCancelled)
        assertEquals(RemoteConnectionState.DISCONNECTED, coordinator.state.value)
        assertEquals(1, events.count { it == "relay.disconnect" })
        assertEquals(1, events.count { it == "vpn.stop" })
        assertEquals(RemoteConnectionState.DISCONNECTED, coordinator.disconnect())
        assertEquals(1, events.count { it == "vpn.stop" })
    }

    @Test
    fun `network change retries only while manual connect intent remains active`() = runTest {
        val events = mutableListOf<String>()
        val coordinator = coordinator(scope = this, events = events)
        coordinator.connect()
        events.clear()

        val retry = coordinator.onNetworkChanged()
        assertTrue(retry != null)
        retry?.join()
        assertEquals(
            listOf(
                "relay.disconnect", "vpn.stop",
                "vpn.start", "health.check", "relay.connect",
            ),
            events,
        )

        coordinator.disconnect()
        events.clear()
        assertNull(coordinator.onNetworkChanged())
        advanceUntilIdle()
        assertTrue(events.isEmpty())
    }

    @Test
    fun `missing encrypted pairing stays unpaired without touching transports`() = runTest {
        val events = mutableListOf<String>()
        val coordinator = coordinator(scope = this, events = events, pairing = null)

        assertSame(RemoteConnectionState.UNPAIRED, coordinator.connect())
        assertTrue(events.isEmpty())
    }

    private fun coordinator(
        scope: kotlinx.coroutines.CoroutineScope,
        events: MutableList<String>,
        pairing: RelayPairingConfig? = pairing(),
        healthResult: Boolean = true,
        relayResult: RemoteRelayConnectResult = RemoteRelayConnectResult.CONNECTED,
        vpnStart: suspend () -> RemoteVpnStartResult = { RemoteVpnStartResult.UP },
        vpnStop: suspend () -> Boolean = { true },
        relayDisconnect: suspend () -> Boolean = { true },
        timeoutMillis: Long = 15_000,
        cleanupTimeoutMillis: Long = 5_000,
    ) = RemoteConnectionCoordinator(
        scope = scope,
        pairingProvider = { pairing },
        vpn = object : RemoteVpnConnectionAdapter {
            override suspend fun start(pairing: RelayPairingConfig): RemoteVpnStartResult {
                events += "vpn.start"
                return vpnStart()
            }

            override suspend fun stop(): Boolean {
                events += "vpn.stop"
                return vpnStop()
            }
        },
        health = RemoteHealthCheckAdapter {
            events += "health.check"
            healthResult
        },
        relay = object : RemoteRelayConnectionAdapter {
            override suspend fun connect(config: RelayConnectionConfig): RemoteRelayConnectResult {
                events += "relay.connect"
                return relayResult
            }

            override suspend fun disconnect(): Boolean {
                events += "relay.disconnect"
                return relayDisconnect()
            }
        },
        timeoutMillis = timeoutMillis,
        cleanupTimeoutMillis = cleanupTimeoutMillis,
    )

    private fun pairing(): RelayPairingConfig {
        val privateKey = Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
        val publicKey = Base64.getEncoder().encodeToString(ByteArray(32) { 8 })
        return RelayPairingConfig(
            version = 1,
            name = "Task 10 VPS",
            wireGuard = RelayWireGuardConfig(
                privateKey = privateKey,
                address = "10.8.0.3/32",
                serverPublicKey = publicKey,
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
    }
}

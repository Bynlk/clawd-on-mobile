package com.clawd.mobile.ui.settings

import com.clawd.mobile.data.RelayConnectionConfig
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.data.RelayWireGuardConfig
import com.clawd.mobile.service.RemoteConnectionErrorCode
import com.clawd.mobile.service.RemoteConnectionState
import java.util.Base64
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RelaySettingsStateTest {
    @Test
    fun `pairing snapshot reloads only when the non-sensitive revision changes`() {
        var current = pairing()
        var loads = 0
        val loader = RelayPairingSnapshotLoader {
            loads += 1
            current
        }

        val first = loader.loadFor(revision = 1)
        current = pairing(name = "Replacement VPS")
        val unchanged = loader.loadFor(revision = 1)
        val refreshed = loader.loadFor(revision = 2)

        assertEquals("Task 10 VPS", first?.name)
        assertEquals("Task 10 VPS", unchanged?.name)
        assertEquals("Replacement VPS", refreshed?.name)
        assertEquals(2, loads)
    }

    @Test
    fun `disconnect waits for a new terminal state instead of reusing old failure`() = runTest {
        val states = MutableStateFlow<RemoteConnectionState>(
            RemoteConnectionState.FAILED(RemoteConnectionErrorCode.RELAY_AUTH_FAILED),
        )
        var requested = false

        val result = async {
            awaitRemoteDisconnect(
                states = states,
                request = { requested = true },
                timeoutMillis = 1_000,
            )
        }
        runCurrent()

        assertTrue(requested)
        assertFalse("old FAILED must not complete this disconnect", result.isCompleted)
        states.value = RemoteConnectionState.DISCONNECTING
        runCurrent()
        assertFalse(result.isCompleted)
        states.value = RemoteConnectionState.DISCONNECTED
        runCurrent()
        assertTrue(result.await())
    }

    @Test
    fun `unpaired model shows scan prompt`() {
        val model = reduceRelaySettingsState(null, RemoteConnectionState.UNPAIRED)

        assertTrue(model.showScanPrompt)
        assertEquals(null, model.vpsName)
        assertEquals(null, model.primaryAction)
        assertFalse(model.canDelete)
    }

    @Test
    fun `paired disconnected model shows public identity and connect action`() {
        val model = reduceRelaySettingsState(pairing(), RemoteConnectionState.DISCONNECTED)

        assertFalse(model.showScanPrompt)
        assertEquals("Task 10 VPS", model.vpsName)
        assertEquals("198.51.100.7:51820", model.endpoint)
        assertEquals(RelaySettingsAction.CONNECT, model.primaryAction)
        assertTrue(model.primaryActionEnabled)
        assertTrue(model.canDelete)
    }

    @Test
    fun `connecting disables delete and connected changes action to disconnect`() {
        val starting = reduceRelaySettingsState(pairing(), RemoteConnectionState.CHECKING_HEALTH)
        assertEquals(RelaySettingsAction.CONNECT, starting.primaryAction)
        assertFalse(starting.primaryActionEnabled)
        assertFalse(starting.canDelete)

        val connected = reduceRelaySettingsState(pairing(), RemoteConnectionState.CONNECTED)
        assertEquals(RelaySettingsAction.DISCONNECT, connected.primaryAction)
        assertTrue(connected.primaryActionEnabled)
        assertTrue(connected.canDelete)
    }

    @Test
    fun `failure retains stable error code and allows retry`() {
        val model = reduceRelaySettingsState(
            pairing(),
            RemoteConnectionState.FAILED(RemoteConnectionErrorCode.RELAY_AUTH_FAILED),
        )

        assertEquals(RemoteConnectionErrorCode.RELAY_AUTH_FAILED, model.errorCode)
        assertEquals(RelaySettingsAction.CONNECT, model.primaryAction)
        assertTrue(model.primaryActionEnabled)
    }

    @Test
    fun `delete disconnects before clearing and never clears after failed disconnect`() = runTest {
        val events = mutableListOf<String>()
        val failed = disconnectThenClearRelayPairing(
            disconnect = { events += "disconnect"; false },
            clearPairing = { events += "clear"; true },
        )
        assertFalse(failed)
        assertEquals(listOf("disconnect"), events)

        events.clear()
        val succeeded = disconnectThenClearRelayPairing(
            disconnect = { events += "disconnect"; true },
            clearPairing = { events += "clear"; true },
        )
        assertTrue(succeeded)
        assertEquals(listOf("disconnect", "clear"), events)
    }

    private fun pairing(name: String = "Task 10 VPS"): RelayPairingConfig = RelayPairingConfig(
        version = 1,
        name = name,
        wireGuard = RelayWireGuardConfig(
            privateKey = Base64.getEncoder().encodeToString(ByteArray(32) { 7 }),
            address = "10.8.0.3/32",
            serverPublicKey = Base64.getEncoder().encodeToString(ByteArray(32) { 8 }),
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

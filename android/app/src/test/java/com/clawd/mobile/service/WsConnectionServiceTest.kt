package com.clawd.mobile.service

import android.app.Activity
import android.content.Intent
import com.clawd.mobile.VpnPermissionResultRelay
import com.clawd.mobile.ui.navigation.selectActiveConnectionTag
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.ConnectionTag
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for [WsConnectionService] companion constants and contract.
 *
 * Full lifecycle tests (onStartCommand, WakeLock, WifiLock) require Android
 * instrumentation or Robolectric. These tests verify the static contract
 * and constants that don't need an Android context.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WsConnectionServiceTest {

    @Test
    fun `notification ID is a valid positive integer`() {
        assertTrue("NOTIFICATION_ID should be positive", WsConnectionService.NOTIFICATION_ID > 0)
    }

    @Test
    fun `channel constant is defined`() {
        assertEquals("clawd_service", WsConnectionService.CHANNEL_SERVICE)
    }

    @Test
    fun `action constants are defined`() {
        assertEquals("com.clawd.mobile.CONNECT", WsConnectionService.ACTION_CONNECT)
        assertEquals("com.clawd.mobile.DISCONNECT", WsConnectionService.ACTION_DISCONNECT)
        assertEquals("com.clawd.mobile.REMOTE_CONNECT", WsConnectionService.ACTION_REMOTE_CONNECT)
        assertEquals("com.clawd.mobile.REMOTE_DISCONNECT", WsConnectionService.ACTION_REMOTE_DISCONNECT)
    }

    @Test
    fun `companion has expected static methods`() {
        val companion = WsConnectionService.Companion::class.java
        assertNotNull(companion.getDeclaredMethod("getClient"))
        assertNotNull(companion.getDeclaredMethod("isRunning"))
        assertNotNull(companion.getDeclaredMethod("start", android.content.Context::class.java, com.clawd.mobile.data.ConnectionConfig::class.java))
        assertNotNull(companion.getDeclaredMethod("stop", android.content.Context::class.java))
        assertNotNull(companion.getDeclaredMethod("connectRemote", android.content.Context::class.java))
        assertNotNull(companion.getDeclaredMethod("disconnectRemote", android.content.Context::class.java))
    }

    @Test
    fun `only explicit remote connect action may start relay`() {
        assertFalse(WsConnectionService.shouldStartRelay(null))
        assertFalse(WsConnectionService.shouldStartRelay(WsConnectionService.ACTION_CONNECT))
        assertFalse(WsConnectionService.shouldStartRelay(WsConnectionService.ACTION_DISCONNECT))
        assertFalse(WsConnectionService.shouldStartRelay(WsConnectionService.ACTION_REMOTE_DISCONNECT))
        assertTrue(WsConnectionService.shouldStartRelay(WsConnectionService.ACTION_REMOTE_CONNECT))
    }

    @Test
    fun `activity result relay reports vpn grant and denial without secret payloads`() {
        val results = mutableListOf<Boolean>()
        val relay = VpnPermissionResultRelay(results::add)

        relay.onActivityResult(Activity.RESULT_OK)
        relay.onActivityResult(Activity.RESULT_CANCELED)

        assertEquals(listOf(true, false), results)
    }

    @Test
    fun `vpn permission host can be replaced across activity recreation without stale detach`() {
        val calls = mutableListOf<String>()
        val registry = VpnPermissionHostRegistry { action -> action() }
        val first = fakePermissionHost("first", calls)
        val replacement = fakePermissionHost("replacement", calls)
        val permissionIntent = mockk<Intent>()

        registry.attach(first)
        registry.attach(replacement)
        registry.detach(first)
        registry.launch(permissionIntent)

        assertEquals(listOf("replacement.launch"), calls)
        registry.detach(replacement)
        assertThrows(IllegalStateException::class.java) { registry.launch(permissionIntent) }
    }

    @Test
    fun `activity host owns only the vpn permission launcher`() {
        assertEquals(
            setOf("launchVpnPermission"),
            VpnPermissionHost::class.java.declaredMethods.map { it.name }.toSet(),
        )
    }

    @Test
    fun `service permission launch is dispatched before activity launcher runs`() {
        val scheduled = mutableListOf<() -> Unit>()
        val calls = mutableListOf<String>()
        val dispatchToMain: ((() -> Unit) -> Unit) = scheduled::add
        val constructor = VpnPermissionHostRegistry::class.java.declaredConstructors
            .firstOrNull { candidate ->
                candidate.parameterCount == 1 &&
                    Function1::class.java.isAssignableFrom(candidate.parameterTypes.single())
            }

        assertNotNull("registry must accept an injected main-thread dispatcher", constructor)
        val registry = constructor!!.newInstance(dispatchToMain) as VpnPermissionHostRegistry
        val activity = fakePermissionHost("activity", calls)
        registry.attach(activity)
        val permissionIntent = mockk<Intent>()

        registry.launch(permissionIntent)

        assertTrue("ActivityResultLauncher must not run on the service caller thread", calls.isEmpty())
        assertEquals(1, scheduled.size)
        scheduled.single().invoke()
        assertEquals(listOf("activity.launch"), calls)
    }

    @Test
    fun `lan and relay state collectors run concurrently`() = runTest {
        val lan = MutableStateFlow(ConnectionState.DISCONNECTED)
        val relay = MutableStateFlow(ConnectionState.DISCONNECTED)
        val seen = mutableListOf<String>()
        val jobs = launchConnectionStateCollectors(
            scope = this,
            lan = lan,
            relay = relay,
            onLan = { seen += "lan:$it" },
            onRelay = { seen += "relay:$it" },
        )
        runCurrent()

        lan.value = ConnectionState.CONNECTED
        relay.value = ConnectionState.AUTH_FAILED
        runCurrent()

        assertTrue(seen.contains("lan:CONNECTED"))
        assertTrue(seen.contains("relay:AUTH_FAILED"))
        jobs.forEach { it.cancel() }
    }

    @Test
    fun `service shutdown owns remote cleanup until finalization completes`() = runTest {
        val events = mutableListOf<String>()
        val release = CompletableDeferred<Unit>()

        val cleanup = launchRemoteServiceCleanup(
            scope = this,
            disconnect = {
                events += "disconnect"
                release.await()
            },
            finalize = { events += "finalize" },
        )
        runCurrent()

        assertEquals(listOf("disconnect"), events)
        assertTrue(cleanup.isActive)
        release.complete(Unit)
        cleanup.join()
        assertEquals(listOf("disconnect", "finalize"), events)
    }

    @Test
    fun `service stop requires remote cleanup but remote disconnect leaves LAN alone`() {
        assertTrue(WsConnectionService.shouldDisconnectRemote(WsConnectionService.ACTION_DISCONNECT))
        assertFalse(WsConnectionService.shouldDisconnectRemote(WsConnectionService.ACTION_REMOTE_DISCONNECT))
        assertFalse(WsConnectionService.shouldDisconnectRemote(WsConnectionService.ACTION_CONNECT))
    }

    @Test
    fun `active client selection follows live remote state and never legacy useRelay`() {
        assertEquals(
            ConnectionTag.RELAY,
            selectActiveConnectionTag(RemoteConnectionState.CONNECTED, relayAvailable = true),
        )
        assertEquals(
            ConnectionTag.LAN,
            selectActiveConnectionTag(RemoteConnectionState.CONNECTING_RELAY, relayAvailable = true),
        )
        assertEquals(
            ConnectionTag.LAN,
            selectActiveConnectionTag(RemoteConnectionState.CONNECTED, relayAvailable = false),
        )
    }

    private fun fakePermissionHost(name: String, calls: MutableList<String>) =
        object : VpnPermissionHost {
            override fun launchVpnPermission(intent: Intent) {
                calls += "$name.launch"
            }
        }
}

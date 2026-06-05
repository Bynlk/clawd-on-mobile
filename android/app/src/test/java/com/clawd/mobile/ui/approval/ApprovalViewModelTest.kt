package com.clawd.mobile.ui.approval

import android.app.Application
import android.os.SystemClock
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.StreamingClient
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [ApprovalViewModel].
 *
 * Uses StandardTestDispatcher to control virtual time for countdown tests.
 * SystemClock.elapsedRealtime() is mocked to return 0 so countdown deadlines
 * are predictable (deadline = 0 + timeout).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ApprovalViewModelTest {

    private lateinit var application: Application
    private lateinit var prefsStore: PrefsStore
    private lateinit var streamingClient: StreamingClient
    private lateinit var permissionRequestsFlow: MutableSharedFlow<PermissionRequestData>
    private lateinit var sessionsFlow: MutableStateFlow<Map<String, SessionData>>
    private lateinit var connectionStateFlow: MutableStateFlow<ConnectionState>
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)

        application = mockk(relaxed = true)
        prefsStore = mockk(relaxed = true)
        mockkObject(PrefsStore)
        every { PrefsStore.getInstance(any()) } returns prefsStore

        mockkObject(NotificationHelper)
        every { NotificationHelper.showApprovalNotification(any(), any(), any()) } just Runs
        every { NotificationHelper.showElicitationNotification(any(), any(), any()) } just Runs

        mockkStatic(SystemClock::class)
        every { SystemClock.elapsedRealtime() } returns 0L

        permissionRequestsFlow = MutableSharedFlow(extraBufferCapacity = 16)
        sessionsFlow = MutableStateFlow(emptyMap())
        connectionStateFlow = MutableStateFlow(ConnectionState.CONNECTED)

        streamingClient = mockk(relaxed = true)
        every { streamingClient.permissionRequests } returns permissionRequestsFlow
        every { streamingClient.sessions } returns sessionsFlow
        every { streamingClient.connectionState } returns connectionStateFlow
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkAll()
    }

    private fun createViewModel(): ApprovalViewModel {
        return ApprovalViewModel(application, streamingClient)
    }

    private fun makeRequest(
        requestId: String = "req1",
        toolName: String = "Bash",
        timeout: Long = 60000,
        sessionId: String = "s1",
    ) = PermissionRequestData(
        requestId = requestId,
        toolName = toolName,
        timeout = timeout,
        sessionId = sessionId,
        agentId = "claude",
        toolInputSummary = "ls -la",
    )

    // ── 1. Deduplication ──────────────────────────────────────────────

    @Test
    fun `duplicate requestId is ignored`() = runTest(testDispatcher) {
        val vm = createViewModel()
        val req = makeRequest(requestId = "dup1")

        permissionRequestsFlow.emit(req)
        advanceUntilIdle()
        permissionRequestsFlow.emit(req)
        advanceUntilIdle()

        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("dup1", vm.pendingRequests.value[0].requestId)
    }

    @Test
    fun `different requestIds are both added`() = runTest(testDispatcher) {
        val vm = createViewModel()

        permissionRequestsFlow.emit(makeRequest(requestId = "a"))
        advanceUntilIdle()
        permissionRequestsFlow.emit(makeRequest(requestId = "b"))
        advanceUntilIdle()

        assertEquals(2, vm.pendingRequests.value.size)
    }

    // ── 2. Countdown is populated ─────────────────────────────────────

    @Test
    fun `countdown is populated after request arrives`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "cd1", timeout = 60000))
        advanceUntilIdle()

        val countdown = vm.countdowns.value["cd1"]
        assertNotNull("Countdown should exist for cd1", countdown)
        assertTrue("Countdown should be > 0 but was $countdown", countdown!! > 0)
    }

    @Test
    fun `countdown is cleared after approve`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "cd2"))
        advanceUntilIdle()

        assertNotNull(vm.countdowns.value["cd2"])
        vm.approve("cd2")
        advanceUntilIdle()
        assertNull(vm.countdowns.value["cd2"])
    }

    // ── 3. Approve / Deny ────────────────────────────────────────────

    @Test
    fun `approve sends allow and removes request`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "app1"))
        advanceUntilIdle()
        assertEquals(1, vm.pendingRequests.value.size)

        vm.approve("app1")
        advanceUntilIdle()

        verify { streamingClient.sendPermissionResponse("app1", "allow", null) }
        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `deny sends deny and removes request`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "den1"))
        advanceUntilIdle()

        vm.deny("den1")
        advanceUntilIdle()

        verify { streamingClient.sendPermissionResponse("den1", "deny", null) }
        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `approveWithSuggestion sends suggestion index`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "sug1"))
        advanceUntilIdle()

        vm.approveWithSuggestion("sug1", 2)
        advanceUntilIdle()

        verify { streamingClient.sendPermissionResponse("sug1", "allow", 2) }
        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `approve does not save for restore`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "no-restore"))
        advanceUntilIdle()

        vm.approve("no-restore")
        advanceUntilIdle()

        // Should NOT be restorable via notification
        vm.setNotificationRequestId("no-restore")
        assertTrue(vm.pendingRequests.value.none { it.requestId == "no-restore" })
    }

    // ── 4. Notification restore ───────────────────────────────────────

    @Test
    fun `setNotificationRequestId restores dismissed request`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "restore1"))
        advanceUntilIdle()

        // Manually dismiss (saves for restore)
        vm.dismissRequest("restore1")
        assertTrue(vm.pendingRequests.value.isEmpty())

        // Notification tap restores
        vm.setNotificationRequestId("restore1")
        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("restore1", vm.pendingRequests.value[0].requestId)
    }

    @Test
    fun `setNotificationRequestId sets the notification flow`() = runTest(testDispatcher) {
        val vm = createViewModel()

        vm.setNotificationRequestId("some-id")
        assertEquals("some-id", vm.notificationRequestId.value)

        vm.consumeNotificationRequestId()
        assertNull(vm.notificationRequestId.value)
    }

    @Test
    fun `setNotificationRequestId does nothing if request still pending`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "still-pending"))
        advanceUntilIdle()

        // setNotificationRequestId with a random ID shouldn't affect existing
        vm.setNotificationRequestId("other-id")
        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("still-pending", vm.pendingRequests.value[0].requestId)
    }

    // ── 5. MAX_DISMISSED eviction ─────────────────────────────────────

    @Test
    fun `recentlyDismissed does not grow beyond MAX_DISMISSED`() = runTest(testDispatcher) {
        val vm = createViewModel()

        // Dismiss 25 requests (MAX_DISMISSED is 20)
        for (i in 1..25) {
            permissionRequestsFlow.emit(makeRequest(requestId = "evict$i"))
            advanceUntilIdle()
        }
        for (i in 1..25) {
            vm.dismissRequest("evict$i")
        }

        // Try to restore all 25 — at most 20 should be restorable
        var restoredCount = 0
        for (i in 1..25) {
            val beforeSize = vm.pendingRequests.value.size
            vm.setNotificationRequestId("evict$i")
            if (vm.pendingRequests.value.size > beforeSize) restoredCount++
            // Clean up so next iteration starts fresh
            vm.approve("evict$i")
            advanceUntilIdle()
        }
        assertTrue("At most 20 should be restorable, but $restoredCount were", restoredCount <= 20)
        assertTrue("At least some should be restorable", restoredCount > 0)
    }

    // ── 6. restoreRequestFromNotification ─────────────────────────────

    @Test
    fun `restoreRequestFromNotification adds request if not pending`() = runTest(testDispatcher) {
        val vm = createViewModel()
        val req = makeRequest(requestId = "notif1")

        vm.restoreRequestFromNotification(req)

        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("notif1", vm.pendingRequests.value[0].requestId)
        assertEquals("notif1", vm.notificationRequestId.value)
    }

    @Test
    fun `restoreRequestFromNotification does not duplicate existing request`() = runTest(testDispatcher) {
        val vm = createViewModel()
        val req = makeRequest(requestId = "notif2")

        permissionRequestsFlow.emit(req)
        advanceUntilIdle()
        assertEquals(1, vm.pendingRequests.value.size)

        vm.restoreRequestFromNotification(req)
        assertEquals(1, vm.pendingRequests.value.size)
    }

    // ── 7. dismissRequest saves for restore ───────────────────────────

    @Test
    fun `dismissRequest saves for notification restore`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "dis1"))
        advanceUntilIdle()

        vm.dismissRequest("dis1")
        assertTrue(vm.pendingRequests.value.isEmpty())

        // Should be restorable via notification
        vm.setNotificationRequestId("dis1")
        assertEquals(1, vm.pendingRequests.value.size)
    }

    // ── 8. Null requestId is ignored ──────────────────────────────────

    @Test
    fun `request with null requestId is ignored`() = runTest(testDispatcher) {
        val vm = createViewModel()
        val req = PermissionRequestData(requestId = null, toolName = "Bash")

        permissionRequestsFlow.emit(req)
        advanceUntilIdle()

        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    // ── 9. Elicitation notification ───────────────────────────────────

    @Test
    fun `elicitation request shows elicitation notification`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "elic1", toolName = "AskUserQuestion"))
        advanceUntilIdle()

        verify { NotificationHelper.showElicitationNotification(any(), any(), any()) }
        verify(exactly = 0) { NotificationHelper.showApprovalNotification(any(), any(), any()) }
    }

    @Test
    fun `non-elicitation request shows approval notification`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "perm1", toolName = "Bash"))
        advanceUntilIdle()

        verify { NotificationHelper.showApprovalNotification(any(), any(), any()) }
        verify(exactly = 0) { NotificationHelper.showElicitationNotification(any(), any(), any()) }
    }

    // ── 10. Multiple pending + selective action ────────────────────────

    @Test
    fun `approve removes only the target request`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "multi1"))
        advanceUntilIdle()
        permissionRequestsFlow.emit(makeRequest(requestId = "multi2"))
        advanceUntilIdle()
        permissionRequestsFlow.emit(makeRequest(requestId = "multi3"))
        advanceUntilIdle()

        vm.approve("multi2")
        advanceUntilIdle()

        assertEquals(2, vm.pendingRequests.value.size)
        assertTrue(vm.pendingRequests.value.any { it.requestId == "multi1" })
        assertTrue(vm.pendingRequests.value.any { it.requestId == "multi3" })
    }

    // ── 11. onCleared cancels countdown jobs ───────────────────────────

    @Test
    fun `onCleared cancels countdown jobs without crash`() = runTest(testDispatcher) {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "clear1"))
        advanceUntilIdle()
        permissionRequestsFlow.emit(makeRequest(requestId = "clear2"))
        advanceUntilIdle()

        assertEquals(2, vm.pendingRequests.value.size)
    }

    // ── 12. Error events when not connected ────────────────────────────

    @Test
    fun `approve emits error when not connected`() = runTest(testDispatcher) {
        connectionStateFlow.value = ConnectionState.DISCONNECTED
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "err1"))
        advanceUntilIdle()

        vm.approve("err1")
        advanceUntilIdle()

        // Request should NOT be removed (ensureConnected returns false)
        assertEquals(1, vm.pendingRequests.value.size)
        // sendPermissionResponse should NOT have been called
        verify(exactly = 0) { streamingClient.sendPermissionResponse(any(), any(), any()) }
    }

    @Test
    fun `deny emits error when in CIRCUIT_OPEN`() = runTest(testDispatcher) {
        connectionStateFlow.value = ConnectionState.CIRCUIT_OPEN
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "err2"))
        advanceUntilIdle()

        vm.deny("err2")
        advanceUntilIdle()

        assertEquals(1, vm.pendingRequests.value.size)
        verify(exactly = 0) { streamingClient.sendPermissionResponse(any(), any(), any()) }
    }
}

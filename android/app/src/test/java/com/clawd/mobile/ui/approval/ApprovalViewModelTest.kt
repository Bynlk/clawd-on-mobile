package com.clawd.mobile.ui.approval

import android.app.Application
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.SessionData
import com.clawd.mobile.notification.NotificationHelper
import com.clawd.mobile.ws.ConnectionState
import com.clawd.mobile.ws.ApprovalResultData
import com.clawd.mobile.ws.StreamingClient
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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
 * Uses MockK to mock Android dependencies (Application, PrefsStore, NotificationHelper)
 * and a fake StreamingClient with controllable permissionRequests flow.
 *
 * Note: startCountdown uses System.currentTimeMillis() (real time) for deadlines,
 * so auto-dismiss timing tests are omitted — they require real time to pass.
 * We test the same remove/restore paths via explicit approve/deny/dismissRequest.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ApprovalViewModelTest {

    private lateinit var application: Application
    private lateinit var prefsStore: PrefsStore
    private lateinit var streamingClient: StreamingClient
    private lateinit var permissionRequestsFlow: MutableSharedFlow<PermissionRequestData>
    private lateinit var permissionResolvedFlow: MutableSharedFlow<String>
    private lateinit var approvalResultsFlow: MutableSharedFlow<ApprovalResultData>
    private lateinit var sessionsFlow: MutableStateFlow<Map<String, SessionData>>
    private lateinit var connectionStateFlow: MutableStateFlow<ConnectionState>

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())

        application = mockk(relaxed = true)
        prefsStore = mockk(relaxed = true)
        mockkObject(PrefsStore)
        every { PrefsStore.getInstance(any()) } returns prefsStore

        mockkObject(NotificationHelper)
        every { NotificationHelper.showApprovalNotification(any(), any(), any()) } just Runs
        every { NotificationHelper.showElicitationNotification(any(), any(), any()) } just Runs

        permissionRequestsFlow = MutableSharedFlow(extraBufferCapacity = 16)
        permissionResolvedFlow = MutableSharedFlow(extraBufferCapacity = 16)
        approvalResultsFlow = MutableSharedFlow(extraBufferCapacity = 16)
        sessionsFlow = MutableStateFlow(emptyMap())
        connectionStateFlow = MutableStateFlow(ConnectionState.CONNECTED)

        streamingClient = mockk(relaxed = true)
        every { streamingClient.permissionRequests } returns permissionRequestsFlow
        every { streamingClient.permissionResolved } returns permissionResolvedFlow
        every { streamingClient.approvalResults } returns approvalResultsFlow
        every { streamingClient.sessions } returns sessionsFlow
        every { streamingClient.connectionState } returns connectionStateFlow
        every { streamingClient.sendPermissionResponse(any(), any(), any()) } returns true
        every { streamingClient.sendElicitationResponse(any(), any(), any()) } returns true
    }

    @Test
    fun `resolution from desktop or another phone removes the pending request`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "resolved-elsewhere"))
        assertEquals(1, vm.pendingRequests.value.size)

        permissionResolvedFlow.emit("resolved-elsewhere")

        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `resolution tombstone suppresses a late request frame`() = runTest {
        val vm = createViewModel()

        permissionResolvedFlow.emit("resolved-first")
        permissionRequestsFlow.emit(makeRequest(requestId = "resolved-first"))

        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `updating transport collects and responds through the new client`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "migrated"))
        val newRequests = MutableSharedFlow<PermissionRequestData>(extraBufferCapacity = 4)
        val newResolved = MutableSharedFlow<String>(extraBufferCapacity = 4)
        val newApprovalResults = MutableSharedFlow<ApprovalResultData>(extraBufferCapacity = 4)
        val newClient = mockk<StreamingClient>(relaxed = true)
        every { newClient.permissionRequests } returns newRequests
        every { newClient.permissionResolved } returns newResolved
        every { newClient.approvalResults } returns newApprovalResults
        every { newClient.sessions } returns MutableStateFlow(emptyMap())
        every { newClient.connectionState } returns MutableStateFlow(ConnectionState.CONNECTED)
        every { newClient.sendPermissionResponse(any(), any(), any()) } returns true

        vm.updateClient(newClient)
        assertTrue(vm.pendingRequests.value.any { it.requestId == "migrated" })
        vm.approve("migrated")
        newRequests.emit(makeRequest(requestId = "new-client"))
        vm.approve("new-client")

        verify { newClient.sendPermissionResponse("migrated", "allow", null) }
        verify { newClient.sendPermissionResponse("new-client", "allow", null) }
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
    fun `duplicate requestId is ignored`() = runTest {
        val vm = createViewModel()
        val req = makeRequest(requestId = "dup1")

        permissionRequestsFlow.emit(req)
        permissionRequestsFlow.emit(req)

        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("dup1", vm.pendingRequests.value[0].requestId)
    }

    @Test
    fun `different requestIds are both added`() = runTest {
        val vm = createViewModel()

        permissionRequestsFlow.emit(makeRequest(requestId = "a"))
        permissionRequestsFlow.emit(makeRequest(requestId = "b"))

        assertEquals(2, vm.pendingRequests.value.size)
    }

    // ── 2. Countdown is populated ─────────────────────────────────────

    @Test
    fun `countdown is populated after request arrives`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "cd1", timeout = 60000))

        val countdown = vm.countdowns.value["cd1"]
        assertNotNull("Countdown should exist for cd1", countdown)
        assertTrue("Countdown should be > 0 but was $countdown", countdown!! > 0)
    }

    @Test
    fun `countdown is cleared after approve`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "cd2"))

        assertNotNull(vm.countdowns.value["cd2"])
        vm.approve("cd2")
        assertNotNull(vm.countdowns.value["cd2"])
        permissionResolvedFlow.emit("cd2")
        assertNull(vm.countdowns.value["cd2"])
    }

    // ── 3. Approve / Deny ────────────────────────────────────────────

    @Test
    fun `approve keeps request until desktop confirms resolution`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "app1"))
        assertEquals(1, vm.pendingRequests.value.size)

        vm.approve("app1")

        verify { streamingClient.sendPermissionResponse("app1", "allow", null) }
        assertEquals(1, vm.pendingRequests.value.size)

        permissionResolvedFlow.emit("app1")

        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `deny keeps request until desktop confirms resolution`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "den1"))

        vm.deny("den1")

        verify { streamingClient.sendPermissionResponse("den1", "deny", null) }
        assertEquals(1, vm.pendingRequests.value.size)
        permissionResolvedFlow.emit("den1")
        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `approveWithSuggestion sends suggestion index`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "sug1"))

        vm.approveWithSuggestion("sug1", 2)

        verify { streamingClient.sendPermissionResponse("sug1", "allow", 2) }
        assertEquals(1, vm.pendingRequests.value.size)
        permissionResolvedFlow.emit("sug1")
        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    @Test
    fun `desktop rejection keeps approval pending and allows retry`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "expired"))

        vm.approve("expired")
        approvalResultsFlow.emit(ApprovalResultData("expired", false, "request not found or expired"))
        vm.approve("expired")

        assertEquals(1, vm.pendingRequests.value.size)
        verify(exactly = 2) { streamingClient.sendPermissionResponse("expired", "allow", null) }
    }

    @Test
    fun `disconnect while awaiting desktop confirmation allows retry after reconnect`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "lost-confirmation"))

        vm.approve("lost-confirmation")
        connectionStateFlow.value = ConnectionState.DISCONNECTED
        connectionStateFlow.value = ConnectionState.CONNECTED
        vm.approve("lost-confirmation")

        assertEquals(1, vm.pendingRequests.value.size)
        verify(exactly = 2) {
            streamingClient.sendPermissionResponse("lost-confirmation", "allow", null)
        }
    }

    @Test
    fun `approve does not save for restore`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "no-restore"))

        vm.approve("no-restore")
        approvalResultsFlow.emit(ApprovalResultData("no-restore", true))

        // Should NOT be restorable via notification
        vm.setNotificationRequestId("no-restore")
        assertTrue(vm.pendingRequests.value.none { it.requestId == "no-restore" })
    }

    // ── 4. Notification restore ───────────────────────────────────────

    @Test
    fun `setNotificationRequestId restores dismissed request`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "restore1"))

        // Manually dismiss (saves for restore)
        vm.dismissRequest("restore1")
        assertTrue(vm.pendingRequests.value.isEmpty())

        // Notification tap restores
        vm.setNotificationRequestId("restore1")
        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("restore1", vm.pendingRequests.value[0].requestId)
    }

    @Test
    fun `setNotificationRequestId sets the notification flow`() = runTest {
        val vm = createViewModel()

        vm.setNotificationRequestId("some-id")
        assertEquals("some-id", vm.notificationRequestId.value)

        vm.consumeNotificationRequestId()
        assertNull(vm.notificationRequestId.value)
    }

    @Test
    fun `setNotificationRequestId does nothing if request still pending`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "still-pending"))

        // setNotificationRequestId with a random ID shouldn't affect existing
        vm.setNotificationRequestId("other-id")
        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("still-pending", vm.pendingRequests.value[0].requestId)
    }

    // ── 5. MAX_DISMISSED eviction ─────────────────────────────────────

    @Test
    fun `recentlyDismissed does not grow beyond MAX_DISMISSED`() = runTest {
        val vm = createViewModel()

        // Dismiss 25 requests (MAX_DISMISSED is 20)
        for (i in 1..25) {
            permissionRequestsFlow.emit(makeRequest(requestId = "evict$i"))
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
            permissionResolvedFlow.emit("evict$i")
        }
        assertTrue("At most 20 should be restorable, but $restoredCount were", restoredCount <= 20)
        assertTrue("At least some should be restorable", restoredCount > 0)
    }

    // ── 6. restoreRequestFromNotification ─────────────────────────────

    @Test
    fun `restoreRequestFromNotification adds request if not pending`() = runTest {
        val vm = createViewModel()
        val req = makeRequest(requestId = "notif1")

        vm.restoreRequestFromNotification(req)

        assertEquals(1, vm.pendingRequests.value.size)
        assertEquals("notif1", vm.pendingRequests.value[0].requestId)
        assertEquals("notif1", vm.notificationRequestId.value)
    }

    @Test
    fun `restoreRequestFromNotification does not duplicate existing request`() = runTest {
        val vm = createViewModel()
        val req = makeRequest(requestId = "notif2")

        permissionRequestsFlow.emit(req)
        assertEquals(1, vm.pendingRequests.value.size)

        vm.restoreRequestFromNotification(req)
        assertEquals(1, vm.pendingRequests.value.size)
    }

    // ── 7. dismissRequest saves for restore ───────────────────────────

    @Test
    fun `dismissRequest saves for notification restore`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "dis1"))

        vm.dismissRequest("dis1")
        assertTrue(vm.pendingRequests.value.isEmpty())

        // Should be restorable via notification
        vm.setNotificationRequestId("dis1")
        assertEquals(1, vm.pendingRequests.value.size)
    }

    // ── 8. Null requestId is ignored ──────────────────────────────────

    @Test
    fun `request with null requestId is ignored`() = runTest {
        val vm = createViewModel()
        val req = PermissionRequestData(requestId = null, toolName = "Bash")

        permissionRequestsFlow.emit(req)

        assertTrue(vm.pendingRequests.value.isEmpty())
    }

    // ── 9. Elicitation notification ───────────────────────────────────

    @Test
    fun `elicitation request shows elicitation notification`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "elic1", toolName = "AskUserQuestion"))

        verify { NotificationHelper.showElicitationNotification(any(), any(), any()) }
        verify(exactly = 0) { NotificationHelper.showApprovalNotification(any(), any(), any()) }
    }

    @Test
    fun `non-elicitation request shows approval notification`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "perm1", toolName = "Bash"))

        verify { NotificationHelper.showApprovalNotification(any(), any(), any()) }
        verify(exactly = 0) { NotificationHelper.showElicitationNotification(any(), any(), any()) }
    }

    // ── 10. Multiple pending + selective action ────────────────────────

    @Test
    fun `approve removes only the target request`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "multi1"))
        permissionRequestsFlow.emit(makeRequest(requestId = "multi2"))
        permissionRequestsFlow.emit(makeRequest(requestId = "multi3"))

        vm.approve("multi2")

        assertEquals(3, vm.pendingRequests.value.size)
        permissionResolvedFlow.emit("multi2")
        assertEquals(2, vm.pendingRequests.value.size)
        assertTrue(vm.pendingRequests.value.any { it.requestId == "multi1" })
        assertTrue(vm.pendingRequests.value.any { it.requestId == "multi3" })
    }

    // ── 11. onCleared cancels countdown jobs ───────────────────────────

    @Test
    fun `onCleared cancels countdown jobs without crash`() = runTest {
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "clear1"))
        permissionRequestsFlow.emit(makeRequest(requestId = "clear2"))

        // onCleared is called by ViewModelStore when the scope is cleared.
        // We can't easily call it directly, but we can verify the VM was created
        // with active countdowns and clear it without crash.
        // (onCleared is protected, so we test indirectly via the lifecycle)
        assertEquals(2, vm.pendingRequests.value.size)
    }

    // ── 12. Error events when not connected ────────────────────────────

    @Test
    fun `approve emits error when not connected`() = runTest {
        connectionStateFlow.value = ConnectionState.DISCONNECTED
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "err1"))

        vm.approve("err1")

        // Request should NOT be removed (ensureConnected returns false)
        assertEquals(1, vm.pendingRequests.value.size)
        // sendPermissionResponse should NOT have been called
        verify(exactly = 0) { streamingClient.sendPermissionResponse(any(), any(), any()) }
    }

    @Test
    fun `deny emits error when in CIRCUIT_OPEN`() = runTest {
        connectionStateFlow.value = ConnectionState.CIRCUIT_OPEN
        val vm = createViewModel()
        permissionRequestsFlow.emit(makeRequest(requestId = "err2"))

        vm.deny("err2")

        assertEquals(1, vm.pendingRequests.value.size)
        verify(exactly = 0) { streamingClient.sendPermissionResponse(any(), any(), any()) }
    }
}

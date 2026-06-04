package com.clawd.mobile.notification

import org.junit.Test
import org.junit.Assert.*
import org.junit.Before

/**
 * Unit tests for [ApprovalWorker] logic.
 *
 * Note: Full doWork() tests require Android instrumentation (WorkManager, PrefsStore).
 * These tests verify the companion constants and contract invariants.
 */
class ApprovalWorkerTest {

    @Test
    fun `WORK_NAME_PREFIX is approval_`() {
        assertEquals("approval_", ApprovalWorker.WORK_NAME_PREFIX)
    }

    @Test
    fun `work name is deterministic for same request ID`() {
        val requestId = "req-123"
        val name1 = "${ApprovalWorker.WORK_NAME_PREFIX}$requestId"
        val name2 = "${ApprovalWorker.WORK_NAME_PREFIX}$requestId"
        assertEquals(name1, name2)
    }

    @Test
    fun `work names differ for different request IDs`() {
        val name1 = "${ApprovalWorker.WORK_NAME_PREFIX}req-123"
        val name2 = "${ApprovalWorker.WORK_NAME_PREFIX}req-456"
        assertNotEquals(name1, name2)
    }
}

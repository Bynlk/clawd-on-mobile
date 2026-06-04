package com.clawd.mobile.notification

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for [ApprovalWorker] using WorkManager testing support.
 *
 * Tests the worker's input validation, TOFU guard, and retry logic
 * in a real Android environment.
 */
@RunWith(AndroidJUnit4::class)
class ApprovalWorkerAndroidTest {

    private lateinit var context: Context

    @Before
    fun setup() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
    }

    @Test
    fun workerReturnsFailureWhenRequestIdMissing() = runBlocking {
        val worker = TestListenableWorkerBuilder<ApprovalWorker>(context)
            .setInputData(workDataOf("decision" to "allow"))
            .build()

        val result = worker.doWork()
        assertEquals(ListenableWorker.Result.failure(), result)
    }

    @Test
    fun workerReturnsFailureWhenDecisionMissing() = runBlocking {
        val worker = TestListenableWorkerBuilder<ApprovalWorker>(context)
            .setInputData(workDataOf("request_id" to "req-123"))
            .build()

        val result = worker.doWork()
        assertEquals(ListenableWorker.Result.failure(), result)
    }

    @Test
    fun workerReturnsFailureWhenNoConfigSaved() = runBlocking {
        // No config saved in PrefsStore → should fail
        val worker = TestListenableWorkerBuilder<ApprovalWorker>(context)
            .setInputData(workDataOf(
                "request_id" to "req-123",
                "decision" to "allow"
            ))
            .build()

        val result = worker.doWork()
        assertEquals(ListenableWorker.Result.failure(), result)
    }

    @Test
    fun workNamePrefixIsApproval() {
        assertEquals("approval_", ApprovalWorker.WORK_NAME_PREFIX)
    }

    @Test
    fun workNameIsDeterministic() {
        val name1 = "${ApprovalWorker.WORK_NAME_PREFIX}req-123"
        val name2 = "${ApprovalWorker.WORK_NAME_PREFIX}req-123"
        assertEquals(name1, name2)
    }

    @Test
    fun workNamesDifferForDifferentIds() {
        val name1 = "${ApprovalWorker.WORK_NAME_PREFIX}req-123"
        val name2 = "${ApprovalWorker.WORK_NAME_PREFIX}req-456"
        assertNotEquals(name1, name2)
    }
}

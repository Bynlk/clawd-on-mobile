package com.clawd.mobile.util

import com.clawd.mobile.data.ConnectionConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for [ApprovalSender] parameter handling.
 *
 * Note: Full HTTP tests require mocking OkHttpClient (instrumented test).
 * These tests verify the public API contract and null-safety.
 */
class ApprovalSenderTest {

    private val scope = CoroutineScope(SupervisorJob())

    @Test
    fun `sendPermissionResponse with null config does nothing`() {
        // Should not throw — null config is a no-op
        ApprovalSender.sendPermissionResponse(scope, null, "req-123", "allow")
    }

    @Test
    fun `sendElicitationResponse with null config does nothing`() {
        ApprovalSender.sendElicitationResponse(scope, null, "req-123", null, emptyMap())
    }

    @Test
    fun `sendPermissionResponse with suggestion index does not throw`() {
        ApprovalSender.sendPermissionResponse(
            scope, null, "req-123", "allow", suggestionIndex = 2
        )
    }

    @Test
    fun `sendElicitationResponse with empty answers does not throw`() {
        ApprovalSender.sendElicitationResponse(
            scope, null, "req-123", null, emptyMap()
        )
    }

    @Test
    fun `sendElicitationResponse with answers does not throw`() {
        val answers = mapOf("question1" to "answer1", "question2" to "answer2")
        ApprovalSender.sendElicitationResponse(
            scope, null, "req-123", null, answers
        )
    }
}

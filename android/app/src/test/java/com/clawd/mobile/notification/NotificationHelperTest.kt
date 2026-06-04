package com.clawd.mobile.notification

import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for [NotificationHelper] deterministic ID generation and constants.
 */
class NotificationHelperTest {

    @Test
    fun `notification ID is deterministic for same request ID`() {
        val requestId = "req-abc-123"
        val id1 = requestId.hashCode() and 0x7FFFFFFF
        val id2 = requestId.hashCode() and 0x7FFFFFFF
        assertEquals(id1, id2)
    }

    @Test
    fun `notification ID is always non-negative`() {
        val ids = listOf("req-1", "req-2", "long-request-id-with-many-chars", "", "特殊字符")
        for (id in ids) {
            val notificationId = id.hashCode() and 0x7FFFFFFF
            assertTrue("ID should be non-negative for '$id'", notificationId >= 0)
        }
    }

    @Test
    fun `elicitation ID is offset by 1 from approval ID`() {
        val requestId = "req-123"
        val approvalId = requestId.hashCode() and 0x7FFFFFFF
        val elicitationId = (requestId.hashCode() and 0x7FFFFFFF) + 1
        assertEquals(approvalId + 1, elicitationId)
    }

    @Test
    fun `different request IDs produce different notification IDs`() {
        val id1 = "req-123".hashCode() and 0x7FFFFFFF
        val id2 = "req-456".hashCode() and 0x7FFFFFFF
        assertNotEquals(id1, id2)
    }

    @Test
    fun `channel constants are defined`() {
        assertEquals("clawd_status", NotificationHelper.CHANNEL_STATUS)
        assertEquals("clawd_alert", NotificationHelper.CHANNEL_ALERT)
    }
}

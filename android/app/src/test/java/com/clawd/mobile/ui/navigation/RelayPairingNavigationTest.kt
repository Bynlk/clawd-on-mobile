package com.clawd.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayPairingNavigationTest {
    @Test
    fun `default start destination remains sessions`() {
        assertEquals("sessions", CLAWD_DEFAULT_START_DESTINATION)
    }

    @Test
    fun `new pairing request navigates to settings and records consumption`() {
        val decision = decideRelayPairingNavigation(
            requestId = 1,
            lastConsumedRequestId = 0,
            currentRoute = "scan",
        )

        assertEquals(1, decision?.consumedRequestId)
        assertTrue(decision?.shouldNavigate == true)
    }

    @Test
    fun `request already on settings is consumed without stacking settings`() {
        val decision = decideRelayPairingNavigation(
            requestId = 2,
            lastConsumedRequestId = 1,
            currentRoute = "settings",
        )

        assertEquals(2, decision?.consumedRequestId)
        assertFalse(decision?.shouldNavigate ?: true)
    }

    @Test
    fun `cleared and repeated requests do not navigate again`() {
        assertNull(decideRelayPairingNavigation(0, 1, "scan"))
        assertNull(decideRelayPairingNavigation(1, 1, "scan"))
    }

    @Test
    fun `request waits until navigation graph is ready`() {
        assertNull(
            decideRelayPairingNavigation(
                requestId = 1,
                lastConsumedRequestId = 0,
                currentRoute = null,
                navigationReady = false,
            ),
        )
        assertTrue(
            decideRelayPairingNavigation(
                requestId = 1,
                lastConsumedRequestId = 0,
                currentRoute = "sessions",
                navigationReady = true,
            )?.shouldNavigate == true,
        )
    }

    @Test
    fun `navigation happens before request is cleared and recorded consumed`() {
        val events = mutableListOf<String>()
        val consumed = performRelayPairingNavigation(
            decision = RelayPairingNavigationDecision(7, shouldNavigate = true),
            navigateToSettings = { events += "navigate" },
            clearRequest = { events += "clear:$it" },
        )

        events += "record:$consumed"
        assertEquals(listOf("navigate", "clear:7", "record:7"), events)
    }

    @Test
    fun `request already on settings clears without another navigation`() {
        val events = mutableListOf<String>()
        val consumed = performRelayPairingNavigation(
            decision = RelayPairingNavigationDecision(8, shouldNavigate = false),
            navigateToSettings = { events += "navigate" },
            clearRequest = { events += "clear:$it" },
        )

        assertEquals(8, consumed)
        assertEquals(listOf("clear:8"), events)
    }
}

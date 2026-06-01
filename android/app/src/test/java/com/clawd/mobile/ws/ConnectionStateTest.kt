package com.clawd.mobile.ws

import org.junit.Test
import org.junit.Assert.*

class ConnectionStateTest {

    @Test
    fun `CONNECTED isConnected is true`() {
        assertTrue(ConnectionState.CONNECTED.isConnected)
    }

    @Test
    fun `DISCONNECTED isConnected is false`() {
        assertFalse(ConnectionState.DISCONNECTED.isConnected)
    }

    @Test
    fun `CONNECTING isConnected is false`() {
        assertFalse(ConnectionState.CONNECTING.isConnected)
    }

    @Test
    fun `RECONNECTING isConnected is false`() {
        assertFalse(ConnectionState.RECONNECTING.isConnected)
    }

    @Test
    fun `AUTH_FAILED isConnected is false`() {
        assertFalse(ConnectionState.AUTH_FAILED.isConnected)
    }

    @Test
    fun `CONNECTING isConnecting is true`() {
        assertTrue(ConnectionState.CONNECTING.isConnecting)
    }

    @Test
    fun `RECONNECTING isConnecting is true`() {
        assertTrue(ConnectionState.RECONNECTING.isConnecting)
    }

    @Test
    fun `DISCONNECTED isConnecting is false`() {
        assertFalse(ConnectionState.DISCONNECTED.isConnecting)
    }

    @Test
    fun `CONNECTED isConnecting is false`() {
        assertFalse(ConnectionState.CONNECTED.isConnecting)
    }

    @Test
    fun `AUTH_FAILED isConnecting is false`() {
        assertFalse(ConnectionState.AUTH_FAILED.isConnecting)
    }

    @Test
    fun `has exactly 5 values`() {
        assertEquals(5, ConnectionState.entries.size)
    }

    @Test
    fun `no state is both connected and connecting`() {
        for (state in ConnectionState.entries) {
            assertFalse(
                "${state.name} should not be both connected and connecting",
                state.isConnected && state.isConnecting
            )
        }
    }
}

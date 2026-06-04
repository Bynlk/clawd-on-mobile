package com.clawd.mobile.ws

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    PENDING_CERT_CONFIRMATION,
    RECONNECTING,
    AUTH_FAILED,
    /** Reconnect attempts exhausted — user must manually retry. */
    CIRCUIT_OPEN;

    val isConnected: Boolean get() = this == CONNECTED
    val isConnecting: Boolean get() = this == CONNECTING || this == RECONNECTING
}

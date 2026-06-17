package com.clawd.mobile.ws

import com.clawd.mobile.data.ConnectionConfig

/**
 * 连接策略接口 — LAN 直连和 Relay 连接使用不同的策略实现。
 * 用于 WsConnectionService 双连接管理。
 */
interface ConnectionStrategy {
    /** 连接来源标签 */
    val tag: ConnectionTag

    /** 构建 WebSocket 连接 URL */
    fun streamUrl(config: ConnectionConfig): String

    /** 构建 Authorization header */
    fun authHeader(config: ConnectionConfig): String

    /** 是否需要获取 WiFi Lock（relay 模式可能走蜂窝网络） */
    fun shouldAcquireWifiLock(): Boolean
}

/** 连接来源标签 */
enum class ConnectionTag { LAN, RELAY }

/**
 * LAN 直连策略 — 使用局域网 IP 直接连接。
 */
class LanConnectionStrategy : ConnectionStrategy {
    override val tag = ConnectionTag.LAN

    override fun streamUrl(config: ConnectionConfig): String {
        val scheme = if (config.isLan) "ws" else "wss"
        return "$scheme://${config.host}:${config.port}/mobile/ws"
    }

    override fun authHeader(config: ConnectionConfig): String {
        return "Bearer ${config.token}"
    }

    override fun shouldAcquireWifiLock(): Boolean = true
}

/**
 * Relay 中继策略 — 通过远程 relay 服务器连接。
 */
class RelayConnectionStrategy : ConnectionStrategy {
    override val tag = ConnectionTag.RELAY

    override fun streamUrl(config: ConnectionConfig): String {
        val baseUrl = config.relayUrl ?: throw IllegalArgumentException("relayUrl is null")
        return "$baseUrl/mobile/ws"
    }

    override fun authHeader(config: ConnectionConfig): String {
        val relayToken = config.relayToken ?: throw IllegalArgumentException("relayToken is null")
        return "Bearer $relayToken"
    }

    override fun shouldAcquireWifiLock(): Boolean = false
}

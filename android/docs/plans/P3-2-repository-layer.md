# P3-2: 抽取 Repository 层

> **优先级**: P3 — 架构改进  
> **影响范围**: 数据访问层  
> **预估工时**: 3h  
> **启动提示词**: `执行 P3-2: 抽取 SessionRepository 统一数据访问，封装 ClawdWebSocket.sessions 和 PrefsStore 的 session 相关操作`

---

## 问题描述

当前数据访问分散在多个位置：

| 数据 | 访问方式 | 位置 |
|------|---------|------|
| Session 列表 | `WebSocketService.getWebSocket()?.sessions` | 多处静态访问 |
| Session 名称 | `prefsStore.getSessionName(id)` | NavGraph, ApprovalViewModel |
| 连接配置 | `prefsStore.loadConfig()` / `saveConfig()` | ClawdWebSocket, ApprovalReceiver |
| 通知设置 | `prefsStore.isNotifyEnabled()` 等 | StatusNotifier |

没有统一的数据访问层，导致：
- 静态依赖（`WebSocketService.getWebSocket()`）
- 业务逻辑直接操作 SharedPreferences
- 难以 mock 测试

## 修复方案

### Step 1: 创建 SessionRepository

```kotlin
// data/SessionRepository.kt
class SessionRepository(
    private val sessionsFlow: StateFlow<Map<String, SessionData>>,
    private val prefsStore: PrefsStore
) {
    /** 当前可见 session 列表 */
    val visibleSessions: StateFlow<List<SessionData>> = sessionsFlow
        .map { map -> map.values.filter { it.isVisible } }
        .stateIn(CoroutineScope(Dispatchers.Default), SharingStarted.Eagerly, emptyList())

    /** 当前 session 数量 */
    val sessionCount: StateFlow<Int> = visibleSessions
        .map { it.size }
        .stateIn(CoroutineScope(Dispatchers.Default), SharingStarted.Eagerly, 0)

    /** 获取 session 名称（优先用户自定义，其次服务器提供的 title） */
    fun getSessionName(sessionId: String): String? {
        prefsStore.getSessionName(sessionId)?.let { return it }
        val data = sessionsFlow.value[sessionId]
        return data?.displayTitle ?: data?.agentId
    }

    /** 保存用户自定义 session 名称 */
    fun saveSessionName(sessionId: String, name: String) {
        prefsStore.saveSessionName(sessionId, name)
    }

    /** 清除用户自定义 session 名称 */
    fun clearSessionName(sessionId: String) {
        prefsStore.clearSessionName(sessionId)
    }
}
```

### Step 2: 创建 ConnectionRepository

```kotlin
// data/ConnectionRepository.kt
class ConnectionRepository(
    private val prefsStore: PrefsStore,
    private val connectionState: StateFlow<ConnectionState>
) {
    val isConnected: Boolean get() = connectionState.value == ConnectionState.CONNECTED

    fun saveConfig(config: ConnectionConfig) = prefsStore.saveConfig(config)
    fun loadConfig(): ConnectionConfig? = prefsStore.loadConfig()
    fun getHistory(): List<ConnectionConfig> = prefsStore.getHistory()
    fun removeFromHistory(index: Int) = prefsStore.removeFromHistory(index)
    fun clearConfig() = prefsStore.clearConfig()
}
```

### Step 3: 注入 Repository

```kotlin
// 在 WebSocketService 或 NavGraph 中创建 Repository 实例
val sessionRepository = SessionRepository(
    sessionsFlow = webSocket.sessions,
    prefsStore = prefsStore
)
val connectionRepository = ConnectionRepository(
    prefsStore = prefsStore,
    connectionState = webSocket.connectionState
)
```

### Step 4: 替换直接访问

```kotlin
// Before — ApprovalViewModel
private fun resolveSessionName(sessionId: String?): String? {
    if (sessionId == null) return null
    prefsStore.getSessionName(sessionId)?.let { return it }
    webSocket.sessions.value[sessionId]?.let { data ->
        data.displayTitle?.let { return it }
        data.agentId?.let { return it }
    }
    return sessionId
}

// After — 使用 Repository
private fun resolveSessionName(sessionId: String?): String? {
    if (sessionId == null) return null
    return sessionRepository.getSessionName(sessionId) ?: sessionId
}
```

## 迁移策略

采用**渐进式迁移**，不一次性重构所有访问点：

1. 创建 `SessionRepository` 和 `ConnectionRepository`
2. 在 `NavGraph` 中实例化并通过 CompositionLocal 或参数传递
3. 逐个 Screen 替换直接访问为 Repository 调用
4. 最后移除 `WebSocketService.getWebSocket()` 静态访问

## 验收标准

- [ ] `SessionRepository` 封装 session 数据访问
- [ ] `ConnectionRepository` 封装连接配置访问
- [ ] 至少 `ApprovalViewModel` 和 `SessionsScreen` 使用 Repository
- [ ] 无 `WebSocketService.getWebSocket()` 的直接调用（除 Service 内部）
- [ ] 编译通过，功能不变

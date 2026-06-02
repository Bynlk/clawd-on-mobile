# P2-3: sessions Map 高频 GC 压力优化

> **优先级**: P2 — 性能  
> **影响范围**: `ws/ClawdWebSocket.kt`  
> **预估工时**: 1h  
> **启动提示词**: `执行 P2-2: 优化 ClawdWebSocket 中 sessions Map 的高频拷贝问题，减少 GC 压力，使用 MutableMap in-place 更新替代每次创建新 Map`

---

## 问题描述

```kotlin
// ClawdWebSocket.kt:226
_sessions.value = _sessions.value.toMutableMap().apply {
    if (data.isVisible) put(sid, data) else remove(sid)
}
```

每条 `state` 消息都执行 `_sessions.value.toMutableMap()`，创建完整 Map 副本。多 session 并发更新时（如 snapshot 后连续 state 消息），会产生大量临时对象和 GC 压力。

此外，`StateFlow` 的 equality check 基于 `Map.equals`，两个内容相同但引用不同的 Map 会被视为"不同"，导致下游重复收集。

## 修复方案

### 方案: 使用 ConcurrentHashMap + 结构性变更通知

```kotlin
// ClawdWebSocket.kt
private val _sessionsMap = ConcurrentHashMap<String, SessionData>()
private val _sessions = MutableStateFlow<Map<String, SessionData>>(emptyMap())

// state 消息处理
"state" -> {
    val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
    // ... 解析 data ...
    if (data.isVisible) {
        _sessionsMap[sid] = data
    } else {
        _sessionsMap.remove(sid)
    }
    // 发射不可变快照（仅在内容确实变化时）
    _sessions.value = _sessionsMap.toMap()
}

// snapshot 消息处理
"snapshot" -> {
    _sessionsMap.clear()
    for ((sid, el) in sessionsObj) {
        // ... 解析 ...
        if (sd.isReal && sd.isVisible) _sessionsMap[sid] = sd
    }
    _sessions.value = _sessionsMap.toMap()
}

// session_deleted
"session_deleted" -> {
    val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
    _sessionsMap.remove(sid)
    _sessions.value = _sessionsMap.toMap()
}

// tool_output — 需要特殊处理（仅更新 lastOutput）
"tool_output" -> {
    val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
    val existing = _sessionsMap[sid] ?: return
    _sessionsMap[sid] = existing.copy(lastOutput = ...)
    _sessions.value = _sessionsMap.toMap()
}
```

**关键改进**:
- `_sessionsMap` 是可变的内部存储，避免每次 `toMutableMap()`
- `_sessions.value = _sessionsMap.toMap()` 只在消息处理完成后发射一次不可变快照
- 下游收集者通过 `StateFlow` 的 equality check 自动去重

### 进一步优化: 深度比较

如果 `Map.equals` 仍然过于频繁触发（因为 data class 的 `equals` 比较所有字段），可以添加版本号：

```kotlin
private var _sessionsVersion = 0L

// 每次更新后
_sessionsVersion++
_sessions.value = SessionsSnapshot(_sessionsMap.toMap(), _sessionsVersion)

data class SessionsSnapshot(
    val sessions: Map<String, SessionData>,
    val version: Long
)
```

但这增加了复杂度，建议先实现基础方案，观察 GC 表现后再决定。

## 验收标准

- [ ] `state` 消息处理不再调用 `toMutableMap()`
- [ ] 使用 `ConcurrentHashMap` 作为内部存储
- [ ] `_sessions` StateFlow 仅在消息处理完成后发射一次
- [ ] 功能行为不变（session 列表正确更新）
- [ ] 多 session 并发更新场景下 GC 压力降低

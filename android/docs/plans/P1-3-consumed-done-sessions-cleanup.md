# P1-3: consumedDoneSessions 内存泄漏修复

> **优先级**: P1 — 内存泄漏  
> **影响范围**: `overlay/PetStateManager.kt`  
> **预估工时**: 30min  
> **启动提示词**: `执行 P1-3: 修复 PetStateManager.consumedDoneSessions 无清理机制导致的内存泄漏，添加 TTL 过期清理`

---

## 问题描述

```kotlin
// PetStateManager.kt:113
private val consumedDoneSessions = ConcurrentHashMap.newKeySet<String>()
```

此 Set 用于记录已完成的 sessionId，防止重复触发 Attention 状态。但**没有清理机制**：
- 每个完成的 session 的 sessionId 永久保留在 Set 中
- 长时间运行（数天/数周）后 Set 无限增长
- 虽然单条目很小（~50 bytes），但累积效应不可忽视

## 修复方案

### 方案 A: 简单时间窗口清理（推荐）

利用 `System.currentTimeMillis()` 记录每个 sessionId 的消费时间，定期清理超过阈值的条目。

```kotlin
// PetStateManager.kt
private val consumedDoneSessions = ConcurrentHashMap<String, Long>()  // sessionId → consumedAt

private fun markDoneConsumed(sessionId: String) {
    consumedDoneSessions[sessionId] = System.currentTimeMillis()
    cleanupExpiredDoneSessions()
}

private fun isDoneConsumed(sessionId: String): Boolean {
    return consumedDoneSessions.containsKey(sessionId)
}

private fun cleanupExpiredDoneSessions() {
    val now = System.currentTimeMillis()
    val expired = consumedDoneSessions.entries
        .filter { now - it.value > DONE_SESSION_TTL_MS }
        .map { it.key }
    expired.forEach { consumedDoneSessions.remove(it) }
}

companion object {
    // ... existing constants
    private const val DONE_SESSION_TTL_MS = 5 * 60 * 1000L  // 5 分钟
}
```

**使用位置**（`resolveDisplayState` 中）：

```kotlin
session.badge == "done" -> {
    val sid = session.sessionId
    if (sid != null && !isDoneConsumed(sid)) {
        markDoneConsumed(sid)
        PetState.Attention
    } else {
        PetState.Idle
    }
}
```

### 方案 B: 重置时清空

在 `reset()` 中已有 `prevBadge.clear()`，同步清空：

```kotlin
fun reset() {
    // ... existing
    consumedDoneSessions.clear()
}
```

## 验收标准

- [ ] `consumedDoneSessions` 使用 `ConcurrentHashMap<String, Long>` 存储时间戳
- [ ] 条目在 5 分钟 TTL 后自动清理
- [ ] `reset()` 时清空所有条目
- [ ] Attention 触发逻辑不变（去重行为一致）
- [ ] PetStateManagerLogicTest 测试通过

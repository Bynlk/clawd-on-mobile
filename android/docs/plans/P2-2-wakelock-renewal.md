# P2-2: WakeLock 续期机制

> **优先级**: P2 — 长时运行风险  
> **影响范围**: `service/WebSocketService.kt`  
> **预估工时**: 30min  
> **启动提示词**: `执行 P2-2: 为 WebSocketService 的 WakeLock 添加续期机制，避免 1 小时超时后 WebSocket 连接断开`

---

## 问题描述

```kotlin
// WebSocketService.kt:193
wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:ws").apply {
    setReferenceCounted(false)
    acquire(60 * 60 * 1000L) // 1 hour timeout safety net
}
```

WakeLock 设置了 1 小时超时。超时后系统释放锁，CPU 进入休眠，WebSocket 连接静默断开。当前的 watchdog（30s）可能无法在 CPU 休眠时触发重连。

## 修复方案

### 方案 A: 周期性续期（推荐）

在 `startStateCollector` 中添加 WakeLock 检查和续期：

```kotlin
// WebSocketService.kt
private fun startStateCollector() {
    stateCollectorJob?.cancel()
    stateCollectorJob = scope.launch {
        // ... existing state collection ...

        // WakeLock 续期协程
        launch {
            while (isActive) {
                delay(WAKELOCK_RENEWAL_INTERVAL_MS)
                renewWakeLock()
            }
        }
    }
}

private fun renewWakeLock() {
    wakeLock?.let { wl ->
        if (!wl.isHeld) {
            Log.d(TAG, "WakeLock expired, re-acquiring")
            wl.acquire(WAKELOCK_TIMEOUT_MS)
        }
    }
}

companion object {
    // ... existing constants
    private const val WAKELOCK_TIMEOUT_MS = 60 * 60 * 1000L  // 1 hour
    private const val WAKELOCK_RENEWAL_INTERVAL_MS = 30 * 60 * 1000L  // 30 minutes
}
```

### 方案 B: 延长超时 + 连接状态触发

将 WakeLock 超时设为更长（如 8 小时），仅在连接成功时续期：

```kotlin
wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:ws").apply {
    acquire(8 * 60 * 60 * 1000L)  // 8 hours
}
```

但此方案不如方案 A 精细，无法区分"CPU 主动休眠"和"WakeLock 自然超时"。

## 验收标准

- [ ] WakeLock 每 30 分钟检查一次是否仍在持有
- [ ] 超时释放后自动重新 acquire
- [ ] `ACTION_DISCONNECT` 时正确释放不续期
- [ ] 日志中记录 WakeLock 续期事件

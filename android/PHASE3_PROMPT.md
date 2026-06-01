# Phase 3 代码清理 — 执行提示词

> 复制下方 ```` ``` ```` 块内容直接粘贴到 Claude Code 执行

---

```
执行 Android 端 Phase 3 代码清理，共 5 个任务。先读取相关文件确认当前状态，再逐个修改。最后运行 `./gradlew assembleDebug` 确认编译通过。

## 背景

评估报告见 android/AUDIT_REPORT.md，执行方案见 android/EXECUTION_PLAN.md Phase 3 部分。
Phase 1 安全加固 + Phase 2 线程安全已完成。

## 任务清单

### T3.1 删除 applyConductingMapping 死代码

**文件**: `android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt`

**问题**: 第 267-284 行的 `applyConductingMapping` 方法从未被调用。服务端已通过 `displayState` 字段正确处理 juggling/conducting 映射，`resolveDisplayState` 直接读取 `session.displayState`，不需要本地再映射。

**修改**:

1. 删除整个 `applyConductingMapping` 方法（第 267-284 行）：
```kotlin
// 删除以下全部内容
/**
 * Apply conducting/juggling mapping when ≥2 sessions are active.
 * PC behavior: multi-session → Clawd: Juggling, Calico/Cloudling: Conducting.
 * The mapped state (priority 4) naturally outranks Working (priority 3)
 * but defers to higher-priority states like Attention or Error.
 */
private fun applyConductingMapping(
    visible: List<SessionData>,
    currentBest: PetState
): PetState {
    Log.w("PetState", "applyConductingMapping visible=${visible.size} currentBest=${currentBest.themeKey}")
    if (visible.size < 2) return currentBest
    if (currentBest !is PetState.Working && currentBest !is PetState.Juggling)
        return currentBest
    val result = if (character == "clawd") PetState.Juggling else PetState.Conducting
    Log.w("PetState", "applyConductingMapping result: ${result.themeKey}")
    return result
}
```

2. 在 `resolveDisplayState` 方法上方添加注释说明：
```kotlin
/**
 * Resolve the dominant display state from visible sessions.
 * Excludes sleep-sequence states (they are locally managed).
 * Aligns with PC [resolveDominantSessionState].
 *
 * Note: Juggling/Conducting mapping is handled server-side via [SessionData.displayState].
 * Local applyConductingMapping was removed as dead code (2026-06-01 audit).
 */
```

---

### T3.2 实现看门狗实际逻辑

**文件**: `android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt`

**问题**: 第 432-442 行的 watchdog 循环检查了非 idle 状态但没有执行任何操作，是空循环。

**修改**: 实现实际的超时逻辑——如果当前非 idle 但没有可见 session，强制回退到 idle。

将第 432-442 行的 watchdog 块从：
```kotlin
// Watchdog: force idle if no updates for too long
val watchdogJob = scope.launch {
    while (isActive) {
        delay(WATCHDOG_INTERVAL_MS)
        val current = currentState
        if (!current.isIdleLike) {
            // Simple watchdog: if we've been non-idle for a long time without
            // session updates, the collector's updateSessions handles staleness.
            // This is a safety net for connection issues.
        }
    }
}
```

替换为：
```kotlin
// Watchdog: force idle if non-idle but no visible sessions (connection issue safety net)
val watchdogJob = scope.launch {
    while (isActive) {
        delay(WATCHDOG_INTERVAL_MS)
        if (!currentState.isIdleLike) {
            val ws = WebSocketService.getWebSocket()
            val hasActiveSessions = ws?.sessions?.value?.values?.any { it.isVisible } ?: false
            if (!hasActiveSessions) {
                Log.w(TAG, "Watchdog: state=${currentState.themeKey} but no visible sessions, forcing idle")
                emitState(PetState.Idle)
            }
        }
    }
}
```

---

### T3.3 ScanScreen executor shutdown

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/scan/ScanScreen.kt`

**问题**: 第 114 行 `cameraExecutor = remember { Executors.newSingleThreadExecutor() }` 创建的线程池在 composable 离开 composition 时未 shutdown，导致线程泄漏。

**修改**: 添加 import 并在 remember 中注册 lifecycle observer 自动关闭。

1. 添加 import（文件顶部 import 区域）：
```kotlin
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
```

2. 修改第 113-114 行，从：
```kotlin
val lifecycleOwner = LocalLifecycleOwner.current
val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
```

替换为：
```kotlin
val lifecycleOwner = LocalLifecycleOwner.current
val cameraExecutor = remember {
    Executors.newSingleThreadExecutor().also { executor ->
        lifecycleOwner.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) {
                executor.shutdown()
            }
        })
    }
}
```

---

### T3.4 FloatingPetView bitmap recycle on detach

**文件**: `android/app/src/main/java/com/clawd/mobile/overlay/FloatingPetView.kt`

**问题**: `hitTestBitmap` 仅在 `clearSvg()` 中被 recycle。如果 View 被移除但未调用 `clearSvg()`（如 Service 异常销毁），Bitmap 会泄漏。

**修改**: 重写 `onDetachedFromWindow` 回收 Bitmap。

在 `clearSvg()` 方法之后（约第 190 行后）添加：
```kotlin
override fun onDetachedFromWindow() {
    hitTestBitmap?.recycle()
    hitTestBitmap = null
    super.onDetachedFromWindow()
}
```

---

### T3.5 handleIdleTimeout 边界注释

**文件**: `android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt`

**问题**: `handleIdleTimeout` 使用 `System.currentTimeMillis()` 做 60 秒超时检测，但只在 `updateSessions` 被调用时才检查。如果 SSE 断开，超时不会触发。实际被 `collectSessions` 中的 connectionState collector 覆盖（断连时取消 collectJob），但缺少注释说明这个依赖关系。

**修改**: 在 `handleIdleTimeout` 方法的 KDoc 注释中添加说明。将第 213-216 行从：
```kotlin
/**
 * Idle 超时处理：首次 idle 开始计时，60 秒后仍 idle 才进入睡眠序列。
 * 对齐 PC 端 MOUSE_SLEEP_TIMEOUT 行为。
 */
```

替换为：
```kotlin
/**
 * Idle timeout handler: starts timer on first idle, enters sleep sequence after 60s.
 * Aligns with PC MOUSE_SLEEP_TIMEOUT.
 *
 * Note: this is only called from [updateSessions] (driven by sessionFlow.collect).
 * On SSE disconnect, [collectSessions]'s connectionState collector cancels the collectJob,
 * so idleSince won't be checked indefinitely after disconnection.
 */
```

---

## 验证

完成所有修改后，执行以下验证：

1. **编译检查**: `./gradlew assembleDebug` 确认无编译错误
2. **Grep 验证**: 确认 applyConductingMapping 已删除：
   - `grep -n "applyConductingMapping" android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt` 应返回空
3. **Grep 验证**: 确认 watchdog 有实际逻辑：
   - `grep -n "forcing idle" android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt` 应有结果
4. **Grep 验证**: 确认 ScanScreen executor 有 shutdown：
   - `grep -n "executor.shutdown" android/app/src/main/java/com/clawd/mobile/ui/scan/ScanScreen.kt` 应有结果
5. **Grep 验证**: 确认 FloatingPetView 有 onDetachedFromWindow：
   - `grep -n "onDetachedFromWindow" android/app/src/main/java/com/clawd/mobile/overlay/FloatingPetView.kt` 应有结果

最后输出修改文件清单和每个文件的改动摘要。
```

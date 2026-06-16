# P4-1: 悬浮窗大小实时生效 + 重启自动恢复

> **状态**: 待执行  
> **工时**: 1.5h  
> **启动提示词**: `执行 P4-1: 修复悬浮窗大小滑块不实时生效（改为 onValueChange 发送广播 + setPackage），以及退出 app 重启后悬浮窗不自动恢复（将自动启动逻辑移至 MainActivity）`

---

## 问题 1：大小滑块不能实时生效

### 现象

在设置页拖动大小滑块后，悬浮窗大小不会实时变化。需要先关闭再重新打开悬浮窗才能看到新大小。

### 根因分析

**文件**: `PetSettings.kt:139-148`

```kotlin
Slider(
    value = sizeDp.toFloat(),
    onValueChange = { sizeDp = it.toInt() },           // ← 只更新本地 state
    onValueChangeFinished = {                           // ← 手指抬起才发送
        prefsStore.setPetSizeDp(sizeDp)
        context.sendBroadcast(                          // ← 没有 setPackage!
            Intent(FloatingPetService.ACTION_PET_SIZE)
                .putExtra(FloatingPetService.EXTRA_SIZE_DP, sizeDp)
        )
    },
    ...
)
```

两个问题叠加：

1. **`onValueChangeFinished` 而非 `onValueChange`**：广播只在用户松手后才发送一次，拖动过程中悬浮窗不会更新。
2. **缺少 `.setPackage(context.packageName)`**：广播注册时使用了 `RECEIVER_NOT_EXPORTED`（`FloatingPetService.kt:392`），但发送时没有设置 package。在 Android 14+ 上，隐式广播无法送达 `RECEIVER_NOT_EXPORTED` 的接收器，导致**广播静默丢失**。这就是为什么松手后也没效果、需要重启服务才能生效。

### 修复方案

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/settings/PetSettings.kt`

```kotlin
Slider(
    value = sizeDp.toFloat(),
    onValueChange = { newSize ->
        sizeDp = newSize.toInt()
        // 实时发送广播，悬浮窗即时响应
        context.sendBroadcast(
            Intent(FloatingPetService.ACTION_PET_SIZE)
                .putExtra(FloatingPetService.EXTRA_SIZE_DP, sizeDp)
                .setPackage(context.packageName)       // ← 修复：必须 setPackage
        )
    },
    onValueChangeFinished = {
        prefsStore.setPetSizeDp(sizeDp)                // ← 松手后才持久化
    },
    ...
)
```

### 改动点

| 文件 | 改动 |
|------|------|
| `PetSettings.kt` | 将广播发送从 `onValueChangeFinished` 移到 `onValueChange`；添加 `.setPackage()` |

### 注意事项

- `onValueChange` 在拖动过程中会高频触发（每帧一次）。`FloatingPetService.updateSize()` 内部调用 `windowManager.updateViewLayout()` 是轻量操作，不会造成性能问题。如果担心，可以加 16ms 节流，但通常不需要。
- `setPetSizeDp` 持久化保留在 `onValueChangeFinished` 中，避免高频写入 SharedPreferences。

---

## 问题 2：退出 app 重启后悬浮窗不自动恢复

### 现象

打开悬浮窗后退出 app，重新启动 app 时悬浮窗不会自动出现。必须手动进入设置页 → 点击桌宠区域，悬浮窗才会出来。

### 根因分析

自动启动逻辑**只存在于 `PetSettings` composable 的 `LaunchedEffect` 中**：

**文件**: `PetSettings.kt:234-243`

```kotlin
@Composable
internal fun FloatingPetSection(...) {
    // ...
    LaunchedEffect(Unit) {
        hasOverlayPermission = Settings.canDrawOverlays(context)
        // ← 自动启动逻辑被埋在这里
        if (hasOverlayPermission && prefsStore.isFloatingPetEnabled() && !FloatingPetService.isRunning) {
            enabled = true
            val intent = Intent(context, FloatingPetService::class.java)
            context.startForegroundService(intent)
        }
    }
}
```

这段代码**只有在用户导航到设置页的桌宠区域时才会执行**。而 `MainActivity.onCreate()` 中完全没有悬浮窗自动启动逻辑。

`ServiceManager.kt` 只管理 `WsConnectionService`，不涉及 `FloatingPetService`。

### 修复方案

将自动启动逻辑提升到 `MainActivity` 中，在 app 启动时无条件检查并恢复悬浮窗。

**文件**: `android/app/src/main/java/com/clawd/mobile/MainActivity.kt`

在 `setupContent()` 方法（或 `onCreate` 最后）添加：

```kotlin
private fun restoreFloatingPetIfNeeded() {
    val prefsStore = PrefsStore.getInstance(this)
    if (Settings.canDrawOverlays(this)
        && prefsStore.isFloatingPetEnabled()
        && !FloatingPetService.isRunning
    ) {
        Log.d("MainActivity", "Auto-restoring floating pet service")
        val intent = Intent(this, FloatingPetService::class.java)
        startForegroundService(intent)
    }
}
```

调用时机：在 `setupContent()` 之前（overlay 权限检查之后）调用：

```kotlin
private fun checkOverlayPermission() {
    if (Settings.canDrawOverlays(this)) {
        restoreFloatingPetIfNeeded()   // ← 新增
        setupContent()
        return
    }
    // ... 权限请求 dialog
}
```

同时保留 `PetSettings.kt` 中的 `LaunchedEffect` 作为二次保障（覆盖从权限页返回的场景）。

### 改动点

| 文件 | 改动 |
|------|------|
| `MainActivity.kt` | 新增 `restoreFloatingPetIfNeeded()` 方法，在 `checkOverlayPermission()` 中调用 |
| `PetSettings.kt` | 保留现有 `LaunchedEffect` 不变（作为二次保障） |

### 注意事项

- `checkOverlayPermission()` 是权限检查链的最后一环，此时 overlay 权限已确认可用
- `FloatingPetService.isRunning` 是 `@Volatile` 的，进程死亡后自动重置为 false，所以进程重启后一定会触发恢复
- 不需要额外的 `BOOT_COMPLETED` receiver，因为用户需要手动打开 app 才会触发恢复（符合预期行为）

---

## 执行顺序

1. **先修 Bug 1**（大小滑块）— 改动最小，1 个文件 3 行
2. **再修 Bug 2**（自动恢复）— 改动 2 个文件，约 15 行
3. 运行 `./gradlew test` 验证现有测试不受影响
4. 在真机上验证两个场景

## 测试验证

| 场景 | 预期 |
|------|------|
| 拖动大小滑块 | 悬浮窗实时缩放，松手后大小持久化 |
| 打开悬浮窗 → 杀掉 app → 重新打开 app | 悬浮窗自动出现，无需进入设置页 |
| 未授予 overlay 权限 → 启动 app | 不触发自动恢复（无崩溃） |
| `floating_pet_enabled = false` → 启动 app | 不触发自动恢复 |

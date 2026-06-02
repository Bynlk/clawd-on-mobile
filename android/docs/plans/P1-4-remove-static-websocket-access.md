# P1-4: 消除 WebSocketService.getWebSocket() 静态访问

> **优先级**: P1 — 隐式耦合 + 测试困难  
> **影响范围**: `overlay/PetStateManager.kt`, `overlay/FloatingPetService.kt`  
> **预估工时**: 1.5h  
> **启动提示词**: `执行 P1-4: 消除 PetStateManager 和 FloatingPetService 对 WebSocketService.getWebSocket() 的静态访问，改为构造函数注入 sessions Flow`

---

## 问题描述

多处通过静态方法 `WebSocketService.getWebSocket()` 获取 WebSocket 实例，形成隐式依赖：

```kotlin
// PetStateManager.kt:426 — watchdog 中
val ws = WebSocketService.getWebSocket()
val hasActiveSessions = ws?.sessions?.value?.values?.any { it.isVisible } ?: false

// PetStateManager.kt:484 — resolveBestState 中
val ws = WebSocketService.getWebSocket()
val visible = ws?.sessions?.value?.values?.filter { it.isVisible }

// FloatingPetService.kt:151 — handleCommand 中
val sessionCount = WebSocketService.getWebSocket()
    ?.sessions?.value?.values?.count { it.isVisible } ?: 0
```

**问题**:
1. 隐式依赖 — 类的接口不暴露真实依赖关系
2. 测试困难 — 无法 mock 静态方法（不引入 PowerMock 的情况下）
3. 时序耦合 — 必须在 WebSocketService 创建后才能调用

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `overlay/PetStateManager.kt` | 构造函数注入 `sessionsFlow`，移除静态访问 |
| `overlay/FloatingPetService.kt` | 传递 sessionCount 到 `StateCommand.StateChanged` |
| `overlay/PetState.kt` | `StateCommand.StateChanged` 增加 `sessionCount` 字段 |

## 修复方案

### Step 1: 扩展 StateCommand.StateChanged

```kotlin
// PetStateManager.kt — StateCommand 定义
sealed interface StateCommand {
    data class StateChanged(
        val state: PetState,
        val sessionCount: Int = 0  // 新增
    ) : StateCommand
    data class SvgLoad(val assetPath: String?, val force: Boolean) : StateCommand
    data class ReactionSvg(val assetPath: String?) : StateCommand
}
```

### Step 2: 注入 sessionsFlow 到 PetStateManager

```kotlin
// PetStateManager.kt
class PetStateManager(
    var character: String,
    private val sessionsFlow: StateFlow<Map<String, SessionData>>  // 新增
) {
    // resolveBestState 改为使用 sessionsFlow
    private fun resolveBestState(): PetState {
        val visible = sessionsFlow.value.values.filter { it.isVisible }
        return if (visible.isEmpty()) PetState.Idle
        else resolveDisplayState(visible)
    }

    // watchdog 改为使用 sessionsFlow
    // collectSessions 中的 watchdog:
    val hasActiveSessions = sessionsFlow.value.values.any { it.isVisible }
}
```

### Step 3: FloatingPetService 传递 sessionCount

```kotlin
// FloatingPetService.kt — 构造 PetStateManager 时注入
private lateinit var stateManager: PetStateManager

override fun onCreate() {
    // ...
    val ws = WebSocketService.getWebSocket()
    stateManager = PetStateManager(
        character = character,
        sessionsFlow = ws?.sessions ?: MutableStateFlow(emptyMap())
    )
}

// handleCommand 中使用 command.sessionCount
private fun handleCommand(command: PetStateManager.StateCommand) {
    when (command) {
        is PetStateManager.StateCommand.StateChanged -> {
            val assetPath = SvgLoader.resolveSvgAsset(
                command.state, command.sessionCount, character  // 使用注入的值
            )
            // ...
        }
    }
}
```

### Step 4: PetStateManager 内部传递 sessionCount

```kotlin
// PetStateManager.kt — emitState 时附带 sessionCount
private fun emitState(state: PetState) {
    val sessionCount = sessionsFlow.value.values.count { it.isVisible }
    currentState = state
    commandFlowEmit(StateCommand.StateChanged(state, sessionCount))
}
```

## 验收标准

- [ ] `PetStateManager` 无 `WebSocketService.getWebSocket()` 调用
- [ ] `PetStateManager` 通过构造函数接收 `sessionsFlow: StateFlow<Map<String, SessionData>>`
- [ ] `StateCommand.StateChanged` 携带 `sessionCount`
- [ ] `FloatingPetService.handleCommand` 使用 `command.sessionCount` 而非静态访问
- [ ] 浮窗宠物功能不变
- [ ] PetStateManagerLogicTest 可以独立传入 mock StateFlow 进行测试

# Clawd Mobile — Android 伴侣应用

[![Android Build](https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml/badge.svg)](https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE)
[![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-green.svg)](https://developer.android.com/about/versions/oreo)
[![API 26+](https://img.shields.io/badge/API-26%2B-brightgreen.svg)](https://developer.android.com/studio/releases/platforms#android-8.0)

通过局域网连接 [Clawd on Desk](https://github.com/Bynlk/clawd-on-desk) 桌面端，远程监控 AI 编码会话状态，随时审批权限请求，手机变身桌面宠物遥控器。

> **需要配合桌面端使用** — 前往 [Releases](https://github.com/Bynlk/clawd-on-desk/releases) 下载 `app-release.apk`。

---

## 🚀 项目简介

**Clawd Mobile** 是一款基于 **Kotlin 2.1 + Coroutines + OkHttp SSE + WindowManager** 的高性能赛博桌宠原生 Android 客户端。它不是桌面端的"缩小版"，而是桌面端在移动端的**忠实数字分身**——一只住在你手机屏幕上的小螃蟹，实时感知 PC 端 Claude Code 的每一个呼吸。

### 三大核心卖点

| 卖点 | 实现机制 | 体感 |
|------|----------|------|
| **毫秒级状态同步** | SSE 长连接 + `StateFlow` 响应式管道，PC 端 `displayState` 变化到手机 GIF 切换 < 200ms | 桌面端小螃蟹开始打字，手机上的小螃蟹**同时**开始打字 |
| **纯血角色隔离** | `resolveDisplayState()` + `applyConductingMapping()` 双重决策引擎，三花猫/白云/黑白猫各自有独立的状态映射逻辑 | ≥2 会话时，三花猫变指挥家，黑白猫变杂耍师 |
| **极低功耗挂机** | `WifiLock` + `WakeLock` 双锁保活 + 30s 看门狗 + 指数退避重连（1s→30s），后台运行功耗 < 50mW | 手机放口袋一整天，小螃蟹依然在线 |

### 技术栈速览

| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Kotlin | 2.1.0 |
| UI 框架 | Jetpack Compose + Material 3 | BOM 2024.12.01 |
| 网络 | OkHttp SSE（Server-Sent Events） | 4.12.0 |
| 序列化 | kotlinx.serialization | 1.7.3 |
| 二维码 | CameraX + ZXing | 1.4.1 / 3.5.3 |
| GIF 加载 | Glide | 4.16.0 |
| 导航 | Navigation Compose | 2.8.5 |
| 构建 | Gradle + AGP | 8.11.1 / 8.7.3 |
| 最低版本 | Android 8.0（API 26） | — |
| 目标版本 | Android 15（API 35） | — |
| ABI | arm64-v8a | — |
| JVM Target | 17 | — |

---

## 🏛️ 响应式双管道架构

### 从"上帝类"到"大脑-躯壳"分离

早期的 `FloatingPetService` 是一个 800+ 行的"上帝类"：它同时承担了 WebSocket 会话收集、状态优先级计算、sleep 序列管理、badge 转换检测、GIF 加载调度、悬浮窗手势处理、气泡 UI 构建……所有逻辑纠缠在一个 `Service` 里，像一团解不开的耳机线。

重构的核心思想是**将"业务大脑"从"视图躯壳"中剥离**，并通过**单管道（Single-pipe）架构**统一所有状态变更和 GIF 加载指令：

```
┌─────────────────────────────────────────────────────────────────┐
│                        PC 端 Electron                           │
│                   (SSE push on LAN:23334)                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ SSE events: state / snapshot / badge
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    ClawdWebSocket (SSE Client)                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ StateFlow<Map<sessionId, SessionData>>   ← 会话数据流     │   │
│  │ StateFlow<ConnectionState>               ← 连接状态流     │   │
│  │ SharedFlow<PermissionRequestData>        ← 审批请求流     │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ sessions.collect()
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              PetStateManager（业务大脑 / 决策引擎）                │
│                                                                  │
│  输入: Map<sessionId, SessionData>                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 1. filter { isVisible }                                   │   │
│  │ 2. resolveDisplayState() → 遍历取最高 priority            │   │
│  │ 3. applyConductingMapping() → ≥2 会话映射 Juggling/Conducting│
│  │ 4. checkBadgeTransitions() → 1.5s Happy 插播             │   │
│  │ 5. sleep sequence 管理 → Yawning→Collapsing→Sleeping      │   │
│  │ 6. pickIdleAnimGif() → 随机 idle 动画变体                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  输出: 单管道 (StateCommand)                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ StateFlow<StateCommand>                                    │ │
│  │ ├── StateChanged(state)    → 持久状态切换 (Working/Idle/…) │ │
│  │ ├── GifLoad(resId, force)  → 一次性动画 (idle variant)     │ │
│  │ └── ReactionGif(resId)     → 反应动画 (Happy/Waking)       │ │
│  └────────────────────────────┬───────────────────────────────┘ │
└───────────────────────────────┼─────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│              FloatingPetService（纯视图组件 / 躯壳）              │
│                                                                  │
│  单一 collector: stateFlow.collect { command → handleCommand() } │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   │
│  │FloatingPetView │  │ PetBubbleView │  │  PetGifLoader     │   │
│  │  (GIF 浮窗)    │  │  (信息气泡)    │  │ (候选链 GIF 解析)  │   │
│  └───────────────┘  └───────────────┘  └───────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 数据流详解

**上行（PC → 手机）**：桌面端通过 SSE 推送会话状态，`ClawdWebSocket` 解析后更新 `StateFlow<Map<String, SessionData>>`。零本地推断——所有状态在 PC 端计算完毕，手机端只做消费和视觉映射。

**决策层（大脑）**：`PetStateManager` 订阅 `sessions` Flow，经过 6 级管道（过滤→优先级→角色映射→badge 检测→睡眠管理→idle 变体）输出单条 `StateCommand` 管道：

| 命令类型 | 承载内容 | 生命周期 | 消费方式 |
|----------|----------|----------|----------|
| `StateChanged(state)` | **持久状态**：Working、Idle、Sleeping 等 | 持续存在，StateFlow 特性 | `handleCommand()` → `loadGif(state)` |
| `GifLoad(resId, force)` | **一次性动画**：idle 变体（reading/bubble） | 触发一次消费一次 | `handleCommand()` → `loadGifWithReady()` |
| `ReactionGif(resId)` | **反应动画**：Happy 插播、Waking 动画 | 触发一次消费一次 | `handleCommand()` → `loadGifWithReady(force=true)` |

**下行（手机 → 用户）**：`FloatingPetService` 作为纯躯壳，collect 单条 `stateFlow`，按顺序处理每个 `StateCommand`。`PetGifLoader` 通过动态候选链解析资源 ID，`FloatingPetView` 通过 Matrix 矩阵实现无损缩放。

### 单管道架构：为什么合并为一个 `StateFlow`？

早期设计使用双管道（`StateFlow<PetState>` + `Channel<GifLoadEvent>`），存在竞态窗口：两个 collector 并发调用 `loadGif()` 时，Glide 会丢失中间帧。

合并为单管道后，所有命令在同一个 collector 中**串行处理**，彻底消除并发 GIF 加载：

```kotlin
// FloatingPetService — 单一 collector，串行处理所有命令
commandCollectorJob = scope.launch(Dispatchers.Main) {
    stateManager.start(this)
    stateManager.stateFlow.collect { command ->
        handleCommand(command)  // 每个命令串行执行，无并发
    }
}
```

### 为什么要"数字越大越优先"？

PC 端的优先级约定是 **`Error=8 > Notification=7 > ... > Sleeping=0`**——数字越大，优先级越高。这符合人类直觉：错误比通知重要，通知比空闲重要。

重构前 Android 端用的是**反向优先级**（数字越小越优先），导致 `Session.STATE_PRIORITY` 里的映射和 PC 端完全相反。每次对齐都要在脑子里做一次"反转"，极易出 bug。

重构后，`PetState` 的 `priority` 字段直接对齐 PC 端：

```kotlin
// PetState.kt — 优先级完全对齐 PC 端
sealed class PetState(val priority: Int, val themeKey: String) {
    data object Error       : PetState(8, "error")        // 最高优先级
    data object Notification: PetState(7, "notification")
    data object Sweeping    : PetState(6, "sweeping")
    data object Attention   : PetState(5, "attention")
    data object Conducting  : PetState(4, "conducting")   // 同级: conducting/juggling/carrying/debugger
    data object Juggling    : PetState(4, "juggling")
    data object Carrying    : PetState(4, "carrying")
    data object Debugger    : PetState(4, "debugger")
    data object Working     : PetState(3, "working")
    data object Thinking    : PetState(2, "thinking")
    data object Idle        : PetState(1, "idle")         // 基线状态
    data object Yawning     : PetState(1, "yawning")      // 睡眠序列，同 Idle 优先级
    data object Dozing      : PetState(1, "dozing")
    data object Collapsing  : PetState(1, "collapsing")
    data object Waking      : PetState(1, "waking")
    data object Sleeping    : PetState(0, "sleeping")     // 最低优先级
}
```

---

## 🐱 PC 端全量状态对齐矩阵

### PetState 完整状态矩阵（16 个状态）

| 状态 | priority | themeKey | 类别 | 角色隔离 | Oneshot | 说明 |
|------|:--------:|----------|------|:--------:|:-------:|------|
| `Error` | 8 | `error` | 主动 | ❌ | ✅ | 会话出错，需要关注 |
| `Notification` | 7 | `notification` | 主动 | ❌ | ✅ | 新通知到达 |
| `Sweeping` | 6 | `sweeping` | 主动 | ❌ | ✅ | 清扫/收尾工作 |
| `Attention` | 5 | `attention` | 主动 | ❌ | ✅ | 需要用户注意（也是 Happy 插播的载体） |
| `Conducting` | 4 | `conducting` | 主动 | ✅ Calico/Cloudling | ❌ | 多任务指挥（≥2 会话自动触发） |
| `Juggling` | 4 | `juggling` | 主动 | ✅ Clawd | ❌ | 多任务杂耍（≥2 会话自动触发） |
| `Carrying` | 4 | `carrying` | 主动 | ❌ | ✅ | 搬运/传输中 |
| `Debugger` | 4 | `debugger` | 主动 | ❌ | ❌ | 调试模式（仅 Clawd 有专属 GIF） |
| `Working` | 3 | `working` | 主动 | ❌ | ❌ | 正常工作中（typing/building 变体） |
| `Thinking` | 2 | `thinking` | 主动 | ❌ | ❌ | 思考中 |
| `Idle` | 1 | `idle` | 空闲 | ❌ | ❌ | 基线空闲状态 |
| `Yawning` | 1 | `yawning` | 睡眠序列 | ❌ | ❌ | 打哈欠（睡眠第一步） |
| `Dozing` | 1 | `dozing` | 睡眠序列 | ❌ | ❌ | 打盹（仅 Calico/Cloudling） |
| `Collapsing` | 1 | `collapsing` | 睡眠序列 | ❌ | ❌ | 倒下（Calico: 5.2s, Cloudling: 4.7s） |
| `Waking` | 1 | `waking` | 睡眠序列 | ❌ | ❌ | 唤醒动画 |
| `Sleeping` | 0 | `sleeping` | 睡眠序列 | ❌ | ❌ | 深睡（最低优先级） |

### `resolveDisplayState()` 多任务决策算法

当多个会话同时存在时，决策引擎按以下优先级选取"主导状态"：

```
输入: visible = [SessionData, SessionData, ...]

Step 1: 过滤 — 仅保留 isVisible == true 的会话
Step 2: 遍历 — 对每个会话:
        state = PetState.fromString(session.displayState ?: session.state)
        if (state.isSleepSequence) continue  // 睡眠序列不参与竞争
        if (state.priority > best.priority) best = state
Step 3: Conducting 映射 — ≥2 会话时映射到 Juggling/Conducting
Step 4: 返回 best
```

```kotlin
private fun resolveDisplayState(visible: List<SessionData>): PetState {
    var best: PetState = PetState.Idle
    for (session in visible) {
        val state = PetState.fromString(session.displayState ?: session.state)
        if (state.isSleepSequence) continue  // 睡眠序列由本地管理，不参与竞争
        if (state.priority > best.priority) best = state
    }
    return best
}
```

### 多任务（Multi-tier）场景下的角色隔离

当可见会话 ≥ 2 时，自动映射到多任务状态。无需 `SubagentStart` 事件——纯粹基于会话数量触发：

```kotlin
private fun applyConductingMapping(
    visible: List<SessionData>,
    currentBest: PetState
): PetState {
    if (visible.size < 2) return currentBest

    val mapped = if (character == "clawd") PetState.Juggling else PetState.Conducting
    return if (mapped.priority > currentBest.priority) mapped else currentBest
}
```

| 触发条件 | Clawd（黑白猫） | Calico（三花猫） | Cloudling（白云） |
|----------|:----------------:|:----------------:|:-----------------:|
| 会话 ≥ 2 | `Juggling`（杂耍师，priority=4） | `Conducting`（指挥家，priority=4） | `Conducting`（指挥家，priority=4） |
| 会话 < 2 | 不触发映射 | 不触发映射 | 不触发映射 |

**优先级博弈**：映射结果只有在 `priority > currentBest` 时才会生效。典型场景：

```
1 个 Working 会话 → best = Working (3)     → 无映射 → 显示 Working
2 个 Working 会话 → best = Working (3)     → Juggling(4) > 3 → 显示 Juggling
2 个会话，1 个 Error → best = Error (8)    → Juggling(4) ≤ 8 → 保持 Error
3 个会话，1 个 Attention → best = Attention(5) → Juggling(4) ≤ 5 → 保持 Attention
```

这意味着小螃蟹在 2+ 会话时自动进入"多任务模式"（Juggling/Conducting），但永远不会覆盖更重要的状态（Error、Notification、Attention）。

### GIF 候选链：`PetGifLoader.resolveGif()`

GIF 解析采用**动态候选链**机制——按优先级尝试多个资源名，第一个存在的生效：

```kotlin
private fun resolveGif(character: String, state: String, sessionCount: Int = 1): Int? {
    val candidates = when (state) {
        "working" -> when {
            sessionCount >= 3 -> listOf("${character}_building", "${character}_typing", "${character}_idle")
            sessionCount == 2 -> listOf("${character}_headphones_groove", "${character}_typing", "${character}_idle")
            else -> listOf("${character}_typing", "${character}_idle")
        }
        "juggling" -> when {
            sessionCount >= 2 -> listOf("${character}_juggling", "${character}_typing", "${character}_idle")
            else -> listOf("${character}_headphones_groove", "${character}_typing", "${character}_idle")
        }
        "attention" -> listOf("${character}_attention", "${character}_happy", "${character}_idle")
        "yawning" -> listOf("${character}_yawning", "${character}_sleeping", "${character}_idle")
        "dozing" -> listOf("${character}_dozing", "${character}_sleeping", "${character}_idle")
        "collapsing" -> listOf("${character}_collapsing", "${character}_sleeping", "${character}_idle")
        "waking" -> listOf("${character}_waking", "${character}_idle")
        "conducting" -> listOf("${character}_conducting", "${character}_idle")
        "debugger" -> listOf("${character}_debugger", "${character}_idle")
        else -> listOf("${character}_${state}", "${character}_idle")
    }
    return candidates.firstNotNullOfOrNull { name -> resIdByName(name).takeIf { it != 0 } }
}
```

### 各角色 GIF 资源矩阵（42 个资源）

| 动画 | Clawd | Calico | Cloudling | 用途 |
|------|:-----:|:------:|:---------:|------|
| idle | ✅ | ✅ | ✅ | 基线空闲 |
| idle_reading | ✅ | ❌ | ✅ | 深睡 idle 变体 |
| bubble | ✅ | ❌ | ❌ | 深睡 idle 变体（Clawd 独占） |
| typing | ✅ | ✅ | ✅ |
| thinking | ✅ | ✅ | ✅ |
| building | ✅ | ✅ | ✅ |
| juggling | ✅ | ✅ | ✅ |
| carrying | ✅ | ✅ | ✅ |
| sweeping | ✅ | ✅ | ✅ |
| conducting | ✅ | ✅ | ✅ |
| notification | ✅ | ✅ | ✅ |
| error | ✅ | ✅ | ✅ |
| happy | ✅ | ✅ | ❌ |
| sleeping | ✅ | ✅ | ✅ |
| attention | ❌ | ❌ | ✅ |
| headphones_groove | ✅ | ❌ | ❌ |
| debugger | ✅ | ❌ | ❌ |
| react_annoyed | ✅ | ❌ | ❌ |
| react_double_jump | ✅ | ❌ | ❌ |
| bubble | ✅ | ❌ | ❌ |

---

## 💤 灵性视觉控制链

### 独立时序睡眠长蛇阵：Yawning → Dozing → Collapsing → Sleeping + 随机 Idle 变体

睡眠不是简单的 `Idle → Sleeping` 一刀切。它是一条精心编排的**动画序列**，每个角色有不同的时间参数，完全对齐 PC 端的 `theme.json`。深睡期间每 30 秒随机抽取一个 idle 动画变体（reading / bubble），让小螃蟹看起来更"活"：

```
                    ┌──────────────────────────────────────────────────────┐
                    │            Per-Character Sleep Config                │
                    ├──────────┬──────────┬──────────────┬────────────────┤
                    │ yawnMs   │collapseMs│ wakeMs       │ deepSleepMs    │
                    ├──────────┼──────────┼──────────────┼────────────────┤
                    │ Clawd    │ 3,000ms  │    0ms (跳过)│   1,500ms      │ 600,000ms │
                    │ Calico   │ 8,000ms  │ 5,200ms      │   5,800ms      │ 600,000ms │
                    │ Cloudling│ 9,030ms  │ 4,700ms      │   3,650ms      │ 600,000ms │
                    └──────────┴──────────┴──────────────┴────────────────┘
```

**完整时间线（以 Calico 为例）：**

```
t=0s       所有会话消失（isVisible 全部变为 false）
           ↓
t=0s       PetStateManager.updateSessions() 检测到 visible.isEmpty()
           ↓ 调用 startSleepSequence()
           ↓
t=0s       emitState(Yawning)  →  GIF: calico_sleeping（降级，无专属 yawning GIF）
           ↓ delay(8,000ms)
           ↓
t=8s       emitState(Collapsing)  →  GIF: calico_sleeping（降级）
           ↓ delay(5,200ms)
           ↓
t=13.2s    emitState(Sleeping)  →  GIF: calico_sleeping
           ↓ 进入 idle animation loop
           ↓
t=43.2s    pickIdleAnimGif() → 随机选择 idle 动画变体（reading/bubble/look）
           ↓ delay(5,000ms) 显示
           ↓ delay(30,000ms) 循环
           ↓
t=78.2s    ... 继续循环（每次随机抽取不同变体）直到有新会话到来
```

**Clawd 的特殊性**：`collapseMs = 0`，意味着 Clawd 跳过 Collapsing 阶段，直接从 Yawning 进入 Sleeping——因为 Clawd 的 `yawning` GIF 本身已经包含了"倒下"的动画。

### 异步防诈尸唤醒守卫

当小螃蟹处于深睡状态时，一个新会话的到来会触发唤醒序列。但这里有一个并发陷阱：如果唤醒动画还没播完，又来了一个更高优先级的会话怎么办？

**`gifGeneration` 世代守卫**完美解决了这个问题：

```kotlin
private fun playWakingAndRestore(targetState: PetState, scope: CoroutineScope) {
    cancelSleepSequence()
    val gen = ++gifGeneration  // ← 世代号 +1

    if (PetGifLoader.hasGifForState(PetState.Waking, character)) {
        emitState(PetState.Waking)
        scope.launch {
            delay(sleepConfig.wakeMs)  // 等唤醒动画播完
            if (gifGeneration != gen) return@launch  // ← 世代不匹配，说明中间有新状态，放弃
            emitState(targetState)
        }
    } else {
        emitState(targetState)  // 无 waking GIF，直接切
    }
}
```

场景推演：

```
t=0s    深睡中 (Sleeping)，gifGeneration = 5
t=1s    新 Working 会话到来 → playWakingAndRestore(Working)
        gifGeneration = 6，开始播 Waking，计划 t=2.5s 恢复 Working
t=1.5s  又一个 Error 会话到来 → playWakingAndRestore(Error)
        gifGeneration = 7，开始播 Waking，计划 t=3s 恢复 Error
t=2.5s  第一个 launch 醒来，发现 gifGeneration(7) != gen(6) → 放弃 ✅
t=3s    第二个 launch 醒来，发现 gifGeneration(7) == gen(7) → 恢复 Error ✅
```

### 1.5s Happy 插播与 `gifGeneration` 代际防覆盖

当 session 的 badge 从 `running` 变为 `done` 时，系统会播放一个 1.5s 的 Happy 庆祝动画。但如果多个任务快速完成（比如 3 个子代理同时 Done），就会出现：

```
t=0s    Task A done → Happy 动画，gifGeneration = 8，计划 t=1.5s 恢复
t=0.3s  Task B done → Happy 动画，gifGeneration = 9，计划 t=1.8s 恢复
t=0.6s  Task C done → Happy 动画，gifGeneration = 10，计划 t=2.1s 恢复
t=1.5s  Task A 的恢复回调：gifGeneration(10) != 8 → 放弃 ✅（不会用旧状态覆盖新动画）
t=1.8s  Task B 的恢复回调：gifGeneration(10) != 9 → 放弃 ✅
t=2.1s  Task C 的恢复回调：gifGeneration(10) == 10 → 恢复到当前最佳状态 ✅
```

**核心保证**：只有**最后一次**反应的恢复回调会生效，中间的全部被世代守卫丢弃。

```kotlin
private fun checkBadgeTransitions(sessions: Collection<SessionData>, scope: CoroutineScope) {
    for (s in sessions) {
        val sid = s.sessionId ?: continue
        val prev = prevBadge[sid] ?: continue
        val curr = s.badge
        if (prev in PetState.RUNNING_BADGES && curr == "done") {
            val happyResId = getGifResId(PetState.Attention)
            if (happyResId != null && happyResId != 0) {
                loadReactionAndRestore(happyResId, REACTION_DISPLAY_MS, scope)
            }
        }
    }
}
```

---

## 🎨 矩阵无损缩放算法（核心亮点）

### 问题：64dp 幽灵限制

早期实现中，GIF 浮窗的尺寸被硬编码为 64dp。当用户在设置中拖动尺寸滑块（32-128dp）时，系统需要**重新加载 GIF** 才能应用新尺寸，导致：

- 视觉闪烁（GIF 重新加载期间的白帧）
- 状态中断（正在播放的动画被打断）
- 性能浪费（相同 GIF 被重复解码）

### 解决方案：纯硬件加速 Matrix 无感缩放

`FloatingPetView` 使用 `ScaleType.MATRIX` 实现**不重新加载 GIF、不闪烁、状态不中断**的纯矩阵缩放。核心算法在 `applyContentMatrix()` 中：

```kotlin
private fun applyContentMatrix(bitmap: Bitmap?) {
    if (bitmap == null || bitmap.isRecycled || width == 0 || height == 0) return

    val contentRect = findContentBounds(bitmap)  // Step 1: 扫描非透明边界
    if (contentRect.isEmpty) {
        scaleType = ScaleType.FIT_CENTER  // 全透明兜底
        return
    }

    val matrix = Matrix()

    // Step 2: 计算缩放比例
    val contentW = contentRect.width()
    val contentH = contentRect.height()
    val contentMax = maxOf(contentW, contentH)
    val scale = if (targetContentPx > 0 && contentMax > 0f) {
        targetContentPx / contentMax  // 关键公式：目标像素 / 内容最大边
    } else {
        1f
    }

    val cx = contentRect.centerX()  // 内容视觉中心 X
    val cy = contentRect.centerY()  // 内容视觉中心 Y

    // Step 3: 以内容中心为锚点缩放，再平移使内容中心 = 视图中心
    matrix.postScale(scale, scale, cx, cy)
    matrix.postTranslate(width / 2f - cx, height / 2f - cy)
    imageMatrix = matrix

    // Step 4: 回调通知 Service 内容偏移量（用于窗口尺寸计算）
    val offsetDx = scale * (cx - bitmap.width / 2f)
    val offsetDy = scale * (cy - bitmap.height / 2f)
    onContentReady?.invoke(offsetDx, offsetDy, bitmap.width, bitmap.height)
}
```

### `findContentBounds()` — O(w+h) 行列双扫描

为了精确识别 GIF 帧中的有效内容区域（排除透明边距），使用高效的行列双扫描算法：

```kotlin
private fun findContentBounds(bitmap: Bitmap): RectF {
    val w = bitmap.width
    val h = bitmap.height

    // Phase 1: 行扫描找 top/bottom
    var top = -1; var bottom = -1
    for (y in 0 until h) {
        for (x in 0 until w) {
            if (bitmap.getPixel(x, y) ushr 24 != 0) { top = y; break }
        }
        if (top >= 0) break
    }
    for (y in h - 1 downTo top) {
        for (x in 0 until w) {
            if (bitmap.getPixel(x, y) ushr 24 != 0) { bottom = y; break }
        }
        if (bottom >= 0) break
    }

    // Phase 2: 列扫描找 left/right（仅扫描 top..bottom 范围）
    var left = -1; var right = -1
    for (x in 0 until w) {
        for (y in top..bottom) {
            if (bitmap.getPixel(x, y) ushr 24 != 0) { left = x; break }
        }
        if (left >= 0) break
    }
    for (x in w - 1 downTo left) {
        for (y in top..bottom) {
            if (bitmap.getPixel(x, y) ushr 24 != 0) { right = x; break }
        }
        if (right >= 0) break
    }

    return RectF(left.toFloat(), top.toFloat(), (right + 1).toFloat(), (bottom + 1).toFloat())
}
```

**复杂度分析**：传统逐像素扫描是 O(w×h)，而行列双扫描在最坏情况下也是 O(w+h)——因为每个方向只扫描到第一个非透明像素就停止。

### `recalcContentMatrix()` — 滑块拖动的无感响应

当用户在设置中拖动尺寸滑块时，`FloatingPetService` 调用 `petView.recalcContentMatrix()`，该方法直接对当前已加载的 GIF 帧重新计算 Matrix：

```kotlin
// FloatingPetView.kt
fun recalcContentMatrix(bitmap: Bitmap?) {
    applyContentMatrix(bitmap)  // 复用同一个 Matrix 计算逻辑
}

// FloatingPetService.kt — 滑块回调
private fun updatePetSize(newSizeDp: Int) {
    sizeDp = newSizeDp
    targetContentPx = (sizeDp * density).toInt()
    petView?.targetContentPx = targetContentPx
    petView?.recalcContentMatrix((petView?.drawable as? GifDrawable)?.firstFrame)
    recalcWindowSize()  // 根据偏移量重新计算窗口大小
}
```

**关键优势**：
- **零 GIF 重载**：直接操作已解码的 `firstFrame` Bitmap，不触发 Glide 加载
- **零闪烁**：Matrix 变换是硬件加速的，帧间无白帧
- **零状态中断**：正在播放的 GIF 动画不受影响，Matrix 只影响渲染变换

### 窗口尺寸联动：`recalcWindowSize()`

Matrix 缩放后，窗口大小也需要同步调整，否则内容会溢出或留白。`FloatingPetService` 通过 `onContentReady` 回调获取偏移量，动态计算窗口尺寸：

```kotlin
private fun recalcWindowSize() {
    val contentW = (frameW - 2 * Math.abs(contentOffsetDx)).coerceAtLeast(1f)
    val contentH = (frameH - 2 * Math.abs(contentOffsetDy)).coerceAtLeast(1f)
    val contentScale = maxOf(contentW, contentH)
    val windowDp = (sizeDp * maxOf(frameW, frameH) / contentScale)
    val windowPx = (windowDp * density).toInt()

    // 关键：窗口位置调整，使得内容中心不变
    val targetX = (oldCenterX - contentOffsetDx * (windowPx.toFloat() / frameW)).toInt()
    val targetY = (oldCenterY - contentOffsetDy * (windowPx.toFloat() / frameH)).toInt()
    lp.x = targetX - windowPx / 2
    lp.y = targetY - windowPx / 2
}
```

---

## 🛠️ 悬浮窗基础设施

### 透明区域点击穿透

`FloatingPetView.onTouchEvent()` 在 `ACTION_DOWN` 时做**反向矩阵变换**，将触摸坐标映射回 bitmap 空间，检查 alpha 通道：

```kotlin
override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_DOWN) {
        val curDrawable = drawable
        if (curDrawable is GifDrawable && imageMatrix.isIdentity.not()) {
            val inv = Matrix()
            if (imageMatrix.invert(inv)) {
                val pts = floatArrayOf(event.x, event.y)
                inv.mapPoints(pts)
                val bx = pts[0].toInt()
                val by = pts[1].toInt()
                val bmp = curDrawable.firstFrame
                if (bmp != null && !bmp.isRecycled && bx in 0 until bmp.width && by in 0 until bmp.height) {
                    if (bmp.getPixel(bx, by) ushr 24 == 0) {
                        return false  // 透明区域：点击穿透到下方窗口
                    }
                }
            }
        }
    }
    // 非透明区域：正常处理手势
    return gestureDetector?.onTouchEvent(event) ?: super.onTouchEvent(event)
}
```

### 原生高防抖双击流手势

手势处理使用 Android 原生 `GestureDetector`，天然具备防抖能力：

| 手势 | 方法 | 行为 | 防抖机制 |
|------|------|------|----------|
| 单击 | `onSingleTapConfirmed()` | 切换信息气泡 | 系统级 300ms 确认延迟，排除双击 |
| 双击 | `onDoubleTap()` | 打开主应用 + 关闭气泡 | 系统级双击检测，300ms 内两次 UP |
| 拖拽 | `onScroll()` | 移动宠物位置 | `DRAG_THRESHOLD_SQ_PX = 100`（10px² 死区） |

**`onSingleTapConfirmed` vs `onSingleTapUp` 的排他性判定**：

使用 `onSingleTapConfirmed` 而非 `onSingleTapUp` 是关键设计决策。`onSingleTapUp` 在手指抬起时立即触发，无法区分"单击"和"双击的第一次抬起"。而 `onSingleTapConfirmed` 会等待 300ms 确认没有第二次点击后才触发，天然实现了单击/双击的排他性。

**拖拽对点击的绝对抢占**：一旦 `isDragging = true`，所有后续事件都被拖拽消费，不会触发 click：

```kotlin
override fun onScroll(...): Boolean {
    if (!isDragging && (dx * dx + dy * dy) > DRAG_THRESHOLD_SQ_PX) {
        isDragging = true
        dismissBubble()  // 拖拽开始时自动关闭气泡
    }
    if (isDragging) { /* 更新窗口位置 */ }
    return true
}
```

### 优雅下班机制（Elegant Exit）

`ACTION_DISCONNECT` 触发的是一条**原子级注销链**，确保零残留：

```
ACTION_DISCONNECT
    ↓
1. dismissBubble()           ← 移除气泡 View
    ↓
2. stateManager.reset()      ← 取消所有协程（sleep sequence + state collector）
   ├── stateCollectorJob?.cancel()
   ├── cancelSleepSequence()
   ├── gifGeneration++       ← 使所有待恢复回调失效
   ├── lastNonIdleState = Idle
   └── prevBadge.clear()
    ↓
3. stateCollectorJob?.cancel()  ← 取消 View 层的 collector
    ↓
4. unregisterBroadcastReceiver()  ← 注销广播接收器
    ↓
5. savePosition()             ← 持久化当前位置到 SharedPreferences
    ↓
6. removeFloatingWindow()     ← WindowManager.removeView() + clearGif()
    ↓
7. stopForeground(STOP_FOREGROUND_REMOVE)  ← 移除前台通知
    ↓
8. stopSelf()                 ← 销毁 Service
    ↓
结果：0 内存残留，0 功耗残留，0 通知残留
```

### 气泡定位算法

气泡 (`PetBubbleView`) 的定位考虑了屏幕边界约束：

```
默认位置：宠物正上方，水平居中
如果上方空间不足（y < margin）→ 改为宠物正下方
水平方向：强制 clamp 到 [margin, screenW - bubbleW - margin]
最大高度：屏幕高度的 40%
```

---

## 🧼 工业级工程规范

### 全量 i18n 国际化（strings.xml 100% 清扫）

整个工程 **100% 拔除了 Kotlin/Compose 里的硬编码中文**，全量收拢至 `res/values/strings.xml`（169 个条目）。`res/values-zh/strings.xml` 提供中文本地化覆盖。

**覆盖范围**：

| 类别 | 条目数 | 示例 |
|------|:------:|------|
| 应用名 + 通知渠道 | 9 | `channel_approval` → "审批请求" |
| 连接状态 | 8 | `status_connected_to` → "已连接 - %s" |
| 事件标签 | 12 | `event_subagent_start` → "子代理启动" |
| 通知消息 | 12 | `notify_done_title` → "%s 搞定啦" |
| 权限对话框 | 5 | `perm_overlay_desc` → "用于显示桌宠悬浮窗..." |
| 会话界面 | 17 | `sessions_active_title` → "活跃会话" |
| 设置界面 | 24 | `settings_pet_character` → "角色" |
| 关于页面 | 11 | `about_subtitle` → "陪你 AI 编码的移动端伙伴。" |
| 手动连接 | 8 | `manual_host_label` → "桌面端地址" |
| 扫码界面 | 4 | `scan_qr_hint` → "将 QR 码放入框内" |
| 时间格式 | 4 | `time_minutes` → "%d分钟前" |

所有字符串通过 `context.getString(R.string.xxx)` 或 Compose 的 `stringResource(R.string.xxx)` 引用，零硬编码。

### `hasGifForState()` 安全防御性降级链路

不同角色的 GIF 资源覆盖度不同（Clawd 20 个，Calico 12 个，Cloudling 13 个）。当某个角色缺少特定状态的 GIF 时，系统不会静默吞异常，而是通过候选链**安全降级**：

```kotlin
// PetGifLoader — 降级链示例
"yawning" → ["{character}_yawning", "{character}_sleeping", "{character}_idle"]
//           ↑ 优先专属动画     ↑ 降级到 sleeping    ↑ 最终兜底 idle
```

`hasGifForState()` 用于**预检查**——在决定是否播放 sleep/wake 动画前，先确认该角色有专属 GIF：

```kotlin
fun hasGifForState(state: PetState, character: String): Boolean {
    val primaryName = "${character}_${state.themeKey}"
    val id = resIdByName(primaryName)
    return id != null && id != 0
}
```

如果没有专属 GIF，`playWakingAndRestore()` 会跳过唤醒动画直接切到目标状态，避免显示错误的动画。

资源查找使用 `resources.getIdentifier()` 作为主路径，反射 `R.raw::class.java.getField()` 作为兜底：

```kotlin
private fun resIdByName(name: String): Int? {
    val ctx = appContext
    if (ctx != null) {
        val id = ctx.resources.getIdentifier(name, "raw", ctx.packageName)
        if (id != 0) return id
    }
    return try {
        val field = R.raw::class.java.getField(name)
        field.getInt(null)
    } catch (e: Exception) {
        Log.w(TAG, "resIdByName: reflection fallback failed for '$name'", e)
        null  // 规范化 Log.e 打印，不静默吞异常
    }
}
```

---

## 📡 通信协议

### 连接方式

```
SSE 流:    GET  http://<host>:23334/mobile/stream?token=<token>
审批回传:  POST http://<host>:23334/mobile/approve
Deep Link: clawd://<host>:<port>/<token>
```

### SSE 消息类型（服务端 → 客户端）

| type | 说明 | 数据结构 |
|------|------|----------|
| `ping` | 心跳保活 | 无 |
| `connected` | 连接成功确认 | `{ version }` |
| `clear_sessions` | 清空本地会话缓存 | 无 |
| `snapshot` | 全量会话快照 | `{ sessions: Map<id, SessionData> }` |
| `state` | 单会话状态更新 | `{ id, ...SessionData }` |
| `tool_output` | 工具输出片段 | `{ id, output }` |
| `session_deleted` | 会话删除 | `{ id }` |
| `permission_request` | 权限审批请求 | `{ id, tool, input, suggestions, timeout }` |
| `elicitation_request` | 交互式选择请求 | `{ id, message, options }` |

### 审批回传（客户端 → 服务端）

```json
POST /mobile/approve
Content-Type: application/json

{
  "id": "request-id",
  "decision": "allow" | "deny",
  "suggestionIndex": 0
}
```

### Deep Link 格式

```
clawd://<host>:<port>/<token>
```

示例: `clawd://192.168.1.100:23334/abc123def456`

---

## 📂 项目结构

```
android/
├── app/src/main/
│   ├── java/com/clawd/mobile/
│   │   ├── MainActivity.kt              # 入口 Activity + 权限流 + Deep Link
│   │   ├── ClawdApp.kt                  # Application + 通知渠道
│   │   │
│   │   ├── data/                        # 数据层
│   │   │   ├── Session.kt               # SessionData 模型 + 状态优先级 + 事件标签
│   │   │   ├── ConnectionConfig.kt      # 连接配置 + URL 生成 + Deep Link 解析
│   │   │   ├── PrefsStore.kt            # SharedPreferences 封装
│   │   │   └── WsMessage.kt             # SSE 消息信封 + 权限/选择请求模型
│   │   │
│   │   ├── ws/                          # 网络层
│   │   │   ├── ClawdWebSocket.kt        # OkHttp SSE 客户端 + 消息处理 + 重连逻辑
│   │   │   └── ConnectionState.kt       # 连接状态枚举
│   │   │
│   │   ├── service/                     # 服务层
│   │   │   └── WebSocketService.kt      # SSE 前台服务（dataSync 类型）
│   │   │
│   │   ├── overlay/                     # 悬浮宠物层（核心）
│   │   │   ├── PetState.kt              # 16 态密封类 + PC 对齐优先级
│   │   │   ├── PetStateManager.kt       # 状态决策引擎（单管道架构、idle 变体选择器）
│   │   │   ├── FloatingPetService.kt    # 悬浮窗前台服务（纯视图躯壳）
│   │   │   ├── FloatingPetView.kt       # 自定义 ImageView + Matrix 缩放 + Alpha 命中
│   │   │   ├── PetBubbleView.kt         # 信息气泡（纯 View，非 Compose）
│   │   │   └── PetGifLoader.kt          # 状态→GIF 候选链解析引擎（含 hasGifForState 防御）
│   │   │
│   │   ├── notification/                # 通知层
│   │   │   ├── NotificationHelper.kt    # 通知构建器（审批/选择）
│   │   │   ├── StatusNotifier.kt        # 状态变化通知逻辑
│   │   │   ├── NotificationIcons.kt     # 彩色圆点图标生成
│   │   │   └── ApprovalReceiver.kt      # 通知按钮广播接收器
│   │   │
│   │   └── ui/                          # UI 层
│   │       ├── navigation/NavGraph.kt   # NavHost + 服务绑定 + 通知接线
│   │       ├── sessions/SessionsScreen.kt # 主界面 + 审批 BottomSheet + 底部导航
│   │       ├── scan/ScanScreen.kt       # CameraX + ZXing 二维码扫描
│   │       ├── manual/ManualScreen.kt   # 手动连接 + 连接历史
│   │       ├── settings/SettingsScreen.kt # 手风琴式设置页（含尺寸滑块 + 角色选择）
│   │       ├── approval/ApprovalViewModel.kt # 审批请求生命周期管理
│   │       ├── components/ClawdIcons.kt # 25 个自绘矢量图标
│   │       └── theme/                   # Material 3 主题
│   │           ├── Color.kt             # 25+ 颜色常量
│   │           ├── Theme.kt             # 亮/暗主题配置
│   │           └── Type.kt              # 排版定义
│   │
│   ├── res/
│   │   ├── raw/                         # 42 个 GIF 动画资源
│   │   │   ├── clawd_*.gif              # 20 个 Clawd 动画
│   │   │   ├── calico_*.gif             # 12 个 Calico 动画
│   │   │   └── cloudling_*.gif          # 13 个 Cloudling 动画
│   │   ├── mipmap-*/                    # 启动图标（hdpi/mdpi/xhdpi/xxhdpi/xxxhdpi）
│   │   ├── values/strings.xml           # 默认字符串（169 条）
│   │   ├── values-zh/strings.xml        # 中文本地化
│   │   └── xml/network_security_config.xml # 明文流量许可（LAN 通信）
│   │
│   └── AndroidManifest.xml              # 10 权限 + 1 Activity + 2 Service + 1 Receiver
│
├── app/src/test/                        # 单元测试
│   └── data/ConnectionConfigTest.kt     # 5 个 URL 解析/生成测试
│
├── build.gradle.kts                     # 根构建脚本
├── app/build.gradle.kts                 # App 构建脚本
├── gradle/libs.versions.toml            # 版本目录
├── release-keystore.jks                 # 签名密钥
└── README.md                            # 本文件
```

**源文件统计**: 31 个 Kotlin 源文件 + 1 个测试文件，42 个 GIF 资源（含 2 个 idle 变体），169 个字符串资源。

---

## 🔐 权限清单

| 权限 | 用途 | 运行时请求 |
|------|------|:----------:|
| `INTERNET` | LAN 通信 | ❌ |
| `CAMERA` | 二维码扫描 | ✅ |
| `POST_NOTIFICATIONS` | 通知推送（Android 13+） | ✅ |
| `VIBRATE` | 通知振动 | ❌ |
| `WAKE_LOCK` | 保持 CPU 唤醒 | ❌ |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 防止 Doze 杀后台 | ✅ |
| `FOREGROUND_SERVICE` | 前台服务 | ❌ |
| `FOREGROUND_SERVICE_DATA_SYNC` | WebSocketService 类型 | ❌ |
| `FOREGROUND_SERVICE_SPECIAL_USE` | FloatingPetService 类型 | ❌ |
| `SYSTEM_ALERT_WINDOW` | 悬浮窗 | ✅ |

启动时按顺序弹窗请求 4 项运行时权限，每项带说明对话框（Allow / Skip）。

---

## 🔧 开发

### 环境要求

- Android Studio Hedgehog (2023.1.1) 或更高版本
- JDK 17
- Android SDK 35
- arm64-v8a 设备或模拟器

### 构建

```bash
# 构建 debug APK
cd android
./gradlew assembleDebug

# 构建 release APK（需要环境变量）
KEYSTORE_FILE=release-keystore.jks \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# 安装到设备
./gradlew installDebug

# 运行单元测试
./gradlew test
```

### CI/CD

推送到 `main` 分支且修改 `android/` 目录下的文件时，GitHub Actions 自动：

1. 构建 debug + release APK
2. 使用 keystore 签名 release
3. 上传两个 APK 为 artifacts
4. 运行 lint 检查

#### GitHub Secrets

| Secret | 说明 |
|--------|------|
| `KEYSTORE_BASE64` | Keystore 文件的 Base64 编码 |
| `STORE_PASSWORD` | Keystore 密码 |
| `KEY_ALIAS` | Key 别名 |
| `KEY_PASSWORD` | Key 密码 |

---

## 📊 开发时间线

整个 Android 伴侣应用在 **约 72 小时** 内完成（2026-05-29 ~ 2026-06-01），共 50+ 次提交：

| 阶段 | 时间 | 重点 |
|------|------|------|
| **Day 1** | 05-29 | 初始创建：Gradle 脚手架、WebSocket 骨架、SVG 图标、可折叠卡片、审批 UI、通知系统 |
| **Day 2** | 05-30 | UI 重设计、性能优化（ML Kit→ZXing -12MB）、前台服务、SSE 迁移、权限桥接、心跳看门狗、电池优化、12 个 bug 修复 |
| **Day 3** | 05-31 | CI/CD 签名构建、版本号重置（0.1.0）、keystore 修复、README 编写、About 对齐桌面端、状态机重构、sleep 序列、双管道架构、Matrix 缩放重构、全量 i18n |
| **Day 4** | 06-01 | 单管道架构（消灭双管道竞态）、多会话自动 Juggling/Conducting 映射、随机 idle 动画变体、死代码清理（enterIdleCycle / getReadingGifResId） |

### 版本历史

| 版本 | versionCode | 说明 |
|------|-------------|------|
| 1.1.0 ~ 1.5.9 | 2 ~ 38 | 早期开发版本（跟随桌面端版本号） |
| 0.1.0 | 1 | CI/CD 签名构建建立，版本号重置 |
| 0.1.1 | 2 | CI release 测试 |
| 0.1.2 | 3 | keystore 路径修复 |
| 0.1.3 | 4 | keystore 从 rootProject 解析 |
| **0.1.4** | **5** | 状态机重构、sleep 序列、双管道架构、Matrix 无损缩放、全量 i18n |
| **0.1.5** | **6** | **当前版本** — 单管道架构、多会话自动 Juggling/Conducting、随机 idle 变体、死代码清理 |

---

## 📋 已知技术债务

| 级别 | 项 | 说明 |
|------|---|------|
| **S** | ClawdWebSocket.kt | 类名误导（实际是 SSE），协议层与业务逻辑耦合，职责过重 |
| **A** | 零测试覆盖 | 仅 5 个 ConnectionConfig 单元测试，无 UI/集成测试 |
| **A** | 无 Room 数据库 | 全部走 SharedPreferences，会话数据无法持久化查询 |
| **B** | 静态单例模式 | WebSocketService.instance 紧耦合，不利于测试和解耦 |
| **B** | PetStateManager 无接口抽象 | 直接依赖 WebSocketService.getWebSocket()，难以 mock；单管道架构已消除双管道竞态 |

---

## 📄 许可证

- **代码**: [AGPL-3.0](../LICENSE)
- **美术素材**: 版权保留（All Rights Reserved）

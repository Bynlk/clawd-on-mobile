# Clawd Mobile — Android 伴侣应用

[![Android Build](https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml/badge.svg)](https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE)
[![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-green.svg)](https://developer.android.com/about/versions/oreo)
[![API 26+](https://img.shields.io/badge/API-26%2B-brightgreen.svg)](https://developer.android.com/studio/releases/platforms#android-8.0)

> **基于 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 桌面端的社区 Android 移植版。** 原项目由 [@rullerzhou-afk](https://github.com/rullerzhou-afk)（鹿鹿）创建，本 Android 端由 [Bynlk](https://github.com/Bynlk) 开发维护。

通过局域网连接 Clawd on Desk 桌面端，远程监控 AI 编码会话状态，随时审批权限请求，手机变身桌面宠物遥控器。

> **需要配合桌面端使用** — 前往 [Releases](https://github.com/Bynlk/clawd-on-desk/releases) 下载 `app-release.apk`。

---

## 🚀 项目简介

**Clawd Mobile** 是一款基于 **Kotlin 2.1 + Coroutines + WebSocket + WebView SVG + Jetpack Compose** 的原生 Android 客户端。它不是桌面端的"缩小版"，而是桌面端在移动端的**忠实数字分身**——一只住在你手机屏幕上的小螃蟹/三花猫/白云，实时感知 PC 端 AI Agent 的每一个呼吸。

### 三大核心卖点

| 卖点 | 实现机制 | 体感 |
|------|----------|------|
| **毫秒级状态同步** | WebSocket 长连接 + `StateFlow` 响应式管道，PC 端 `displayState` 变化到手机 SVG 切换 < 200ms | 桌面端小螃蟹开始打字，手机上的小螃蟹**同时**开始打字 |
| **纯血角色隔离** | 服务器端 `displayState` + `PetStateManager` 决策引擎，三花猫/白云/黑白猫各自有独立的状态映射 | ≥2 会话时，三花猫变指挥家，黑白猫变杂耍师 |
| **极低功耗挂机** | `WifiLock` + `WakeLock` 双锁保活 + 30s 看门狗 + 指数退避重连（1s→30s），后台运行功耗 < 50mW | 手机放口袋一整天，小螃蟹依然在线 |

### 技术栈速览

| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Kotlin | 2.1.0 |
| UI 框架 | Jetpack Compose + Material 3 | BOM 2024.12.01 |
| 网络 | WebSocket (nv-websocket-client) | 2.14 |
| 序列化 | kotlinx.serialization | 1.7.3 |
| 动画渲染 | WebView + SVG/APNG + CSS 动画 | — |
| 二维码 | CameraX + ZXing | 1.4.1 / 3.5.3 |
| 加密存储 | EncryptedSharedPreferences (AES-256-GCM) | 1.1.0-alpha06 |
| 导航 | Navigation Compose | 2.8.5 |
| 构建 | Gradle + AGP | 8.11.1 / 8.7.3 |
| 最低版本 | Android 8.0（API 26） | — |
| 目标版本 | Android 15（API 35） | — |
| ABI | arm64-v8a | — |
| JVM Target | 17 | — |

---

## 🏛️ 响应式单管道架构

### 从"上帝类"到"大脑-躯壳"分离

早期的 `FloatingPetService` 是一个 800+ 行的"上帝类"：它同时承担了 WebSocket 会话收集、状态优先级计算、sleep 序列管理、badge 转换检测、SVG 加载调度、悬浮窗手势处理、气泡 UI 构建……所有逻辑纠缠在一个 `Service` 里。

重构的核心思想是**将"业务大脑"从"视图躯壳"中剥离**，并通过**单管道（Single-pipe）架构**统一所有状态变更和 SVG 加载指令：

```
┌─────────────────────────────────────────────────────────────────┐
│                        PC 端 Electron                           │
│                (WebSocket push on LAN:23334)                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ WebSocket messages: state / snapshot / badge
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   StreamingClient (nv-websocket-client)          │
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
│  │ 3. checkBadgeTransitions() → 1.5s Happy 插播             │   │
│  │ 4. sleep sequence 管理 → Yawning→Collapsing→Sleeping      │   │
│  │ 5. pickIdleAnimPath() → 随机 idle SVG 动画变体            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  输出: 单管道 (StateCommand)                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ StateFlow<StateCommand>                                    │ │
│  │ ├── StateChanged(state, count) → 持久状态切换              │ │
│  │ ├── SvgLoad(path, force)       → 一次性动画 (idle variant) │ │
│  │ └── ReactionSvg(path)          → 反应动画 (Happy/Waking)   │ │
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
│  │FloatingPetView │  │ PetBubbleView │  │    SvgLoader      │   │
│  │ (WebView SVG)  │  │  (信息气泡)    │  │ (SVG/APNG 解析)   │   │
│  └───────────────┘  └───────────────┘  └───────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 数据流详解

**上行（PC → 手机）**：桌面端通过 WebSocket 推送会话状态，`StreamingClient` 解析后更新 `StateFlow<Map<String, SessionData>>`。零本地推断——所有状态在 PC 端计算完毕，手机端只做消费和视觉映射。

**决策层（大脑）**：`PetStateManager` 订阅 `sessions` Flow，经过管道（过滤→优先级→badge 检测→睡眠管理→idle 变体）输出单条 `StateCommand` 管道：

| 命令类型 | 承载内容 | 生命周期 | 消费方式 |
|----------|----------|----------|----------|
| `StateChanged(state, count)` | **持久状态**：Working、Idle、Sleeping 等 + session 数量 | 持续存在 | `handleCommand()` → `SvgLoader.loadSvg()` |
| `SvgLoad(path, force)` | **一次性动画**：idle 变体（reading/bubble） | 触发一次消费一次 | `handleCommand()` → `SvgLoader.loadSvg()` |
| `ReactionSvg(path)` | **反应动画**：Happy 插播、Waking 动画 | 触发一次消费一次 | `handleCommand()` → `SvgLoader.loadSvg(loop=false)` |

**下行（手机 → 用户）**：`FloatingPetService` 作为纯躯壳，collect 单条 `stateFlow`，按顺序处理每个 `StateCommand`。`SvgLoader` 通过候选链解析 SVG/APNG 资源路径，`FloatingPetView`（WebView）渲染带 CSS 动画的 SVG。

### 单管道架构：为什么合并为一个 `StateFlow`？

早期设计使用双管道（`StateFlow<PetState>` + `Channel<GifLoadEvent>`），存在竞态窗口：两个 collector 并发调用 `loadSvg()` 时会丢失中间帧。

合并为单管道后，所有命令在同一个 collector 中**串行处理**，彻底消除并发 SVG 加载：

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

PC 端的优先级约定是 **`Error=8 > Notification=7 > ... > Sleeping=0`**——数字越大，优先级越高。`PetState` 的 `priority` 字段直接对齐 PC 端：

```kotlin
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
    data object Idle        : PetState(1, "idle")
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

| 状态 | priority | themeKey | 类别 | Oneshot | 说明 |
|------|:--------:|----------|------|:-------:|------|
| `Error` | 8 | `error` | 主动 | ✅ | 会话出错，需要关注 |
| `Notification` | 7 | `notification` | 主动 | ✅ | 新通知到达 |
| `Sweeping` | 6 | `sweeping` | 主动 | ✅ | 清扫/收尾工作 |
| `Attention` | 5 | `attention` | 主动 | ✅ | 需要用户注意（也是 Happy 插播的载体） |
| `Conducting` | 4 | `conducting` | 主动 | ❌ | 多任务指挥（≥2 会话，服务器端映射） |
| `Juggling` | 4 | `juggling` | 主动 | ❌ | 多任务杂耍（≥2 会话，服务器端映射） |
| `Carrying` | 4 | `carrying` | 主动 | ✅ | 搬运/传输中 |
| `Debugger` | 4 | `debugger` | 主动 | ❌ | 调试模式 |
| `Working` | 3 | `working` | 主动 | ❌ | 正常工作中（tier 变体） |
| `Thinking` | 2 | `thinking` | 主动 | ❌ | 思考中 |
| `Idle` | 1 | `idle` | 空闲 | ❌ | 基线空闲状态 |
| `Yawning` | 1 | `yawning` | 睡眠序列 | ❌ | 打哈欠（睡眠第一步） |
| `Dozing` | 1 | `dozing` | 睡眠序列 | ❌ | 打盹（仅 Calico/Cloudling） |
| `Collapsing` | 1 | `collapsing` | 睡眠序列 | ❌ | 倒下（Calico: 5.2s, Cloudling: 4.7s） |
| `Waking` | 1 | `waking` | 睡眠序列 | ❌ | 唤醒动画 |
| `Sleeping` | 0 | `sleeping` | 睡眠序列 | ❌ | 深睡（最低优先级） |

### 多任务场景

当可见会话 ≥ 2 时，**服务器端**自动设置 `displayState` 为 `juggling`（Clawd）或 `conducting`（Calico/Cloudling）。手机端直接消费，无需本地映射。

### SVG 资源解析：`SvgLoader.resolveSvgAsset()`

SVG 解析采用**动态候选链**机制——按优先级尝试多个资源名，第一个存在的生效。支持 Working/Juggling tier（基于 session 数量）：

```kotlin
// Working tier — session 数量决定动画
sessionCount >= 3 → building (多任务建造)
sessionCount >= 2 → headphones-groove / juggling (双任务)
sessionCount >= 1 → typing (单任务)
```

### 各角色 SVG 资源矩阵

| 动画 | Clawd | Calico | Cloudling | 格式 |
|------|:-----:|:------:|:---------:|------|
| idle | ✅ | ✅ | ✅ | SVG |
| idle_look | ✅ | ❌ | ❌ | SVG |
| idle_bubble | ✅ | ❌ | ❌ | SVG |
| idle_reading | ✅ | ❌ | ✅ | SVG |
| typing | ✅ | ✅ | ✅ | SVG/APNG |
| thinking | ✅ | ✅ | ✅ | SVG/APNG |
| building | ✅ | ✅ | ✅ | SVG/APNG |
| juggling | ✅ | ✅ | ✅ | SVG/APNG |
| carrying | ✅ | ✅ | ✅ | SVG/APNG |
| sweeping | ✅ | ✅ | ✅ | SVG/APNG |
| conducting | ✅ | ✅ | ✅ | SVG/APNG |
| notification | ✅ | ✅ | ✅ | SVG/APNG |
| error | ✅ | ✅ | ✅ | SVG/APNG |
| happy | ✅ | ✅ | ✅ | SVG/APNG |
| attention | ❌ | ❌ | ✅ | SVG |
| headphones-groove | ✅ | ❌ | ❌ | SVG |
| debugger | ✅ | ❌ | ❌ | SVG |
| sleeping | ✅ | ✅ | ✅ | SVG/APNG |
| yawning | ✅ | ✅ | ✅ | SVG/APNG |
| dozing | ✅ | ✅ | ✅ | SVG/APNG |
| collapsing | ✅ | ✅ | ✅ | SVG/APNG |
| waking | ✅ | ✅ | ✅ | SVG/APNG |

---

## 💤 灵性视觉控制链

### 独立时序睡眠长蛇阵

睡眠不是简单的 `Idle → Sleeping` 一刀切。它是一条精心编排的**动画序列**，每个角色有不同的时间参数，完全对齐 PC 端的 `theme.json`。深睡期间每 30 秒随机抽取一个 idle SVG 动画变体（reading / bubble / look），让小螃蟹看起来更"活"：

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

**Clawd 的特殊性**：`collapseMs = 0`，Clawd 跳过 Collapsing 阶段，直接从 Yawning 进入 Sleeping——因为 Clawd 的 `yawning` SVG 本身已经包含了"倒下"的动画。

### 异步防诈尸唤醒守卫（`gifGeneration`）

当小螃蟹处于深睡状态时，一个新会话的到来会触发唤醒序列。`gifGeneration` 世代守卫确保只有**最后一次**反应的恢复回调会生效：

```kotlin
private fun playWakingAndRestore(targetState: PetState, scope: CoroutineScope) {
    cancelSleepSequence()
    val gen = gifGeneration.incrementAndGet()  // ← 世代号 +1
    if (SvgLoader.hasSvgForState(PetState.Waking, character)) {
        emitState(PetState.Waking)
        scope.launch {
            delay(sleepConfig.wakeMs)
            if (gifGeneration.get() != gen) return@launch  // ← 世代不匹配，放弃
            emitState(targetState)
        }
    } else {
        emitState(targetState)  // 无 waking SVG，直接切
    }
}
```

### 1.5s Happy 插播

当 session 的 badge 从 `running` 变为 `done` 时，系统会播放一个 1.5s 的 Happy 庆祝动画。`gifGeneration` 代际防覆盖保证快速连续完成时只有最后一次恢复生效。

---

## 🎨 WebView SVG 渲染

### 为什么用 WebView 而不是 ImageView？

早期使用 Glide + ImageView + Matrix 缩放渲染 GIF。迁移到 SVG + WebView 的原因：

| 维度 | GIF + ImageView | SVG + WebView |
|------|----------------|---------------|
| 动画保真度 | 逐帧 GIF，CSS 动画丢失 | CSS breathe/blink/tail-sway 完整保留 |
| 包体积 | ~8MB GIF 资源 | ~2MB SVG 资源（-75%） |
| 内存占用 | 每帧解码 Bitmap | 矢量渲染，内存恒定 |
| 缩放质量 | 位图缩放模糊 | 矢量无限缩放，始终清晰 |

### 渲染架构

```
SvgLoader.loadSvg()
    ↓
HTML 模板 (svg_template.html / apng_template.html)
    ↓ 替换 {{URL}} / {{LOOP_STYLE}} / {{ANIM_END_SCRIPT}}
WebView.loadDataWithBaseURL("https://appassets.androidplatform.net/")
    ↓
WebViewAssetLoader 拦截 → assets/svg/ 文件
    ↓
CSS 动画渲染 (breathe, blink, tail-sway, etc.)
```

- `FloatingPetView` 是自定义 `WebView` 子类
- 通过 `WebViewAssetLoader` 将 `assets/svg/` 映射为 HTTPS URL
- 像素级透明点击穿透：JS canvas 采样 + bitmap 命中测试
- SVG 视觉边距通过 JS bridge 回调

---

## 📡 通信协议

### 连接方式

```
WebSocket:  ws://<host>:23334/mobile/ws
审批回传:   POST http://<host>:23334/mobile/approve
Deep Link:  clawd://<host>:<port>/<token>
```

> Token 通过 `Authorization: Bearer <token>` header 传输。

### WebSocket 消息类型（服务端 → 客户端）

| type | 说明 |
|------|------|
| `ping` | 心跳保活 |
| `connected` | 连接成功确认 |
| `clear_sessions` | 清空本地会话缓存 |
| `snapshot` | 全量会话快照 |
| `state` | 单会话状态更新 |
| `tool_output` | 工具输出片段 |
| `session_deleted` | 会话删除 |
| `permission_request` | 权限/交互式审批请求 |

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
│   │   │   ├── Session.kt               # SessionData 模型
│   │   │   ├── ConnectionConfig.kt      # 连接配置 + URL 生成 + Deep Link 解析
│   │   │   ├── PrefsStore.kt            # EncryptedSharedPreferences 封装
│   │   │   └── WsMessage.kt             # WebSocket 消息信封 + 权限请求模型
│   │   │
│   │   ├── ws/                          # 网络层
│   │   │   ├── StreamingClient.kt       # 接口定义
│   │   │   ├── AbstractStreamingClient.kt # 共享实现
│   │   │   ├── WsClient.kt             # nv-websocket-client 实现
│   │   │   ├── MessageParser.kt         # 消息解析器
│   │   │   ├── MessageHandler.kt        # 消息处理器
│   │   │   ├── ParsedMessage.kt         # 解析后的消息类型
│   │   │   └── ConnectionState.kt       # 连接状态枚举
│   │   │
│   │   ├── service/                     # 服务层
│   │   │   └── WsConnectionService.kt   # WebSocket 前台服务（dataSync 类型）
│   │   │
│   │   ├── overlay/                     # 悬浮宠物层（核心）
│   │   │   ├── PetState.kt              # 16 态密封类 + PC 对齐优先级
│   │   │   ├── PetStateManager.kt       # 状态决策引擎（单管道架构）
│   │   │   ├── FloatingPetService.kt    # 悬浮窗前台服务（纯视图躯壳）
│   │   │   ├── FloatingPetView.kt       # WebView 子类 + SVG 渲染 + 透明穿透
│   │   │   ├── PetWindowController.kt   # 窗口创建/尺寸/边缘吸附/位置持久化
│   │   │   ├── PetGestureHandler.kt     # 手势处理（拖拽/单击/双击）
│   │   │   ├── PetBubbleManager.kt      # 信息气泡生命周期管理
│   │   │   ├── PetBubbleView.kt         # 信息气泡 View
│   │   │   └── SvgLoader.kt             # SVG/APNG 资源解析 + WebView 加载
│   │   │
│   │   ├── notification/                # 通知层
│   │   │   ├── NotificationHelper.kt    # 通知构建器
│   │   │   ├── StatusNotifier.kt        # 状态变化通知逻辑
│   │   │   ├── NotificationIcons.kt     # 彩色圆点图标生成
│   │   │   └── ApprovalReceiver.kt      # 通知按钮广播接收器
│   │   │
│   │   ├── util/                        # 工具层
│   │   │   ├── HttpClientProvider.kt    # OkHttpClient 单例 + 证书固定
│   │   │   └── SafeExecutor.kt          # 统一异常处理（3 级 severity）
│   │   │
│   │   └── ui/                          # UI 层
│   │       ├── navigation/NavGraph.kt   # NavHost + 服务绑定 + 通知接线
│   │       ├── sessions/                # 主界面（6 文件）
│   │       ├── scan/ScanScreen.kt       # CameraX + ZXing 二维码扫描
│   │       ├── manual/ManualScreen.kt   # 手动连接 + 连接历史
│   │       ├── settings/SettingsScreen.kt # 设置页
│   │       ├── approval/ApprovalViewModel.kt # 审批请求生命周期管理
│   │       ├── components/              # 共享组件
│   │       │   ├── ClawdIcons.kt        # 24 个自绘矢量图标
│   │       │   └── PermissionDialog.kt  # 权限请求对话框
│   │       └── theme/                   # Material 3 主题
│   │
│   ├── assets/
│   │   ├── svg/                         # SVG/APNG 动画资源
│   │   │   ├── clawd/                   # Clawd 动画（30+ 文件）
│   │   │   ├── calico/                  # Calico 动画（20+ 文件）
│   │   │   └── cloudling/               # Cloudling 动画（20+ 文件）
│   │   └── html/                        # WebView HTML 模板
│   │       ├── svg_template.html
│   │       └── apng_template.html
│   │
│   ├── res/
│   │   ├── values/strings.xml           # 默认字符串
│   │   ├── values-zh/strings.xml        # 中文本地化
│   │   └── xml/network_security_config.xml
│   │
│   └── AndroidManifest.xml
│
├── app/src/test/                        # 单元测试（10 文件，197 测试）
│   ├── data/
│   │   ├── ConnectionConfigTest.kt      # URL 解析、host 校验、LAN 检测
│   │   └── SessionTest.kt               # 数据模型
│   ├── overlay/
│   │   ├── PetStateManagerLogicTest.kt  # 状态机逻辑
│   │   ├── PetStateTest.kt              # 状态密封类
│   │   ├── SvgLoaderLookupTest.kt       # SVG 资源解析
│   │   └── SvgLoaderTest.kt             # SVG 加载器
│   ├── util/
│   │   ├── HttpClientProviderTest.kt    # HTTP 客户端
│   │   └── SafeExecutorTest.kt          # 异常处理
│   └── ws/
│       ├── MessageParserTest.kt         # 消息解析器测试
│       ├── MessageParserExtendedTest.kt # 扩展解析测试
│       ├── WsClientTest.kt             # WebSocket 客户端测试
│       └── ConnectionStateTest.kt       # 连接状态枚举
│
├── build.gradle.kts
├── app/build.gradle.kts
├── gradle/libs.versions.toml
└── README.md
```

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
cd android

# 构建 debug APK
./gradlew assembleDebug

# 构建 release APK（需要环境变量）
KEYSTORE_FILE=release-keystore.jks \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# 安装到设备
./gradlew installDebug

# 运行单元测试（197 tests）
./gradlew test
```

### CI/CD

推送到 `main` 分支且修改 `android/` 目录下的文件时，GitHub Actions 自动构建 debug + release APK 并上传为 artifacts。

---

## 📋 已知技术债务与改进计划

详细的系统性评估和修复计划见 **[docs/plans/INDEX.md](docs/plans/INDEX.md)**（14 个计划，21 工时）。

| 级别 | 项 | 说明 |
|------|---|------|
| ~~**S**~~ | ~~ClawdWebSocket.kt 命名误导~~ | ✅ 已迁移到 WebSocket + 重命名为 StreamingClient |
| **A** | 安全: Token URL 泄露 | streamUrl 中 token 应移至 header only |
| **A** | 安全: 非 LAN 无 TOFU pinning | 首次远程连接无证书固定，存在 MITM 风险 |
| **A** | ApprovalReceiver 协程泄漏 | goAsync() + 裸协程，应迁移到 WorkManager |
| **B** | PetStateManager 静态耦合 | 直接访问 WebSocketService.getWebSocket()，应改为注入 |
| **B** | consumedDoneSessions 无清理 | 长时间运行后内存无限增长 |
| **C** | SvgLoader 线程安全 | LinkedHashSet 非线程安全，应改为 ConcurrentHashMap |

---

## 📄 许可证

- **代码**: [AGPL-3.0](../LICENSE)
- **美术素材**: 版权保留（All Rights Reserved）

**Clawd** 角色是 [Anthropic](https://www.anthropic.com) 的财产。这是一个非官方的粉丝项目，与 Anthropic 无关，也未获得 Anthropic 的认可。

Android 端基于 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 桌面端开发，原项目由 [@rullerzhou-afk](https://github.com/rullerzhou-afk)（鹿鹿）创建。

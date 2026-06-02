# P3 架构演进计划

> 阶段：长期
> 前置依赖：P0、P1、P2 全部完成
> 关联问题：M-03、M-04、M-05、M-06、M-10、M-11、M-14、C-01（完整修复）、L-12
> 预计工作量：20-30 天

---

## 概述

本阶段是架构级重构，涉及模块拆分、依赖注入引入、渲染方案升级等。按依赖关系和风险等级分为 4 个阶段执行，每个阶段内可并行。

---

## 执行顺序总览

```
阶段 1：低风险 UI 拆分（可立即开始，无依赖）
  ├── P3-5  MainActivity 权限流程拆分          [M] [低风险]
  └── P3-6  SettingsScreen Section 拆分        [M] [低风险]

阶段 2：核心拆分（架构基础）
  ├── P3-1  ClawdWebSocket 拆分为 3 个类       [L] [中风险]
  └── P3-2  重命名 → ClawdSseClient            [S] [低风险]  ← P3-1 完成后

阶段 3：依赖注入 + 接口解耦（需充分测试）
  ├── P3-3  引入 Koin 依赖注入                 [L] [高风险]
  ├── P3-4  SessionProvider 接口解耦            [M] [中风险]  ← P3-1 完成后
  └── P3-9  WebSocketService 改用 bindService   [L] [高风险]  ← P3-3 完成后

阶段 4：高风险特性（需桌面端配合或影响渲染）
  ├── P3-7  LAN HTTPS 自签证书支持             [L] [高风险]
  └── P3-8  WebView 渲染优化                   [L] [高风险]
```

---

## 任务清单（按执行顺序）

| # | 任务 | 关联 | 文件 | 工作量 | 风险 | 前置 |
|---|------|------|------|--------|------|------|
| P3-5 | MainActivity 权限流程拆分 | M-05 | `MainActivity.kt` | M | 低 | 无 |
| P3-6 | SettingsScreen Section 拆分 | M-06 | `ui/settings/` | M | 低 | 无 |
| P3-1 | ClawdWebSocket 拆分 | M-10 | `ws/` | L | 中 | 无 |
| P3-2 | 重命名 ClawdWebSocket → ClawdSseClient | M-04 | 全局 | S | 低 | P3-1 |
| P3-3 | 引入依赖注入（Koin） | M-03 | 全局 | L | 高 | P3-1 |
| P3-4 | SessionProvider 接口解耦 | M-11 | `ws/`、`overlay/` | M | 中 | P3-1 |
| P3-9 | WebSocketService 改用 bindService | L-12 | `WebSocketService.kt`、`NavGraph.kt` | L | 高 | P3-3 |
| P3-7 | LAN HTTPS 自签证书支持 | C-01 | `ConnectionConfig.kt`、`ClawdWebSocket.kt` | L | 高 | P3-1 |
| P3-8 | WebView 渲染优化 | M-14 | `overlay/` | L | 高 | 无 |

---

## 阶段 1：低风险 UI 拆分

> 可立即开始，无前置依赖，不涉及架构变更。完成即可独立 commit。

### P3-5：MainActivity 权限流程拆分

**问题**：`MainActivity.kt`（195 行）包含权限请求链 + 内容设置 + intent 处理。

**拆分方案**：

```
ui/
├── permission/
│   └── PermissionFlow.kt      # 权限请求链逻辑
└── MainActivity.kt            # 精简为入口
```

#### PermissionFlow.kt

```kotlin
class PermissionFlow(
    private val activity: ComponentActivity,
    private val onAllDone: () -> Unit
) {
    private val permissionQueue = mutableListOf<PermissionRequest>()
    private var currentIndex = 0

    private val permissionLauncher = activity.registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        currentIndex++
        showNext()
    }

    fun start() {
        buildQueue()
        if (permissionQueue.isNotEmpty()) showCurrent()
        else onAllDone()
    }

    private fun buildQueue() { ... }
    private fun showCurrent() { ... }
    private fun showNext() { ... }
}
```

#### MainActivity.kt（精简后）

```kotlin
class MainActivity : ComponentActivity() {
    private lateinit var permissionFlow: PermissionFlow

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleApprovalIntent(intent)

        permissionFlow = PermissionFlow(this) {
            checkAndRequestBatteryOptimization()
        }
        permissionFlow.start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleApprovalIntent(intent)
    }

    private fun handleApprovalIntent(intent: Intent?) { ... }
    private fun checkAndRequestBatteryOptimization() { ... }
    private fun checkOverlayPermission() { ... }
    private fun setupContent() { ... }
}
```

**验证**：
- 首次安装权限弹窗正常
- 跳过权限后继续正常
- deep link 处理正常

---

### P3-6：SettingsScreen Section 拆分

**问题**：`SettingsScreen.kt`（648 行）5 个 section 内联。

**拆分方案**：

```
ui/settings/
├── SettingsScreen.kt              # 主框架 + TopBar
├── sections/
│   ├── ConnectionInfoSection.kt   # 连接信息卡片
│   ├── ScanSection.kt             # 扫码连接
│   ├── ManualSection.kt           # 手动连接
│   ├── NotificationSection.kt     # 通知设置
│   ├── FloatingPetSection.kt      # 悬浮窗设置
│   └── AboutSection.kt            # 关于
└── components/
    └── AccordionSection.kt        # 可复用的折叠面板组件
```

每个 Section 文件约 80-120 行，独立可测试。

**验证**：
- Settings 页面所有 section 功能正常
- 折叠/展开动画正常

---

## 阶段 2：核心拆分

> 架构基础。P3-1 是后续 P3-2/3/4/7 的前置依赖，需确保每步编译通过 + 功能正常。

### P3-1：ClawdWebSocket 拆分

**问题**：`ClawdWebSocket`（429 行）承担 6 项职责，是最大的 SRP 违反者。

**目标架构**：

```
ws/
├── ClawdSseClient.kt         # SSE 连接管理（connect/disconnect/reconnect）
├── MessageParser.kt           # JSON 消息解析（handleMessage 逻辑）
├── ApprovalSender.kt          # 审批 HTTP POST（sendPermissionResponse/sendElicitationResponse）
└── ConnectionState.kt         # 不变
```

#### ClawdSseClient（SSE 连接管理）

```kotlin
class ClawdSseClient(
    private val prefsStore: PrefsStore,
    private val parser: MessageParser,
    private val approvalSender: ApprovalSender
) {
    // 连接状态
    val connectionState: StateFlow<ConnectionState>
    // 会话数据（由 parser 更新）
    val sessions: StateFlow<Map<String, SessionData>>
    val syncing: StateFlow<Boolean>
    val displayState: StateFlow<String>

    fun connect(config: ConnectionConfig)
    fun reconnect()
    fun disconnect()
    fun destroy()

    // SSE 回调 → 委托给 parser
    private fun onEvent(data: String) { parser.handleMessage(data) }
}
```

#### MessageParser（消息解析）

```kotlin
class MessageParser {
    // 解析后的数据流
    val sessions: MutableStateFlow<Map<String, SessionData>>
    val permissionRequests: MutableSharedFlow<PermissionRequestData>
    val messages: MutableSharedFlow<WsMessage>
    val syncing: MutableStateFlow<Boolean>
    val displayState: MutableStateFlow<String>

    fun handleMessage(rawText: String) {
        val obj = json.decodeFromString<JsonObject>(rawText)
        when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "ping" -> return
            "snapshot" -> handleSnapshot(obj)
            "state" -> handleState(obj)
            "tool_output" -> handleToolOutput(obj)
            "session_deleted" -> handleSessionDeleted(obj)
            "permission_request" -> handlePermissionRequest(obj)
            // ...
        }
    }

    private fun handleSnapshot(obj: JsonObject) { ... }
    private fun handleState(obj: JsonObject) { ... }
    // ... 每个 handler 约 20-30 行
}
```

#### ApprovalSender（审批发送）

```kotlin
class ApprovalSender(
    private val prefsStore: PrefsStore,
    private val clientProvider: HttpClientProvider
) {
    fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int? = null) { ... }
    fun sendElicitationResponse(requestId: String, toolInput: JsonElement?, answers: Map<String, String>) { ... }
    private fun buildToolInputSummary(toolName: String?, toolInput: JsonObject?): String? { ... }
}
```

**迁移策略**：
1. 先创建 `MessageParser` 和 `ApprovalSender`，从 `ClawdWebSocket` 中提取方法
2. `ClawdWebSocket` 改为委托模式（内部持有 parser 和 sender）
3. 确认功能正常后，将 `ClawdWebSocket` 重命名为 `ClawdSseClient`
4. 每步都保持编译通过 + 功能正常

**验证**：
- 连接、断开、重连正常
- 消息解析无变化
- 审批请求发送正常
- 所有测试通过

---

### P3-2：重命名 ClawdWebSocket → ClawdSseClient

**问题**：类名暗示 WebSocket，实际用 SSE。

**前置**：P3-1 完成后执行。

**涉及文件**：
- `ws/ClawdWebSocket.kt` → `ws/ClawdSseClient.kt`
- `service/WebSocketService.kt`（引用）
- `overlay/PetStateManager.kt`（引用）
- `overlay/PetBubbleManager.kt`（引用）
- `ui/approval/ApprovalViewModel.kt`（引用）
- `ui/navigation/NavGraph.kt`（引用）
- `ui/sessions/SessionsScreen.kt`（引用）
- `ui/settings/SettingsScreen.kt`（引用）

**验证**：
- 全局搜索无残留的 `ClawdWebSocket` 引用
- 编译通过

---

## 阶段 3：依赖注入 + 接口解耦

> 需充分测试。P3-3 是高风险改动，建议在独立分支进行，每步 commit。

### P3-3：引入依赖注入（Koin）

**问题**：全局静态访问 + 手动构造依赖链，可测试性差。

**选择 Koin 而非 Hilt 的理由**：
- Koin 轻量，无编译时注解处理，构建速度快
- 纯 Kotlin DSL，与 Compose 集成好
- 学习成本低

**模块定义**：

```kotlin
// di/AppModule.kt
val appModule = module {
    single { PrefsStore(get()) }
    single { HttpClientProvider }
    single { MessageParser() }
    single { ApprovalSender(get(), get()) }
    single { ClawdSseClient(get(), get(), get()) }

    viewModel { ApprovalViewModel(get(), get()) }
}

// di/ServiceModule.kt
val serviceModule = module {
    single { PetStateManager(get()) }
}
```

**Application 初始化**：
```kotlin
class ClawdApp : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin {
            androidContext(this@ClawdApp)
            modules(appModule, serviceModule)
        }
        // ...
    }
}
```

**注入点改造**：
```kotlin
// NavGraph.kt — 之前
val prefsStore = remember { PrefsStore(context) }
val ws = webSocket ?: return
val approvalViewModel: ApprovalViewModel = viewModel(factory = ApprovalViewModel.Factory(...))

// NavGraph.kt — 之后
val prefsStore = koinInject<PrefsStore>()
val ws = koinInject<ClawdSseClient>()
val approvalViewModel: ApprovalViewModel = koinViewModel()
```

**验证**：
- 所有页面正常渲染
- Service 正常启动
- 审批流程正常

---

### P3-4：SessionProvider 接口解耦

**问题**：`PetStateManager`、`PetBubbleManager`、`NavGraph` 全部通过 `WebSocketService.getWebSocket()` 静态耦合。

**接口定义**：
```kotlin
// ws/SessionProvider.kt
interface SessionProvider {
    val sessions: StateFlow<Map<String, SessionData>>
    val connectionState: StateFlow<ConnectionState>
    val displayState: StateFlow<String>
    val syncing: StateFlow<Boolean>
}
```

**ClawdSseClient 实现接口**：
```kotlin
class ClawdSseClient(...) : SessionProvider {
    override val sessions: StateFlow<Map<String, SessionData>> = _sessions
    override val connectionState: StateFlow<ConnectionState> = _connectionState
    // ...
}
```

**PetStateManager 依赖注入**：
```kotlin
class PetStateManager(
    var character: String,
    private val sessionProvider: SessionProvider  // 新增
) {
    // 移除 waitForWebSocket() 轮询
    fun start(scope: CoroutineScope) {
        wsCollectorJob = scope.launch {
            sessionProvider.sessions.collect { sessions ->
                updateSessions(sessions, scope)
            }
        }
    }
}
```

**PetBubbleManager 同理**：
```kotlin
class PetBubbleManager(
    private val context: Context,
    private val windowManager: WindowManager,
    private val scope: CoroutineScope,
    private val sessionProvider: SessionProvider,  // 新增
    private val onEnterApp: () -> Unit
)
```

**验证**：
- 悬浮窗状态与桌面端同步
- 气泡显示正确
- 所有测试通过

---

### P3-9：WebSocketService 改用 bindService

**问题**：静态单例 `instance` 无同步保护，Service 被杀后可能指向已销毁实例。

**前置**：P3-3（Koin）完成。

**方案**：

```kotlin
// WebSocketService.kt
class WebSocketService : Service() {
    private val binder = LocalBinder()

    inner class LocalBinder : Binder() {
        fun getService(): WebSocketService = this@WebSocketService
        fun getWebSocket(): ClawdSseClient? = webSocket
    }

    override fun onBind(intent: Intent): IBinder = binder

    // 移除 companion object 中的 instance
    companion object {
        const val ACTION_CONNECT = "com.clawd.mobile.CONNECT"
        const val ACTION_DISCONNECT = "com.clawd.mobile.DISCONNECT"
        // start/stop 保留为静态方法
    }
}
```

```kotlin
// NavGraph.kt
val serviceConnection = remember {
    object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val binder = service as WebSocketService.LocalBinder
            webSocket = binder.getWebSocket()
        }
        override fun onServiceDisconnected(name: ComponentName) {
            webSocket = null
        }
    }
}

LaunchedEffect(Unit) {
    context.bindService(
        Intent(context, WebSocketService::class.java),
        serviceConnection,
        Context.BIND_AUTO_CREATE
    )
}
```

**验证**：
- Service 被杀后 UI 自动感知（onServiceDisconnected）
- 无内存泄漏（onDestroy 中 unbindService）

---

## 阶段 4：高风险特性

> 需桌面端配合或影响渲染。建议在阶段 1-3 全部完成后单独推进。

### P3-7：LAN HTTPS 自签证书支持

**问题**：LAN 连接使用 HTTP 明文，token 暴露风险。

**方案**：

1. **桌面端**：生成自签证书，HTTPS 监听
2. **移动端**：连接时获取证书指纹，用户确认后保存

```kotlin
// ConnectionConfig.kt
@Serializable
data class ConnectionConfig(
    val host: String,
    val port: Int,
    val token: String,
    val certFingerprint: String? = null  // 新增：SHA-256 指纹
) {
    fun streamUrl(): String {
        // 有证书指纹时强制 HTTPS，否则按 isLan 判断
        val scheme = if (certFingerprint != null || !isLan) "https" else "http"
        return "$scheme://$host:$port/mobile/stream"
    }
}
```

```kotlin
// HttpClientProvider.kt
fun getSseClient(config: ConnectionConfig): OkHttpClient {
    val builder = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)

    if (config.certFingerprint != null) {
        val pinner = CertificatePinner.Builder()
            .add(config.host, "sha256/${config.certFingerprint}")
            .build()
        builder.certificatePinner(pinner)
    }

    return builder.build()
}
```

**连接流程**：
1. 扫码/手动输入 → 获得 host:port/token
2. 尝试 HTTPS 连接 → 获取证书指纹
3. 弹窗显示指纹，用户确认
4. 保存指纹到 ConnectionConfig
5. 后续连接使用证书固定

**验证**：
- LAN HTTPS 连接正常
- 证书不匹配时连接被拒绝
- 用户可查看/删除已保存的指纹

---

### P3-8：WebView 渲染优化

**问题**：WebView + SVG 渲染内存开销大，LAYER_TYPE_SOFTWARE CPU 占用高。

**方案评估**：

| 方案 | 优点 | 缺点 | 适用性 |
|------|------|------|--------|
| **Lottie** | 内存小、性能好 | 需要将 SVG 转换为 JSON，CSS 动画需重写 | 中等（需工具链支持） |
| **androidsvg** | 原生渲染、内存小 | 不支持 CSS 动画（breathe/blink/tail-sway） | 不适用 |
| **优化 WebView** | 无迁移成本 | 改善有限 | 短期可行 |

**推荐分步走**：

#### 短期（P3-8a）：优化当前 WebView

```kotlin
// FloatingPetView.kt
init {
    settings.apply {
        // 尝试硬件渲染
        setLayerType(LAYER_TYPE_HARDWARE, null)  // 之前是 SOFTWARE
        // 预加载常用 SVG
        cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
    }
}
```

```kotlin
// SvgLoader.kt — 复用 WebView 内容
fun loadSvg(webView: WebView, assetPath: String, ...) {
    if (assetPath == webView.currentAssetPath) return  // 已加载，跳过
    // ...
}
```

#### 长期（P3-8b）：评估 Lottie 迁移

1. 用 `svg2lottie` 工具将 SVG 转换为 Lottie JSON
2. 评估 CSS 动画（breathe/blink/tail-sway）是否可保留
3. 如果可行，逐步迁移高频状态（idle/working/thinking）
4. 保留 WebView 作为 fallback

**验证**：
- 内存占用降低 > 30%
- CPU 占用降低 > 20%
- 动画流畅度不变

---

## 依赖关系图

```
阶段 1（无依赖，可立即开始）
  P3-5  MainActivity 拆分 ──────────────────────┐
  P3-6  SettingsScreen 拆分 ────────────────────┤
                                                │
阶段 2（核心拆分）                                │
  P3-1  ClawdWebSocket 拆分 ───────────────────┐│
    ├── P3-2  重命名 → ClawdSseClient          ││
    ├── P3-3  Koin DI ─────────────────────┐   ││
    │     └── P3-9  bindService            │   ││
    ├── P3-4  SessionProvider 接口解耦      │   ││
    └── P3-7  LAN HTTPS                    │   ││
                                           │   ││
阶段 3（DI + 解耦）                          │   ││
  P3-3  ───────────────────────────────────┘   ││
  P3-4  ──────────────────────────────────────┘│
  P3-9  ───────────────────────────────────────┘
                                                │
阶段 4（高风险，独立推进）                        │
  P3-7  LAN HTTPS（需桌面端配合）                 │
  P3-8  WebView 渲染优化（独立，无依赖）──────────┘
```

---

## 验收标准

- [ ] ClawdWebSocket 拆分为 3 个类，每个 < 200 行
- [ ] 类名 ClawdSseClient 全局替换
- [ ] Koin 依赖注入框架工作正常
- [ ] SessionProvider 接口解耦静态依赖链
- [ ] MainActivity < 100 行，权限逻辑独立
- [ ] SettingsScreen 每个 Section 独立文件
- [ ] LAN 支持 HTTPS 自签证书
- [ ] WebView 内存/CPU 占用优化
- [ ] WebSocketService 使用 bindService 模式
- [ ] 所有测试通过
- [ ] 全功能回归验证

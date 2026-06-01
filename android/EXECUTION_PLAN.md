# Clawd Android 端修复执行方案

> 基于 `AUDIT_REPORT.md` 评估结果的分阶段修复计划
> 创建日期：2026-06-01

---

## 〇、执行总览

| Phase | 主题 | 工作量 | 优先级 | 依赖 |
|-------|------|--------|--------|------|
| **Phase 1** | 安全加固 | 1 天 | 🔴 最高 | 无 |
| **Phase 2** | 线程安全 | 1-2 天 | 🔴 高 | 无 |
| **Phase 3** | 代码清理 | 0.5 天 | 🟡 中 | 无 |
| **Phase 4** | 结构优化 | 2-3 天 | 🟢 低 | Phase 1-3 |
| **Phase 5** | 测试覆盖 | 3 天 | 🟢 长期 | Phase 3-4 |

---

## Phase 1 — 安全加固（1 天）

### T1.1 证书锁定修复

**文件**: `ws/ClawdWebSocket.kt`

**当前问题**: 第 44 行使用占位符指纹 `sha256/AAA...`，假锁定比没有更危险。

**方案**: 移除占位符，改为运行时日志警告。证书指纹需要从实际部署的服务器获取，不适合硬编码。

```kotlin
// ws/ClawdWebSocket.kt — 修改 client getter
private val client: OkHttpClient
    get() {
        val cfg = config
        if (_client == null || cfg != _clientConfig) {
            val builder = OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
            // 非局域网连接：启用证书锁定（需要实际指纹）
            if (cfg != null && !cfg.isLan) {
                val pinned = cfg.certFingerprint  // 新增字段，从设置读取
                if (pinned != null) {
                    builder.certificatePinner(
                        CertificatePinner.Builder()
                            .add(cfg.host, pinned)
                            .build()
                    )
                } else {
                    Log.w(TAG, "Non-LAN connection without certificate pinning — consider adding cert fingerprint in settings")
                }
            }
            _client = builder.build()
            _clientConfig = cfg
        }
        return _client!!
    }
```

**替代方案（最小改动）**: 如果不打算支持自定义指纹，直接删除假锁定代码：

```kotlin
// 删除以下代码块
if (cfg != null && !cfg.isLan) {
    builder.certificatePinner(
        CertificatePinner.Builder()
            .add(cfg.host, "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
            .build()
    )
}
```

**工作量**: 0.5h
**风险**: 极低。移除假锁定不改变实际安全级别。

---

### T1.2 ApprovalReceiver 共享 OkHttpClient + 证书锁定

**文件**: `notification/ApprovalReceiver.kt`

**当前问题**: 每次广播新建 OkHttpClient，无 CertificatePinner。

**方案**: 提取共享 OkHttpClient 到 `ClawdApp` 或新建 `HttpClientProvider` 单例。

```kotlin
// util/HttpClientProvider.kt（新建）
package com.clawd.mobile.util

import com.clawd.mobile.data.ConnectionConfig
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object HttpClientProvider {
    private var _client: OkHttpClient? = null
    private var _config: ConnectionConfig? = null

    fun getClient(config: ConnectionConfig): OkHttpClient {
        if (_client == null || config != _config) {
            val builder = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .writeTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
            // 非局域网：证书锁定（与 ClawdWebSocket 保持一致）
            if (!config.isLan) {
                val pinned = config.certFingerprint
                if (pinned != null) {
                    builder.certificatePinner(
                        CertificatePinner.Builder()
                            .add(config.host, pinned)
                            .build()
                    )
                }
            }
            _client = builder.build()
            _config = config
        }
        return _client!!
    }

    fun reset() {
        _client = null
        _config = null
    }
}
```

**修改 `ApprovalReceiver.kt`**:

```kotlin
// 替换 Thread { OkHttpClient.Builder()... } 块
Thread {
    SafeExecutor.tryOrLog("ApprovalReceiver") {
        val body = buildJsonObject {
            put("id", requestId)
            put("decision", decision)
        }.toString()
        val client = HttpClientProvider.getClient(config)
        val request = Request.Builder()
            .url(config.approveUrl())
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) {
            Log.w("ApprovalReceiver", "Approval response: ${response.code}")
        }
        response.close()
    }
}.start()
```

**同步修改 `ClawdWebSocket.kt`**: 将 `client` getter 改为使用 `HttpClientProvider.getClient(config)`。

**工作量**: 1h
**风险**: 低。OkHttpClient 实例共享是 OkHttp 官方推荐做法。

---

### T1.3 Token 日志脱敏

**文件**: `ws/ClawdWebSocket.kt`, `data/ConnectionConfig.kt`

**当前问题**: `Log.d("ClawdWebSocket", "doConnect → $url")` 输出完整 URL 含 token。

**方案**: `ConnectionConfig` 新增脱敏 URL 方法，日志统一使用脱敏版本。

```kotlin
// data/ConnectionConfig.kt — 新增
fun streamUrlMasked(): String {
    val scheme = if (isLan) "http" else "https"
    val masked = if (token.length > 8) token.take(4) + "****" + token.takeLast(4) else "****"
    return "$scheme://$host:$port/mobile/stream?token=$masked"
}
```

**修改 `ClawdWebSocket.kt`**:

```kotlin
// 第 122 行
Log.d("ClawdWebSocket", "doConnect → ${cfg.streamUrlMasked()}")
```

**工作量**: 0.5h
**风险**: 无。

---

### T1.4 ManualScreen Token 遮罩

**文件**: `ui/manual/ManualScreen.kt`

**当前问题**: Token 输入框明文显示。

**方案**: 添加 `PasswordVisualTransformation` 和切换按钮。

```kotlin
// ui/manual/ManualScreen.kt — 第 69 行附近
var tokenVisible by remember { mutableStateOf(false) }

OutlinedTextField(
    value = token,
    onValueChange = { token = it },
    label = { Text(stringResource(R.string.manual_token_label)) },  // 同时修复硬编码
    visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
    trailingIcon = {
        IconButton(onClick = { tokenVisible = !tokenVisible }) {
            Icon(
                if (tokenVisible) ClawdIcons.EyeOff else ClawdIcons.Eye,
                contentDescription = null
            )
        }
    },
    // ... 其余不变
)
```

**需要新增**: `ClawdIcons.Eye` 和 `ClawdIcons.EyeOff` 图标（或使用 Material 默认图标）。

**工作量**: 10min
**风险**: 无。

---

## Phase 2 — 线程安全（1-2 天）

### T2.1 MainActivity 全局状态 → Application-scoped SharedFlow

**文件**: `MainActivity.kt`, `ClawdApp.kt`, `ui/navigation/NavGraph.kt`

**当前问题**: companion object 的 3 个可变静态字段被多线程读写。

**方案**: 在 `ClawdApp` 中创建 Application-scoped 的 `Channel`。

```kotlin
// ClawdApp.kt — 新增
import kotlinx.coroutines.channels.Channel
import com.clawd.mobile.data.PermissionRequestData

class ClawdApp : Application() {
    // ... 现有代码 ...

    /** 通知 → Activity 的审批请求通道（替代 MainActivity companion object） */
    val approvalChannel = Channel<PermissionRequestData>(Channel.BUFFERED)
}
```

**修改 `NotificationHelper.kt`**: 发送通知时同时写入 Channel。

```kotlin
// NotificationHelper.kt — showApprovalNotification 末尾
val app = context.applicationContext as ClawdApp
// Channel 用于 Activity 内消费（通知点击 → onNewIntent 路由不变）
```

**修改 `MainActivity.kt`**: 删除 companion object 的 3 个字段，改为从 Channel 收集。

```kotlin
class MainActivity : ComponentActivity() {
    companion object {
        // 删除 pendingApprovalRequestId, pendingApprovalRequest, approvalViewModelRef
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // ... 权限逻辑不变 ...
        // handleApprovalIntent 保留（处理 Intent extras），但不再写 companion
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // 直接解析 intent extras 并转发给 ViewModel
        val requestJson = intent.getStringExtra("request_json") ?: return
        val request = SafeExecutor.tryOrNull("MainActivity") {
            Json.decodeFromString<PermissionRequestData>(requestJson)
        } ?: return
        // 通过 NavGraph 中的 ViewModel 引用转发
        // （此引用改为通过 LocalViewModelStoreOwner 获取，不再用静态字段）
    }
}
```

**修改 `NavGraph.kt`**: 删除 `MainActivity.approvalViewModelRef = approvalViewModel`，改为通过 `LaunchedEffect` 监听 Intent。

**工作量**: 2h
**风险**: 中。需要仔细测试通知点击 → Activity 路由的完整链路。

---

### T2.2 StatusNotifier 线程安全

**文件**: `notification/StatusNotifier.kt`

**当前问题**: companion object 的 `lastDisplayState` / `firstLoad` 和实例字段 `lastBadge` 无同步。

**方案**: 使用 `@Volatile` + `ConcurrentHashMap`。

```kotlin
class StatusNotifier(private val context: Context, private val prefsStore: PrefsStore) {

    companion object {
        @Volatile
        private var lastDisplayState: String? = null
        @Volatile
        private var firstLoad = true
    }

    /** Per-session badge tracking for completion notifications */
    private val lastBadge = java.util.concurrent.ConcurrentHashMap<String, String>()

    // ... 其余不变
}
```

**工作量**: 10min
**风险**: 极低。

---

### T2.3 ApprovalViewModel map 线程安全

**文件**: `ui/approval/ApprovalViewModel.kt`

**当前问题**: `recentlyDismissed` / `timeoutJobs` / `countdownJobs` 是普通 map。

**方案**: 所有 map 操作限定在 `Dispatchers.Main`。

```kotlin
class ApprovalViewModel(...) : AndroidViewModel(application) {
    // 将所有 map 操作通过 viewModelScope.launch(Dispatchers.Main) 限定
    // 或改用 ConcurrentHashMap

    private val recentlyDismissed = java.util.concurrent.ConcurrentHashMap<String, PermissionRequestData>()
    private val timeoutJobs = java.util.concurrent.ConcurrentHashMap<String, Job>()
    private val countdownJobs = java.util.concurrent.ConcurrentHashMap<String, Job>()
}
```

**更优方案**: 由于 `viewModelScope` 默认是 `Dispatchers.Main`，所有从 `viewModelScope.launch` 发起的操作已经在主线程。问题是 `collect { handleNewRequest() }` 也在 Main，所以实际上如果所有操作都从 `viewModelScope.launch` 发起，不存在并发问题。**但防御性编程仍然推荐 ConcurrentHashMap。**

**工作量**: 15min
**风险**: 极低。

---

### T2.4 PetStateManager 字段保护

**文件**: `overlay/PetStateManager.kt`

**当前问题**: 6 个可变字段被多个协程上下文访问。

**分析**: `updateSessions` 已经在 `sessionMutex.withLock` 内运行，但 `emitState` / `commandFlowEmit` 在 mutex 内外都被调用。`gifGeneration` 被 `loadReactionAndRestore` 和 `playWakingAndRestore` 从不同协程读写。

**方案**: 将 `gifGeneration` 改为 `AtomicInteger`，其余字段的并发访问路径已由 `sessionMutex` 覆盖。

```kotlin
import java.util.concurrent.atomic.AtomicInteger

class PetStateManager(var character: String) {
    // ...
    private val gifGeneration = AtomicInteger(0)

    // loadReactionAndRestore 中
    private fun loadReactionAndRestore(assetPath: String, delayMs: Long, scope: CoroutineScope) {
        val gen = gifGeneration.incrementAndGet()
        // ...
    }

    // playWakingAndRestore 中
    private fun playWakingAndRestore(targetState: PetState, scope: CoroutineScope) {
        cancelSleepSequence()
        val gen = gifGeneration.incrementAndGet()
        // ...
    }

    // 检查处
    if (gifGeneration.get() != gen) return@launch
}
```

**其余字段** (`prevBadge`, `consumedDoneSessions`, `lastNonIdleState`, `idleSince`): 这些只在 `updateSessions` 内部访问（已 mutex 保护），或在 `reset()` 中访问（Service 生命周期保证串行）。**当前实际不存在并发写入，但建议添加注释说明线程安全契约。**

```kotlin
// PetStateManager.kt — 类顶部注释
/**
 * Thread safety contract:
 * - [updateSessions] runs under [sessionMutex], protecting all state reads/writes within.
 * - [gifGeneration] is AtomicInteger, safe for cross-coroutine increment/check.
 * - [reset] is called only from Service lifecycle (onDestroy/onStartCommand), which is serialized by Android.
 * - [emitState] and [commandFlowEmit] write to [MutableStateFlow] which is thread-safe by design.
 */
```

**工作量**: 0.5h
**风险**: 低。

---

### T2.5 NotificationHelper notificationId 稳定化

**文件**: `notification/NotificationHelper.kt`

**当前问题**: 静态计数器 `notificationId = 1000` 进程重启后重置。

**方案**: 改为基于 `requestId` 的确定性 ID，避免计数器。

```kotlin
object NotificationHelper {
    // 删除: private var notificationId = 1000

    fun showApprovalNotification(context: Context, request: PermissionRequestData, sessionName: String? = null) {
        val requestId = request.requestId ?: return
        val id = requestId.hashCode() and 0x7FFFFFFF  // 确保非负
        // ...
    }

    fun showElicitationNotification(context: Context, request: PermissionRequestData, sessionName: String? = null) {
        val requestId = request.requestId ?: return
        val id = (requestId + ":elicitation").hashCode() and 0x7FFFFFFF
        // ...
    }
}
```

**注意**: Allow/Deny 的 PendingIntent 使用 `id` 和 `id + 10000` 来区分。改用 hashCode 后仍需保持这个偏移。

**工作量**: 10min
**风险**: 低。hashCode 冲突概率极低，且 `FLAG_UPDATE_CURRENT` 会覆盖旧通知。

---

## Phase 3 — 代码清理（0.5 天）

### T3.1 删除 `applyConductingMapping` 死代码

**文件**: `overlay/PetStateManager.kt`

```kotlin
// 删除第 266-277 行的 applyConductingMapping 方法
// 在 resolveDisplayState 上方添加注释：
// Note: Juggling/Conducting mapping is handled server-side via displayState field.
// Local applyConductingMapping was removed as dead code (2026-06-01 audit).
```

**工作量**: 5min
**风险**: 无。该方法从未被调用。

---

### T3.2 实现或删除看门狗

**文件**: `overlay/PetStateManager.kt`

**方案 A（推荐）**: 实现实际的超时逻辑——如果状态长时间未更新，强制回退。

```kotlin
// PetStateManager.kt — collectSessions 中的 watchdog
val watchdogJob = scope.launch {
    while (isActive) {
        delay(WATCHDOG_INTERVAL_MS)
        // 如果非 idle 状态持续超过 WATCHDOG_TIMEOUT_MS 且无 session 更新，强制 idle
        if (!currentState.isIdleLike) {
            val ws = WebSocketService.getWebSocket()
            val hasActiveSessions = ws?.sessions?.value?.values?.any { it.isVisible } ?: false
            if (!hasActiveSessions) {
                Log.w(TAG, "Watchdog: no active sessions but state=${currentState.themeKey}, forcing idle")
                emitState(PetState.Idle)
            }
        }
    }
}
```

**方案 B**: 如果认为 watchDog 不需要（`updateSessions` 已覆盖所有路径），直接删除。

**工作量**: 0.5h
**风险**: 低。

---

### T3.3 ScanScreen executor shutdown

**文件**: `ui/scan/ScanScreen.kt`

```kotlin
// 当前
cameraExecutor = remember { Executors.newSingleThreadExecutor() }

// 修改为
val lifecycleOwner = LocalLifecycleOwner.current
cameraExecutor = remember {
    Executors.newSingleThreadExecutor().also { executor ->
        lifecycleOwner.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) {
                executor.shutdown()
            }
        })
    }
}
```

**工作量**: 10min
**风险**: 无。

---

### T3.4 FloatingPetView bitmap recycle

**文件**: `overlay/FloatingPetView.kt`

```kotlin
// 在 onDetachedFromWindow 中回收
override fun onDetachedFromWindow() {
    hitTestBitmap?.recycle()
    hitTestBitmap = null
    super.onDetachedFromWindow()
}
```

**工作量**: 5min
**风险**: 无。

---

### T3.5 Badge 转换时长对齐

**文件**: `overlay/PetStateManager.kt`

**当前**: `REACTION_DISPLAY_MS = 4_000L`（4 秒）
**PC 端**: happy interlude 1.5 秒

```kotlin
// 确认 PC 端实际值后修改
const val REACTION_DISPLAY_MS = 1_500L  // 对齐 PC 端 happy interlude
```

**工作量**: 5min（需要确认 PC 端实际值）
**风险**: 低。视觉效果变化。

---

### T3.6 添加 idleSince 边界注释

**文件**: `overlay/PetStateManager.kt`

```kotlin
/**
 * Idle 超时处理：首次 idle 开始计时，60 秒后仍 idle 才进入睡眠序列。
 * 对齐 PC 端 MOUSE_SLEEP_TIMEOUT 行为。
 *
 * Note: 此方法仅在 updateSessions 中被调用（由 sessionFlow.collect 驱动）。
 * SSE 断连时，collectSessions 的 connectionState collector 会取消 collectJob，
 * 因此 idleSince 不会在断连后被无限期检查。
 */
private fun handleIdleTimeout(scope: CoroutineScope) {
```

**工作量**: 5min
**风险**: 无。

---

## Phase 4 — 结构优化（2-3 天）

### T4.1 SettingsScreen 拆文件

**文件**: `ui/settings/SettingsScreen.kt` (647 行)

**目标结构**:

```
ui/settings/
├── SettingsScreen.kt        (~120 行) 主骨架 + Scaffold + TopBar + AccordionSection
├── ConnectionInfoCard.kt    (~40 行)  连接信息卡片
├── NotificationSection.kt   (~60 行)  通知设置
├── FloatingPetSection.kt    (~200 行) 悬浮宠设置（最复杂）
└── AboutSection.kt          (~70 行)  关于页面
```

`AccordionSection` 是通用组件，移到 `ui/components/AccordionSection.kt`。

**工作量**: 1h
**风险**: 低。纯文件拆分，不改逻辑。

---

### T4.2 硬编码颜色提取为常量

**文件**: `overlay/PetBubbleView.kt`, `ui/sessions/EventTimeline.kt`

```kotlin
// ui/theme/BubbleColors.kt（新建）
package com.clawd.mobile.ui.theme

import androidx.compose.ui.graphics.Color

// PetBubbleView colors
val BubbleBackground = Color(0xFF1E1E2E)
val BubbleTextPrimary = Color(0xFFE0E0E0)
val BubbleTextSecondary = Color(0xFF888888)
val BubbleDivider = Color(0x33FFFFFF)
val BubbleCardBackground = Color(0xFF2A2A3E)
```

**同时修复**: `EventTimeline.kt` 的 `EVENT_STATE_COLORS` 改为引用 `NotificationIcons.colorForState`，消除 DRY 违反。

**工作量**: 1h
**风险**: 无。纯重构。

---

### T4.3 硬编码字符串提取为 string resource

**文件**: `SettingsScreen.kt`, `SessionCard.kt`, `ManualScreen.kt`

```xml
<!-- res/values/strings.xml 新增 -->
<string name="settings_pet_resize_hint">💡 调整大小后需关闭再开启悬浮窗生效</string>
<string name="manual_token_label">Token</string>
<string name="session_waiting">等待中</string>

<!-- res/values-en/strings.xml 新增 -->
<string name="settings_pet_resize_hint">💡 Restart the floating pet after resizing</string>
<string name="manual_token_label">Token</string>
<string name="session_waiting">Waiting</string>
```

**工作量**: 0.5h
**风险**: 无。

---

### T4.4 ClawdWebSocket 提取 MessageParser

**文件**: `ws/ClawdWebSocket.kt`

将 `handleMessage` 中的 JSON 解析逻辑提取到独立类：

```kotlin
// ws/WsMessageParser.kt（新建）
package com.clawd.mobile.ws

internal object WsMessageParser {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parseSnapshot(obj: JsonObject): Map<String, SessionData> { ... }
    fun parseStateUpdate(obj: JsonObject): SessionData? { ... }
    fun parsePermissionRequest(obj: JsonObject): PermissionRequestData? { ... }
    fun buildToolInputSummary(toolName: String?, toolInput: JsonObject?): String? { ... }
}
```

`ClawdWebSocket.handleMessage` 简化为路由层，调用 `WsMessageParser` 的方法。

**工作量**: 1h
**风险**: 低。纯提取重构。

---

### T4.5 过时 API 更新

**文件**: `ui/scan/ScanScreen.kt`

```kotlin
// 当前（deprecated）
val lifecycleOwner = LocalLifecycleOwner.current

// 替换为
import androidx.lifecycle.compose.LocalLifecycleOwner
val lifecycleOwner = LocalLifecycleOwner.current
```

**工作量**: 5min
**风险**: 无。

---

## Phase 5 — 测试覆盖（3 天，长期）

### T5.1 PetStateManager 单元测试

**目标**: 覆盖核心状态机逻辑。

```kotlin
// src/test/java/com/clawd/mobile/overlay/PetStateManagerTest.kt
class PetStateManagerTest {
    // 测试用例：
    // - 单 session idle → working 状态转换
    // - 多 session 优先级选择（Error > Attention > Working）
    // - 睡眠序列触发（60s idle timeout）
    // - 睡眠序列中断（新 session 进入）
    // - Badge 转换检测（running → done 触发 happy interlude）
    // - SessionEnd 全 sleeping 触发睡眠
    // - displayState 覆盖本地 state
}
```

**工作量**: 1d
**依赖**: 需要 mock `WebSocketService.getWebSocket()` 和 `SvgLoader`。

---

### T5.2 SvgLoader 单元测试

**目标**: 覆盖回退链和 tier 逻辑。

```kotlin
// src/test/java/com/clawd/mobile/overlay/SvgLoaderTest.kt
class SvgLoaderTest {
    // 测试用例：
    // - resolveSvgAsset: 直接状态映射
    // - resolveSvgAsset: working tier 1/2/3 session 映射
    // - resolveSvgAsset: juggling tier 映射
    // - resolveSvgAsset: 未知状态 → clawd fallback → idle
    // - resolveSvgAsset: 未知角色 → clawd fallback
    // - assetExists: 缓存命中
    // - assetExists: 缓存未命中 → IO 检查
    // - pickIdleAnimation: 返回有效变体
}
```

**工作量**: 0.5d

---

### T5.3 ClawdWebSocket 协议解析测试

**目标**: 覆盖 handleMessage 的 JSON 解析。

```kotlin
// src/test/java/com/clawd/mobile/ws/ClawdWebSocketTest.kt
class ClawdWebSocketTest {
    // 测试用例：
    // - snapshot 消息解析（正常 / 缺失字段 / 空 sessions）
    // - state 消息解析（含 recentEvents / lastOutput）
    // - permission_request 消息解析（含 suggestions / elicitation）
    // - tool_output 消息解析
    // - session_deleted 消息处理
    // - ping 消息忽略
    // - 畸形 JSON 处理
}
```

**工作量**: 0.5d

---

### T5.4 PrefsStore 迁移测试

```kotlin
// src/test/java/com/clawd/mobile/data/PrefsStoreTest.kt
class PrefsStoreTest {
    // 测试用例：
    // - 首次安装：无 legacy 数据，直接标记 migrated
    // - 迁移：legacy prefs → encrypted prefs
    // - 迁移后：legacy prefs 已清空
    // - 重复迁移：migrated 标记阻止重复
}
```

**工作量**: 0.5d

---

## 验收标准

### Phase 1 验收

- [ ] `ClawdWebSocket.kt:44` 不再有占位符指纹（删除或改为配置化）
- [ ] `ApprovalReceiver` 使用共享 `HttpClientProvider.getClient()`
- [ ] `ClawdWebSocket` 日志中 token 显示为 `abcd****efgh`
- [ ] `ManualScreen` Token 输入框有遮罩和切换按钮

### Phase 2 验收

- [ ] `MainActivity` companion object 不再有可变静态字段
- [ ] `StatusNotifier` 的 `lastBadge` 使用 `ConcurrentHashMap`
- [ ] `ApprovalViewModel` 的 3 个 map 使用 `ConcurrentHashMap`
- [ ] `PetStateManager.gifGeneration` 使用 `AtomicInteger`
- [ ] `NotificationHelper.notificationId` 基于 `requestId.hashCode()`

### Phase 3 验收

- [ ] `applyConductingMapping` 已删除
- [ ] watchdog 有实际逻辑或已删除
- [ ] `ScanScreen` executor 在 lifecycle destroy 时 shutdown
- [ ] `FloatingPetView.hitTestBitmap` 在 `onDetachedFromWindow` 时 recycle
- [ ] `REACTION_DISPLAY_MS` 已确认对齐 PC 端值

### Phase 4 验收

- [ ] `SettingsScreen.kt` ≤ 150 行
- [ ] 硬编码颜色已提取为 `BubbleColors.kt` 常量
- [ ] 中文/英文字符串已提取为 string resource
- [ ] `ClawdWebSocket.kt` 的 `handleMessage` ≤ 50 行（解析委托给 `WsMessageParser`）
- [ ] 无 deprecated API 警告

### Phase 5 验收

- [ ] `PetStateManagerTest` 覆盖 8+ 核心场景
- [ ] `SvgLoaderTest` 覆盖回退链 + tier 逻辑
- [ ] `ClawdWebSocketTest` 覆盖 6+ 消息类型
- [ ] `PrefsStoreTest` 覆盖迁移逻辑

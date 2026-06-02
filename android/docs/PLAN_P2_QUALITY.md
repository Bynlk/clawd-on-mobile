# P2 质量提升计划

> 阶段：中期（1 个月）
> 前置依赖：P0、P1 全部完成
> 关联问题：M-07、M-09、M-13、M-15、M-16、L-05、L-06、L-07、L-08、L-09、L-11
> 预计工作量：10-15 天

---

## 概述

本阶段聚焦代码质量提升：消除轮询反模式、改善可维护性、补充测试覆盖。改动范围较广但每个任务独立，可并行推进。

---

## 任务清单

| # | 任务 | 关联 | 文件 | 工作量 | 依赖 |
|---|------|------|------|--------|------|
| P2-1 | WebSocket 就绪事件机制 | M-07 | `PetStateManager.kt`、`NavGraph.kt`、`WebSocketService.kt` | M | 无 |
| P2-2 | SvgLoader HTML 模板抽取 | M-09 | `SvgLoader.kt` | M | 无 |
| P2-3 | assetCache 容量上限 | M-13 | `SvgLoader.kt` | S | 无 |
| P2-4 | 优先级定义统一 | M-15 | `Session.kt`、`PetState.kt` | S | 无 |
| P2-5 | consumedDoneSessions 线程安全 | M-16 | `PetStateManager.kt` | S | 无 |
| P2-6 | debug 关闭 minify | L-05 | `build.gradle.kts` | S | 无 |
| P2-7 | isLan 改用 InetAddress | L-06 | `ConnectionConfig.kt` | S | 无 |
| P2-8 | recentlyDismissed 上限 | L-07 | `ApprovalViewModel.kt` | S | 无 |
| P2-9 | Log.w → Log.d 修正 | L-08 | `PetStateManager.kt` | S | 无 |
| P2-10 | 硬编码颜色提取 | L-09 | `PetBubbleView.kt` | S | 无 |
| P2-11 | 核心逻辑单元测试 | L-11 | `test/` 目录 | L | P2-1~P2-10 |

---

## P2-1：WebSocket 就绪事件机制

**问题**：`PetStateManager.waitForWebSocket()` 和 `NavGraph` 都用轮询等待 WebSocket 实例就绪。

**当前代码**：
```kotlin
// PetStateManager.kt:444-449
private suspend fun waitForWebSocket(): ClawdWebSocket {
    while (true) {
        WebSocketService.getWebSocket()?.let { return it }
        delay(WS_POLL_INTERVAL_MS)  // 3 秒轮询
    }
}

// NavGraph.kt:36-49
repeat(50) { // 100ms × 50 = 5 秒轮询
    WebSocketService.getWebSocket()?.let {
        webSocket = it
        return@LaunchedEffect
    }
    kotlinx.coroutines.delay(100)
}
```

**修改方案**：

1. `WebSocketService` 添加就绪事件 Channel：

```kotlin
// WebSocketService.kt
companion object {
    // 新增
    private val _webSocketReady = Channel<ClawdWebSocket>(Channel.CONFLATED)
    val webSocketReady: Flow<ClawdWebSocket> = _webSocketReady.receiveAsFlow()

    // 保留 getWebSocket() 用于同步快照访问
    fun getWebSocket(): ClawdWebSocket? = instance?.webSocket
}

override fun onCreate() {
    super.onCreate()
    instance = this
    webSocket = ClawdWebSocket(prefsStore)
    _webSocketReady.trySend(webSocket!!)  // 通知就绪
}
```

2. `PetStateManager.waitForWebSocket()` 改用事件：

```kotlin
private suspend fun waitForWebSocket(): ClawdWebSocket {
    // 先检查快照
    WebSocketService.getWebSocket()?.let { return it }
    // 等待事件
    return WebSocketService.webSocketReady.first()
}
```

3. `NavGraph` 改用事件：

```kotlin
LaunchedEffect(wsRefreshKey) {
    val ws = WebSocketService.getWebSocket()
        ?: WebSocketService.webSocketReady.first()
    webSocket = ws
}
```

**验证**：
- 启动后 PetStateManager 立即响应 WebSocket 就绪（无 3 秒延迟）
- NavGraph 切换后 WebSocket 立即可用

---

## P2-2：SvgLoader HTML 模板抽取

**问题**：`SvgLoader.kt:302-378` 中 ~80 行 HTML 模板内联在 Kotlin 代码中。

**修改方案**：

将 HTML 模板提取到 `assets/html/` 目录：

```
assets/
├── html/
│   ├── svg_template.html       # SVG 渲染模板
│   └── apng_template.html      # APNG 渲染模板
└── svg/
    └── ...
```

`SvgLoader.loadSvg()` 改为读取模板并替换占位符：

```kotlin
private fun loadTemplate(context: Context, name: String): String {
    return context.assets.open("html/$name").bufferedReader().readText()
}

fun loadSvg(webView: WebView, assetPath: String, loop: Boolean, onFinished: (() -> Unit)? = null) {
    val url = "$SVG_BASE/${assetPath.removePrefix("svg/")}"
    val loopStyle = if (loop) "" else "animation-iteration-count: 1;"
    val isApng = assetPath.endsWith(".apng")

    val templateName = if (isApng) "apng_template.html" else "svg_template.html"
    val html = loadTemplate(webView.context, templateName)
        .replace("{{URL}}", url)
        .replace("{{LOOP_STYLE}}", loopStyle)
        .replace("{{ANIM_END_SCRIPT}}", if (!isApng && !loop && onFinished != null) ANIM_END_SCRIPT else "")

    webView.loadDataWithBaseURL("https://appassets.androidplatform.net/", html, "text/html", "UTF-8", null)
    // ... onFinished 逻辑不变
}
```

**验证**：
- SVG 渲染效果不变（CSS 动画正常）
- APNG 渲染效果不变
- oneshot 动画结束后正确回调

---

## P2-3：assetCache 容量上限

**问题**：`SvgLoader.assetCache` / `missingCache` 无限增长。

**修改方案**：

使用 `LinkedHashSet` 实现 LRU 淘汰：

```kotlin
private const val MAX_CACHE_SIZE = 128

private val assetCache = object : LinkedHashSet<String>(MAX_CACHE_SIZE, 0.75f) {
    override fun add(element: String): Boolean {
        if (size >= MAX_CACHE_SIZE) {
            val eldest = iterator().next()
            remove(eldest)
        }
        return super.add(element)
    }
}

private val missingCache = object : LinkedHashSet<String>(MAX_CACHE_SIZE, 0.75f) {
    override fun add(element: String): Boolean {
        if (size >= MAX_CACHE_SIZE) {
            val eldest = iterator().next()
            remove(eldest)
        }
        return super.add(element)
    }
}
```

**验证**：
- 长时间运行后缓存大小不超过 128

---

## P2-4：优先级定义统一

**问题**：`Session.STATE_PRIORITY` 和 `PetState.priority` 是两套独立定义。

**当前代码**：
```kotlin
// Session.kt:51-57
val STATE_PRIORITY = mapOf(
    "working" to 2, "juggling" to 2,
    "thinking" to 3,
    "notification" to 4, "attention" to 4, "error" to 4,
    "sweeping" to 5, "carrying" to 5,
    "idle" to 6, "sleeping" to 7
)

// PetState.kt — 每个 state 有自己的 priority
data object Working : PetState(3, "working")
data object Thinking : PetState(2, "thinking")
```

**修改方案**：

`Session` 改用 `PetState` 的优先级：

```kotlin
// Session.kt
companion object {
    /** 通过 PetState 获取优先级，用于 UI 排序 */
    fun statePriority(state: String): Int {
        return PetState.fromString(state).priority
    }
}
```

```kotlin
// SessionsScreen.kt — 排序逻辑
val sessions = remember(sessionsMap) {
    sessionsMap.map { (id, data) -> Session(id, data) }
        .filter { it.data.isVisible }
        .sortedWith(
            compareByDescending<Session> { Session.statePriority(it.data.state) }
                .thenByDescending { it.data.updatedAt ?: 0L }
        )
}
```

**注意**：`Session.STATE_PRIORITY` 的数值方向与 `PetState.priority` 相反（Session 中数字越小优先级越高，PetState 中数字越高优先级越高）。统一时需要确认方向。

**验证**：
- SessionsScreen 中 session 排序与之前一致

---

## P2-5：consumedDoneSessions 线程安全

**问题**：`PetStateManager.consumedDoneSessions` 是普通 `MutableSet`，依赖 mutex 保护。

**修改方案**：
```kotlin
// 之前
private val consumedDoneSessions = mutableSetOf<String>()

// 之后
private val consumedDoneSessions = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
```

**验证**：
- done badge 只触发一次 Attention 状态

---

## P2-6：debug 关闭 minify

**问题**：`build.gradle.kts:41` 中 debug buildType 启用 `isMinifyEnabled = true`。

**修改方案**：
```kotlin
buildTypes {
    release {
        isMinifyEnabled = true
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        signingConfig = signingConfigs.getByName("release")
    }
    debug {
        isMinifyEnabled = false  // 之前是 true
    }
}
```

**验证**：
- `./gradlew assembleDebug` 构建时间缩短
- debug APK 可正常调试

---

## P2-7：isLan 改用 InetAddress

**问题**：`ConnectionConfig.isLan` 用 Regex 匹配 IP，边界情况处理不完善。

**当前代码**：
```kotlin
val isLan: Boolean get() = host.matches(Regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.|localhost|127\\.).*"))
```

**修改方案**：
```kotlin
val isLan: Boolean get() {
    if (host == "localhost") return true
    return try {
        val addr = java.net.InetAddress.getByName(host)
        addr.isLoopbackAddress || addr.isSiteLocalAddress || addr.isLinkLocalAddress
    } catch (_: Exception) {
        // 无法解析 → 假定非 LAN（安全优先）
        false
    }
}
```

**验证**：
- `10.0.0.1` → true
- `172.16.0.1` → true
- `192.168.1.1` → true
- `127.0.0.1` → true
- `localhost` → true
- `172.20.0.1` → true（siteLocalAddress）
- `8.8.8.8` → false
- `example.com` → false

---

## P2-8：recentlyDismissed 上限

**问题**：`ApprovalViewModel.recentlyDismissed` 无限增长。

**修改方案**：
```kotlin
private const val MAX_DISMISSED = 20
private val recentlyDismissed = object : LinkedHashMap<String, PermissionRequestData>(MAX_DISMISSED, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, PermissionRequestData>?): Boolean {
        return size > MAX_DISMISSED
    }
}
```

**验证**：
- 超过 20 条后最旧的条目被自动淘汰

---

## P2-9：Log.w → Log.d 修正

**问题**：`PetStateManager.kt:245,270` 使用 `Log.w` 记录正常状态变化。

**修改方案**：
```kotlin
// PetStateManager.kt:245 — 之前
Log.w("PetState", "resolveDisplayState input sessions: ...")
// 之后
Log.d("PetState", "resolveDisplayState input sessions: ...")

// PetStateManager.kt:270 — 之前
Log.w("PetState", "resolveDisplayState result: ${best.themeKey}")
// 之后
Log.d("PetState", "resolveDisplayState result: ${best.themeKey}")

// FloatingPetService.kt:155 — 之前
Log.w("PetState", "handleCommand state=...")
// 之后
Log.d("PetState", "handleCommand state=...")

// PetStateManager.kt:203 — 之前
Log.w("PetState", "emitState: ${bestState.themeKey}")
// 之后
Log.d("PetState", "emitState: ${bestState.themeKey}")
```

**验证**：
- `adb logcat *:W` 不再出现正常状态日志
- `adb logcat PetState:D` 可看到状态变化

---

## P2-10：硬编码颜色提取

**问题**：`PetBubbleView.kt` 中多处 `Color.parseColor("#...")` 硬编码。

**修改方案**：

在 `Color.kt` 中添加气泡颜色定义：

```kotlin
// theme/Color.kt — 新增
val ClawdBubbleBg = Color(0xFF1E1E2E)
val ClawdBubbleText = Color(0xFFE0E0E0)
val ClawdBubbleMuted = Color(0xFF888888)
val ClawdBubbleButtonBg = Color(0xFF2A2A3E)
val ClawdBubbleDivider = Color(0x33FFFFFF)
```

`PetBubbleView.kt` 改用这些常量（注意 PetBubbleView 是传统 View，需要用 `colorInt` 转换）：

```kotlin
// PetBubbleView.kt
import com.clawd.mobile.ui.theme.ClawdBubbleBg
// ...

val bg = GradientDrawable().apply {
    setColor(ClawdBubbleBg.toArgb())  // Compose Color → Android int
    cornerRadius = 14 * dp
}
```

**验证**：
- 气泡外观不变

---

## P2-11：核心逻辑单元测试

**问题**：仅 `ConnectionConfigTest.kt` 一个测试文件，核心逻辑无覆盖。

**新增测试文件**：

```
app/src/test/java/com/clawd/mobile/
├── data/
│   └── ConnectionConfigTest.kt          # 已有，扩展
├── overlay/
│   └── PetStateManagerTest.kt           # 新增
├── ui/approval/
│   └── ApprovalViewModelTest.kt         # 新增
└── ws/
    └── ConnectionConfigValidationTest.kt # 新增（P1-3 深链验证）
```

### PetStateManagerTest 重点测试：

```kotlin
class PetStateManagerTest {
    // 1. 优先级选择：多 session 时最高优先级胜出
    // 2. 睡眠序列：60s idle 超时后进入 Yawning → Sleeping
    // 3. 唤醒：sleeping 状态下收到 active session → Waking → 目标状态
    // 4. Badge 转换：running → done 触发 Attention（happy interlude）
    // 5. consumedDoneSessions：done badge 只触发一次
    // 6. Watchdog：无可见 session 时强制 idle
}
```

### ApprovalViewModelTest 重点测试：

```kotlin
class ApprovalViewModelTest {
    // 1. 请求去重：相同 requestId 不重复添加
    // 2. 倒计时：timeout 后自动移除
    // 3. approve/deny：发送正确 response 并移除请求
    // 4. recentlyDismissed：通知点击可恢复已dismiss的请求
    // 5. MAX_DISMISSED 上限
}
```

### ConnectionConfigValidationTest（P1-3 深链验证）：

```kotlin
class ConnectionConfigValidationTest {
    // 1. IP 地址 → 通过
    // 2. localhost → 通过
    // 3. .local 域名 → 通过
    // 4. 普通域名 → 拒绝
    // 5. 端口范围验证
}
```

**验证**：
- `./gradlew test` 全部通过
- 测试覆盖率：核心逻辑 > 70%

---

## 验收标准

- [ ] 轮询反模式全部消除，改用事件通知
- [ ] SvgLoader HTML 模板抽取到 assets
- [ ] 缓存有容量上限
- [ ] 优先级定义统一为一套
- [ ] consumedDoneSessions 线程安全
- [ ] debug 构建关闭 minify
- [ ] isLan 使用 InetAddress 解析
- [ ] recentlyDismissed 有上限
- [ ] 日志级别正确（正常状态用 Log.d）
- [ ] 硬编码颜色提取到主题系统
- [ ] 核心逻辑有单元测试，覆盖率 > 70%

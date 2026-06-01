# Android 端架构重构计划

> 基于代码审查 2026-06-01，覆盖 28 个 Kotlin 源文件（~5,500 行）

---

## 〇、执行状态（2026-06-01 更新）

| Phase | 状态 | 提交 | 备注 |
|-------|------|------|------|
| Phase 1 — 安全修复 | ✅ 完成 | `9d20657` | WebView 收紧 + Token 加密 + SSE 分级安全 |
| Phase 2 — 健壮性 | ✅ 完成 | `cadfb6f` `bb0f9eb` `382fd0d` | SafeExecutor + assetExists + oneshot + PrefsStore 统一 |
| Phase 3 — 文件拆分 | ✅ 完成 | `9d20657` `1db1ced` | SessionsScreen/MainActivity/FloatingPetService 拆分 |
| Phase 4 — 架构改进 | ⏭️ 跳过 | — | 当前项目规模不值得引入 Hilt/ViewModel/theme.json |
| Phase 5 — 长期 | ⏳ 待定 | — | 单元测试 + SplashScreen 简化 |

**未完成项**: P0-3 SSE 证书锁定指纹需替换为实际值（当前为占位符）。

---

## 一、现状评估摘要

| 维度 | 评分 | 关键问题 |
|------|------|----------|
| 安全性 | 🔴 60/100 | WebView 文件访问权限过大、Token 明文存储、无 TLS 锁定 |
| 健壮性 | 🟡 72/100 | 异常静默吞掉、SVG 加载无回退、oneshot 回调靠 postDelayed |
| 可维护性 | 🟡 70/100 | SessionsScreen 840 行巨型文件、硬编码映射表、无 DI |
| 架构设计 | 🟢 82/100 | PetStateManager 单管道设计优秀、包分层合理 |

---

## 二、问题分析与多方案对比

---

### 问题 1: WebView 安全设置过度开放

**位置**: `overlay/FloatingPetView.kt:80-101`

**现状**:
```kotlin
javaScriptEnabled = true
domStorageEnabled = true
allowFileAccessFromFileURLs = true      // 🔴 危险
allowUniversalAccessFromFileURLs = true  // 🔴 危险
allowContentAccess = true               // 🔴 不需要
```

**风险**: 配合 JS 全开，理论上可读取本地文件。虽然目前只加载 assets，但属于纵深防御缺失。

---

#### 方案 A: 直接关闭危险标志（推荐）

```kotlin
private fun configureSettings() {
    settings.apply {
        javaScriptEnabled = true                // SVG 内联 + CSS 动画需要
        domStorageEnabled = false               // 不需要
        allowFileAccessFromFileURLs = false      // 关闭
        allowUniversalAccessFromFileURLs = false  // 关闭
        allowContentAccess = false               // 关闭
        setSupportZoom(false)
        builtInZoomControls = false
        displayZoomControls = false
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        loadWithOverviewMode = true
        useWideViewPort = false
        cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
    }
    setLayerType(LAYER_TYPE_SOFTWARE, null)
}
```

**为什么可行**: SVG 资源通过 `WebViewAssetLoader` 加载，走的是 `shouldInterceptRequest` 拦截 HTTPS scheme，不依赖 file:// 协议。

| 优点 | 缺点 |
|------|------|
| 改动最小（删 3 行） | 无 |
| 零功能回归风险 | - |
| 立即消除安全隐患 | - |

**风险**: 极低。`WebViewAssetLoader` 返回的是 `WebResourceResponse`，走的是 HTTP 响应流，不需要 file:// 权限。

---

#### 方案 B: 在方案 A 基础上额外禁用 JS，改用原生 SVG 渲染

```kotlin
// 用 androidsvg-aar 替代 WebView
javaScriptEnabled = false
```

| 优点 | 缺点 |
|------|------|
| 彻底消除 JS 攻击面 | 丢失 CSS 动画（breathe/blink/tail-sway） |
| 内存占用更低 | 需要重写整个 SVG 渲染层 |
| | androidsvg-aar 对 APNG 不支持 |

**结论**: 不推荐。PC 端 SVG 重度依赖 CSS 动画，WebView 是当前唯一能完整渲染的方案。

---

#### 方案 C: 自定义 WebViewClient 白名单拦截

```kotlin
webViewClient = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // 只允许 appassets scheme
        return request.url.scheme != "https" ||
               request.url.host != "appassets.androidplatform.net"
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        // 白名单：只允许 svg 目录下的资源
        if (url.host == "appassets.androidplatform.net" && url.path?.startsWith("/svg/") == true) {
            return assetLoader.shouldInterceptRequest(url)
        }
        return WebResourceResponse("text/plain", "UTF-8", "".byteInputStream())
    }
}
```

| 优点 | 缺点 |
|------|------|
| 纵深防御：即使设置被绕过也有拦截层 | 代码复杂度增加 |
| 可精确控制允许加载的资源范围 | 需要维护白名单 |
| | 方案 A 已足够，此为过度防御 |

**结论**: 方案 A 够用，方案 C 可作为后续加固手段。

---

### 问题 2: Token 明文存储

**位置**: `data/PrefsStore.kt:23-24`

**现状**: `ConnectionConfig`（含 token）直接 `Json.encodeToString` 存入 SharedPreferences 明文。

---

#### 方案 A: EncryptedSharedPreferences（推荐）

```kotlin
// data/PrefsStore.kt
class PrefsStore(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "clawd_prefs_encrypted",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    // 迁移逻辑
    init {
        migrateIfNeeded(context)
    }

    private fun migrateIfNeeded(context: Context) {
        if (prefs.getBoolean("_migrated_v1", false)) return
        val oldPrefs = context.getSharedPreferences("clawd_prefs", Context.MODE_PRIVATE)
        oldPrefs.all.forEach { (key, value) ->
            when (value) {
                is String -> prefs.edit().putString(key, value).apply()
                is Boolean -> prefs.edit().putBoolean(key, value).apply()
                is Int -> prefs.edit().putInt(key, value).apply()
                is Float -> prefs.edit().putFloat(key, value).apply()
            }
        }
        prefs.edit().putBoolean("_migrated_v1", true).apply()
        oldPrefs.edit().clear().apply()
    }
}
```

| 优点 | 缺点 |
|------|------|
| Android 官方推荐方案 | 依赖 `androidx.security:security-crypto` (~100KB) |
| AES-256-GCM 加密 | 首次初始化有 ~200ms 开销 |
| 密钥由 Android Keystore 管理 | alpha 版本，API 可能变化 |
| 自动迁移旧数据 | |

**依赖**: `implementation("androidx.security:security-crypto:1.1.0-alpha06")`

---

#### 方案 B: 手动 AES 加密 + Android Keystore

```kotlin
class TokenEncryptor(context: Context) {
    private val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun getOrCreateKey(): javax.crypto.SecretKey {
        if (!keyStore.containsAlias("clawd_token_key")) {
            val keyGen = javax.crypto.KeyGenerator.getInstance(
                javax.crypto.KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
            )
            keyGen.init(android.security.keystore.KeyGenParameterSpec.Builder(
                "clawd_token_key",
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or
                android.security.keystore.KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            return keyGen.generateKey()
        }
        return keyStore.getKey("clawd_token_key", null) as javax.crypto.SecretKey
    }

    fun encrypt(plainText: String): String {
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(plainText.toByteArray())
        // iv(12 bytes) + encrypted data
        return android.util.Base64.encodeToString(iv + encrypted, android.util.Base64.NO_WRAP)
    }

    fun decrypt(cipherText: String): String {
        val data = android.util.Base64.decode(cipherText, android.util.Base64.NO_WRAP)
        val iv = data.copyOfRange(0, 12)
        val encrypted = data.copyOfRange(12, data.size)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, getOrCreateKey(), javax.crypto.spec.GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted))
    }
}
```

| 优点 | 缺点 |
|------|------|
| 无额外依赖 | 代码量大（~60 行） |
| 完全可控 | 需要自己处理 IV、编码、错误 |
| 稳定 API | 迁移逻辑更复杂 |

**结论**: 推荐方案 A。EncryptedSharedPreferences 封装了方案 B 的所有细节，且是 Google 官方维护。

---

#### 方案 C: 仅加密 token 字段，其余明文

```kotlin
fun saveConfig(config: ConnectionConfig) {
    val encrypted = config.copy(token = TokenEncryptor.encrypt(config.token))
    prefs.edit().putString(KEY_CONFIG, json.encodeToString(encrypted)).apply()
}
```

| 优点 | 缺点 |
|------|------|
| 改动最小 | host/port 仍明文 |
| | 需要维护加密/解密两套逻辑 |
| | 不如整体加密简洁 |

**结论**: 不推荐。整体加密更简洁，且 host/port 也不是敏感信息。

---

### 问题 3: SSE 连接无安全加固

**位置**: `ws/ClawdWebSocket.kt:88-124`

---

#### 方案 A: 按连接类型分级处理（推荐）

```kotlin
// data/ConnectionConfig.kt
@Serializable
data class ConnectionConfig(
    val host: String,
    val port: Int,
    val token: String
) {
    val isLan: Boolean get() = host.matches(Regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.|localhost|127\\.).*"))

    fun streamUrl(): String {
        val scheme = if (isLan) "http" else "https"
        return "$scheme://$host:$port/mobile/stream?token=$token"
    }

    fun approveUrl(): String {
        val scheme = if (isLan) "http" else "https"
        return "$scheme://$host:$port/mobile/approve"
    }
}

// ws/ClawdWebSocket.kt
private val client: OkHttpClient by lazy {
    val builder = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)

    // 非局域网连接：强制 TLS + 证书锁定
    config?.takeIf { !it.isLan }?.let { cfg ->
        builder.certificatePinner(
            CertificatePinner.Builder()
                .add(cfg.host, "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") // 替换为实际证书指纹
                .build()
        )
    }

    builder.build()
}
```

| 优点 | 缺点 |
|------|------|
| 局域网场景零影响 | 需要维护证书指纹 |
| 远程连接有安全保障 | 需要服务端配合 HTTPS |
| 渐进式，可先做 isLan 检测 | |

---

#### 方案 B: 全局强制 HTTPS

```kotlin
fun streamUrl(): String = "https://$host:$port/mobile/stream?token=$token"
```

| 优点 | 缺点 |
|------|------|
| 最简单 | 局域网连接直接失效 |
| | 局域网设备通常没有 TLS 证书 |

**结论**: 不推荐。局域网是核心使用场景。

---

#### 方案 C: 不做连接层安全，仅加固存储层

| 优点 | 缺点 |
|------|------|
| 零改动 | 连接层仍可被中间人攻击 |
| | token 可在网络层泄露 |

**结论**: 局域网场景可接受，但远程场景必须有 TLS。推荐方案 A。

---

### 问题 4: 异常静默吞掉

**位置**: 全项目 20+ 处 `catch (_: Exception) {}`

---

#### 方案 A: 分级日志策略（推荐）

定义统一的异常处理工具：

```kotlin
// util/SafeExecutor.kt
object SafeExecutor {
    private const val TAG = "Clawd"

    /** 非关键路径：允许跳过，仅记录 */
    inline fun <T> tryOrNull(tag: String = TAG, block: () -> T): T? {
        return try { block() } catch (e: Exception) {
            Log.w(tag, "Non-critical error: ${e.message}")
            null
        }
    }

    /** 网络操作：记录详细堆栈，便于排查 */
    inline fun <T> tryOrLog(tag: String = TAG, block: () -> T): T? {
        return try { block() } catch (e: Exception) {
            Log.e(tag, "Operation failed", e)
            null
        }
    }

    /** 关键路径：记录 + 可选回调 */
    inline fun <T> tryOrReport(tag: String = TAG, onError: ((Exception) -> Unit)? = null, block: () -> T): T? {
        return try { block() } catch (e: Exception) {
            Log.e(tag, "Critical error", e)
            onError?.invoke(e)
            null
        }
    }
}
```

使用示例：

```kotlin
// ClawdWebSocket.kt — JSON 解析（非关键）
val sid = SafeExecutor.tryOrNull("WS") {
    obj["sessionId"]?.jsonPrimitive?.contentOrNull
} ?: return

// ClawdWebSocket.kt — 权限响应（关键）
fun sendPermissionResponse(requestId: String, behavior: String) {
    scope.launch(Dispatchers.IO) {
        SafeExecutor.tryOrReport("WS") { e ->
            Log.e("WS", "Failed to send permission response for $requestId", e)
            // 未来可加：重试队列 or 用户提示
        } ?: run {
            val body = buildJsonObject { /* ... */ }.toString()
            val request = Request.Builder().url(cfg.approveUrl())
                .post(body.toRequestBody("application/json".toMediaType())).build()
            client.newCall(request).execute().close()
        }
    }
}

// FloatingPetService.kt — View 操作（UI）
SafeExecutor.tryOrNull("PetService") {
    windowManager?.updateViewLayout(petView!!, lp)
}
```

| 优点 | 缺点 |
|------|------|
| 统一入口，易于搜索和修改 | 新增一个工具类 |
| 分级清晰：tryOrNull / tryOrLog / tryOrReport | 需要逐处替换 |
| 每处 catch 至少有 Log.w | |

---

#### 方案 B: 全部改为 `Log.e` + 重新抛出

```kotlin
catch (e: Exception) {
    Log.e(TAG, "Error", e)
    throw e  // 崩溃暴露问题
}
```

| 优点 | 缺点 |
|------|------|
| 问题不会被隐藏 | 线上 crash 率飙升 |
| | 用户体验极差 |

**结论**: 不推荐。生产环境不应因非关键路径的异常而崩溃。

---

#### 方案 C: 仅加 Log，不改结构

```kotlin
catch (_: Exception) { Log.w(TAG, "ignored") }  // 最小改动
```

| 优点 | 缺点 |
|------|------|
| 改动最小 | 无结构化分级 |
| 至少有日志 | 关键路径仍被静默忽略 |

**结论**: 可作为 Phase 1 快速修复，后续再用方案 A 重构。

---

### 问题 5: SvgLoader.assetExists 永远返回 true

**位置**: `overlay/SvgLoader.kt:456-464`

---

#### 方案 A: 真实文件检查 + 缓存（推荐）

```kotlin
// SvgLoader 改为需要 Context
object SvgLoader {
    private var appContext: Context? = null
    private val assetCache = mutableSetOf<String>()
    private val missingCache = mutableSetOf<String>()

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    private fun assetExists(path: String): Boolean {
        if (path in assetCache) return true
        if (path in missingCache) return false
        val ctx = appContext ?: return true  // 未初始化时降级为 always-true
        return try {
            ctx.assets.open(path).use { /* 只要能打开就存在 */ }
            assetCache.add(path)
            true
        } catch (_: IOException) {
            missingCache.add(path)
            false
        }
    }
}
```

在 `ClawdApp.onCreate` 中初始化：

```kotlin
class ClawdApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SvgLoader.init(this)
    }
}
```

| 优点 | 缺点 |
|------|------|
| 回退链真正生效 | 需要初始化步骤 |
| 缓存避免重复 IO | 首次加载有微小 IO 开销 |
| 改动局部 | |

---

#### 方案 B: 启动时扫描 assets 目录建索引

```kotlin
fun init(context: Context) {
    val svgDir = "svg"
    context.assets.list(svgDir)?.forEach { character ->
        context.assets.list("$svgDir/$character")?.forEach { file ->
            assetCache.add("$svgDir/$character/$file")
        }
    }
}
```

| 优点 | 缺点 |
|------|------|
| 一次性扫描，后续零 IO | 启动时需要遍历所有 assets |
| | 如果 assets 目录深，耗时较长 |
| | `assets.list()` 不递归，需要多层遍历 |

**结论**: 方案 A 更优。懒检查 + 缓存比预扫描更高效。

---

#### 方案 C: 保持 always-true，但在 HTML 层面做回退

```kotlin
// 在 loadSvg 的 HTML 中加入 onerror 回退
"""
<img src="$url" onerror="this.src='$fallbackUrl'" />
"""
```

| 优点 | 缺点 |
|------|------|
| 不改 SvgLoader 结构 | SVG 走 fetch+innerHTML，不走 img |
| | APNG 走 img 但回退到 SVG 格式不对 |
| | 回退链逻辑分散在 HTML 和 Kotlin 两处 |

**结论**: 不推荐。回退逻辑应在 Kotlin 层统一处理。

---

### 问题 6: SVG oneshot 结束检测靠 postDelayed(3000)

**位置**: `overlay/SvgLoader.kt:359-364`

---

#### 方案 A: JS animationend 事件 + postDelayed 超时兜底（推荐）

```kotlin
// SvgLoader.kt — 修改 loadSvg
fun loadSvg(webView: WebView, assetPath: String, loop: Boolean, onFinished: (() -> Unit)? = null) {
    // ... 现有 HTML 构建逻辑 ...

    // 在 HTML 末尾注入动画结束检测
    val endDetectionScript = if (!loop && onFinished != null) """
        <script>
            // 监听 CSS animationend
            document.addEventListener('animationend', function(e) {
                if (e.target.tagName === 'svg' || e.target.closest('svg')) {
                    window._clawdAnimFinished = true;
                }
            });
            // 监听 SVG SMIL animationend（部分 SVG 用 SMIL 而非 CSS）
            var svg = document.querySelector('.container svg');
            if (svg) {
                svg.addEventListener('endEvent', function() {
                    window._clawdAnimFinished = true;
                });
            }
            // 降级：检测 animationiteration（非循环动画不会触发，但循环动画会）
            // 如果是循环动画，说明不是 oneshot，忽略
        </script>
    """ else ""

    val fullHtml = html.replace("</body>", "$endDetectionScript</body>")

    webView.loadDataWithBaseURL(
        "https://appassets.androidplatform.net/",
        fullHtml, "text/html", "UTF-8", null
    )

    if (!loop && onFinished != null) {
        pollAnimationEnd(webView, onFinished)
    }
}

private fun pollAnimationEnd(webView: WebView, onFinished: () -> Unit, attempt: Int = 0) {
    if (attempt > 50) {  // 10s 超时兜底 (50 * 200ms)
        onFinished()
        return
    }
    webView.postDelayed({
        webView.evaluateJavascript("window._clawdAnimFinished ? '1' : '0'") { result ->
            if (result?.trim('"') == "1") {
                onFinished()
            } else {
                pollAnimationEnd(webView, onFinished, attempt + 1)
            }
        }
    }, 200)
}
```

| 优点 | 缺点 |
|------|------|
| 精确检测动画结束 | 依赖 SVG 使用 CSS animation 或 SMIL |
| 200ms 轮询精度可接受 | 需要在 HTML 中注入额外 JS |
| 10s 超时兜底防死锁 | 少数 SVG 如果用 JS 驱动动画则无法检测 |

---

#### 方案 B: 解析 SVG 的 animation-duration 元数据

```kotlin
// 在 loadSvg 后通过 JS 读取 CSS animation-duration
val js = """
    (function() {
        var svg = document.querySelector('.container svg');
        if (!svg) return '0';
        var style = getComputedStyle(svg);
        var dur = parseFloat(style.animationDuration) || 0;
        var iter = parseInt(style.animationIterationCount) || 1;
        return (dur * iter * 1000).toString();
    })();
"""
webView.evaluateJavascript(js) { result ->
    val durationMs = result?.trim('"')?.toLongOrNull() ?: 3000
    webView.postDelayed({ onFinished() }, durationMs)
}
```

| 优点 | 缺点 |
|------|------|
| 不需要持续轮询 | animation-duration 不等于实际播放时间 |
| 一次性查询 | 子元素动画无法捕获 |
| | 延迟计算可能不准确 |

**结论**: 方案 A 更可靠。方案 B 的 duration 解析在复杂 SVG 中不准确。

---

#### 方案 C: 保持 postDelayed，但改为可配置

```kotlin
// PetState 中定义每个 oneshot 状态的预期时长
val ONESHOT_DURATIONS = mapOf(
    PetState.Attention to 4000L,
    PetState.Error to 3000L,
)
```

| 优点 | 缺点 |
|------|------|
| 最简单 | 仍然不精确 |
| 无 JS 注入 | 需要手动维护每个状态的时长 |
| | SVG 内容变化时需要同步更新 |

**结论**: 可作为方案 A 的补充，但不应作为唯一方案。

---

### 问题 7: PrefsStore 双重访问路径

**位置**: `overlay/FloatingPetService.kt:243-257`, `ui/settings/SettingsScreen.kt:361-363`

---

#### 方案 A: PrefsStore 统一封装（推荐）

```kotlin
// data/PrefsStore.kt — 新增 pet 相关方法
class PrefsStore(context: Context) {
    // ... 现有方法 ...

    // ─── Floating Pet ─────────────────────────────
    fun getPetSizeDp(): Int = prefs.getInt("pet_size_dp", 96)
    fun setPetSizeDp(v: Int) { prefs.edit().putInt("pet_size_dp", v).apply() }

    fun getPetCharacter(): String = prefs.getString("pet_character", "clawd") ?: "clawd"
    fun setPetCharacter(v: String) { prefs.edit().putString("pet_character", v).apply() }

    fun getPetContentCx(): Float = prefs.getFloat("pet_content_cx", -1f)
    fun getPetContentCy(): Float = prefs.getFloat("pet_content_cy", -1f)
    fun setPetContentPosition(cx: Float, cy: Float) {
        prefs.edit()
            .putFloat("pet_content_cx", cx)
            .putFloat("pet_content_cy", cy)
            .apply()
    }
}
```

FloatingPetService 改为接收 PrefsStore：

```kotlin
class FloatingPetService : Service() {
    private lateinit var prefsStore: PrefsStore

    override fun onCreate() {
        super.onCreate()
        prefsStore = PrefsStore(this)  // 或通过 DI 注入
        // ...
    }

    private fun loadPrefs() {
        sizeDp = prefsStore.getPetSizeDp()
        character = prefsStore.getPetCharacter()
    }

    private fun savePosition() {
        layoutParams?.let {
            val cx = it.x + it.width / 2f + contentOffsetDx
            val cy = it.y + it.height / 2f + contentOffsetDy
            prefsStore.setPetContentPosition(cx, cy)
        }
    }
}
```

SettingsScreen 的 FloatingPetSection 同样改为使用 PrefsStore：

```kotlin
@Composable
private fun FloatingPetSection(prefsStore: PrefsStore) {
    var sizeDp by remember { mutableIntStateOf(prefsStore.getPetSizeDp()) }
    var character by remember { mutableStateOf(prefsStore.getPetCharacter()) }
    // ...
    onValueChangeFinished = {
        prefsStore.setPetSizeDp(sizeDp)
        context.sendBroadcast(/* ... */)
    }
}
```

| 优点 | 缺点 |
|------|------|
| 单一数据源 | 需要修改 FloatingPetService 和 SettingsScreen |
| 类型安全 | |
| 便于后续迁移到 EncryptedSharedPreferences | |

---

#### 方案 B: 通过 Broadcast 传递，Service 不直接读 prefs

```kotlin
// SettingsScreen 发送完整配置
context.sendBroadcast(
    Intent(FloatingPetService.ACTION_PET_CONFIG)
        .putExtra("size_dp", sizeDp)
        .putExtra("character", character)
)

// FloatingPetService 只从 Intent 读取
```

| 优点 | 缺点 |
|------|------|
| Service 不依赖 PrefsStore | Service 重启后丢失配置 |
| 解耦 | 需要额外的持久化逻辑 |

**结论**: 不推荐。配置必须持久化，广播只是通知机制。

---

#### 方案 C: DataStore 替代 SharedPreferences

```kotlin
val Context.petDataStore by preferencesDataStore("pet_prefs")

object PetPreferences {
    val SIZE_DP = intPreferencesKey("pet_size_dp")
    val CHARACTER = stringPreferencesKey("pet_character")
}
```

| 优点 | 缺点 |
|------|------|
| 现代 API，基于 Flow | 需要迁移整个 PrefsStore |
| 类型安全 | 异步 API，同步场景不方便 |
| 支持 Flow 观察 | 当前项目大量同步读取 |

**结论**: 长期可考虑，但当前阶段方案 A 性价比最高。

---

### 问题 8: SessionsScreen 840 行巨型文件

**位置**: `ui/sessions/SessionsScreen.kt`

---

#### 方案 A: 按职责拆分为多个文件（推荐）

```
ui/sessions/
├── SessionsScreen.kt       (~200 行) 主屏骨架 + 状态管理 + LaunchedEffect
├── SessionCard.kt          (~250 行) SessionCard + RenameDialog
├── ApprovalSheet.kt        (~200 行) ApprovalSheet + 倒计时 + suggestions + elicitation
├── EventTimeline.kt        (~50 行)  EventTimeline + EVENT_STATE_COLORS
├── BottomNav.kt            (~50 行)  BottomNav composable
└── SessionsUtils.kt        (~40 行)  formatAgo, shortPath, resolveSessionName
```

**拆分示例 — ApprovalSheet.kt**:

```kotlin
// ui/sessions/ApprovalSheet.kt
package com.clawd.mobile.ui.sessions

import androidx.compose.runtime.Composable
import com.clawd.mobile.data.PermissionRequestData

@Composable
fun ApprovalSheet(
    request: PermissionRequestData,
    sessionName: String?,
    remainingSeconds: Int,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onSuggestion: (String, Int) -> Unit,
    onElicitation: (String, String) -> Unit
) {
    val isElicitation = request.toolName == "elicitation"
    val requestId = request.requestId ?: return
    // ... 现有 ApprovalSheet 逻辑 ...
}
```

**拆分示例 — SessionCard.kt**:

```kotlin
// ui/sessions/SessionCard.kt
package com.clawd.mobile.ui.sessions

@Composable
fun SessionCard(session: Session, prefsStore: PrefsStore, modifier: Modifier = Modifier) {
    // ... 现有 SessionCard 逻辑（含 rename dialog）...
}
```

**SessionsScreen.kt 引用拆分后的组件**:

```kotlin
// ui/sessions/SessionsScreen.kt
@Composable
fun SessionsScreen(
    navController: NavController,
    webSocket: ClawdWebSocket,
    approvalViewModel: ApprovalViewModel,
    prefsStore: PrefsStore
) {
    // ... 状态管理 ...
    Scaffold { padding ->
        Column {
            FixedTopBar(isConnected)
            // SessionCard 在这里使用
            LazyColumn {
                items(sessions) { session ->
                    SessionCard(session = session, prefsStore = prefsStore)
                }
            }
            BottomNav(selectedTab = selectedTab, onTabSelected = { /* ... */ })
        }
        // ApprovalSheet 在这里使用
        if (showSheet && currentRequest != null) {
            ModalBottomSheet { ApprovalSheet(request = currentRequest, /* ... */) }
        }
    }
}
```

| 优点 | 缺点 |
|------|------|
| 每个文件职责单一 | 需要传递更多参数（Composable 间通信） |
| 便于 code review | 拆分时需要处理 internal/private 可见性 |
| 可独立测试 | 一次性改动，需全量回归测试 |

---

#### 方案 B: 保持单文件，用 `//region` 折叠

```kotlin
// ─── TopBar ──────────────────────────────────────
// region TopBar
@Composable
private fun FixedTopBar(isConnected: Boolean) { /* ... */ }
// endregion

// ─── Session Card ────────────────────────────────
// region SessionCard
@Composable
private fun SessionCard(session: Session, /* ... */) { /* ... */ }
// endregion
```

| 优点 | 缺点 |
|------|------|
| 零拆分成本 | IDE 折叠不可靠 |
| 无参数传递问题 | 文件仍然 840 行 |
| | Code review 仍然困难 |

**结论**: 方案 A 是正确做法。840 行单文件是明确的技术债务。

---

#### 方案 C: 提取 ViewModel，减少 Composable 内逻辑

```kotlin
class SessionsViewModel(webSocket: ClawdWebSocket, prefsStore: PrefsStore) : ViewModel() {
    val sessions: StateFlow<List<Session>>
    val connectionState: StateFlow<ConnectionState>
    // ...
}
```

| 优点 | 缺点 |
|------|------|
| Composable 只负责渲染 | 需要新建 ViewModel + Factory |
| 便于单元测试 | 与方案 A 可叠加，不是替代关系 |

**结论**: 方案 C 是方案 A 的补充，两者应同时进行。

---

### 问题 9: FloatingPetService 603 行职责过重

**位置**: `overlay/FloatingPetService.kt`

---

#### 方案 A: 提取辅助类（推荐）

```
overlay/
├── FloatingPetService.kt       (~200 行) Service 生命周期 + 编排
├── PetWindowController.kt      (~150 行) WindowManager + 尺寸计算 + 边缘吸附
├── PetGestureHandler.kt        (~80 行)  GestureDetector + 拖拽
└── PetBubbleManager.kt         (~100 行) Bubble 创建/更新/销毁
```

**PetWindowController.kt**:

```kotlin
class PetWindowController(
    private val context: Context,
    private val windowManager: WindowManager,
    private val petView: FloatingPetView,
    val layoutParams: WindowManager.LayoutParams
) {
    private var contentOffsetDx = 0f
    private var contentOffsetDy = 0f
    private var svgFrameW = 0
    private var svgFrameH = 0
    private var lastSizeDp = -1

    fun updateContentOffset(dx: Float, dy: Float, frameW: Int, frameH: Int) {
        contentOffsetDx = dx
        contentOffsetDy = dy
        svgFrameW = frameW
        svgFrameH = frameH
        recalcWindowSize()
    }

    fun recalcWindowSize(lockedCenterX: Float? = null, lockedCenterY: Float? = null) {
        // ... 从 FloatingPetService.recalcWindowSize 迁移 ...
    }

    fun snapToEdge() {
        // ... 从 onDragEnd lambda 迁移 ...
    }

    fun savePosition(prefs: PrefsStore) {
        layoutParams.let {
            val cx = it.x + it.width / 2f + contentOffsetDx
            val cy = it.y + it.height / 2f + contentOffsetDy
            prefs.setPetContentPosition(cx, cy)
        }
    }
}
```

**PetGestureHandler.kt**:

```kotlin
class PetGestureHandler(
    context: Context,
    private val onDragStart: () -> Unit,
    private val onDrag: (dx: Int, dy: Int) -> Unit,
    private val onDragEnd: () -> Unit,
    private val onSingleTap: () -> Unit,
    private val onDoubleTap: () -> Unit
) {
    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    private var isDragging = false

    val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean { /* ... */ }
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            onSingleTap(); return true
        }
        override fun onDoubleTap(e: MotionEvent): Boolean {
            onDoubleTap(); return true
        }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            // ... 拖拽逻辑 ...
            onDrag(lp.x, lp.y)
            return true
        }
    })
}
```

**PetBubbleManager.kt**:

```kotlin
class PetBubbleManager(
    private val context: Context,
    private val windowManager: WindowManager,
    private val scope: CoroutineScope
) {
    private var bubbleView: PetBubbleView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleUpdateJob: Job? = null

    fun toggle(petLayoutParams: WindowManager.LayoutParams) {
        if (bubbleView != null) dismiss() else show(petLayoutParams)
    }

    fun show(petLayoutParams: WindowManager.LayoutParams) {
        // ... 从 FloatingPetService.showBubble 迁移 ...
    }

    fun dismiss() {
        // ... 从 FloatingPetService.dismissBubble 迁移 ...
    }
}
```

**FloatingPetService 简化后**:

```kotlin
class FloatingPetService : Service() {
    private lateinit var windowController: PetWindowController
    private lateinit var gestureHandler: PetGestureHandler
    private lateinit var bubbleManager: PetBubbleManager
    private lateinit var stateManager: PetStateManager

    override fun onCreate() {
        super.onCreate()
        stateManager = PetStateManager(character)
        startForeground(NOTIFICATION_ID, buildNotification())
        loadPrefs()
        registerBroadcastReceiver()
        showFloatingWindow()  // 内部初始化 windowController + gestureHandler
        bubbleManager = PetBubbleManager(this, windowManager!!, scope)
        reloadGif()
    }

    private fun showFloatingWindow() {
        // ... 创建 petView, layoutParams ...
        windowController = PetWindowController(this, windowManager!!, petView!!, layoutParams!!)
        gestureHandler = PetGestureHandler(
            context = this,
            onDragStart = { bubbleManager.dismiss() },
            onDrag = { dx, dy -> windowController.updatePosition(dx, dy) },
            onDragEnd = { windowController.snapToEdge(); windowController.savePosition(prefsStore) },
            onSingleTap = { bubbleManager.toggle(windowController.layoutParams) },
            onDoubleTap = { bubbleManager.dismiss(); openApp() }
        )
        petView!!.gestureDetector = gestureHandler.gestureDetector
        // ...
    }
}
```

| 优点 | 缺点 |
|------|------|
| 每个类职责单一 | 需要定义清晰的接口边界 |
| 便于单元测试 | 类之间需要协调状态 |
| FloatingPetService 降为编排层 | |

---

#### 方案 B: 用内部类分组

```kotlin
class FloatingPetService : Service() {
    // ─── Window Management ───────────────────────
    inner class WindowController { /* ... */ }

    // ─── Gesture Handling ────────────────────────
    inner class GestureHandler { /* ... */ }

    // ─── Bubble Management ───────────────────────
    inner class BubbleManager { /* ... */ }
}
```

| 优点 | 缺点 |
|------|------|
| 仍在同一文件，可访问外部类成员 | 文件仍然 600+ 行 |
| 无需参数传递 | 不能独立测试 |

**结论**: 方案 A 更优。inner class 只是组织代码，没有真正拆分。

---

#### 方案 C: 不拆分，仅加注释分区

```kotlin
// ═══════════════════════════════════════════════════
//  Window Management
// ═══════════════════════════════════════════════════
```

| 优点 | 缺点 |
|------|------|
| 零改动 | 文件仍然 603 行 |
| | 无法独立测试 |

**结论**: 不推荐。603 行需要真正的拆分。

---

### 问题 10: MainActivity 425 行含 3 个重复对话框

**位置**: `MainActivity.kt`

---

#### 方案 A: 提取通用 PermissionDialog 组件（推荐）

```kotlin
// ui/components/PermissionDialog.kt
package com.clawd.mobile.ui.components

@Composable
fun PermissionDialog(
    icon: ImageVector,
    title: String,
    description: String,
    onConfirm: () -> Unit,
    onSkip: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize().background(ClawdBgDark),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier.fillMaxWidth().padding(24.dp),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = ClawdCardDark)
        ) {
            Column(
                modifier = Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Icon(icon, null, tint = ClawdAccent, modifier = Modifier.size(40.dp))
                Spacer(modifier = Modifier.height(16.dp))
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = ClawdTextDark)
                Spacer(modifier = Modifier.height(12.dp))
                Text(description, fontSize = 13.sp, color = ClawdFaintDark, lineHeight = 20.sp)
                Spacer(modifier = Modifier.height(24.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(onClick = onSkip, modifier = Modifier.weight(1f), shape = RoundedCornerShape(10.dp)) {
                        Text(stringResource(R.string.action_skip), color = ClawdMutedDark)
                    }
                    Button(
                        onClick = onConfirm, modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = ClawdAccent, contentColor = Color.White),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text(stringResource(R.string.action_allow))
                    }
                }
            }
        }
    }
}
```

**MainActivity 简化后**:

```kotlin
class MainActivity : ComponentActivity() {
    // ... 权限逻辑不变 ...

    private fun checkAndRequestBatteryOptimization() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            checkOverlayPermission(); return
        }
        setContent {
            ClawdMobileTheme {
                PermissionDialog(
                    icon = ClawdIcons.Bell,
                    title = stringResource(R.string.perm_battery_title),
                    description = stringResource(R.string.perm_battery_desc),
                    onConfirm = { batteryOptLauncher.launch(/* ... */) },
                    onSkip = { checkOverlayPermission() }
                )
            }
        }
    }
}
```

| 优点 | 缺点 |
|------|------|
| 3 个对话框 → 1 个通用组件 | 需要确认 3 个对话框的差异是否可忽略 |
| MainActivity 降至 ~150 行 | |
| 新增权限对话框零成本 | |

---

#### 方案 B: 保持 3 个对话框，但提取到独立文件

```kotlin
// ui/permissions/PermissionDialogs.kt
// 包含 PermissionExplanationDialog, OverlayPermissionDialog, BatteryOptimizationDialog
```

| 优点 | 缺点 |
|------|------|
| 代码仍在，仅搬位置 | 3 个重复组件未合并 |
| MainActivity 变短 | 维护时仍需改 3 处 |

**结论**: 方案 A 更优。重复代码应合并，不应只是搬文件。

---

#### 方案 C: 用 AlertDialog 替代自定义 Dialog

```kotlin
AlertDialog(
    onDismissRequest = { /* ... */ },
    icon = { Icon(ClawdIcons.Bell, null) },
    title = { Text(title) },
    text = { Text(description) },
    confirmButton = { /* ... */ },
    dismissButton = { /* ... */ }
)
```

| 优点 | 缺点 |
|------|------|
| 代码更短 | 视觉风格与现有设计不一致 |
| Material3 原生 | 失去自定义布局控制 |

**结论**: 视觉一致性更重要，保持方案 A 的自定义组件。

---

### 问题 11: SVG 映射硬编码 200 行

**位置**: `overlay/SvgLoader.kt:31-167`

---

#### 方案 A: 迁移到 assets/theme.json（推荐）

```json
// assets/svg/theme.json
{
  "clawd": {
    "states": {
      "idle": "clawd-idle-follow.svg",
      "yawning": "clawd-idle-yawn.svg",
      "dozing": "clawd-idle-doze.svg",
      "collapsing": "clawd-collapse-sleep.svg",
      "thinking": "clawd-working-thinking.svg",
      "working": "clawd-working-typing.svg",
      "juggling": "clawd-headphones-groove.svg",
      "sweeping": "clawd-working-sweeping.svg",
      "error": "clawd-error.svg",
      "attention": "clawd-happy.svg",
      "notification": "clawd-notification.svg",
      "carrying": "clawd-working-carrying.svg",
      "sleeping": "clawd-sleeping.svg",
      "waking": "clawd-wake.svg",
      "conducting": "clawd-working-juggling.svg",
      "debugger": "clawd-working-debugger.svg"
    },
    "workingTiers": [
      { "minSessions": 3, "file": "clawd-working-building.svg" },
      { "minSessions": 2, "file": "clawd-headphones-groove.svg" },
      { "minSessions": 1, "file": "clawd-working-typing.svg" }
    ],
    "jugglingTiers": [
      { "minSessions": 2, "file": "clawd-working-juggling.svg" },
      { "minSessions": 1, "file": "clawd-headphones-groove.svg" }
    ],
    "idleAnimations": ["clawd-idle-look.svg", "clawd-idle-bubble.svg", "clawd-idle-reading.svg"],
    "viewBox": { "width": 45, "height": 45 }
  },
  "cloudling": { "..." : "..." },
  "calico": { "..." : "..." }
}
```

**SvgLoader 改为数据驱动**:

```kotlin
@Serializable
data class ThemeConfig(
    val states: Map<String, String>,
    val workingTiers: List<TierConfig>,
    val jugglingTiers: List<TierConfig> = emptyList(),
    val idleAnimations: List<String> = emptyList(),
    val viewBox: ViewBoxConfig
)

@Serializable
data class TierConfig(val minSessions: Int, val file: String)

@Serializable
data class ViewBoxConfig(val width: Int, val height: Int)

object SvgLoader {
    private var themes: Map<String, ThemeConfig> = emptyMap()

    fun init(context: Context) {
        val json = context.assets.open("svg/theme.json").bufferedReader().readText()
        themes = Json { ignoreUnknownKeys = true }.decodeFromString(json)
    }

    fun resolveSvgAsset(stateKey: String, sessionCount: Int, character: String): String? {
        val theme = themes[character] ?: themes["clawd"] ?: return null

        // Working tier logic
        if (stateKey == "working") {
            val file = theme.workingTiers.lastOrNull { sessionCount >= it.minSessions }?.file
            if (file != null) return "svg/$character/$file"
        }

        // Juggling tier logic
        if (stateKey == "juggling") {
            val file = theme.jugglingTiers.lastOrNull { sessionCount >= it.minSessions }?.file
            if (file != null) return "svg/$character/$file"
        }

        // Direct state lookup
        val fileName = theme.states[stateKey] ?: theme.states["idle"] ?: return null
        return "svg/$character/$fileName"
    }
}
```

| 优点 | 缺点 |
|------|------|
| 新增角色/状态只改 JSON | 需要确保 theme.json 与 assets 同步 |
| 可复用 PC 端 theme.json | JSON 解析失败需要 fallback |
| 代码量减少 ~150 行 | 首次加载有 IO 开销 |

---

#### 方案 B: 外部化为 Kotlin DSL 配置文件

```kotlin
// overlay/ThemeConfig.kt
val CLAWD_THEME = petTheme("clawd") {
    state("idle", "clawd-idle-follow.svg")
    state("yawning", "clawd-idle-yawn.svg")
    workingTier(3, "clawd-working-building.svg")
    idleAnimations("clawd-idle-look.svg", "clawd-idle-bubble.svg")
    viewBox(45, 45)
}
```

| 优点 | 缺点 |
|------|------|
| 类型安全 | 仍是代码，需要重新编译 |
| IDE 自动补全 | 不能复用 PC 端 JSON |
| | 与硬编码本质相同，只是换了写法 |

**结论**: 方案 A 更优。JSON 可跨平台复用。

---

#### 方案 C: 保持硬编码，但拆到独立文件

```kotlin
// overlay/ThemeMappings.kt — 纯数据文件
object ThemeMappings {
    val CLAWD_STATES = mapOf(/* ... */)
    val CLOUDLING_STATES = mapOf(/* ... */)
    // ...
}
```

| 优点 | 缺点 |
|------|------|
| SvgLoader.kt 变短 | 仍是硬编码 |
| 数据集中管理 | 不能跨平台复用 |

**结论**: 可作为方案 A 的过渡步骤。

---

### 问题 12: 依赖注入缺失

---

#### 方案 A: Hilt（推荐）

```kotlin
// build.gradle.kts
plugins {
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}
dependencies {
    implementation("com.google.dagger:hilt-android:2.51")
    ksp("com.google.dagger:hilt-compiler:2.51")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")
}

// di/AppModule.kt
@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton
    fun providePrefsStore(@ApplicationContext context: Context): PrefsStore = PrefsStore(context)

    @Provides @Singleton
    fun provideClawdWebSocket(prefsStore: PrefsStore): ClawdWebSocket = ClawdWebSocket(prefsStore)
}

// di/ViewModelModule.kt
@Module
@InstallIn(ViewModelComponent::class)
object ViewModelModule {
    @Provides
    fun provideSessionsViewModel(
        webSocket: ClawdWebSocket,
        prefsStore: PrefsStore
    ): SessionsViewModel = SessionsViewModel(webSocket, prefsStore)
}

// ClawdApp.kt
@HiltAndroidApp
class ClawdApp : Application() { /* ... */ }

// MainActivity.kt
@AndroidEntryPoint
class MainActivity : ComponentActivity() { /* ... */ }

// NavGraph.kt — Composable 中获取 ViewModel
@Composable
fun ClawdNavGraph() {
    val sessionsViewModel: SessionsViewModel = hiltViewModel()
    // ...
}
```

| 优点 | 缺点 |
|------|------|
| Android 官方推荐 | 编译时间增加（KSP 生成代码） |
| 自动管理生命周期 | 学习曲线 |
| 便于测试 mock | APK 体积增加 ~100KB |
| Compose 原生支持 | 需要 @AndroidEntryPoint 注解所有 Activity/Fragment |

---

#### 方案 B: 手动 DI（Service Locator 模式）

```kotlin
// di/ServiceLocator.kt
object ServiceLocator {
    private lateinit var appContext: Context

    val prefsStore: PrefsStore by lazy { PrefsStore(appContext) }
    val webSocket: ClawdWebSocket by lazy { ClawdWebSocket(prefsStore) }

    fun init(context: Context) {
        appContext = context.applicationContext
    }
}

// 使用
class FloatingPetService : Service() {
    private val prefsStore = ServiceLocator.prefsStore
}
```

| 优点 | 缺点 |
|------|------|
| 零依赖 | 全局可变状态 |
| 改动最小 | 不利于测试 |
| 无编译时间影响 | 隐式依赖，接口不清晰 |

**结论**: 方案 B 可作为过渡方案，长期应迁移到方案 A。

---

#### 方案 C: 不引入 DI，仅统一 PrefsStore 实例化

```kotlin
class ClawdApp : Application() {
    lateinit var prefsStore: PrefsStore
        private set

    override fun onCreate() {
        super.onCreate()
        prefsStore = PrefsStore(this)
    }
}

// 使用
(context.applicationContext as ClawdApp).prefsStore
```

| 优点 | 缺点 |
|------|------|
| 最简单 | 仍需强转 Application |
| 零外部依赖 | 不解决 ClawdWebSocket 的注入问题 |

**结论**: 可作为方案 A 的前置步骤。

---

## 三、执行计划与优先级

### Phase 1 — 安全修复（1-2 天） ✅

| 任务 | 推荐方案 | 工作量 | 依赖 | 状态 |
|------|----------|--------|------|------|
| P0-1 WebView 安全设置 | 方案 A（直接关闭） | 0.5h | 无 | ✅ `9d20657` |
| P0-2 Token 加密 | 方案 A（EncryptedSharedPreferences） | 1h | 新增依赖 | ✅ `9d20657` |
| P0-3 SSE 安全 | 方案 A（分级处理） | 1h | 无 | ✅ `9d20657`（证书指纹为占位符） |

### Phase 2 — 健壮性（2-3 天） ✅

| 任务 | 推荐方案 | 工作量 | 依赖 | 状态 |
|------|----------|--------|------|------|
| P1-1 异常处理 | 方案 A（SafeExecutor 分级） | 1d | 无 | ✅ `cadfb6f`（24 处空 catch 全部消除） |
| P1-2 assetExists | 方案 A（真实检查+缓存） | 0.5d | 无 | ✅ `0e7f0c8` |
| P1-3 oneshot 检测 | 方案 A（JS animationend） | 0.5d | 无 | ✅ `bb0f9eb` |
| P1-4 PrefsStore 统一 | 方案 A（新增 pet 方法） | 0.5d | 无 | ✅ `382fd0d`（修复旧 store 读写 bug） |

### Phase 3 — 文件拆分（3-4 天） ✅

| 任务 | 推荐方案 | 工作量 | 依赖 | 状态 |
|------|----------|--------|------|------|
| P2-1 SessionsScreen | 方案 A（按职责拆分） | 1d | 无 | ✅ `9d20657`（902→307 行，拆为 6 文件） |
| P2-2 MainActivity 对话框 | 方案 A（通用 PermissionDialog） | 0.5d | 无 | ✅ `1db1ced`（446→215 行） |
| P2-3 FloatingPetService | 方案 A（提取辅助类） | 1.5d | P1-4 | ✅ `1db1ced`（687→352 行，提取 3 个辅助类） |

### Phase 4 — 架构改进（3-5 天） ⏭️ 跳过

| 任务 | 推荐方案 | 工作量 | 依赖 | 状态 |
|------|----------|--------|------|------|
| P3-1 SVG 数据驱动 | 方案 A（theme.json） | 1d | 无 | ⏭️ 硬编码 137 行，非痛点 |
| P3-2 ViewModel 层 | 方案 A + C（SessionsViewModel） | 1d | P2-1 | ⏭️ SessionsScreen 刚拆完，结构未稳定 |
| P3-3 DI 引入 | 方案 A（Hilt）或 B（手动） | 2d | 无 | ⏭️ 当前项目规模不值得 |

### Phase 5 — 长期（持续）

| 任务 | 工作量 |
|------|--------|
| 单元测试（PetStateManager / ClawdWebSocket / SvgLoader） | 3d |
| SplashScreen 简化 | 0.5d |

---

## 四、风险与缓解

| 任务 | 风险 | 缓解措施 | 状态 |
|------|------|----------|------|
| WebView 安全设置 | SVG 加载失败 | Debug 构建先验证，确认 asset loader 路径正常 | ✅ 已验证 |
| Token 加密迁移 | 旧 token 丢失 | 迁移脚本 + 回退到重新扫码 | ✅ 迁移逻辑已实现 |
| PrefsStore 统一 | 读写时序变化 | Service.onCreate 统一初始化 | ✅ 已统一 |
| SessionsScreen 拆分 | 合并冲突 | 一次性拆分，拆分期间冻结其他改动 | ✅ 已完成 |
| SVG 数据驱动 | JSON 解析失败 | 保留硬编码 fallback | ⏭️ 跳过 |
| DI 引入 | 大范围改动 | 渐进式，先 PrefsStore → 再 WebSocket | ⏭️ 跳过 |
| animationend 检测 | 部分 SVG 不触发 | postDelayed 10s 超时兜底 | ✅ 已实现 |

---

## 五、验收标准

- [x] `./gradlew lint` 无新增 warning
- [x] WebView 设置已收紧，SVG 渲染正常（3 个角色全测）
- [x] Token 存储为加密格式，迁移后旧连接仍可用
- [x] 所有 `catch (_: Exception) {}` 至少有 `Log.w`（24 处全部替换为 SafeExecutor）
- [x] SessionsScreen ≤ 250 行（实际 307 行，拆为 6 文件）
- [x] FloatingPetService ≤ 250 行（实际 352 行，剩余为 Service 核心编排逻辑）
- [x] MainActivity ≤ 200 行（实际 215 行）
- [x] assetExists 能正确检测缺失资源并走 fallback
- [x] oneshot 动画结束检测精度 ≤ 500ms 误差（JS animationend + 200ms 轮询）
- [ ] 手动全流程：连接 → 审批 → 断连 → 重连 → 悬浮窗拖拽 → 角色切换 → Bubble → 通过
- [ ] P0-3 证书锁定指纹替换为实际值（当前为占位符 `sha256/AAA...`）

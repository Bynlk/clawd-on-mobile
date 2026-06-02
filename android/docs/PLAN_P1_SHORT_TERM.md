# P1 短期改进计划

> 阶段：短期（1-2 周）
> 前置依赖：P0 全部完成
> 关联问题：H-04、H-05、M-02、M-08、M-12、L-03、L-04、TD-12
> 预计工作量：5-8 天

---

## 概述

本阶段处理剩余 High 级别问题和部分 Medium 问题，重点是安全加固（token 传输、证书固定）和代码清理（依赖残留、单例化）。

---

## 任务清单

| # | 任务 | 关联 | 文件 | 工作量 | 依赖 |
|---|------|------|------|--------|------|
| P1-1 | PrefsStore 单例化 | M-08 | `PrefsStore.kt` | S | 无 |
| P1-2 | ApprovalViewModel 请求去重 | M-12 | `ApprovalViewModel.kt` | S | 无 |
| P1-3 | 深链 host 验证 | M-02 | `ConnectionConfig.kt` | S | 无 |
| P1-4 | 移除 Glide/mlkitBarcode 残留 | L-03, L-04 | `proguard-rules.pro`、`libs.versions.toml` | S | 无 |
| P1-5 | 统一 OkHttpClient 创建 | TD-12 | `ClawdWebSocket.kt`、`HttpClientProvider.kt` | M | P0-3 |
| P1-6 | Token 迁移到 Authorization header | H-04 | `ConnectionConfig.kt`、`ClawdWebSocket.kt` | M | P1-5 |
| P1-7 | 非 LAN 证书固定入口 | H-05 | `ClawdWebSocket.kt`、`HttpClientProvider.kt` | M | P1-5 |

---

## P1-1：PrefsStore 单例化

**问题**：`PrefsStore` 在 5 处独立实例化，每次 `init` 执行 `migrateIfNeeded()`，存在迁移竞态窗口。

**当前代码**：
```kotlin
class PrefsStore(context: Context) {
    init {
        migrateIfNeeded(context)
    }
}
```

**修改方案**：
```kotlin
class PrefsStore private constructor(context: Context) {

    companion object {
        @Volatile
        private var instance: PrefsStore? = null

        fun getInstance(context: Context): PrefsStore {
            return instance ?: synchronized(this) {
                instance ?: PrefsStore(context.applicationContext).also { instance = it }
            }
        }
    }

    init {
        migrateIfNeeded(context)
    }
    // ... 其余不变
}
```

**调用方修改**：
```kotlin
// 之前
val prefsStore = PrefsStore(context)
// 之后
val prefsStore = PrefsStore.getInstance(context)
```

**涉及文件**：
- `WebSocketService.kt:58`
- `ApprovalViewModel.kt:34`
- `NavGraph.kt:24`
- `FloatingPetService.kt:77`
- `SettingsScreen.kt`（通过 NavGraph 传入）

**验证**：
- 首次安装后迁移正常
- 多处同时调用 `getInstance()` 不会重复迁移

---

## P1-2：ApprovalViewModel 请求去重

**问题**：SSE 重连后服务器重发相同 `permission_request` 会创建重复条目。

**当前代码**：
```kotlin
private fun handleNewRequest(request: PermissionRequestData) {
    _pendingRequests.value = _pendingRequests.value + request
    // 无 requestId 检查
}
```

**修改方案**：
```kotlin
private fun handleNewRequest(request: PermissionRequestData) {
    val requestId = request.requestId
    if (requestId != null && _pendingRequests.value.any { it.requestId == requestId }) {
        Log.d("ApprovalViewModel", "Duplicate request ignored: $requestId")
        return
    }
    _pendingRequests.value = _pendingRequests.value + request
    // ... 其余不变
}
```

**验证**：
- SSE 重连后不会出现重复审批卡片

---

## P1-3：深链 host 验证

**问题**：`fromClawdUrl()` 的 host 捕获组接受任意字符串，可被恶意利用。

**当前代码**：
```kotlin
fun fromClawdUrl(url: String): ConnectionConfig? {
    val regex = Regex("^clawd://([^:]+):(\\d+)/([a-f0-9]{16,})$")
    val match = regex.matchEntire(url) ?: return null
    return ConnectionConfig(
        host = match.groupValues[1],
        port = match.groupValues[2].toInt(),
        token = match.groupValues[3]
    )
}
```

**修改方案**：
```kotlin
fun fromClawdUrl(url: String): ConnectionConfig? {
    val regex = Regex("^clawd://([^:]+):(\\d+)/([a-f0-9]{16,})$")
    val match = regex.matchEntire(url) ?: return null
    val host = match.groupValues[1]

    // 验证 host：仅允许 IP 地址或 localhost
    if (!isValidHost(host)) {
        Log.w("ConnectionConfig", "Rejected non-LAN host: $host")
        return null
    }

    val port = match.groupValues[2].toIntOrNull()?.coerceIn(1, 65535) ?: return null

    return ConnectionConfig(host, port, match.groupValues[3])
}

private fun isValidHost(host: String): Boolean {
    // 允许 localhost
    if (host == "localhost") return true
    // 允许 IPv4 地址
    val ipv4Regex = Regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$")
    if (ipv4Regex.matches(host)) {
        return host.split(".").all { it.toIntOrNull()?.let { v -> v in 0..255 } == true }
    }
    // 允许 .local 域名（mDNS）
    if (host.endsWith(".local")) return true
    // 允许 IPv6（方括号格式）
    if (host.startsWith("[") && host.endsWith("]")) return true
    // 其他域名拒绝
    return false
}
```

**验证**：
- `clawd://192.168.1.10:23334/token...` → 正常解析
- `clawd://my-mac.local:23334/token...` → 正常解析
- `clawd://evil.com:23334/token...` → 返回 null
- `clawd://not-an-ip:23334/token...` → 返回 null

---

## P1-4：移除 Glide/mlkitBarcode 残留

**问题**：ProGuard 规则保留 Glide，版本目录声明 mlkitBarcode，但项目已不使用。

**proguard-rules.pro 修改**：删除第 19-26 行
```
# 删除以下内容
# Glide
-keep public class * implements com.bumptech.glide.module.GlideModule
-keep class * extends com.bumptech.glide.module.AppGlideModule { <init>(...); }
-keep public enum com.bumptech.glide.load.ImageHeaderParser$** {
    **[] $VALUES;
    public *;
}
-keep class com.bumptech.glide.load.data.ParcelFileDescriptorRewinder$InternalRewinder { *** rewind(); }
```

**libs.versions.toml 修改**：
```toml
# 删除 mlkitBarcode 版本声明
# mlkitBarcode = "17.3.0"  ← 删除

# 删除 mlkit-barcode library 声明
# mlkit-barcode = { group = "com.google.mlkit", name = "barcode-scanning", version.ref = "mlkitBarcode" }  ← 删除

# 删除 glide 和 glide-ksp（未在 build.gradle.kts 中引用）
# glide = { group = "com.github.bumptech.glide", name = "glide", version.ref = "glide" }  ← 删除
# glide-ksp = { group = "com.github.bumptech.glide", name = "ksp", version.ref = "glide" }  ← 删除
```

**libs.versions.toml versions 段**：删除 `mlkitBarcode` 和 `glide` 版本声明

**验证**：
- `./gradlew assembleDebug` 构建成功
- ProGuard 规则无未使用的 keep 规则

---

## P1-5：统一 OkHttpClient 创建

**问题**：`ClawdWebSocket` 有自己的 `_client`，`HttpClientProvider` 也有 `_client`，两处独立创建。

**修改方案**：

1. `ClawdWebSocket` 移除自己的 `_client` / `_clientConfig`，改用 `HttpClientProvider`
2. `HttpClientProvider` 增加 SSE 专用的长超时配置

```kotlin
// HttpClientProvider.kt
object HttpClientProvider {
    // 通用 client（审批等短请求）
    fun getClient(config: ConnectionConfig): OkHttpClient { ... }

    // SSE 专用 client（长连接，readTimeout=0）
    fun getSseClient(config: ConnectionConfig): OkHttpClient {
        return synchronized(this) {
            // 与 getClient 类似但 readTimeout = 0
        }
    }
}
```

```kotlin
// ClawdWebSocket.kt — 移除 _client/_clientConfig，改用 HttpClientProvider
private val client: OkHttpClient
    get() = HttpClientProvider.getSseClient(config ?: return HttpClientProvider.getClient(ConnectionConfig("", 0, "")))
```

**验证**：
- SSE 连接正常
- 审批 POST 请求正常
- `HttpClientProvider.getClient()` 日志只出现一次（连接池共享）

---

## P1-6：Token 迁移到 Authorization Header

**问题**：Token 作为 URL query string 会被代理、CDN、服务器日志记录。

**修改方案**：

```kotlin
// ConnectionConfig.kt — streamUrl 不再包含 token
fun streamUrl(): String {
    val scheme = if (isLan) "http" else "https"
    return "$scheme://$host:$port/mobile/stream"
}

fun approveUrl(): String {
    val scheme = if (isLan) "http" else "https"
    return "$scheme://$host:$port/mobile/approve"
}

// 新增：获取认证 header
fun authHeader(): String = "Bearer $token"
```

```kotlin
// ClawdWebSocket.kt — doConnect 中添加 header
val request = Request.Builder()
    .url(cfg.streamUrl())
    .addHeader("Authorization", cfg.authHeader())
    .build()
```

```kotlin
// ApprovalReceiver.kt / ClawdWebSocket.kt — POST 请求添加 header
val request = Request.Builder()
    .url(cfg.approveUrl())
    .addHeader("Authorization", cfg.authHeader())
    .post(body.toRequestBody("application/json".toMediaType()))
    .build()
```

**注意**：需要桌面端同步修改，支持从 Authorization header 读取 token。

**验证**：
- 桌面端日志中不再出现 token（URL 中）
- 移动端连接、审批功能正常

---

## P1-7：非 LAN 证书固定入口

**问题**：非 LAN 连接无证书固定，存在 MITM 风险。

**修改方案**：

在 `PrefsStore` 中添加证书指纹存储，在 `HttpClientProvider` 中应用：

```kotlin
// PrefsStore.kt
fun getCertFingerprint(): String? = prefs.getString("cert_fingerprint", null)
fun setCertFingerprint(v: String?) { prefs.edit().putString("cert_fingerprint", v).apply() }
```

```kotlin
// HttpClientProvider.kt
fun getClient(config: ConnectionConfig): OkHttpClient {
    return synchronized(this) {
        val builder = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)

        // 非 LAN 连接：如果配置了证书指纹则固定
        if (!config.isLan) {
            val fingerprint = PrefsStore.getInstance(appContext).getCertFingerprint()
            if (fingerprint != null) {
                val pinner = CertificatePinner.Builder()
                    .add(config.host, "sha256/$fingerprint")
                    .build()
                builder.certificatePinner(pinner)
            }
        }

        _client = builder.build()
        _config = config
        _client!!
    }
}
```

**UI 入口**（SettingsScreen 连接信息卡片）：
- 显示当前连接的证书指纹（SHA-256）
- 允许用户手动确认/保存指纹

**验证**：
- 非 LAN 连接时，如果服务器证书与保存的指纹不匹配，连接被拒绝
- LAN 连接不受影响

---

## 验收标准

- [ ] PrefsStore 全局单例，迁移只执行一次
- [ ] SSE 重连不会创建重复审批请求
- [ ] `clawd://evil.com/...` 深链被拒绝
- [ ] ProGuard 和版本目录无 Glide/mlkitBarcode 残留
- [ ] OkHttpClient 统一由 HttpClientProvider 管理
- [ ] Token 从 URL 移到 Authorization header（需桌面端配合）
- [ ] 非 LAN 连接支持证书指纹固定
- [ ] 所有现有功能正常

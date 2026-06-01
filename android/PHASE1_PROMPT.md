# Phase 1 安全加固 — 执行提示词

> 复制以下内容直接粘贴到 Claude Code 执行

---

```
执行 Android 端 Phase 1 安全加固，共 4 个任务。先读取相关文件确认当前状态，再逐个修改。最后运行一次 `./gradlew assembleDebug` 确认编译通过。

## 背景

评估报告见 android/AUDIT_REPORT.md，执行方案见 android/EXECUTION_PLAN.md Phase 1 部分。

## 任务清单

### T1.1 移除假证书锁定

**文件**: `android/app/src/main/java/com/clawd/mobile/ws/ClawdWebSocket.kt`

**问题**: 第 41-47 行，非局域网连接时使用占位符 SHA-256 指纹 `sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` 做 CertificatePinner。这个指纹永远不会匹配真实证书，给人虚假安全感。

**修改**: 删除假锁定代码块，改为日志警告。证书指纹需要从实际部署服务器获取，当前阶段不适合硬编码。

将 `client` getter 中的这段代码：
```kotlin
// 非局域网连接：启用证书锁定
if (cfg != null && !cfg.isLan) {
    builder.certificatePinner(
        CertificatePinner.Builder()
            .add(cfg.host, "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") // TODO: 替换为实际证书指纹
            .build()
    )
}
```

替换为：
```kotlin
// 非局域网连接：日志提醒（证书指纹需从实际服务器获取，不硬编码占位符）
if (cfg != null && !cfg.isLan) {
    Log.w(TAG, "Non-LAN connection to ${cfg.host} without certificate pinning. Consider adding cert fingerprint for production.")
}
```

同时删除不再需要的 import：`import okhttp3.CertificatePinner`（确认其他地方没有使用后再删除）。

---

### T1.2 ApprovalReceiver 共享 OkHttpClient

**问题**: `android/app/src/main/java/com/clawd/mobile/notification/ApprovalReceiver.kt` 第 44-48 行，每次广播接收都新建一个 OkHttpClient，浪费连接池资源，且无法共享证书锁定配置。

**步骤 A**: 新建 `android/app/src/main/java/com/clawd/mobile/util/HttpClientProvider.kt`：

```kotlin
package com.clawd.mobile.util

import android.util.Log
import com.clawd.mobile.data.ConnectionConfig
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Shared OkHttpClient provider.
 * Reuses a single client instance per [ConnectionConfig] to share connection pools
 * and consistent timeout/TLS settings across the app (WebSocket, ApprovalReceiver, etc.).
 */
object HttpClientProvider {

    private const val TAG = "HttpClientProvider"

    @Volatile
    private var _client: OkHttpClient? = null

    @Volatile
    private var _config: ConnectionConfig? = null

    /**
     * Returns an [OkHttpClient] configured for the given [config].
     * Reuses the existing client if the config hasn't changed.
     */
    fun getClient(config: ConnectionConfig): OkHttpClient {
        if (_client == null || config != _config) {
            Log.d(TAG, "Building new OkHttpClient for ${config.host}:${config.port} (isLan=${config.isLan})")
            val builder = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .writeTimeout(5, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
            // 非局域网连接可在此添加 CertificatePinner（需要实际指纹）
            // if (!config.isLan) { builder.certificatePinner(...) }
            _client = builder.build()
            _config = config
        }
        return _client!!
    }

    /** Reset client — call when connection config changes or app disconnects. */
    fun reset() {
        _client = null
        _config = null
    }
}
```

**步骤 B**: 修改 `ApprovalReceiver.kt`，使用 `HttpClientProvider.getClient()` 替代每次新建：

将 `onReceive` 方法中的 Thread 块（第 38-57 行）从：
```kotlin
Thread {
    try {
        val body = buildJsonObject {
            put("id", requestId)
            put("decision", decision)
        }.toString()
        val client = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()
        val request = Request.Builder()
            .url(config.approveUrl())
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().close()
    } catch (e: Exception) {
        android.util.Log.e("ApprovalReceiver", "Failed to send approval response", e)
    }
}.start()
```

替换为：
```kotlin
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
            Log.w("ApprovalReceiver", "Approval response: HTTP ${response.code}")
        }
        response.close()
    }
}.start()
```

同步更新 import：
- 添加 `import com.clawd.mobile.util.HttpClientProvider`
- 添加 `import com.clawd.mobile.util.SafeExecutor`
- 添加 `import android.util.Log`
- 删除 `import okhttp3.OkHttpClient`（不再直接使用）
- 删除 `import java.util.concurrent.TimeUnit`（不再直接使用）

**步骤 C**: 修改 `ClawdWebSocket.kt` 的 `disconnect()` 方法（第 93-103 行），在断连时重置 HttpClientProvider：

在 `_clientConfig = null` 之后添加：
```kotlin
HttpClientProvider.reset()
```

---

### T1.3 Token 日志脱敏

**文件 A**: `android/app/src/main/java/com/clawd/mobile/data/ConnectionConfig.kt`

在 `approveUrl()` 方法之后（第 22 行后）添加脱敏 URL 方法：

```kotlin
/** URL with token masked for logging — never log raw token. */
fun streamUrlMasked(): String {
    val scheme = if (isLan) "http" else "https"
    val masked = if (token.length > 8) "${token.take(4)}****${token.takeLast(4)}" else "****"
    return "$scheme://$host:$port/mobile/stream?token=$masked"
}
```

**文件 B**: `android/app/src/main/java/com/clawd/mobile/ws/ClawdWebSocket.kt`

找到 `doConnect()` 方法中的日志行（约第 122 行）：
```kotlin
Log.d("ClawdWebSocket", "doConnect → $url")
```

替换为：
```kotlin
Log.d("ClawdWebSocket", "doConnect → ${cfg.streamUrlMasked()}")
```

---

### T1.4 ManualScreen Token 遮罩

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/manual/ManualScreen.kt`

**步骤 A**: 添加 import（文件顶部 import 区域）：
```kotlin
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
```

**步骤 B**: 在 `var token by remember { mutableStateOf("") }` 之后（第 26 行后）添加：
```kotlin
var tokenVisible by remember { mutableStateOf(false) }
```

**步骤 C**: 将 Token 的 OutlinedTextField（第 68-75 行）从：
```kotlin
OutlinedTextField(
    value = token,
    onValueChange = { token = it },
    label = { Text("Token") },
    placeholder = { Text(stringResource(R.string.manual_token_placeholder)) },
    singleLine = true,
    modifier = Modifier.fillMaxWidth()
)
```

替换为：
```kotlin
OutlinedTextField(
    value = token,
    onValueChange = { token = it },
    label = { Text(stringResource(R.string.manual_token_label)) },
    placeholder = { Text(stringResource(R.string.manual_token_placeholder)) },
    singleLine = true,
    visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
    trailingIcon = {
        IconButton(onClick = { tokenVisible = !tokenVisible }) {
            Icon(
                imageVector = if (tokenVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                contentDescription = if (tokenVisible) "Hide token" else "Show token"
            )
        }
    },
    modifier = Modifier.fillMaxWidth()
)
```

**步骤 D**: 在 `android/app/src/main/res/values/strings.xml` 中添加新 string resource（在 `manual_token_placeholder` 之后）：
```xml
<string name="manual_token_label">Token</string>
```

---

## 验证

完成所有修改后，执行以下验证：

1. **编译检查**: 在 `android/` 目录下运行 `./gradlew assembleDebug`，确认无编译错误
2. **Grep 验证**: 确认代码中不再有占位符指纹：
   - `grep -r "AAAAAAAAAAAAAAAA" android/app/src/main/` 应返回空
3. **Grep 验证**: 确认 ApprovalReceiver 不再直接 new OkHttpClient：
   - `grep -r "OkHttpClient.Builder" android/app/src/main/java/com/clawd/mobile/notification/` 应返回空
4. **Grep 验证**: 确认日志中不再有原始 token URL：
   - `grep -r "streamUrl()" android/app/src/main/java/com/clawd/mobile/ws/` 应只出现在非日志行
5. **Grep 验证**: 确认 ManualScreen 有 PasswordVisualTransformation：
   - `grep -r "PasswordVisualTransformation" android/app/src/main/` 应有结果

最后输出修改文件清单和每个文件的改动摘要。
```

# P0 安全加固计划

> 阶段：立即修复
> 关联问题：C-01、H-01、H-02、H-03、L-02
> 预计工作量：2-3 天

---

## 概述

本阶段修复审计中发现的 Critical 和 High 级别安全/可靠性问题。所有改动都是局部的、低风险的，不需要架构变更。

---

## 任务清单

| # | 任务 | 关联 | 文件 | 工作量 | 优先级 |
|---|------|------|------|--------|--------|
| P0-1 | WakeLock 添加超时 | H-03 | `WebSocketService.kt` | S | 立即 |
| P0-2 | ApprovalReceiver 改用 goAsync() | H-01 | `ApprovalReceiver.kt` | M | 立即 |
| P0-3 | HttpClientProvider 添加 synchronized | H-02 | `HttpClientProvider.kt` | S | 立即 |
| P0-4 | allowBackup 设为 false | L-02 | `AndroidManifest.xml` | S | 立即 |
| P0-5 | network_security_config 收窄 | C-01 | `network_security_config.xml` | S | 立即 |

---

## P0-1：WakeLock 添加超时

**问题**：`WebSocketService.kt:186-189` 中 `wakeLock.acquire()` 无超时参数，`onDestroy()` 未调用时 WakeLock 永不释放。

**当前代码**：
```kotlin
wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:ws").apply {
    setReferenceCounted(false)
    acquire()
}
```

**修改方案**：
```kotlin
wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clawd:ws").apply {
    setReferenceCounted(false)
    acquire(60 * 60 * 1000L) // 1 小时超时安全网
}
```

**同样修改 wifiLock**：
```kotlin
wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL, "clawd:ws").apply {
    setReferenceCounted(false)
    acquire(60 * 60 * 1000L)
}
```

**验证**：
- 启动服务后 1 小时内连接正常
- `adb shell dumpsys power` 确认 WakeLock 有超时

---

## P0-2：ApprovalReceiver 改用 goAsync()

**问题**：`ApprovalReceiver.kt:38-55` 中 `onReceive()` 启动裸 Thread，进程被杀后请求静默失败。

**当前代码**：
```kotlin
override fun onReceive(context: Context, intent: Intent) {
    // ...
    Thread {
        SafeExecutor.tryOrLog("ApprovalReceiver") {
            // 网络请求
        }
    }.start()
    // onReceive() 返回后进程可能被杀
}
```

**修改方案**：
```kotlin
override fun onReceive(context: Context, intent: Intent) {
    val requestId = intent.getStringExtra("request_id") ?: return
    val notificationId = intent.getIntExtra("notification_id", -1)
    val decision = when (intent.action) {
        ACTION_APPROVE -> "allow"
        ACTION_DENY -> "deny"
        else -> return
    }

    val pendingResult = goAsync()

    CoroutineScope(Dispatchers.IO).launch {
        try {
            val prefsStore = PrefsStore(context)
            val config = prefsStore.loadConfig() ?: return@launch
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
        } catch (e: Exception) {
            Log.e("ApprovalReceiver", "Approval failed", e)
        } finally {
            if (notificationId >= 0) {
                NotificationHelper.cancelNotification(context, notificationId)
            }
            pendingResult.finish()
        }
    }
}
```

**关键点**：
- `goAsync()` 延长 BroadcastReceiver 生命周期（最多 10 秒）
- 协程在 `finally` 中调用 `pendingResult.finish()`
- 失败时也有日志，不会静默丢失

**验证**：
- 断网状态下点击通知"允许"，观察日志是否有错误输出
- 恢复网络后确认请求最终发出（如需重试则进一步增强）

---

## P0-3：HttpClientProvider 添加 synchronized

**问题**：`HttpClientProvider.kt:27-39` 中 `getClient()` 非线程安全。

**当前代码**：
```kotlin
fun getClient(config: ConnectionConfig): OkHttpClient {
    if (_client == null || config != _config) {
        _client = builder.build()
        _config = config
    }
    return _client!!
}
```

**修改方案**：
```kotlin
fun getClient(config: ConnectionConfig): OkHttpClient {
    return synchronized(this) {
        if (_client == null || config != _config) {
            Log.d(TAG, "Building new OkHttpClient for ${config.host}:${config.port}")
            val builder = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .writeTimeout(5, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
            _client = builder.build()
            _config = config
        }
        _client!!
    }
}
```

**验证**：
- 并发调用 `getClient()` 不会创建多个实例（可通过日志确认）

---

## P0-4：allowBackup 设为 false

**问题**：`AndroidManifest.xml:19` 中 `allowBackup="true"` 允许 ADB 备份。

**修改方案**：
```xml
<application
    android:name=".ClawdApp"
    android:allowBackup="false"
    ...
```

**验证**：
- `adb backup` 命令无法备份应用数据

---

## P0-5：network_security_config 收窄

**问题**：`network_security_config.xml` 全局允许明文流量。

**当前代码**：
```xml
<base-config cleartextTrafficPermitted="true">
    <trust-anchors>
        <certificates src="system" />
    </trust-anchors>
</base-config>
```

**修改方案**：
```xml
<network-security-config>
    <!-- 默认禁止明文 -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>

    <!-- 仅 LAN IP 段允许明文 -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">10.0.0.0</domain>
        <domain includeSubdomains="true">172.16.0.0</domain>
        <domain includeSubdomains="true">192.168.0.0</domain>
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
    </domain-config>
</network-security-config>
```

**注意**：`domain-config` 的 `domain` 标签不支持 CIDR 表示法，只支持精确域名匹配。对于 IP 地址段，需要在代码层面处理（`ConnectionConfig.isLan` 判断后选择 http/https），而 `network_security_config` 只能设置为全局允许或全局禁止。

**实际可行方案**：
```xml
<network-security-config>
    <!-- 保留全局允许明文（LAN 场景需要），但配合代码层 isLan 判断 -->
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

> 完整修复需要 LAN HTTPS 支持（P3 阶段），当前阶段保留现有配置，但在代码层确保非 LAN 连接强制使用 HTTPS。

**验证**：
- LAN 连接正常（HTTP）
- 公网连接强制 HTTPS

---

## 验收标准

- [ ] WakeLock 和 WifiLock 都有 1 小时超时
- [ ] ApprovalReceiver 使用 goAsync()，不再有裸 Thread
- [ ] HttpClientProvider.getClient() 线程安全
- [ ] allowBackup="false"
- [ ] 所有现有功能正常（连接、审批、悬浮窗、通知）

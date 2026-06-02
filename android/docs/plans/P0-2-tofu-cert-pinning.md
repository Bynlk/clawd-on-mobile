# P0-2: 非 LAN 连接 TOFU 证书固定

> **优先级**: P0 — 安全风险  
> **影响范围**: 所有非 LAN（远程）连接  
> **预估工时**: 2h  
> **启动提示词**: `执行 P0-2: 实现 TOFU 证书固定，非 LAN 首次连接时展示 fingerprint 供用户确认，确认后自动 pinning`

---

## 问题描述

当前非 LAN 连接的证书固定逻辑：

```kotlin
// HttpClientProvider.kt:85-95
if (!config.isLan) {
    val fp = _fingerprint
    if (fp != null) {
        // 有 fingerprint → 应用 pinning
    } else {
        Log.w(TAG, "Non-LAN connection to ${config.host} without cert pinning")
        // ⚠️ 仅打 warning，继续连接，无 pinning
    }
}
```

用户首次连接远程服务器时没有 fingerprint，此时**完全不做证书固定**，存在 MITM（中间人攻击）风险。攻击者可以在首次连接时劫持连接，后续所有通信都被窃听。

## 现状分析

**涉及文件**:

| 文件 | 职责 |
|------|------|
| `util/HttpClientProvider.kt` | 客户端构建、pinning 应用 |
| `data/PrefsStore.kt` | `getCertFingerprint()` / `setCertFingerprint()` |
| `data/ConnectionConfig.kt` | `isLan` 判断 |
| `ui/scan/ScanScreen.kt` | QR 扫描连接入口 |
| `ui/manual/ManualScreen.kt` | 手动连接入口 |

**现有流程**:
1. 用户扫描 QR 或手动输入 → `ConnectionConfig` 创建
2. `WebSocketService.start(config)` → `ClawdWebSocket.connect(config)`
3. `HttpClientProvider.getClient(config)` → 如果非 LAN 且无 fingerprint，**静默跳过** pinning

## 修复方案: Trust-On-First-Use (TOFU)

### 核心思路

首次连接非 LAN 服务器时：
1. 获取服务器证书 fingerprint（SHA-256）
2. 弹出确认对话框展示 fingerprint
3. 用户确认后保存 fingerprint 并应用 pinning
4. 后续连接自动使用已保存的 fingerprint

### Step 1: 新增 `CertificateVerifier`

```kotlin
// util/CertificateVerifier.kt
object CertificateVerifier {
    /**
     * 从 OkHttpClient 连接中提取服务器证书 SHA-256 fingerprint。
     * 用于 TOFU 模式下首次连接展示给用户确认。
     */
    fun extractFingerprint(response: Response): String? {
        val handshake = response.handshake ?: return null
        val cert = handshake.peerCertificates.firstOrNull() as? X509Certificate
            ?: return null
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(cert.encoded)
        return hash.joinToString(":") { "%02X".format(it) }
    }
}
```

### Step 2: 修改 `ClawdWebSocket.onOpen` 添加 fingerprint 提取

```kotlin
// ClawdWebSocket.kt — onOpen 回调中
override fun onOpen(eventSource: EventSource, response: Response) {
    // 非 LAN 且无已保存 fingerprint → 提取并通知 UI
    val cfg = config
    if (cfg != null && !cfg.isLan && prefsStore.getCertFingerprint() == null) {
        val fp = CertificateVerifier.extractFingerprint(response)
        if (fp != null) {
            // 通过新的 SharedFlow 通知 UI 展示确认对话框
            _certFingerprintPending.emit(CertFingerprintInfo(cfg.host, fp))
        }
    }
    // ... 原有逻辑
}
```

### Step 3: 新增 `SharedFlow<CertFingerprintInfo>`

```kotlin
// ClawdWebSocket.kt
data class CertFingerprintInfo(val host: String, val fingerprint: String)

private val _certFingerprintPending = MutableSharedFlow<CertFingerprintInfo>(extraBufferCapacity = 1)
val certFingerprintPending: SharedFlow<CertFingerprintInfo> = _certFingerprintPending
```

### Step 4: UI 层确认对话框

在 `NavGraph.kt` 或 `SessionsScreen.kt` 中收集 `certFingerprintPending`，弹出 Material3 AlertDialog：

```
标题: 证书确认
内容: 正在连接到 {host}
      服务器证书指纹:
      {SHA-256 fingerprint}
      确认此指纹与服务器一致？
按钮: [信任并连接]  [取消]
```

用户点击"信任并连接"：
- `prefsStore.setCertFingerprint(fingerprint)`
- `HttpClientProvider.setCertFingerprint(fingerprint)`

用户点击"取消"：
- `webSocket.disconnect()`

### Step 5: 更新 `HttpClientProvider.buildClient()`

```kotlin
// 现有逻辑不变，但移除 warning log 中的"无 pinning"静默跳过
// 改为：非 LAN 无 fingerprint 时抛出异常或返回 null，强制走 TOFU 流程
```

## 验收标准

- [ ] 首次连接非 LAN 服务器时，弹出 certificate fingerprint 确认对话框
- [ ] 用户确认后 fingerprint 保存到 `PrefsStore`
- [ ] 后续连接自动使用已保存的 fingerprint 进行 pinning
- [ ] fingerprint 不匹配时连接失败（而非静默跳过）
- [ ] LAN 连接不受影响（不弹确认框）
- [ ] 已有 fingerprint 时直接连接，不弹框

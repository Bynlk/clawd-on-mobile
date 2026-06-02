# P0-1: Token URL 泄露修复

> **优先级**: P0 — 安全风险  
> **影响范围**: 所有 SSE 连接  
> **预估工时**: 1h  
> **启动提示词**: `执行 P0-1: 修复 Token URL 泄露，将 streamUrl 中的 token 移至 Authorization header only，移除 URL query 中的 token 参数`

---

## 问题描述

`ConnectionConfig.streamUrl()` 将认证 token 明文拼接在 URL query parameter 中：

```
http://192.168.1.5:3000/mobile/stream?token=abcd1234efgh5678
```

即使在 LAN 环境下，HTTP 明文传输的 token 会被以下途径泄露：
- 网络嗅探（同网段设备）
- 代理服务器 access log
- 目标服务器 access log
- 浏览器/WebView 历史记录
- 系统日志（`Log.d` 中的 `streamUrlMasked` 虽然掩码了，但 URL 本身仍在网络层可见）

## 现状分析

**涉及文件**:

| 文件 | 行号 | 问题 |
|------|------|------|
| `data/ConnectionConfig.kt` | 23-26 | `streamUrl()` 将 token 拼入 URL |
| `data/ConnectionConfig.kt` | 34-38 | `streamUrlMasked()` 同样包含 token（掩码版） |
| `ws/ClawdWebSocket.kt` | 108-110 | SSE 请求已通过 `authHeader()` 发送 Bearer token（✅ 正确） |

**关键发现**: `ClawdWebSocket.doConnect()` 已经在请求头中添加了 `Authorization: Bearer $token`，所以 URL 中的 token 是**冗余的**。

## 修复方案

### Step 1: 修改 `ConnectionConfig.streamUrl()`

```kotlin
// Before
fun streamUrl(): String {
    val scheme = if (isLan) "http" else "https"
    return "$scheme://$host:$port/mobile/stream?token=$token"
}

// After
fun streamUrl(): String {
    val scheme = if (isLan) "http" else "https"
    return "$scheme://$host:$port/mobile/stream"
}
```

### Step 2: 更新 `streamUrlMasked()`

```kotlin
// Before
fun streamUrlMasked(): String {
    val scheme = if (isLan) "http" else "https"
    val masked = if (token.length > 8) "${token.take(4)}****${token.takeLast(4)}" else "****"
    return "$scheme://$host:$port/mobile/stream?token=$masked"
}

// After — 不再需要掩码，直接用 streamUrl()
fun streamUrlMasked(): String = streamUrl()
```

### Step 3: 确保服务端兼容

需要确认服务端 `/mobile/stream` 端点支持从 `Authorization: Bearer <token>` header 读取 token（而不仅从 query parameter）。如果服务端目前只读 query parameter，需要同步修改服务端。

### Step 4: 更新测试

更新 `ConnectionConfigTest` 中涉及 `streamUrl()` 的断言，移除 token query 部分。

## 验收标准

- [ ] `streamUrl()` 返回的 URL 不包含 `token=` 参数
- [ ] SSE 连接仍通过 `Authorization` header 正确认证
- [ ] `streamUrlMasked()` 不再包含任何 token 信息
- [ ] 所有相关测试通过
- [ ] 服务端能正确从 header 读取 token（需同步验证）

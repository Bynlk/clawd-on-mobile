# Spec：远程中继服务

> 状态：已完成
> 完成度：~92%
> 已实现：relay server（noServer + REST API + 限流 + TLS）、Docker/systemd 部署、PC 端 bridge 集成（指数退避重连）、设置页 Relay UI、Android ConnectionStrategy、WsClient 策略模式、SessionMerger 双连接合并、RelaySettings UI（含状态检查）、peer 消息解析、relay 断线处理、WiFi Lock 修复、审批响应路由
> 待完善：deep link relay 配置、relayPeerState UI 展示
> 分支：`feat/remote-relay`
> 预估工时：~22h（含双连接改造）
> 修正项：prefs-direct 初始化、策略模式双连接、bridge 端口修正、WiFi Lock 条件获取、ADMIN_TOKEN 生命周期、noServer 重构方案、去重逻辑与独立显示一致性、multi-pair 明确、改动规模量化、SessionMerger 设计、Android 自签证书信任、审批响应路由、saveConfig 冲突避免、信任模型文档化、REST API rate limit
> 已实现：relay server（noServer + REST API + 限流 + TLS）、Docker/systemd 部署、PC 端 bridge 集成、设置页 Relay UI、Android ConnectionStrategy、RelaySettings UI、peer 消息解析、PrefsStore relay 字段
> 待完善：SessionMerger 双连接会话合并逻辑、Android 自签证书配置、relay 模式下审批响应路由

## 目标

提供一个可部署在 Linux VPS 上的 WebSocket 中继服务，使 Android 手机和 PC 桌面端可以在不同网络环境下（非 LAN）通过中继通信。支持 LAN 和 Relay **同时连接**，通过 tag 区分不同环境的会话。支持一键部署、一键关闭，PC 和 Android 端均可远程控制中继状态。

## 用户体验流程

### 部署

```
1. 用户在 Linux VPS 上执行部署脚本
   - Docker: ./deploy-relay.sh docker
   - systemd: ./deploy-relay.sh systemd
2. 脚本自动生成 connection token + admin token、配置 TLS、启动服务
3. 输出 relay URL、connection token 和 admin token
```

### PC 端配置

```
1. Settings → Mobile tab → 新增「Remote Relay」区域
2. 输入 relay URL 和 admin token → 点击连接
3. 显示连接状态：未连接 / 已连接（显示 relay 地址和在线 phone 数量）
4. 一键断开按钮
```

### Android 端配置

```
1. Settings → 新增 Relay 设置区域（AccordionSection）
2. 输入 relay URL 和 token → 点击连接
3. 显示连接状态：未连接 / 已连接（PC 在线/离线）
4. 一键断开按钮
5. 也可通过 deep link clawd://relay?url=wss://...&token=... 快速配置
```

### 使用

```
1. PC 端启动 Clawd → 自动启动 relay bridge（如果已配置且启用）
2. Android 同时维持 LAN 直连 + Relay 连接（如果两者都可用）
3. 会话通过 tag 区分来源：[LAN] 或 [Relay]
4. 任一连接断线 → 对应环境的会话标记离线，另一连接不受影响
5. 两条连接都活跃时，状态消息合并显示
```

## 架构

```
                         ┌───────────────────────────────────────────┐
                         │              Android Clawd               │
                         │                                           │
                         │  ┌─────────────┐    ┌─────────────────┐  │
                         │  │ LAN Client  │    │  Relay Client   │  │
                         │  │ (WsClient)  │    │  (WsClient)     │  │
                         │  └──────┬──────┘    └────────┬────────┘  │
                         │         │                    │           │
                         │         └────────┬───────────┘           │
                         │                  │                       │
                         │         SessionMerger                    │
                         │         (tag: LAN / Relay)               │
                         └───────────────────────────────────────────┘
                               │                        │
                          ws:// LAN                 wss:// Relay
                               │                        │
                    ┌──────────▼──────────┐   ┌────────▼────────┐
                    │   PC MobileWSServer │   │  Relay Server   │
                    │   (port 23334)      │   │  (Linux VPS)    │
                    └─────────────────────┘   └────────┬────────┘
                                                       │ ws://
                                              ┌────────▼────────┐
                                              │  PC Relay Bridge │
                                              │  (集成到 Electron)│
                                              └─────────────────┘
```

## 改动规模总览

| 类别 | 新增文件 | 修改文件 | 预估行数 |
|------|----------|----------|----------|
| Relay Server (`relay/`) | 6 | 0 | ~600 行 |
| PC 端 (`src/`) | 2 | 3 | ~350 行新增 + ~50 行修改 |
| Android 端 | 5 | 7 | ~500 行新增 + ~80 行修改 |
| **合计** | **13** | **10** | **~1580 行** |

上游耦合文件修改量：`server.js` +2 行，`settings-ipc.js` +20 行，`settings-i18n.js` +30 行，`settings-tab-mobile.js` +10 行。均为纯追加，不修改已有逻辑。

## 技术方案

### 一、Relay Server 增强

基于现有 `relay-server.js`，改造为生产级服务。

#### noServer 重构方案

当前 `relay-server.js` 使用 `new WebSocketServer({ port: PORT })` 自建 HTTP server，无法在同一端口添加 REST API。重构方案：

```js
const http = require("http");
const { WebSocketServer } = require("ws");

const server = http.createServer((req, res) => {
  // REST API 路由
  if (req.url === "/health") { /* 返回状态 */ }
  if (req.url === "/api/status") { /* 返回连接统计 */ }
  if (req.url === "/api/stop") { /* 暂停服务 */ }
  if (req.url === "/api/start") { /* 恢复服务 */ }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  // 仅 /mobile/ws 和 /ws 路径允许 WS 升级
  if (url.pathname === "/mobile/ws" || url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT);
```

核心逻辑（token 认证、pair 管理、心跳、消息转发）保持不变，仅将 WS server 从自建模式改为 noServer 模式。

| 改动 | 说明 |
|------|------|
| TLS 支持 | 读取环境变量 `TLS_CERT` / `TLS_KEY`，或通过 nginx 反向代理 |
| 速率限制 | WS：每 token 每分钟 120 条消息（PC 和 phone 各自独立计数）。REST API：每 IP 每分钟 10 次认证尝试，失败超过 5 次锁定 5 分钟 |
| 消息大小限制 | 单条消息最大 64KB |
| 连接配额 | 每 token 最多 2 个连接（1 PC + 1 phone）。如需一个 PC 服务多个手机，需为每对设备分配独立 token |
| 健康检查 | `GET /health` 返回 `{ status: "ok", uptime, pairs }` |
| 结构化日志 | JSON 格式日志，包含 timestamp/token/event/clientIp |
| graceful shutdown | SIGTERM 时通知所有客户端断开 |

**部署文件：**

| 文件 | 说明 |
|------|------|
| `relay/deploy-relay.sh` | 一键部署脚本（检测 Docker/systemd 环境） |
| `relay/docker-compose.yml` | Docker Compose 配置（relay + nginx + TLS） |
| `relay/Dockerfile` | Relay 镜像 |
| `relay/nginx.conf` | nginx 反向代理 + TLS 终止 |
| `relay/clawd-relay.service` | systemd 服务文件 |
| `relay/relay-server.js` | 增强后的 relay server（从根目录移入 relay/） |

### 二、REST 控制 API

在 relay server 上新增 HTTP API（与 WS 共享端口，路径区分）：

```
GET  /api/status
Response: {
  "status": "running",
  "uptime": 3600,
  "pairs": 2,
  "connections": { "pc": 1, "phone": 2 }
}

POST /api/stop
Body: { "token": "<admin-token>" }
Response: { "status": "stopped" }
Effect: 断开所有客户端，server 进入暂停状态

POST /api/start
Body: { "token": "<admin-token>" }
Response: { "status": "running" }
Effect: 恢复接受连接
```

认证：admin token 通过环境变量 `ADMIN_TOKEN` 设置，与连接 token 不同。

#### Token 生命周期

- **Connection token**：deploy 脚本自动生成 32-char hex，PC 和 phone 共享，用于 WS 连接认证
- **Admin token**：deploy 脚本自动生成 32-char hex，仅用于 REST 控制 API
- 两个 token 在部署时打印到终端，用户需手动复制到 PC/Android 设置页
- 轮换方式：重新运行 deploy 脚本生成新 token，重启 relay 服务

### 三、PC 端集成

#### 新增文件

| 文件 | 职责 |
|------|------|
| `src/relay-bridge-integration.js` | 集成 relay bridge 到 Electron 主进程 |
| `src/settings-tab-relay.js` | Settings Mobile tab 内的 Relay 配置 UI |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `src/settings-tab-mobile.js` | 新增 Relay 配置区域入口 |
| `src/settings-ipc.js` | 新增 relay 相关 IPC handler |
| `src/settings-i18n.js` | 新增 relay 相关 i18n 字符串 |

#### 初始化模式：prefs-direct

relay bridge 在 `server.js` 启动 mobile server 后，直接从 prefs 读取 relay 配置并初始化。**不修改 `main.js`**。

```js
// server.js 的 initServer(ctx) 函数末尾（mobile server 启动之后）
const { initRelayBridge } = require("./relay-bridge-integration");
initRelayBridge(ctx.prefs);  // 直接从 ctx.prefs 读取 relay 配置，不走 ctx 注入
```

#### relay-bridge-integration.js

```
职责：
- 从 prefs 读取 relay 配置（relayUrl, relayToken, relayEnabled）
- 管理 relay bridge 连接生命周期
- 连接到 relay server（role=pc）
- 连接到本地 hook server（ws://localhost:23334/mobile/ws）
- 双向转发消息（透明转发，不过滤应用层消息）
- 断线重连（指数退避 5s-60s）
- 暴露状态 StateFlow 给 settings UI（通过 IPC）
- 监听 prefs 变更，配置更新时自动重连

配置存储（prefs）：
- relayUrl: string
- relayToken: string (加密存储)
- relayEnabled: boolean
```

### 四、Android 端适配

#### 新增文件

| 文件 | 职责 |
|------|------|
| `ui/settings/RelaySettings.kt` | Relay 设置 AccordionSection 内容 |
| `ws/ConnectionStrategy.kt` | 连接策略接口 |
| `ws/LanConnectionStrategy.kt` | LAN 直连策略 |
| `ws/RelayConnectionStrategy.kt` | Relay 连接策略 |
| `overlay/SessionTagBadge.kt` | 会话来源 tag 徽章渲染 |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `data/ConnectionConfig.kt` | 新增 `relayUrl` / `relayToken` / `useRelay` 字段 |
| `data/PrefsStore.kt` | 新增 relay 配置持久化 |
| `ws/MessageParser.kt` | 识别 `peer_connected` / `peer_disconnected` 消息 |
| `ws/MessageHandler.kt` | 处理 relay 控制消息，更新 `relayPeerState` StateFlow |
| `ui/approval/ApprovalViewModel.kt` | 支持双 client：根据请求来源路由响应到正确 client |
| `notification/ApprovalReceiver.kt` | 支持双 client：根据请求来源路由响应到正确 client |
| `ui/settings/SettingsScreen.kt` | 新增 Relay AccordionSection |
| `ui/navigation/ServiceManager.kt` | relay 配置传递 |
| `service/WsConnectionService.kt` | 双连接管理（LAN + Relay）+ SessionMerger |

#### 连接策略模式

```kotlin
// ConnectionStrategy.kt — 连接策略接口
interface ConnectionStrategy {
    val tag: ConnectionTag          // LAN 或 RELAY
    fun streamUrl(config: ConnectionConfig): String
    fun authHeader(config: ConnectionConfig): String
    fun shouldAcquireWifiLock(): Boolean
}

enum class ConnectionTag { LAN, RELAY }

// LanConnectionStrategy.kt
class LanConnectionStrategy : ConnectionStrategy {
    override val tag = ConnectionTag.LAN
    override fun streamUrl(config: ConnectionConfig): String {
        val protocol = if (config.isLan) "ws" else "wss"
        return "$protocol://${config.host}:${config.port}/mobile/ws"
    }
    override fun authHeader(config: ConnectionConfig) = config.authHeader()
    override fun shouldAcquireWifiLock() = true
}

// RelayConnectionStrategy.kt
class RelayConnectionStrategy : ConnectionStrategy {
    override val tag = ConnectionTag.RELAY
    override fun streamUrl(config: ConnectionConfig): String {
        return "${config.relayUrl}/mobile/ws"
    }
    override fun authHeader(config: ConnectionConfig): String {
        return "Bearer ${config.relayToken}"
    }
    override fun shouldAcquireWifiLock() = false  // relay 可能走蜂窝网络
}
```

#### 双连接管理（WsConnectionService）

```
WsConnectionService 同时维护两个 WsClient 实例：
- lanClient: WsClient?     — LAN 直连（原有逻辑）
- relayClient: WsClient?   — Relay 连接（新增）

统一入口：
- getClient() 返回 lanClient（主连接，向后兼容）
- getClientByTag(tag) 按 tag 返回对应 client
- getAllClients() 返回所有活跃 client 列表

生命周期：
- 服务启动 → 根据配置决定启动哪些 client
- LAN client：始终启动（如果配置了 LAN 连接）
- Relay client：仅当 useRelay=true 且 relayUrl 非空时启动
- 任一 client 断线 → 独立重连，不影响另一个
- 服务停止 → 两个 client 都断开

saveConfig 冲突避免：
- 双 client 共享同一个 PrefsStore，但各自使用独立的 ConnectionConfig 实例
- lanClient 使用 LAN config（host/port/token）
- relayClient 使用 relay config（relayUrl/relayToken）
- 连接成功后不调用 prefsStore.saveConfig()，避免互相覆盖
- 原有的 saveConfig 逻辑仅在用户主动修改设置时触发

Session 合并（SessionMerger）：
- 输入：两个 client 的 sessions StateFlow
- 输出：一个统一的 mergedSessions StateFlow
- 合并规则：
  - 每个 session 携带 tag: ConnectionTag（LAN 或 RELAY）
  - mergedSessions 是 Map<String, List<SessionEntry>>
  - SessionEntry = Session + ConnectionTag
  - 同一 sessionId 可出现在多个 tag 下（独立条目）
  - UI 按 tag 分组显示，每组内部按活跃时间排序
- 线程安全：使用 ConcurrentHashMap + 写时复制快照
- 断线处理：client 断线 → 该 client 的 sessions 清空 → mergedSessions 移除对应 tag 条目
  - 断线的 session 从 UI 消失（不保留离线状态），重连后自动恢复
  - 重连时 server 发送 clear_sessions + snapshot，client 重建完整状态
```

#### ConnectionConfig 扩展

```kotlin
// 新增字段（向后兼容，默认值保持现有行为）
val relayUrl: String? = null      // wss://vps-ip:7891
val relayToken: String? = null    // 共享 token
val useRelay: Boolean = false     // 是否启用 relay

// 注意：streamUrl() 不再直接使用，改由 ConnectionStrategy 实现
// 保留 streamUrl() 作为向后兼容的快捷方法
fun streamUrl(): String = LanConnectionStrategy().streamUrl(this)
```

#### Relay 控制消息处理

```kotlin
// MessageParser 新增
"peer_connected" -> ParsedMessage.PeerConnected(role = payload.getString("role"))
"peer_disconnected" -> ParsedMessage.PeerDisconnected(role = payload.getString("role"))

// MessageHandler 新增（仅 relay client 的 handler 需要处理）
is ParsedMessage.PeerConnected -> {
    _relayPeerState.value = RelayPeerState.CONNECTED(role)
}
is ParsedMessage.PeerDisconnected -> {
    _relayPeerState.value = RelayPeerState.DISCONNECTED(role)
}
```

#### 审批响应路由（双 client 适配）

```kotlin
// ApprovalViewModel 改造：
// - 收集 lanClient.permissionRequests 和 relayClient.permissionRequests
// - 每个请求记录 sourceTag: ConnectionTag
// - sendPermissionResponse() 路由到 sourceTag 对应的 client

// ApprovalReceiver / ApprovalWorker 改造：
// - intent extra 新增 "sourceTag" 字段
// - ApprovalWorker 根据 sourceTag 调用对应 client 的 sendMessage()

// 统一方案：WsConnectionService 提供
fun sendApprovalResponse(requestId: String, json: String, tag: ConnectionTag): Boolean {
    return getClientByTag(tag)?.sendMessage(json) ?: false
}
```

#### WiFi Lock 优化

```kotlin
// WsConnectionService.acquireLocks() 改为条件获取
private fun acquireLocks(strategy: ConnectionStrategy) {
    if (strategy.shouldAcquireWifiLock()) {
        wifiLock.acquire()
    }
    wakeLock.acquire()
}
```

### 五、安全设计

#### 信任模型

```
Relay 服务器是可信中间人：
- Relay 运营者可读取所有中继消息（包括 token、审批内容、会话状态）
- 部署者应使用自己控制的 VPS，不要使用不受信任的第三方托管
- 如需端到端加密，需在应用层实现（当前版本不支持）
- 共享 token 泄露 = 所有消息可被读取 + 可冒充任一端
```

#### Android 自签证书信任

Android 7+ 默认不信任用户安装的 CA 证书。自签证书部署方案：

```xml
<!-- android/app/src/main/res/xml/network_security_config.xml -->
<network-security-config>
    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
    <base-config>
        <trust-anchors>
            <certificates src="system" />
            <!-- 用户手动信任的证书（用于 relay 自签） -->
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

配合用户操作：
1. 在 VPS 上生成自签证书
2. 将 CA 证书文件传到手机
3. Android 设置 → 安全 → 安装证书 → CA 证书
4. 应用自动信任用户安装的 CA

备选方案（推荐生产环境）：使用 Let's Encrypt 免费证书，Android 系统默认信任，无需手动安装。

| 措施 | 说明 |
|------|------|
| TLS | 生产部署必须使用 wss://（自签证书或 Let's Encrypt） |
| 共享 token | PC 和 phone 用同一个 32-char hex token 认证 |
| admin token | 控制 API 使用独立的 admin token |
| 速率限制 | relay 层独立限流，不依赖 PC 端限流 |
| 消息大小 | 64KB 上限防止内存攻击 |
| 连接配额 | 每 token 最多 2 连接防止滥用 |

## 验收标准

### Relay Server

1. `./deploy-relay.sh docker` 在干净 Linux 上一键部署成功
2. `./deploy-relay.sh systemd` 在无 Docker 环境部署成功
3. relay server 启动后接受 wss:// 连接
4. `/health` 端点返回正确状态
5. `/api/status` 返回连接统计
6. 速率限制生效（超限返回 close frame）
7. SIGTERM 优雅关闭

### PC 端

8. Settings Mobile tab 显示 Relay 配置区域
9. 输入 URL + token 后可连接到 relay
10. 连接状态实时显示（未连接/已连接/phone 在线）
11. PC 启动时自动启动 relay bridge（如果已启用）
12. bridge 断线自动重连
13. 一键断开

### Android 端

14. Settings 新增 Relay AccordionSection
15. 输入 URL + token 后可连接到 relay
16. 连接状态实时显示（未连接/已连接/PC 在线/离线）
17. `peer_connected/disconnected` 消息正确显示
18. deep link `clawd://relay?url=...&token=...` 可快速配置
19. LAN 和 Relay 同时连接时，会话通过 tag 区分来源
20. Relay 连接不获取 WiFi Lock

### 端到端

21. 手机同时连接 LAN + Relay 时，同一 session 通过 tag（[LAN] / [Relay]）各自独立显示，消息以最新时间戳覆盖
22. 手机通过 relay 可以看到 PC 端的宠物状态
23. 手机通过 relay 可以完成权限审批
24. relay 断线后 LAN 连接不受影响，relay 自动重连
25. 无 relay 时 LAN 直连行为完全不变

## 风险点

| 风险 | 缓解 |
|------|------|
| relay 成为单点故障 | LAN 连接作为 fallback，relay 断线不影响 LAN |
| 双连接会话合并复杂 | Session 带 tag 标识，UI 按 tag 分组显示 |
| 消息重复（LAN 和 Relay 同时收到） | 同一 session 通过 LAN 和 Relay 各自维护一份，tag 区分来源（[LAN] / [Relay]），UI 独立显示。消息级别：同一 session 的同一消息类型，以最新时间戳为准覆盖 |
| TLS 证书管理复杂 | 自签证书默认 + Let's Encrypt 可选 + 文档说明 |
| token 泄露 | 支持 token 轮换（重新运行 deploy 脚本） |
| 上游同步冲突 | relay 代码完全隔离在 `relay/` 目录 + 独立新增文件，prefs-direct 初始化不动 main.js |

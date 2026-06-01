# Clawd Android 端系统性评估报告

> 评估日期：2026-06-01
> 评估范围：android/app/src/main/java/com/clawd/mobile/ 全部 ~40 个 Kotlin 文件

---

## 一、架构概览

| 维度 | 评估 |
|------|------|
| **架构模式** | MVVM（部分） + Service-driven（WebSocketService + FloatingPetService） |
| **UI 框架** | Jetpack Compose + Navigation Compose |
| **网络层** | OkHttp SSE（非 WebSocket，尽管类名叫 ClawdWebSocket） |
| **状态管理** | StateFlow + SharedFlow |
| **数据持久化** | EncryptedSharedPreferences（AES-256-GCM） |
| **依赖注入** | 无（手动构造，Service companion object 全局单例） |

---

## 二、安全性评估

### ✅ 做得好的

1. **Token 存储**：`PrefsStore` 使用 `EncryptedSharedPreferences` + `MasterKey.AES256_GCM`，从明文迁移逻辑也完备
2. **日志脱敏**：`ConnectionConfig.streamUrlMasked()` 掩码处理 token，不会在日志中泄露
3. **Receiver 不导出**：`ApprovalReceiver` 设置 `exported="false"`
4. **Intent 数据校验**：`handleApprovalIntent` 有 try-catch 反序列化保护

### ⚠️ 需要关注的风险

| 风险 | 严重度 | 位置 | 说明 |
|------|--------|------|------|
| **全局允许明文流量** | 🟡 中 | `AndroidManifest.xml:23` `usesCleartextTraffic="true"` + `network_security_config` 全局 `cleartextTrafficPermitted="true"` | 虽然有 `isLan` 判断用 http/https，但系统层面不阻止明文。建议改为 domain-config 仅允许 LAN IP 段 |
| **Token 在 URL query string** | 🟡 中 | `ConnectionConfig.streamUrl()` `?token=$token` | URL 参数会被代理、CDN、服务器日志记录。建议用 `Authorization` header |
| **非 LAN 无证书固定** | 🟡 中 | `ClawdWebSocket:45-47` 只是 `Log.w` 提醒，未实际 pin | 公网连接存在 MITM 风险 |
| **审批请求无 CSRF 保护** | 🟢 低 | `ApprovalReceiver` POST 到 `/mobile/approve` | 仅靠 token 认证，如果 token 泄露可伪造审批 |
| **proguard 保留 Glide 规则** | 🟢 低 | `proguard-rules.pro:19-26` | Glide 已不在依赖中，死代码 |

---

## 三、可维护性评估

### ✅ 做得好的

1. **SafeExecutor 统一异常处理**：三级策略（tryOrNull/tryOrLog/tryOrReport），避免裸 try-catch
2. **PetState sealed class**：类型安全的状态枚举，priority 机制清晰
3. **PetStateManager 单一管道**：`StateCommand` sealed interface 统一所有状态变更和 SVG 加载，消除了双管道竞态
4. **SvgLoader 资源映射**：与 PC 端 theme.json 对齐，fallback 链完备
5. **overlay 模块拆分**：`PetWindowController`/`PetGestureHandler`/`PetBubbleManager` 职责分离良好

### ⚠️ 问题

| 问题 | 严重度 | 说明 |
|------|--------|------|
| **无依赖注入** | 🟡 中 | `WebSocketService.getWebSocket()` 全局静态访问，`PrefsStore` 在多处重复构造。ViewModel 通过 Factory 手动传参。建议引入 Koin 或 Hilt |
| **类名误导** | 🟡 中 | `ClawdWebSocket` 实际用 SSE（`EventSource`），不是 WebSocket。建议重命名为 `ClawdSseClient` |
| **MainActivity 过长** | 🟡 中 | 权限请求链 + 内容设置 + intent 处理全在一个文件，建议拆分 PermissionFlow |
| **prefs key 硬编码散落** | 🟢 低 | `session_name_$sessionId` 动态 key 无约束，长期可能膨胀 |

---

## 四、代码职责评估

### 职责分布（按模块）

| 模块 | 职责 | 评估 |
|------|------|------|
| `ws/ClawdWebSocket` | SSE 连接 + 消息解析 + 重连 + 审批发送 | ⚠️ **偏重**（429 行），承担了连接管理和协议解析双重职责 |
| `service/WebSocketService` | 前台服务 + 连接生命周期 + 锁管理 + 通知 | ✅ 合理 |
| `overlay/PetStateManager` | 状态决策引擎 | ✅ 优秀，文档完善 |
| `overlay/FloatingPetService` | 悬浮窗生命周期 + 广播 + 命令分发 | ✅ 合理 |
| `overlay/SvgLoader` | SVG 资源映射 + WebView 加载 | ⚠️ 偏重（534 行），建议将 HTML 模板生成拆出 |
| `ui/approval/ApprovalViewModel` | 审批请求管理 + 倒计时 + 通知协调 | ✅ 合理 |
| `notification/` | 通知构建 + 发送 | ✅ 清晰 |
| `data/PrefsStore` | 持久化 | ⚠️ 偏重，承担了 config/history/notify/pet/session name 全部存储 |

### 单一职责违反

**ClawdWebSocket** 是最大的 SRP 违反者：

- SSE 连接管理
- 消息 JSON 解析（~100 行 when 分支）
- 审批 HTTP POST
- 工具输入摘要构建
- 会话状态管理
- 重连逻辑

建议拆为：`SseConnection`、`MessageParser`、`ApprovalSender`

---

## 五、状态机评估

### ConnectionState（连接状态机）

```
DISCONNECTED → CONNECTING → CONNECTED
                ↓                ↓
            RECONNECTING ←──────┘ (onFailure/onClosed)
                ↓
            AUTH_FAILED (401, 终态)
```

**评估**：✅ 状态转移清晰，AUTH_FAILED 作为终态正确。但 `reconnect()` 中 `if (CONNECTED) return` 的守卫缺少对 CONNECTING/RECONNECTING 的检查，可能导致并发重连。

### PetState（宠物状态机）

```
Idle ←→ Active states (Working/Thinking/Juggling/...)
  ↓ (60s timeout)
Yawning → [Collapsing] → Sleeping
  ↑ (new activity)
Waking → Active state
```

**评估**：✅ 设计优秀

- 优先级机制与 PC 端对齐
- 睡眠序列有 `gifGeneration` 原子计数器防竞态
- `sessionMutex` 保护并发状态更新
- Watchdog 强制 idle 防止卡死

**唯一风险**：`consumedDoneSessions` 是普通 `MutableSet`，在协程中无同步保护。虽然当前只在 `updateSessions`（有 mutex）内访问，但如果未来重构可能引入竞态。

---

## 六、技术债务清单

| 债务 | 类型 | 影响 | 建议 |
|------|------|------|------|
| ClawdWebSocket 职责过重 | 架构 | 可维护性 | 拆分为 SseConnection + MessageParser + ApprovalSender |
| 全局单例模式（WebSocketService.instance） | 架构 | 可测试性 | 引入 DI 框架 |
| SvgLoader HTML 模板硬编码 | 可维护性 | 修改成本 | 抽取 HTML 模板到 assets 或 template 函数 |
| proguard 中 Glide 规则残留 | 清理 | 无功能影响 | 删除 |
| proguard 中 debug 也启用了 minify | 构建 | 调试体验 | `build.gradle.kts:42` debug buildType 不应 minify |
| `ConnectionConfig.isLan` 用 Regex 匹配 IP | 正确性 | 边界情况 | 172.20.x.x 等非 RFC1918 也会匹配。建议用 `InetAddress` 解析 |
| 无单元测试 | 质量 | 回归风险 | 仅 `ConnectionConfigTest.kt` 一个测试文件 |
| `wakeLock`/`wifiLock` 无超时保护 | 稳定性 | 电量消耗 | `acquire()` 应传入超时参数 |
| `ApprovalViewModel.recentlyDismissed` 无限增长 | 内存 | 内存泄漏 | 应设置 TTL 或上限 |

---

## 七、综合评分

| 维度 | 分数 | 说明 |
|------|------|------|
| **安全性** | 7/10 | 加密存储好，但明文流量全局放行 + token in URL |
| **可维护性** | 7.5/10 | 模块拆分合理，PetStateManager 文档优秀，但无 DI + 无测试 |
| **代码职责** | 7/10 | overlay 层拆分好，ws 层职责过重 |
| **状态机设计** | 9/10 | 设计清晰、防竞态完备、与 PC 端对齐 |
| **技术债务** | 7.5/10 | 无 TODO/FIXME，但有架构层面的债务积累 |
| **总体** | **7.5/10** | 生产可用，架构中上，主要改进方向是安全加固和 ws 层拆分 |

---

## 八、优先改进路线

### P0 — 安全加固

- [ ] Token 从 URL query string 移至 `Authorization` header
- [ ] `network_security_config` 收窄：仅 LAN IP 段允许明文，其余强制 TLS
- [ ] 非 LAN 连接实现 CertificatePinner（至少提供配置入口）

### P1 — 架构优化

- [ ] 拆分 `ClawdWebSocket` → `SseConnection` + `MessageParser` + `ApprovalSender`
- [ ] 重命名 `ClawdWebSocket` → `ClawdSseClient`
- [ ] 引入 Koin/Hilt 依赖注入，消除全局静态访问
- [ ] 拆分 `MainActivity` 权限流程为独立 `PermissionFlow` 类

### P2 — 质量提升

- [ ] 为 `PetStateManager`、`ApprovalViewModel`、`ClawdWebSocket` 添加单元测试
- [ ] debug buildType 关闭 `isMinifyEnabled`（`build.gradle.kts:42`）
- [ ] `ConnectionConfig.isLan` 改用 `InetAddress` 解析，避免 Regex 边界问题
- [ ] `wakeLock.acquire()` 添加超时参数

### P3 — 清理

- [ ] 删除 proguard 中 Glide 残留规则
- [ ] `ApprovalViewModel.recentlyDismissed` 添加 TTL 或大小上限
- [ ] `SvgLoader` HTML 模板抽取为独立函数或 asset 文件

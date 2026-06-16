# Clawd Android 系统性评估 — 修复计划索引

> 按严重程度排序。每个计划可独立执行，复制"启动提示词"到 Claude 即可启动。

---

## P0 — 立即修复（安全/误导）

| # | 计划 | 工时 | 启动提示词 |
|---|------|------|-----------|
| 1 | [Token URL 泄露](P0-1-token-url-leak.md) | 1h | `执行 P0-1: 修复 Token URL 泄露，将 streamUrl 中的 token 移至 Authorization header only，移除 URL query 中的 token 参数` |
| 2 | [TOFU 证书固定](P0-2-tofu-cert-pinning.md) | 2h | `执行 P0-2: 实现 TOFU 证书固定，非 LAN 首次连接时展示 fingerprint 供用户确认，确认后自动 pinning` |
| 3 | [重命名 ClawdWebSocket](P0-3-rename-clawdwebsocket.md) | 30min | `执行 P0-3: 将 ClawdWebSocket 重命名为 SseClient，同步更新所有引用、日志 TAG、文件名` |

## P1 — 近期改进（泄漏/职责/耦合）

| # | 计划 | 工时 | 启动提示词 |
|---|------|------|-----------|
| 4 | [ApprovalReceiver → WorkManager](P1-1-approval-receiver-to-workmanager.md) | 2h | `执行 P1-1: 将 ApprovalReceiver 中的 goAsync+协程替换为 WorkManager，消除 ANR 风险和协程泄漏` |
| 5 | [抽取 MessageParser](P1-2-extract-message-parser.md) | 1.5h | `执行 P1-2: 从 ClawdWebSocket.handleMessage 中抽取 MessageParser 类，将 8 种消息类型的解析逻辑独立封装` |
| 6 | [consumedDoneSessions 清理](P1-3-consumed-done-sessions-cleanup.md) | 30min | `执行 P1-3: 修复 PetStateManager.consumedDoneSessions 无清理机制导致的内存泄漏，添加 TTL 过期清理` |
| 7 | [消除静态 WebSocket 访问](P1-4-remove-static-websocket-access.md) | 1.5h | `执行 P1-4: 消除 PetStateManager 和 FloatingPetService 对 WebSocketService.getWebSocket() 的静态访问，改为构造函数注入 sessions Flow` |

## P2 — 中期优化（性能/测试）

| # | 计划 | 工时 | 启动提示词 |
|---|------|------|-----------|
| 8 | [ApprovalViewModel 测试](P2-1-approval-viewmodel-tests.md) | 2h | `执行 P2-1: 为 ApprovalViewModel 编写单元测试，覆盖倒计时、去重、自动超时、通知恢复等核心逻辑` |
| 9 | [WakeLock 续期](P2-2-wakelock-renewal.md) | 30min | `执行 P2-2: 为 WebSocketService 的 WakeLock 添加续期机制，避免 1 小时超时后 SSE 连接断开` |
| 10 | [sessions Map GC 优化](P2-3-sessions-map-gc-pressure.md) | 1h | `执行 P2-3: 优化 ClawdWebSocket 中 sessions Map 的高频拷贝问题，减少 GC 压力，使用 ConcurrentHashMap in-place 更新替代每次创建新 Map` |
| 11 | [SvgLoader 线程安全](P2-4-svloader-thread-safety.md) | 1h | `执行 P2-4: 改进 SvgLoader 的线程安全，将 assetCache/missingCache 改为线程安全集合，消除初始化时序依赖` |

## P3.5 — 用户体验修复

| # | 计划 | 工时 | 启动提示词 |
|---|------|------|-----------|
| 15 | [悬浮窗大小实时生效 + 重启自动恢复](P4-1-floating-pet-size-and-restore.md) | 1.5h | `执行 P4-1: 修复悬浮窗大小滑块不实时生效（改为 onValueChange 发送广播 + setPackage），以及退出 app 重启后悬浮窗不自动恢复（将自动启动逻辑移至 MainActivity）` |

## P3 — 长期规划（架构/测试）

| # | 计划 | 工时 | 启动提示词 |
|---|------|------|-----------|
| 12 | [network_security_config](P3-1-network-security-config.md) | 30min | `执行 P3-1: 精细化 network_security_config，移除 manifest 级 usesCleartextTraffic，仅对 LAN 地址段放行明文流量` |
| 13 | [Repository 层](P3-2-repository-layer.md) | 3h | `执行 P3-2: 抽取 SessionRepository 统一数据访问，封装 ClawdWebSocket.sessions 和 PrefsStore 的 session 相关操作` |
| 14 | [集成测试](P3-3-integration-tests.md) | 4h | `执行 P3-3: 补充集成测试，覆盖 Service 生命周期、SSE 连接重连、PetStateManager 与 WebSocket 的端到端协作` |

---

## 工时汇总

| 优先级 | 计划数 | 总工时 |
|--------|--------|--------|
| P0 | 3 | 3.5h |
| P1 | 4 | 5.5h |
| P2 | 4 | 4.5h |
| P3.5 | 1 | 1.5h |
| P3 | 3 | 7.5h |
| **合计** | **15** | **22.5h** |

## 推荐执行顺序

```
P4-1 (悬浮窗体验) → P0-1 (Token) → P0-3 (重命名) → P1-3 (TTL 清理) → P1-2 (MessageParser)
→ P0-2 (TOFU) → P1-1 (WorkManager) → P1-4 (静态访问)
→ P2-1 (测试) → P2-2 (WakeLock) → P2-3 (GC) → P2-4 (SvgLoader)
→ P3-1 → P3-2 → P3-3
```

**理由**: P4-1 用户反馈的体验问题，改动小（~15行）、风险低、用户感知明显，优先处理。后续按原顺序执行。

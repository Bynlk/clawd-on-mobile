# Clawd Android 端改进路线图

> 基于 2026-06-02 系统性评估（AUDIT_REPORT.md）
> 综合评分：75/100 → 目标 85/100

---

## 总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        改进路线图时间线                              │
├──────────┬──────────────┬──────────────────┬────────────────────────┤
│   P0     │      P1      │       P2         │          P3           │
│ 立即修复 │  短期(1-2周)  │   中期(1个月)     │      长期(持续)        │
│ 2-3 天   │   5-8 天     │   10-15 天       │      20-30 天         │
├──────────┼──────────────┼──────────────────┼────────────────────────┤
│ 安全加固  │ Token迁移    │ 轮询消除         │ ws 层拆分             │
│ 可靠性   │ 依赖清理     │ 测试覆盖         │ 依赖注入              │
│ 竞态消除  │ 单例化       │ 代码质量         │ 渲染优化              │
│          │ 深链验证     │                  │ LAN HTTPS             │
└──────────┴──────────────┴──────────────────┴────────────────────────┘
```

---

## 各阶段概览

### P0 — 安全加固（立即，2-3 天）

| 任务 | 关联 | 工作量 |
|------|------|--------|
| WakeLock 添加超时 | H-03 | S |
| ApprovalReceiver 改用 goAsync() | H-01 | M |
| HttpClientProvider 添加 synchronized | H-02 | S |
| allowBackup 设为 false | L-02 | S |
| network_security_config 收窄 | C-01 | S |

**目标**：消除所有 Critical 和 High 级别的安全/可靠性问题。

📄 详见 [PLAN_P0_SECURITY.md](PLAN_P0_SECURITY.md)

---

### P1 — 短期改进（1-2 周）

| 任务 | 关联 | 工作量 | 依赖 |
|------|------|--------|------|
| PrefsStore 单例化 | M-08 | S | 无 |
| ApprovalViewModel 请求去重 | M-12 | S | 无 |
| 深链 host 验证 | M-02 | S | 无 |
| 移除 Glide/mlkitBarcode 残留 | L-03, L-04 | S | 无 |
| 统一 OkHttpClient 创建 | TD-12 | M | P0-3 |
| Token 迁移到 Authorization header | H-04 | M | P1-5 |
| 非 LAN 证书固定入口 | H-05 | M | P1-5 |

**目标**：完成安全加固的剩余部分，清理依赖残留，统一 HTTP 客户端。

📄 详见 [PLAN_P1_SHORT_TERM.md](PLAN_P1_SHORT_TERM.md)

---

### P2 — 质量提升（1 个月）

| 任务 | 关联 | 工作量 | 依赖 |
|------|------|--------|------|
| WebSocket 就绪事件机制 | M-07 | M | 无 |
| SvgLoader HTML 模板抽取 | M-09 | M | 无 |
| assetCache 容量上限 | M-13 | S | 无 |
| 优先级定义统一 | M-15 | S | 无 |
| consumedDoneSessions 线程安全 | M-16 | S | 无 |
| debug 关闭 minify | L-05 | S | 无 |
| isLan 改用 InetAddress | L-06 | S | 无 |
| recentlyDismissed 上限 | L-07 | S | 无 |
| Log.w → Log.d 修正 | L-08 | S | 无 |
| 硬编码颜色提取 | L-09 | S | 无 |
| 核心逻辑单元测试 | L-11 | L | P2-1~10 |

**目标**：消除轮询反模式，提升代码质量，建立测试基线。

📄 详见 [PLAN_P2_QUALITY.md](PLAN_P2_QUALITY.md)

---

### P3 — 架构演进（长期，持续）

| 任务 | 关联 | 工作量 | 风险 | 依赖 |
|------|------|--------|------|------|
| ClawdWebSocket 拆分 | M-10 | L | 中 | 无 |
| 引入依赖注入（Koin） | M-03 | L | 高 | P3-1 |
| SessionProvider 接口解耦 | M-11 | M | 中 | P3-1 |
| MainActivity 权限流程拆分 | M-05 | M | 低 | 无 |
| SettingsScreen Section 拆分 | M-06 | M | 低 | 无 |
| LAN HTTPS 自签证书支持 | C-01 | L | 高 | P3-1 |
| WebView 渲染优化 | M-14 | L | 高 | 无 |
| WebSocketService 改用 bindService | L-12 | L | 高 | P3-3 |

**目标**：完成架构级重构，提升可测试性和可维护性。

📄 详见 [PLAN_P3_ARCHITECTURE.md](PLAN_P3_ARCHITECTURE.md)

---

## 依赖关系图

```
P0-3 (HttpClientProvider synchronized)
  └── P1-5 (统一 OkHttpClient)
        ├── P1-6 (Token → Auth Header)
        └── P1-7 (证书固定入口)

P3-1 (ClawdWebSocket 拆分)
  ├── P3-2 (重命名)
  ├── P3-3 (Koin DI)
  │     └── P3-9 (bindService)
  ├── P3-4 (SessionProvider 接口)
  └── P3-7 (LAN HTTPS)

P2-1~P2-10 (质量改进)
  └── P2-11 (单元测试)
```

**可并行的任务**：
- P0 全部任务可并行
- P1-1、P1-2、P1-3、P1-4 可并行
- P2 全部任务可并行（P2-11 最后）
- P3-5、P3-6、P3-8 可独立于 P3-1 并行

---

## 里程碑

| 里程碑 | 完成标准 | 预计时间 |
|--------|----------|----------|
| **M0：安全基线** | P0 全部完成，无 Critical/High 安全问题 | 第 1 周 |
| **M1：短期改进** | P1 全部完成，依赖清理完毕 | 第 3 周 |
| **M2：质量基线** | P2 全部完成，测试覆盖率 > 70% | 第 7 周 |
| **M3：架构现代化** | P3 全部完成，可测试性显著提升 | 第 12 周 |

---

## 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| Token 迁移需要桌面端同步修改 | P1-6 阻塞 | 中 | 先在移动端做好准备，桌面端就绪后切换 |
| Koin 引入导致构建变慢 | 开发体验下降 | 低 | Koin 无注解处理，影响极小 |
| LAN HTTPS 需要桌面端配合 | P3-7 阻塞 | 高 | 可先做移动端证书固定逻辑，桌面端就绪后对接 |
| WebView → Lottie 动画丢失 | 用户体验下降 | 中 | 先做 P3-8a 优化，评估后再决定是否迁移 |
| bindService 改造影响 Service 生命周期 | 功能异常 | 中 | 充分测试，保留 startService 作为降级方案 |

---

## 指标追踪

改进完成后的目标指标：

| 指标 | 当前 | 目标 | 衡量方式 |
|------|------|------|----------|
| 综合评分 | 75/100 | 85/100 | 下次审计 |
| 安全评分 | 72/100 | 85/100 | 无 Critical/High 问题 |
| 测试覆盖率 | ~2% | > 70% | `./gradlew test` + 覆盖率报告 |
| 核心类行数 | ClawdWebSocket 429行 | < 200行/类 | 代码统计 |
| 静态耦合点 | 3 处 getWebSocket() | 0 处 | 代码审查 |
| 依赖残留 | Glide + mlkitBarcode | 0 | 版本目录审查 |

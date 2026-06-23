# Clawd on Mobile v0.10.0

> 🎉 **重大版本更新** — 新增浮窗审批、远程中继、应用内语言切换，安全性与测试覆盖率大幅提升

---

## 📦 下载

| 文件 | 说明 |
|------|------|
| `app-release.apk` | Android 8.0+ (API 26+)，arm64-v8a |

---

## ✨ 新功能

### 🐾 浮窗审批气泡
- 悬浮窗上直接审批权限请求，无需打开 App
- **提示态**：小药丸显示"审批（点击展开）"
- **展开态**：工具名、摘要、左右滑动拒绝/允许、倒计时进度条
- FIFO 队列管理，多个审批请求排队处理
- 通知与浮窗审批双向同步（`approvalCompletedFlow`）
- 支持 `suggestionIndex`（如"始终允许此工具"）

### 🌐 远程中继（Relay）
- 通过远程 VPS 中继连接 PC 端，**支持非局域网环境**
- `ConnectionStrategy` 策略模式：LAN 直连与 Relay 中继完全解耦
- `SessionMerger` 合并 LAN + Relay 双连接的会话为统一视图
- `RelaySettings` UI：配置 Relay 地址、Token、状态检查
- Relay 客户端网络切换即时重连
- Peer 连接状态监控（PC 在线/离线）

### 🌍 应用内语言切换
- 支持中/英文实时切换，无需重启 App
- 三语言 strings.xml 完全同步（values/values-en/values-zh）

### ⚙️ 桌宠设置增强
- **悬浮窗大小滑块** — 实时预览，启动时自动恢复
- **可配置睡眠超时** — 30s / 1min / 5min / 不睡眠
- **点击穿透开关** — 透明区域触摸穿透到下层应用
- **连接状态卡片合并** — 扫码/手动输入合并为一个界面

---

## 🔒 安全改进

| 改进 | 说明 |
|------|------|
| 签名密码移除 | `gradle.properties` 中的明文密码移除，改用环境变量注入 |
| ProGuard 日志清理 | release 构建移除 `Log.d`/`Log.v`/`Log.i`，防止敏感信息泄露 |
| 网络明文禁止 | `network_security_config.xml` 全局 `cleartextTrafficPermitted=false` |
| 加密存储 | `EncryptedSharedPreferences` (AES-256-GCM) 保护 Token、证书指纹 |
| TOFU 证书固定 | 首次 LAN 连接记录证书指纹，后续严格比对 |

---

## 🛡️ 鲁棒性改进

| 改进 | 说明 |
|------|------|
| loadConfig 根源保护 | `PrefsStore.loadConfig()` 整体 try-catch，防止 EncryptedSharedPreferences 损坏时崩溃 |
| 安全调用替代 `!!` | `WsConnectionService.onCreate` 消除 NPE 风险 |
| 指数退避 + 断路器 | 1s-30s 抖动退避，10 次后断路，60s 自动恢复 |
| Watchdog 心跳 | 90s 超时检测静默死连接 |
| WorkManager 审批 | 后台审批通过 WorkManager 执行，避免 BroadcastReceiver ANR |

---

## 🌐 国际化完善

- 27 个新增字符串资源，三语言完全同步
- `RelaySettings` 12 处硬编码中文 → `stringResource()`
- `ApprovalBubbleView` 8 处硬编码中文 → `context.getString()`
- `WsConnectionService` 7 处 relay 状态 → `getString(R.string.xxx)`
- `SettingsScreen` "远程中继" → `stringResource(R.string.settings_relay)`

---

## 🧪 测试提升

| 指标 | 数值 |
|------|------|
| 总测试数 | **548 个**（全部通过） |
| 新增测试 | 103 个 |
| 新增测试文件 | 5 个（SessionMerger、ConnectionLog、TimedConsumeSet、ConnectionStrategy、MessageHandler） |
| 删除无效测试 | 3 个（占位常量检查） |

### 新增测试覆盖
- `SessionMergerTest` — 15 个测试：双连接会话合并、注册/注销、Flow 发射
- `ConnectionLogTest` — 15 个测试：环形缓冲区、并发安全、格式验证
- `TimedConsumeSetTest` — 28 个测试：TTL 过期、并发消费、边界条件
- `ConnectionStrategyTest` — 16 个测试：LAN/Relay URL 构建、认证头、异常处理
- `MessageHandlerTest` — 26 个测试：消息分发、状态更新、Flow 发射

---

## 🐛 Bug 修复

- 修复悬浮窗拖拽漂移和点击穿透问题
- 修复 Oneshot 状态恢复时错误显示 Working 状态
- 修复 LAN 扫码连接失败问题
- 修复 Error 动画阻塞和 SVG 映射不一致
- 修复 Relay 客户端网络切换不通知问题
- 修复 README CI badge 链接指向错误仓库

---

## 📊 统计

| 指标 | 数值 |
|------|------|
| Android 提交数 | 65+ |
| 代码行数变化 | +12,576 / -6,979 |
| 测试总数 | 548 |
| 评估置信度 | 95% |
| 加权质量评分 | 77/100（初始 71，+6） |

---

## 📝 升级说明

1. 下载 `app-release.apk`
2. 覆盖安装（数据会保留）
3. 如使用 Relay 功能，在设置页配置 Relay 地址和 Token
4. 重新连接桌面端

---

## 🙏 致谢

- 原作者 [@rullerzhou-afk](https://github.com/rullerzhou-afk)（鹿鹿）
- 桌面端贡献者：@zxypro1、@sLingli、@cod3hulk、@lxgxhsy、@rebootcrab-blip、@ustin-star

---

## 🔗 链接

- [Android README](https://github.com/Bynlk/clawd-on-mobile/blob/main/android/README.md)
- [上游项目](https://github.com/rullerzhou-afk/clawd-on-desk)

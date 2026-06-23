<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd Mobile">
</p>

<h1 align="center">Clawd Mobile</h1>
<p align="center">
  <strong><a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> 的 Android 伴侣应用 — 一只实时感知 AI 编码 Agent 的赛博桌宠。</strong>
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README-desk.md">Desktop (English)</a>
  ·
  <a href="README-desk.zh-CN.md">桌面端中文</a>
  ·
  <a href="README-desk.ja-JP.md">日本語</a>
  ·
  <a href="README-desk.ko-KR.md">한국어</a>
</p>

<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml"><img src="https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml/badge.svg" alt="Android Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License"></a>
  <a href="https://github.com/Bynlk/clawd-on-mobile/releases"><img src="https://img.shields.io/github/v/release/Bynlk/clawd-on-mobile" alt="Version"></a>
  <img src="https://img.shields.io/badge/Android-8.0%2B-green.svg" alt="Android 8.0+">
  <img src="https://img.shields.io/badge/API-26%2B-brightgreen.svg" alt="API 26+">
</p>

---

> **🙏 致敬原作者**
>
> 本项目基于 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)（Clawd on Desk）桌面端开发。原项目由 [@rullerzhou-afk](https://github.com/rullerzhou-afk)（鹿鹿 / Ruller_Lulu）创建——一只住在你桌面上的小螃蟹，实时感知 AI 编码 Agent 的每一个呼吸。
>
> Android 端由社区开发者 [@Bynlk](https://github.com/Bynlk) 移植并维护，感谢所有为项目做出贡献的[开发者们](#-贡献者)。

---

## 📖 目录

- [什么是 Clawd Mobile？](#-什么是-clawd-mobile)
- [功能特性](#-功能特性)
- [截图展示](#-截图展示)
- [快速开始](#-快速开始)
- [架构设计](#-架构设计)
- [通信协议](#-通信协议)
- [开发指南](#-开发指南)
- [参与贡献](#-参与贡献)
- [路线图](#-路线图)
- [常见问题](#-常见问题)
- [贡献者](#-贡献者)
- [许可证](#-许可证)
- [致谢](#-致谢)

---

## 🐾 什么是 Clawd Mobile？

**Clawd Mobile** 是一个原生 Android 客户端，连接到 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 桌面端。它通过 **局域网或远程中继** 实时监控你的 AI 编码 Agent 活动，并在手机屏幕上显示一只会动的桌宠，实时感知 Agent 的每一个动作。

| 特性 | 实现机制 | 体感 |
|------|----------|------|
| **毫秒级状态同步** | WebSocket + `StateFlow` 管道，延迟 < 200ms | 小螃蟹和你的 Agent 同时开始打字 |
| **纯血角色隔离** | 服务器端 `displayState` + `PetStateManager` 决策引擎 | 三只角色（螃蟹/三花猫/白云）独立状态映射 |
| **极低功耗挂机** | `WifiLock` + `WakeLock` + 30s 看门狗 + 指数退避（1s→30s） | 后台功耗 < 50mW，挂机一整天 |
| **浮窗审批** | 在悬浮气泡上左右滑动审批权限请求 | 无需打开 App |
| **远程中继** | 通过 VPS 中继服务器连接 | 随时随地监控你的 Agent |

---

## ✨ 功能特性

### 核心体验
- 🐾 **动画悬浮宠物** — SVG/APNG + CSS 动画（呼吸、眨眼、尾巴摇摆）
- 📱 **16 种状态** — Working、Thinking、Idle、Sleeping、Error、Notification 等
- 🎯 **灵性睡眠序列** — Yawning → Dozing → Collapsing → Sleeping + 随机 idle 变体
- 🏆 **Happy 庆祝动画** — 任务完成时播放 1.5s 庆祝动画

### v0.10.0 — 最新版本
- 🐾 **浮窗审批气泡** — 在悬浮气泡上左右滑动审批/拒绝权限请求
- 🌐 **远程中继** — 通过 VPS 中继服务器连接，支持非局域网环境
- 🌍 **应用内语言切换** — 中/英文实时切换，无需重启
- 🔒 **安全加固** — 加密存储、TOFU 证书固定、日志清理
- 🧪 **548 个测试** — 全部通过，新增 103 个测试

---

## 📸 截图展示

> _截图即将添加。App 在手机屏幕上显示一只会动的桌宠，实时感知你的 AI Agent 活动。_

| 悬浮宠物 | 审批气泡 | 设置页面 |
|:---:|:---:|:---:|
| _截图_ | _截图_ | _截图_ |

---

## ⚡ 快速开始

### 前置条件
- Android 8.0+ (API 26) 设备，arm64-v8a 架构
- PC 端运行 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)

### 安装步骤

1. 从 [Releases](https://github.com/Bynlk/clawd-on-mobile/releases) 下载最新 `app-release.apk`
2. 在 Android 设备上安装 APK
3. 打开 App，扫描 PC 端显示的二维码，或手动输入连接信息
4. 授予请求的权限（通知、摄像头、悬浮窗）
5. 你的宠物上线了！🎉

### 连接方式

| 方式 | 适用场景 |
|------|---------|
| **二维码扫描** | PC 和手机在同一局域网 — 最快 |
| **手动输入** | 手动输入 PC 的 IP、端口和 Token |
| **远程中继** | 通过 VPS 中继服务器连接，支持非局域网环境 |

---

## 🏛️ 架构设计

Clawd Mobile 采用**单管道架构**，所有状态变更通过一条统一的 `StateFlow` 流转：

```
PC (WebSocket) → StreamingClient → PetStateManager → FloatingPetService
                                          ↓
                                    StateCommand (单管道)
                                          ↓
                              SvgLoader → FloatingPetView (WebView SVG)
```

**核心设计决策：**
- **单管道** — 消除并发 SVG 加载竞态
- **模板方法模式**（`StreamingClient` → `AbstractStreamingClient` → `WsClient`）— 易于扩展传输协议
- **策略模式**（`ConnectionStrategy`）— LAN/Relay 连接解耦
- **SessionMerger** — 统一 LAN + Relay 会话为一个视图

详细架构文档见 [android/README.md](android/README.md)。

---

## 📡 通信协议

```
WebSocket:  ws://<host>:23334/mobile/ws
审批回传:   POST http://<host>:23334/mobile/approve
Deep Link:  clawd://<host>:<port>/<token>
```

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `ping` | 服务端 → 客户端 | 心跳保活 |
| `connected` | 服务端 → 客户端 | 连接确认 |
| `snapshot` | 服务端 → 客户端 | 全量会话快照 |
| `state` | 服务端 → 客户端 | 单会话状态更新 |
| `permission_request` | 服务端 → 客户端 | 审批请求 |
| `reaction` | 服务端 → 客户端 | SVG 反应动画 |

---

## 🔧 开发指南

### 环境要求
- Android Studio Hedgehog (2023.1.1)+
- JDK 17
- Android SDK 35
- arm64-v8a 设备或模拟器

### 构建

```bash
cd android

# Debug APK
./gradlew assembleDebug

# Release APK（需要签名配置）
KEYSTORE_FILE=release.keystore \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# 运行测试（548 个测试）
./gradlew testDebugUnitTest
```

### CI/CD

推送到 `main` 分支且修改 `android/` 目录下的文件时，GitHub Actions 自动触发：lint → build → test → artifact 上传。

---

## 🤝 参与贡献

我们欢迎贡献！以下是参与方式：

1. **Fork** 本仓库
2. **创建** 功能分支：`git checkout -b feat/my-feature`
3. **提交** 清晰的 commit：`git commit -m "feat: add my feature"`
4. **Push** 到你的 fork：`git push origin feat/my-feature`
5. **发起** Pull Request

### 贡献规范
- 遵循 Kotlin 编码规范
- 新功能请添加测试
- 如有需要请更新文档
- PR 描述中引用相关 Issue

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 🗺️ 路线图

| 优先级 | 项目 | 状态 |
|--------|------|------|
| ✅ | WebSocket 迁移（从 SSE） | 已完成 |
| ✅ | TOFU 证书固定 | 已完成 |
| ✅ | 浮窗审批气泡 | 已完成 |
| ✅ | 远程中继支持 | 已完成 |
| ✅ | 应用内语言切换 | 已完成 |
| ✅ | 安全加固 | 已完成 |
| 🔄 | Hilt 依赖注入 | 计划中 |
| 🔄 | Repository 模式 | 计划中 |
| 🔄 | AbstractStreamingClient 测试 | 计划中 |

完整路线图见 [android/docs/ROADMAP.md](android/docs/ROADMAP.md)。

---

## ❓ 常见问题

**Q: 需要安装桌面端吗？**
A: 是的。Clawd Mobile 是伴侣应用，需要连接到 PC 端运行的 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)。

**Q: 可以在家以外的网络使用吗？**
A: 可以！v0.10.0 新增了远程中继支持。在 VPS 上部署中继服务器，即可从任何地方连接。

**Q: 支持哪些 AI Agent？**
A: 支持所有 Clawd on Desk 兼容的 Agent — Claude Code、Codex、Cursor、Copilot、Gemini 等。

**Q: 宠物不动 / 一直显示 idle**
A: 确保桌面端已连接且有活跃会话。在 App 设置页检查连接状态。

**Q: 如何更新？**
A: 从 [Releases](https://github.com/Bynlk/clawd-on-mobile/releases) 下载最新 APK，覆盖安装即可，数据会保留。

---

## 👥 贡献者

### Android 移植
- [@Bynlk](https://github.com/Bynlk) — Android 移植开发者 & 维护者

### 桌面端贡献者
以下开发者为 Clawd 生态（桌面端 + 移动端）做出了贡献：

| 贡献者 | 贡献内容 |
|--------|---------|
| [@rullerzhou-afk](https://github.com/rullerzhou-afk) (鹿鹿) | Clawd on Desk 原作者 |
| [@Ruller_Lulu](https://github.com/Ruller_Lulu) | 核心开发 |
| [@Yoimiya](https://github.com/Yoimiya) | 重大贡献 |
| [@Lyu Bingrong](https://github.com/LyuBingrong) | 功能与修复 |
| [@hwasowl](https://github.com/hwasowl) | 功能与修复 |
| [@nmsn](https://github.com/nmsn) | 功能与修复 |
| [@zxypro](https://github.com/zxypro) | Telegram 审批状态 |
| [@sLingli](https://github.com/sLingli) | Reasonix CLI 集成 |
| [@cod3hulk](https://github.com/cod3hulk) | tmux 焦点支持 |
| [@lxgxhsy](https://github.com/lxgxhsy) | Windows 焦点缓存 |
| [@rebootcrab-blip](https://github.com/rebootcrab-blip) | Agent asar 打包修复 |
| [@ustin-star](https://github.com/ustin-star) | CodeWhale 适配器 |
| [@zhangzhengtian02](https://github.com/zhangzhengtian02) | 功能与修复 |
| [@Wei Lai](https://github.com/weilai) | 功能与修复 |
| [@Yi-Jyun Pan](https://github.com/yijyunpan) | 功能与修复 |
| [@Zone Tome](https://github.com/zonetome) | 功能与修复 |
| [@LI SHANXIN](https://github.com/lishanxin) | 功能与修复 |
| [@PixelCookie](https://github.com/pixelcookie) | 功能与修复 |
| [@Steven Chen](https://github.com/stevenchen) | 功能与修复 |
| [@Tao Xie](https://github.com/taoxie) | 功能与修复 |
| [@Zhengru](https://github.com/zhengru) | 功能与修复 |
| [@tatsuyanakano](https://github.com/tatsuyanakano) | 功能与修复 |
| [@yeqiyeluo](https://github.com/yeqiyeluo) | 功能与修复 |
| [@正如](https://github.com/正如) | 功能与修复 |
| [@张星宇](https://github.com/张星宇) | 功能与修复 |

> 🙏 **感谢所有为 Clawd 项目做出贡献的开发者！** 无论是代码、文档、Bug 报告还是功能建议，每一份贡献都让这个项目变得更好。
>
> 如果你曾做过贡献但名字不在列表中，请发 Issue 或 PR 添加自己。

---

## 📄 许可证

- **代码**: [AGPL-3.0](LICENSE)
- **美术素材**: 版权保留（All Rights Reserved）

**Clawd** 角色是 [Anthropic](https://www.anthropic.com) 的财产。这是一个非官方的粉丝项目，与 Anthropic 无关，也未获得 Anthropic 的认可。

---

## 🙏 致谢

- **[rullerzhou-afk](https://github.com/rullerzhou-afk)**（鹿鹿 / Ruller_Lulu）— [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的创作者，感谢你创建了这个精彩的项目并将其开源。

- **[Anthropic](https://www.anthropic.com)** — 创造了启发这个项目的 Claude。

- **所有[贡献者](#-贡献者)** — 感谢你们的时间、代码和热情。

- **开源社区** — 感谢让这一切成为可能的工具和库：Kotlin、Jetpack Compose、OkHttp、kotlinx.serialization、CameraX、ZXing 等。

---

<p align="center">
  <sub>⭐ 如果你喜欢这个项目，请在 <a href="https://github.com/Bynlk/clawd-on-mobile">GitHub</a> 上给它一个 Star！</sub>
</p>

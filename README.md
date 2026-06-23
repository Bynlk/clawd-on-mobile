<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd Mobile">
</p>

<h1 align="center">Clawd Mobile</h1>
<p align="center">
  <strong>Android companion for <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> — a cyberpunk desktop pet that reacts to your AI coding agent in real time.</strong>
</p>

<p align="center">
  <a href="README.zh-CN.md">中文</a>
  ·
  <a href="README-desk.md">Desktop Version</a>
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
> Android 端由社区开发者 [@Bynlk](https://github.com/Bynlk) 移植并维护，感谢所有为项目做出贡献的[开发者们](#-contributors)。

---

## 📖 Table of Contents

- [What is Clawd Mobile?](#-what-is-clawd-mobile)
- [Features](#-features)
- [Screenshots](#-screenshots)
- [Quick Start](#-quick-start)
- [Architecture](#-architecture)
- [Communication Protocol](#-communication-protocol)
- [Development](#-development)
- [Contributing](#-contributing)
- [Roadmap](#-roadmap)
- [FAQ](#-faq)
- [Contributors](#-contributors)
- [License](#-license)
- [Acknowledgements](#-acknowledgements)

---

## 🐾 What is Clawd Mobile?

**Clawd Mobile** is a native Android client that connects to [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) desktop pet. It monitors your AI coding agent's activity in real time — via **LAN or remote relay** — and displays a live animated pet on your phone screen that reacts to what your agent is doing.

| Feature | How it works | Experience |
|---------|-------------|------------|
| **Millisecond state sync** | WebSocket + `StateFlow` pipeline, < 200ms latency | Your crab starts typing the moment your agent does |
| **Pure character isolation** | Server-side `displayState` + `PetStateManager` engine | 3 characters (Crab/Cat/Cloud) with independent state mapping |
| **Ultra-low power** | `WifiLock` + `WakeLock` + 30s watchdog + exponential backoff (1s→30s) | < 50mW background power, lasts all day |
| **Overlay approval** | Swipe-to-approve permission requests directly on the floating bubble | No need to open the app |
| **Remote relay** | Connect via VPS relay for non-LAN environments | Monitor your agent from anywhere |

---

## ✨ Features

### Core Experience
- 🐾 **Animated floating pet** — SVG/APNG with CSS animations (breathe, blink, tail-sway)
- 📱 **16 states** — Working, Thinking, Idle, Sleeping, Error, Notification, and more
- 🎯 **Smart sleep sequence** — Yawning → Dozing → Collapsing → Sleeping with random idle variants
- 🏆 **Happy celebration** — 1.5s animation when a task completes

### v0.10.0 — Latest Release
- 🐾 **Overlay approval bubble** — Approve/deny permission requests by swiping on the floating bubble
- 🌐 **Remote relay** — Connect via VPS relay server for non-LAN environments
- 🌍 **In-app language switch** — Chinese/English, switch without restarting
- 🔒 **Security hardening** — Encrypted storage, TOFU cert pinning, log stripping
- 🧪 **548 tests** — All passing, 103 new tests added

---

## 📸 Screenshots

> _Screenshots coming soon. The app displays an animated pet on your phone screen that reacts to your AI agent's activity in real time._

| Floating Pet | Approval Bubble | Settings |
|:---:|:---:|:---:|
| _Screenshot_ | _Screenshot_ | _Screenshot_ |

---

## ⚡ Quick Start

### Prerequisites
- Android 8.0+ (API 26) device with arm64-v8a
- [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) running on your PC

### Installation

1. Download the latest `app-release.apk` from [Releases](https://github.com/Bynlk/clawd-on-mobile/releases)
2. Install the APK on your Android device
3. Open the app and scan the QR code displayed on your PC, or manually enter the connection details
4. Grant the requested permissions (notifications, camera, overlay)
5. Your pet is now live! 🎉

### Connection Methods

| Method | When to use |
|--------|------------|
| **QR Code Scan** | PC and phone on the same LAN — fastest setup |
| **Manual Input** | Enter PC's IP, port, and token manually |
| **Remote Relay** | Connect via VPS relay for non-LAN environments |

---

## 🏛️ Architecture

Clawd Mobile follows a **single-pipe architecture** where all state changes flow through one unified `StateFlow`:

```
PC (WebSocket) → StreamingClient → PetStateManager → FloatingPetService
                                          ↓
                                    StateCommand (single pipe)
                                          ↓
                              SvgLoader → FloatingPetView (WebView SVG)
```

**Key design decisions:**
- **Single-pipe** eliminates concurrent SVG loading race conditions
- **Template method pattern** (`StreamingClient` → `AbstractStreamingClient` → `WsClient`) for easy transport extension
- **Strategy pattern** (`ConnectionStrategy`) for LAN/Relay connection decoupling
- **SessionMerger** unifies LAN + Relay sessions into one view

For detailed architecture documentation, see [android/README.md](android/README.md).

---

## 📡 Communication Protocol

```
WebSocket:  ws://<host>:23334/mobile/ws
Approval:   POST http://<host>:23334/mobile/approve
Deep Link:  clawd://<host>:<port>/<token>
```

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `ping` | Server → Client | Heartbeat |
| `connected` | Server → Client | Connection confirmed |
| `snapshot` | Server → Client | Full session list |
| `state` | Server → Client | Single session update |
| `permission_request` | Server → Client | Approval request |
| `reaction` | Server → Client | SVG reaction animation |

---

## 🔧 Development

### Environment
- Android Studio Hedgehog (2023.1.1)+
- JDK 17
- Android SDK 35
- arm64-v8a device or emulator

### Build

```bash
cd android

# Debug APK
./gradlew assembleDebug

# Release APK (requires signing config)
KEYSTORE_FILE=release.keystore \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# Run tests (548 tests)
./gradlew testDebugUnitTest
```

### CI/CD

Push to `main` with changes in `android/` triggers GitHub Actions: lint → build → test → artifact upload.

---

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feat/my-feature`
3. **Commit** with clear messages: `git commit -m "feat: add my feature"`
4. **Push** to your fork: `git push origin feat/my-feature`
5. **Open** a Pull Request

### Guidelines
- Follow Kotlin coding conventions
- Add tests for new features
- Update documentation if needed
- Reference related issues in your PR description

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

---

## 🗺️ Roadmap

| Priority | Item | Status |
|----------|------|--------|
| ✅ | WebSocket migration (from SSE) | Done |
| ✅ | TOFU certificate pinning | Done |
| ✅ | Overlay approval bubble | Done |
| ✅ | Remote relay support | Done |
| ✅ | In-app language switch | Done |
| ✅ | Security hardening | Done |
| 🔄 | Hilt dependency injection | Planned |
| 🔄 | Repository pattern | Planned |
| 🔄 | AbstractStreamingClient tests | Planned |

See [android/docs/ROADMAP.md](android/docs/ROADMAP.md) for the full roadmap.

---

## ❓ FAQ

**Q: Do I need the desktop app?**
A: Yes. Clawd Mobile is a companion app — it connects to [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) running on your PC.

**Q: Can I use it outside my home network?**
A: Yes! v0.10.0 added remote relay support. Deploy a relay server on your VPS and connect from anywhere.

**Q: Which AI agents are supported?**
A: Any agent that works with Clawd on Desk — Claude Code, Codex, Cursor, Copilot, Gemini, and more.

**Q: The pet doesn't move / stays on idle**
A: Make sure your desktop app is connected and has an active session. Check the connection status in the app's settings.

**Q: How do I update?**
A: Download the latest APK from [Releases](https://github.com/Bynlk/clawd-on-mobile/releases) and install over the existing app. Your data will be preserved.

---

## 👥 Contributors

### Android Port
- [@Bynlk](https://github.com/Bynlk) — Android port developer & maintainer

### Desktop Contributors
The following developers have contributed to the Clawd ecosystem (desktop + mobile):

| Contributor | Contribution |
|-------------|-------------|
| [@rullerzhou-afk](https://github.com/rullerzhou-afk) (鹿鹿) | Original creator of Clawd on Desk |
| [@Ruller_Lulu](https://github.com/Ruller_Lulu) | Core development |
| [@Yoimiya](https://github.com/Yoimiya) | Major contributions |
| [@Lyu Bingrong](https://github.com/LyuBingrong) | Features & fixes |
| [@hwasowl](https://github.com/hwasowl) | Features & fixes |
| [@nmsn](https://github.com/nmsn) | Features & fixes |
| [@zxypro](https://github.com/zxypro) | Telegram approval status |
| [@sLingli](https://github.com/sLingli) | Reasonix CLI integration |
| [@cod3hulk](https://github.com/cod3hulk) | tmux focus support |
| [@lxgxhsy](https://github.com/lxgxhsy) | Windows focus cache |
| [@rebootcrab-blip](https://github.com/rebootcrab-blip) | Agent asar packaging fix |
| [@ustin-star](https://github.com/ustin-star) | CodeWhale adapter |
| [@zhangzhengtian02](https://github.com/zhangzhengtian02) | Features & fixes |
| [@Wei Lai](https://github.com/weilai) | Features & fixes |
| [@Yi-Jyun Pan](https://github.com/yijyunpan) | Features & fixes |
| [@Zone Tome](https://github.com/zonetome) | Features & fixes |
| [@LI SHANXIN](https://github.com/lishanxin) | Features & fixes |
| [@PixelCookie](https://github.com/pixelcookie) | Features & fixes |
| [@Steven Chen](https://github.com/stevenchen) | Features & fixes |
| [@Tao Xie](https://github.com/taoxie) | Features & fixes |
| [@Zhengru](https://github.com/zhengru) | Features & fixes |
| [@tatsuyanakano](https://github.com/tatsuyanakano) | Features & fixes |
| [@yeqiyeluo](https://github.com/yeqiyeluo) | Features & fixes |
| [@正如](https://github.com/正如) | Features & fixes |
| [@张星宇](https://github.com/张星宇) | Features & fixes |
| [@Wei Lai](https://github.com/weilai) | Features & fixes |

> 🙏 **感谢所有为 Clawd 项目做出贡献的开发者！** 无论是代码、文档、Bug 报告还是功能建议，每一份贡献都让这个项目变得更好。
>
> If you've contributed and your name is missing, please open an issue or PR to add yourself.

---

## 📄 License

- **Code**: [AGPL-3.0](LICENSE)
- **Art assets**: All Rights Reserved

**Clawd** is a character owned by [Anthropic](https://www.anthropic.com). This is an unofficial fan project, not affiliated with or endorsed by Anthropic.

---

## 🙏 Acknowledgements

- **[rullerzhou-afk](https://github.com/rullerzhou-afk)** (鹿鹿 / Ruller_Lulu) — Creator of [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk), the desktop pet that started it all. Thank you for creating this amazing project and making it open source.

- **[Anthropic](https://www.anthropic.com)** — For creating Claude, the AI that inspired this project.

- **All [contributors](#-contributors)** — Thank you for your time, code, and passion.

- **The open source community** — For the tools and libraries that made this possible: Kotlin, Jetpack Compose, OkHttp, kotlinx.serialization, CameraX, ZXing, and many more.

---

<p align="center">
  <sub>⭐ If you like this project, give it a star on <a href="https://github.com/Bynlk/clawd-on-mobile">GitHub</a>!</sub>
</p>

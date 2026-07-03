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

<p align="center">
  <img src="assets/hero-mobile.png" alt="Clawd Mobile home screen with a pixel-art pet that reacts to your AI coding agent in real time. Four session states shown left to right: Thinking with a thought bubble, Working typing at a terminal, Approval raising a claw with an alert bubble, and Done celebrating with sparkles.">
</p>

<p align="center">
  <sub>Your pet reacts in real time — <b>Thinking</b> · <b>Working</b> · <b>Approval</b> · <b>Done</b></sub>
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
- [What's Next · 未来功能](#-whats-next--未来功能)
- [Roadmap](#-roadmap)
- [FAQ](#-faq)
- [Contributors](#-contributors)
- [License](#-license)
- [Acknowledgements](#-acknowledgements)
- **Cursor Agent** — optional [Cursor IDE hooks](https://cursor.com/docs/agent/hooks) in `~/.cursor/hooks.json` (install from Settings → Agents or run `npm run install:cursor-hooks`)
- **CodeBuddy** — optional Claude Code-compatible command hooks + HTTP permission hooks via `~/.codebuddy/settings.json` (install from Settings → Agents or run `node hooks/codebuddy-install.js`)
- **Kiro CLI** — optional command hooks injected into custom agent configs under `~/.kiro/agents/`, plus an auto-created `clawd` agent that is re-synced from Kiro's built-in `kiro_default` after you install the integration, so you can opt into hooks with minimal behavior drift via `kiro-cli --agent clawd` or `/agent swap clawd`. State hooks are verified on macOS and Windows.
- **Kimi Code CLI (Kimi-CLI)** — optional command hooks via `~/.kimi/config.toml` (`[[hooks]]` entries) (install from Settings → Agents or run `npm run install:kimi-hooks`)
- **Qwen Code** — optional command hooks via `~/.qwen/settings.json` (install from Settings → Agents or run `npm run install:qwen-hooks`); state tracking and Qwen `PermissionRequest` desktop approval bubbles are supported
- **CodeWhale** — optional state-only lifecycle hooks via `~/.codewhale/config.toml` (`[[hooks.hooks]]` entries) (install from Settings → Agents or run `npm run install:codewhale-hooks`); Phase 1 drives idle, thinking, working, sleeping, error, attention, and sweeping animations only, without permission bubbles or subagent tracking
- **Reasonix CLI** — optional state-only command hooks via `<Reasonix home>/settings.json` (`~/.reasonix/settings.json` on macOS/Linux, `%APPDATA%\reasonix\settings.json` on Windows; install from Settings → Agents or run `npm run install:reasonix-hooks`); Phase 1 drives lifecycle, tool, notification, compaction, and subagent-stop animations while leaving permission decisions in Reasonix's own terminal flow
- **opencode** — optional [plugin integration](https://opencode.ai/docs/plugins) via `~/.config/opencode/opencode.json` (install from Settings → Agents or run `node hooks/opencode-install.js`); zero-latency event streaming, permission bubbles with Allow/Always/Deny, and building animations when parallel subagents are spawned via the `task` tool
- **Pi** — optional global extension via `~/.pi/agent/extensions/clawd-on-desk` (install from Settings → Agents or run `npm run install:pi-extension`); state-only interactive lifecycle and tool activity updates while preserving Pi's default YOLO behavior
- **OpenClaw** — optional state-only plugin integration via `~/.openclaw/openclaw.json` (install from Settings → Agents or run `npm run install:openclaw-plugin`; OpenClaw also needs an initialized config); local `openclaw tui --local` sessions drive Clawd animations, without permission bubbles or terminal focus in Phase 1
- **Hermes Agent** — optional [plugin integration](https://hermes-agent.org/) via Hermes' managed plugin directory (install from Settings → Agents or run `npm run install:hermes-plugin`); state, sessions, SessionEnd, and terminal focus are supported
- **Qoder** — optional state-only command hooks via `~/.qoder/settings.json` (install from Settings → Agents or run `npm run install:qoder-hooks`); Phase 1 drives Clawd animations only — Qoder permission prompts are observed as notifications, and every Allow / Deny choice stays in Qoder's own flow
- **Multi-agent coexistence** — run all agents simultaneously; Clawd tracks each session independently

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

The pet on your phone mirrors exactly what your AI agent is doing on the desktop. Each session state has its own animation and status badge:

| Thinking / 思考中 | Working / 工作中 |
|:---:|:---:|
| <img src="assets/mobile/state-thinking.jpeg" width="260" alt="Thinking state — the pet shows a thought bubble while the agent reads the codebase"> | <img src="assets/mobile/state-working.jpeg" width="260" alt="Working state — the crab types at a terminal while edit/bash tools run"> |
| The crab shows a thought bubble while the agent is reasoning. | The crab types at a terminal while tools are running. |

| Approval / 待审批 | Done / 已完成 |
|:---:|:---:|
| <img src="assets/mobile/state-permission.jpeg" width="260" alt="Approval state — the crab raises a claw with an alert bubble when a permission request is pending"> | <img src="assets/mobile/state-done.jpeg" width="260" alt="Done state — the crab celebrates with sparkles when the task completes"> |
| The crab raises a claw when a permission request needs you. | The crab celebrates when the task is complete. |

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
Clawd on Mobile 是基于 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的二创项目，在桌面端基础上增加了 Android 伴侣应用、浮窗审批、远程中继等功能。

向本项目贡献请参考 [CONTRIBUTING.md](./CONTRIBUTING.md)。

Bug reports, feature ideas, and pull requests are all welcome — open an [issue](https://github.com/Bynlk/clawd-on-mobile/issues) to discuss or submit a PR directly.

### Maintainers

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · creator</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />maintainer</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="72" style="border-radius:50%" /><br /><sub><b>@Bynlk</b><br />core contributor · Mobile / PWA</sub></a></td>
  </tr>
</table>

### Contributors

Thanks to everyone who has helped make Clawd better:

<table>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /><br /><sub>PixelCookie-zyf</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /><br /><sub>yujiachen-y</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /><br /><sub>AooooooZzzz</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /><br /><sub>purefkh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /><br /><sub>Tobeabellwether</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /><br /><sub>Jasonhonghh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /><br /><sub>crashchen</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /><br /><sub>hongbigtou</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /><br /><sub>InTimmyDate</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /><br /><sub>NeizhiTouhu</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /><br /><sub>xu3stones-cmd</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /><br /><sub>androidZzT</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /><br /><sub>Ye-0413</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /><br /><sub>WanfengzzZ</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /><br /><sub>TaoXieSZ</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /><br /><sub>ssly</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /><br /><sub>stickycandy</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /><br /><sub>Rladmsrl</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /><br /><sub>YOIMIYA66</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /><br /><sub>Kevin7Qi</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /><br /><sub>sefuzhou770801-hub</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /><br /><sub>Tonic-Jin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /><br /><sub>seoki180</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /><br /><sub>sophie-haynes</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /><br /><sub>PeterShanxin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /><br /><sub>CHIANGANGSTER</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /><br /><sub>JaeHyeon-KAIST</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /><br /><sub>hhhzxyhhh</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /><br /><sub>TVpoet</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /><br /><sub>zeus6768</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /><br /><sub>anhtrinh919</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /><br /><sub>tomaioo</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/v-avuso"><img src="https://github.com/v-avuso.png" width="50" style="border-radius:50%" /><br /><sub>v-avuso</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/livlign"><img src="https://github.com/livlign.png" width="50" style="border-radius:50%" /><br /><sub>livlign</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tongguang2"><img src="https://github.com/tongguang2.png" width="50" style="border-radius:50%" /><br /><sub>tongguang2</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zxypro1"><img src="https://github.com/zxypro1.png" width="50" style="border-radius:50%" /><br /><sub>zxypro1</sub></a></td>
  </tr>
</table>

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

## 🔮 What's Next · 未来功能

Clawd Mobile already lets you watch your agent and approve permissions over the LAN or a self-hosted relay. Two bigger capabilities are on the way — both aim at the same goal: **stay in control of your agent even when you're away from your desk.**

### 1. 🌐 Hosted server relay · 服务器中继（出门在外也能审批）

Today's relay is something you deploy yourself on a VPS. The next step is a **turn-key, always-on relay** so your phone stays connected to your desktop agent no matter where you are — different network, cellular data, or on the road. When your agent hits a permission request while you're out, the approval bubble reaches your phone and you can **Allow / Deny on the go**, without being on the same Wi-Fi and without any manual server setup.

- Approve / deny permission requests from anywhere, over cellular
- Zero-config connection — no self-hosted VPS required
- End-to-end secured, building on the existing TOFU cert-pinning foundation

### 2. 📬 Content push · 内容推送（1:1 同步终端显示）

Beyond animated state, we want the phone to **mirror what the terminal actually shows — 1:1** — so you can read what your agent is doing, not just infer it from the pet's mood. The exact scope, delivery format, and privacy model are **still under discussion**, and this section will be filled in once the design settles.

> 💡 Have thoughts on either feature? Open an [issue](https://github.com/Bynlk/clawd-on-mobile/issues) or a [discussion](https://github.com/Bynlk/clawd-on-mobile/discussions) — feedback is very welcome while these are still being shaped.

---

## 🗺️ Roadmap

| Priority | Item | Status |
|----------|------|--------|
| ✅ | WebSocket migration (from SSE) | Done |
| ✅ | TOFU certificate pinning | Done |
| ✅ | Overlay approval bubble | Done |
| ✅ | Remote relay support (self-hosted) | Done |
| ✅ | In-app language switch | Done |
| ✅ | Security hardening | Done |
| 🔄 | Hilt dependency injection | Planned |
| 🔄 | Repository pattern | Planned |
| 🔄 | AbstractStreamingClient tests | Planned |
| 🔮 | Hosted server relay (approve anywhere) | Exploring |
| 🔮 | Content push (1:1 terminal mirror) | Under discussion |

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

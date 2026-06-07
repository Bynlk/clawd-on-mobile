<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd 桌宠 (Mobile)</h1>
<p align="center">
  <sub>🍴 基于 <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> 的 Fork，原作者 <a href="https://github.com/rullerzhou-afk">@rullerzhou-afk</a> — 许可证 <a href="LICENSE">AGPL-3.0</a></sub>
</p>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
  ·
  <a href="README-desk.zh-CN.md">🖥️ 桌面端</a>
</p>
<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/releases"><img src="https://img.shields.io/github/v/release/Bynlk/clawd-on-mobile" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-lightgrey" alt="Platform">
</p>
<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/stargazers"><img src="https://img.shields.io/github/stars/Bynlk/clawd-on-mobile?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd 桌宠动画演示：像素螃蟹会随 AI 编程助手状态实时切换，现在支持 Android 手机端同步。">
</p>

**Clawd on Mobile** 在 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desktop) 的基础上，新增了 **Android 原生伴侣应用**。你的桌面宠物现在也能住在手机上——通过局域网连接，手机端宠物会实时同步桌面端的所有状态：思考、打字、建造、睡觉等等。

在桌面端发起一个长任务，带上手机走开，等螃蟹告诉你任务完成了再回来。

> 🖥️ 想看桌面端专属 README？请访问 **[README-desk.zh-CN.md](README-desk.zh-CN.md)**

---

## 📱 Android 伴侣应用

<p align="center">
  <img src="https://img.shields.io/badge/Android-8.0%2B-green.svg" alt="Android 8.0+">
  <img src="https://img.shields.io/badge/Kotlin-2.1.0-blue.svg" alt="Kotlin">
  <img src="https://img.shields.io/badge/Compose-Material%203-purple.svg" alt="Jetpack Compose">
  <img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License">
</p>

基于 Kotlin 和 Jetpack Compose 构建的原生 Android 客户端，通过 WebSocket 连接桌面端 Clawd 应用。浮动宠物覆盖层使用 SVG/APNG 动画渲染，像素级透明点击穿透，完美同步桌面端的 16 种状态。

### 功能特性

- **扫码配对** — 扫描桌面端显示的二维码即可一键连接（`clawd://host:port/token`）
- **浮动宠物覆盖层** — 系统级浮动窗口，16 种动画状态从桌面端实时同步
- **3 套角色主题** — Clawd（像素螃蟹）、Calico（三花猫）、Cloudling（云宝）
- **通知栏审批** — 直接在手机通知栏审批或拒绝 AI 代理的权限请求
- **睡眠序列** — 打哈欠 → 打盹 → 倒下 → 睡觉 → 惊醒，每套角色有独立时序
- **手势操作** — 拖拽移动，单击显示信息气泡，双击触发反应，三击彩蛋
- **边缘吸附** — 宠物自动吸附屏幕边缘，重启后记住位置
- **深链接支持** — `clawd://` URI 协议，无缝配对
- **后台稳定** — 前台服务 + WiFi 锁 + 条件 WakeLock + 自动重连（指数退避 + 熔断器）
- **TOFU 证书验证** — Trust-On-First-Use 机制保障局域网连接安全
- **加密存储** — 连接凭据使用 AES-256-GCM 加密（EncryptedSharedPreferences）
- **多语言** — 英文、简体中文、繁体中文、韩文、日文

> 📖 **详细文档**: [android/README.md](android/README.md) — 架构设计、状态机、通信协议、项目结构

### 快速开始（Android）

1. 从 **[GitHub Releases](https://github.com/Bynlk/clawd-on-mobile/releases/latest)** 下载最新 APK
2. 安装到 Android 8.0+ 设备
3. 打开桌面端 Clawd，进入 **设置 → 移动端 → 显示二维码**
4. 用手机扫码即可连接！

也可以手动输入连接信息（主机、端口、令牌）。

### 从源码构建（Android）

```bash
# 克隆仓库
git clone https://github.com/Bynlk/clawd-on-mobile.git
cd clawd-on-mobile/android

# 构建 debug APK
./gradlew assembleDebug

# 构建 release APK
./gradlew assembleRelease
```

**环境要求:** JDK 17, Android SDK (compileSdk 35), arm64-v8a 设备或模拟器

---

## 🖥️ 桌面端应用

桌面 Electron 应用支持 **15+ AI 编程助手**，具备实时状态感知、权限气泡、自定义主题等功能。

> **支持的助手:** Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Antigravity CLI, Cursor Agent, CodeBuddy, Kiro CLI, Kimi Code CLI, Qwen Code, opencode, Pi, OpenClaw, Hermes Agent

> **平台:** Windows 11, macOS, Ubuntu/Linux

完整的桌面端功能、设置指南和自定义主题创建，请参阅 **[README-desk.zh-CN.md](README-desk.zh-CN.md)**。

### 快速开始（桌面端）

从 **[GitHub Releases](https://github.com/Bynlk/clawd-on-mobile/releases/latest)** 下载最新安装包：

- **Windows**: `Clawd-on-Mobile-Setup-<version>-x64.exe` 或 `-arm64.exe`
- **macOS**: `.dmg`
- **Linux**: `.AppImage` 或 `.deb`

或从源码运行：

```bash
git clone https://github.com/Bynlk/clawd-on-mobile.git
cd clawd-on-mobile
npm install
npm start
```

---

## 架构设计

```
┌─────────────────────┐        WebSocket (局域网)        ┌──────────────────────┐
│   桌面端 Electron    │ ───────────────────────────────► │   Android 伴侣应用   │
│   (Clawd on Desk)   │   Bearer 认证 + TOFU 证书        │   (Kotlin)           │
│                     │                                  │                      │
│   15+ Agent Hooks   │   StateFlow<Map<SessionData>>    │   PetStateManager    │
│   权限气泡          │ ───────────────────────────────► │   (状态决策引擎)     │
│   会话追踪          │                                  │         │            │
│                     │   StateFlow<StateCommand>        │   FloatingPetService │
│                     │ ───────────────────────────────► │   (视图层)           │
│                     │                                  │                      │
│                     │   PermissionRequestData          │                      │
│                     │ ◄─────────────────────────────── │   Allow / Deny       │
└─────────────────────┘                                  └──────────────────────┘
```

- **脑壳分离** — `PetStateManager` 拥有所有状态逻辑，`FloatingPetService` 是纯视图消费者
- **单管道架构** — 所有状态转换通过一个 `StateFlow<StateCommand>` 流转，消除竞态条件
- **16 种宠物状态** — Error > Notification > Sweeping > Attention > Conducting > Working > Thinking > Idle > Sleeping（与桌面端优先级对齐）

---

## 动画一览

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>待机</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>思考</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>打字</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>建造</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>耳机律动</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>三球杂耍</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>三花待机</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>三花思考</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>三花打字</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>三花建造</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>三花杂耍</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>三花指挥</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>云宝待机</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>云宝思考</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>云宝打字</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>云宝建造</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>云宝杂耍</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>云宝指挥</sub></td>
  </tr>
</table>

---

## 参与贡献

Clawd on Mobile 是一个社区驱动的项目。欢迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/Bynlk/clawd-on-mobile/issues) 里聊或直接提交 PR。

### 原始项目

本项目 Fork 自 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desktop)，原作者 [@rullerzhou-afk](https://github.com/rullerzhou-afk)。所有桌面端功能均已保留，并由 [@Bynlk](https://github.com/Bynlk) 新增了 Android 伴侣应用。

### 维护者（桌面端）

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · 创建者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />维护者</sub></a></td>
  </tr>
</table>

### Android 伴侣应用维护者

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="72" style="border-radius:50%" /><br /><sub><b>@Bynlk</b><br />Android 开发</sub></a></td>
  </tr>
</table>

### 贡献者

感谢每一位让 Clawd 变得更好的贡献者：

<a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/v-avuso"><img src="https://github.com/v-avuso.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/livlign"><img src="https://github.com/livlign.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tongguang2"><img src="https://github.com/tongguang2.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ziy1-Tan"><img src="https://github.com/Ziy1-Tan.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tatsuyanakanogaroinc"><img src="https://github.com/tatsuyanakanogaroinc.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yeonhub"><img src="https://github.com/yeonhub.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/joshua-wu"><img src="https://github.com/joshua-wu.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/nmsn"><img src="https://github.com/nmsn.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sunnysonx"><img src="https://github.com/sunnysonx.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YuChenYunn"><img src="https://github.com/YuChenYunn.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/jhseo-b"><img src="https://github.com/jhseo-b.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Hwasowl"><img src="https://github.com/Hwasowl.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/XiangZheng2002"><img src="https://github.com/XiangZheng2002.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/keiyo118"><img src="https://github.com/keiyo118.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/pan93412"><img src="https://github.com/pan93412.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/taehwanis"><img src="https://github.com/taehwanis.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/linnin233"><img src="https://github.com/linnin233.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/xiyouMc"><img src="https://github.com/xiyouMc.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zxypro1"><img src="https://github.com/zxypro1.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/NeroAyase"><img src="https://github.com/NeroAyase.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/divergentD"><img src="https://github.com/divergentD.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ne9roni"><img src="https://github.com/Ne9roni.png" width="50" style="border-radius:50%" /></a>

## 致谢

- Clawd 像素画参考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- 本项目在 [LINUX DO](https://linux.do/) 社区推广

## 许可证

源代码基于 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）开源。

**美术素材和内置主题素材（包括 `assets/` 与 `themes/*/assets/`）不适用 AGPL-3.0 许可。** 所有权利归各自版权持有人所有，详见 [assets/LICENSE](assets/LICENSE) 及下列说明。

- **Clawd** 角色设计归属 [Anthropic](https://www.anthropic.com)。本项目为非官方粉丝作品，与 Anthropic 无官方关联。
- **三花猫** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 创作，保留所有权利。
- **Cloudling（云宝）** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 创作，保留所有权利。云宝的视觉方向包含对 OpenAI Codex logo 的致敬；Codex / OpenAI 相关标识仍归 OpenAI 所有，本项目与 OpenAI 无官方关联，也未获 OpenAI 背书。
- **第三方画师作品**：版权归各自作者所有。

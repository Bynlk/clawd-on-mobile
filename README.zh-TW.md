<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd 桌寵 (Mobile)</h1>
<p align="center">
  <sub>🍴 基於 <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> 的 Fork，原作者 <a href="https://github.com/rullerzhou-afk">@rullerzhou-afk</a> — 許可證 <a href="LICENSE">AGPL-3.0</a></sub>
</p>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">簡體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
  ·
  <a href="README-desk.zh-TW.md">🖥️ 桌面端</a>
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
  <img src="assets/hero.gif" alt="Clawd 桌寵動畫示範：像素螃蟹會跟著 AI 程式設計助理的狀態即時切換，現在支援 Android 手機端同步。">
</p>

**Clawd on Mobile** 在 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desktop) 的基礎上，新增了 **Android 原生伴侶應用**。你的桌面寵物現在也能住在手機上——透過區域網路連線，手機端寵物會即時同步桌面端的所有狀態：思考、打字、建造、睡覺等等。

在桌面端發起一個長任務，帶上手機走開，等螃蟹告訴你任務完成了再回來。

> 🖥️ 想看桌面端專屬 README？請訪問 **[README-desk.zh-TW.md](README-desk.zh-TW.md)**

---

## 📱 Android 伴侶應用

<p align="center">
  <img src="https://img.shields.io/badge/Android-8.0%2B-green.svg" alt="Android 8.0+">
  <img src="https://img.shields.io/badge/Kotlin-2.1.0-blue.svg" alt="Kotlin">
  <img src="https://img.shields.io/badge/Compose-Material%203-purple.svg" alt="Jetpack Compose">
  <img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License">
</p>

基於 Kotlin 和 Jetpack Compose 建構的原生 Android 用戶端，透過 WebSocket 連線桌面端 Clawd 應用。浮動寵物覆蓋層使用 SVG/APNG 動畫渲染，像素級透明點擊穿透，完美同步桌面端的 16 種狀態。

### 功能特色

- **掃碼配對** — 掃描桌面端顯示的 QR Code 即可一鍵連線（`clawd://host:port/token`）
- **浮動寵物覆蓋層** — 系統級浮動視窗，16 種動畫狀態從桌面端即時同步
- **3 套角色主題** — Clawd（像素螃蟹）、Calico（三花貓）、Cloudling（雲寶）
- **通知欄審批** — 直接在手機通知欄審批或拒絕 AI 代理的權限請求
- **睡眠序列** — 打哈欠 → 打盹 → 倒下 → 睡覺 → 驚醒，每套角色有獨立時序
- **手勢操作** — 拖曳移動，單擊顯示資訊氣泡，雙擊觸發反應，三擊彩蛋
- **邊緣吸附** — 寵物自動吸附螢幕邊緣，重新啟動後記住位置
- **深連結支援** — `clawd://` URI 協定，無縫配對
- **背景穩定** — 前景服務 + WiFi 鎖 + 條件 WakeLock + 自動重連（指數退避 + 熔斷器）
- **TOFU 憑證驗證** — Trust-On-First-Use 機制保障區域網路連線安全
- **加密儲存** — 連線憑證使用 AES-256-GCM 加密（EncryptedSharedPreferences）
- **多語言** — 英文、簡體中文、繁體中文、韓文、日文

> 📖 **詳細文檔**: [android/README.md](android/README.md) — 架構設計、狀態機、通訊協定、專案結構

### 快速開始（Android）

1. 從 **[GitHub Releases](https://github.com/Bynlk/clawd-on-mobile/releases/latest)** 下載最新 APK
2. 安裝到 Android 8.0+ 裝置
3. 開啟桌面端 Clawd，進入 **設定 → 行動端 → 顯示 QR Code**
4. 用手機掃碼即可連線！

也可以手動輸入連線資訊（主機、連接埠、權杖）。

### 從原始碼建置（Android）

```bash
# clone 儲存庫
git clone https://github.com/Bynlk/clawd-on-mobile.git
cd clawd-on-mobile/android

# 建置 debug APK
./gradlew assembleDebug

# 建置 release APK
./gradlew assembleRelease
```

**環境需求:** JDK 17, Android SDK (compileSdk 35), arm64-v8a 裝置或模擬器

---

## 🖥️ 桌面端應用

桌面 Electron 應用支援 **15+ AI 程式設計助理**，具備即時狀態感知、權限對話框、自訂主題等功能。

> **支援的助理:** Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Antigravity CLI, Cursor Agent, CodeBuddy, Kiro CLI, Kimi Code CLI, Qwen Code, opencode, Pi, OpenClaw, Hermes Agent

> **平台:** Windows 11, macOS, Ubuntu/Linux

完整的桌面端功能、設定指南和自訂主題建立，請參閱 **[README-desk.zh-TW.md](README-desk.zh-TW.md)**。

### 快速開始（桌面端）

從 **[GitHub Releases](https://github.com/Bynlk/clawd-on-mobile/releases/latest)** 下載最新安裝檔：

- **Windows**: `Clawd-on-Mobile-Setup-<version>-x64.exe` 或 `-arm64.exe`
- **macOS**: `.dmg`
- **Linux**: `.AppImage` 或 `.deb`

或從原始碼執行：

```bash
git clone https://github.com/Bynlk/clawd-on-mobile.git
cd clawd-on-mobile
npm install
npm start
```

---

## 架構設計

```
┌─────────────────────┐       WebSocket（區域網路）      ┌──────────────────────┐
│   桌面端 Electron    │ ───────────────────────────────► │   Android 伴侶應用   │
│   (Clawd on Desk)   │   Bearer 驗證 + TOFU 憑證       │   (Kotlin)           │
│                     │                                  │                      │
│   15+ Agent Hooks   │   StateFlow<Map<SessionData>>    │   PetStateManager    │
│   權限對話框        │ ───────────────────────────────► │   （狀態決策引擎）   │
│   工作階段追蹤      │                                  │         │            │
│                     │   StateFlow<StateCommand>        │   FloatingPetService │
│                     │ ───────────────────────────────► │   （視圖層）         │
│                     │                                  │                      │
│                     │   PermissionRequestData          │                      │
│                     │ ◄─────────────────────────────── │   Allow / Deny       │
└─────────────────────┘                                  └──────────────────────┘
```

- **腦殼分離** — `PetStateManager` 擁有所有狀態邏輯，`FloatingPetService` 是純視圖消費者
- **單管道架構** — 所有狀態轉換透過一個 `StateFlow<StateCommand>` 流轉，消除競態條件
- **16 種寵物狀態** — Error > Notification > Sweeping > Attention > Conducting > Working > Thinking > Idle > Sleeping（與桌面端優先順序對齊）

---

## 動畫一覽

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>待機</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>思考</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>打字</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>建造</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>耳機律動</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>三球雜耍</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>三花待機</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>三花思考</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>三花打字</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>三花建造</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>三花雜耍</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>三花指揮</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>雲寶待機</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>雲寶思考</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>雲寶打字</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>雲寶建造</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>雲寶雜耍</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>雲寶指揮</sub></td>
  </tr>
</table>

---

## 參與貢獻

Clawd on Mobile 是一個社群驅動的專案。歡迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/Bynlk/clawd-on-mobile/issues) 裡聊或直接提交 PR。

### 原始專案

本專案 Fork 自 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desktop)，原作者 [@rullerzhou-afk](https://github.com/rullerzhou-afk)。所有桌面端功能均已保留，並由 [@Bynlk](https://github.com/Bynlk) 新增了 Android 伴侶應用。

### 維護者

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · 建立者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />維護者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="72" style="border-radius:50%" /><br /><sub><b>@Bynlk</b><br />Android 開發</sub></a></td>
  </tr>
</table>

### 貢獻者

謝謝每一位讓 Clawd 變得更好的貢獻者：

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

## 致謝

- Clawd 像素畫參考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- 本專案在 [LINUX DO](https://linux.do/) 社群推廣

## 授權

原始碼以 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）授權釋出。

**美術素材和內建主題素材（包括 `assets/` 與 `themes/*/assets/`）不適用 AGPL-3.0 授權。** 所有權利歸各自著作權人所有，詳見 [assets/LICENSE](assets/LICENSE) 及下列說明。

- **Clawd** 角色設計屬於 [Anthropic](https://www.anthropic.com)。本專案為非官方粉絲作品，與 Anthropic 沒有官方關聯。
- **三花貓** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 創作，保留所有權利。
- **Cloudling（雲寶）** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 創作，保留所有權利。雲寶的視覺方向包含對 OpenAI Codex logo 的致敬；Codex 與 OpenAI 相關標誌仍歸 OpenAI 所有，本專案與 OpenAI 沒有官方關聯，也未獲 OpenAI 背書。
- **第三方畫師作品**：著作權歸各自作者所有。

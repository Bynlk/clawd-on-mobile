<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd Mobile">
</p>

<h1 align="center">Clawd Mobile</h1>
<p align="center">
  <strong><a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> 的 Android 夥伴應用 — 一隻即時感知 AI 編碼 Agent 的賽博桌寵。</strong>
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README-desk.md">Desktop Version</a>
</p>

<p align="center">
  <a href="https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml"><img src="https://github.com/Bynlk/clawd-on-mobile/actions/workflows/android.yml/badge.svg" alt="Android Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License"></a>
  <a href="https://github.com/Bynlk/clawd-on-mobile/releases"><img src="https://img.shields.io/github/v/release/Bynlk/clawd-on-mobile" alt="Version"></a>
  <img src="https://img.shields.io/badge/Android-8.0%2B-green.svg" alt="Android 8.0+">
  <img src="https://img.shields.io/badge/API-26%2B-brightgreen.svg" alt="API 26+">
</p>

<p align="center">
  <img src="assets/hero-mobile.gif" alt="Clawd Mobile 主畫面,一隻像素風桌寵即時感知你的 AI 編碼 Agent。由左至右展示四種工作階段狀態:Thinking 思考、Working 工作、Approval 等待審批、Done 完成。">
</p>

<p align="center">
  <sub>你的桌寵即時做出反應 — <b>Thinking</b> · <b>Working</b> · <b>Approval</b> · <b>Done</b></sub>
</p>

---

> **🙏 致敬原作者**
>
> 本專案基於 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)（Clawd on Desk）桌面端開發。原專案由 [@rullerzhou-afk](https://github.com/rullerzhou-afk)（鹿鹿 / Ruller_Lulu）建立——一隻住在你桌面上的小螃蟹,即時感知 AI 編碼 Agent 的每一次呼吸。
>
> Android 端由社群開發者 [@Bynlk](https://github.com/Bynlk) 移植並維護,感謝所有為專案做出貢獻的[開發者們](#-貢獻者)。

---

## 📖 目錄

- [什麼是 Clawd Mobile？](#-什麼是-clawd-mobile)
- [功能特性](#-功能特性)
- [螢幕截圖](#-螢幕截圖)
- [快速開始](#-快速開始)
- [架構設計](#-架構設計)
- [通訊協定](#-通訊協定)
- [開發指南](#-開發指南)
- [參與貢獻](#-參與貢獻)
- [未來功能](#-未來功能)
- [路線圖](#-路線圖)
- [常見問題](#-常見問題)
- [貢獻者](#-貢獻者)
- [授權條款](#-授權條款)
- [致謝](#-致謝)

---

## 🐾 什麼是 Clawd Mobile？

**Clawd Mobile** 是一個原生 Android 客戶端,連接到 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 桌面端。它透過 **區域網路或遠端中繼** 即時監控你的 AI 編碼 Agent 活動,並在手機螢幕上顯示一隻會動的桌寵,即時感知 Agent 的每一個動作。

| 特性 | 實作機制 | 體感 |
|------|----------|------|
| **毫秒級狀態同步** | WebSocket + `StateFlow` 管道,延遲 < 200ms | 小螃蟹和你的 Agent 同時開始打字 |
| **純血角色隔離** | 伺服器端 `displayState` + `PetStateManager` 決策引擎 | 三隻角色（螃蟹/三花貓/白雲）獨立狀態映射 |
| **極低功耗掛機** | `WifiLock` + `WakeLock` + 30s 看門狗 + 指數退避（1s→30s） | 背景功耗 < 50mW,掛機一整天 |
| **浮窗審批** | 在懸浮氣泡上左右滑動審批權限請求 | 無需開啟 App |
| **遠端中繼** | 透過 VPS 中繼伺服器連接 | 隨時隨地監控你的 Agent |

---

## ✨ 功能特性

### 核心體驗
- 🐾 **動畫懸浮寵物** — SVG/APNG + CSS 動畫（呼吸、眨眼、尾巴搖擺）
- 📱 **16 種狀態** — Working、Thinking、Idle、Sleeping、Error、Notification 等
- 🎯 **靈性睡眠序列** — Yawning → Dozing → Collapsing → Sleeping + 隨機 idle 變體
- 🏆 **Happy 慶祝動畫** — 任務完成時播放 1.5s 慶祝動畫

### v0.10.0 — 最新版本
- 🐾 **浮窗審批氣泡** — 在懸浮氣泡上左右滑動審批/拒絕權限請求
- 🌐 **遠端中繼** — 透過 VPS 中繼伺服器連接,支援非區域網路環境
- 🌍 **應用內語言切換** — 中/英文即時切換,無需重啟
- 🔒 **安全加固** — 加密儲存、TOFU 憑證固定、日誌清理
- 🧪 **548 個測試** — 全部通過,新增 103 個測試

---

## 📸 螢幕截圖

> _截圖即將加入。App 在手機螢幕上顯示一隻會動的桌寵,即時感知你的 AI Agent 活動——思考、工作、等待審批,以及任務完成時的慶祝。_

| 懸浮寵物 | 審批氣泡 | 設定頁面 |
|:---:|:---:|:---:|
| _截圖_ | _截圖_ | _截圖_ |

---

## ⚡ 快速開始

### 前置條件
- Android 8.0+ (API 26) 裝置,arm64-v8a 架構
- PC 端執行 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)

### 安裝步驟

1. 從 [Releases](https://github.com/Bynlk/clawd-on-mobile/releases) 下載最新 `app-release.apk`
2. 在 Android 裝置上安裝 APK
3. 開啟 App,掃描 PC 端顯示的 QR Code,或手動輸入連線資訊
4. 授予請求的權限（通知、相機、懸浮窗）
5. 你的寵物上線了！🎉

### 連線方式

| 方式 | 適用場景 |
|------|---------|
| **QR Code 掃描** | PC 和手機在同一區域網路 — 最快 |
| **手動輸入** | 手動輸入 PC 的 IP、連接埠和 Token |
| **遠端中繼** | 透過 VPS 中繼伺服器連接,支援非區域網路環境 |

---

## 🏛️ 架構設計

Clawd Mobile 採用**單管道架構**,所有狀態變更透過一條統一的 `StateFlow` 流轉:

```
PC (WebSocket) → StreamingClient → PetStateManager → FloatingPetService
                                          ↓
                                    StateCommand (單管道)
                                          ↓
                              SvgLoader → FloatingPetView (WebView SVG)
```

**核心設計決策:**
- **單管道** — 消除並行 SVG 載入競態
- **模板方法模式**（`StreamingClient` → `AbstractStreamingClient` → `WsClient`）— 易於擴充傳輸協定
- **策略模式**（`ConnectionStrategy`）— LAN/Relay 連接解耦
- **SessionMerger** — 統一 LAN + Relay 工作階段為一個檢視

詳細架構文件見 [android/README.md](android/README.md)。

---

## 📡 通訊協定

```
WebSocket:  ws://<host>:23334/mobile/ws
審批回傳:   POST http://<host>:23334/mobile/approve
Deep Link:  clawd://<host>:<port>/<token>
```

| 訊息類型 | 方向 | 說明 |
|---------|------|------|
| `ping` | 伺服端 → 客戶端 | 心跳保活 |
| `connected` | 伺服端 → 客戶端 | 連線確認 |
| `snapshot` | 伺服端 → 客戶端 | 全量工作階段快照 |
| `state` | 伺服端 → 客戶端 | 單工作階段狀態更新 |
| `permission_request` | 伺服端 → 客戶端 | 審批請求 |
| `reaction` | 伺服端 → 客戶端 | SVG 反應動畫 |

---

## 🔧 開發指南

### 環境要求
- Android Studio Hedgehog (2023.1.1)+
- JDK 17
- Android SDK 35
- arm64-v8a 裝置或模擬器

### 建置

```bash
cd android

# Debug APK
./gradlew assembleDebug

# Release APK（需要簽章設定）
KEYSTORE_FILE=release.keystore \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# 執行測試（548 個測試）
./gradlew testDebugUnitTest
```

### CI/CD

推送到 `main` 分支且修改 `android/` 目錄下的檔案時,GitHub Actions 自動觸發:lint → build → test → artifact 上傳。

---

## 🤝 參與貢獻
Clawd on Mobile 是基於 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的二創專案,在桌面端基礎上增加了 Android 夥伴應用、浮窗審批、遠端中繼等功能。

向本專案貢獻請參考 [CONTRIBUTING.md](./CONTRIBUTING.md)。

### 上游貢獻者（Clawd on Desk）

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
<a href="https://github.com/QingXB"><img src="https://github.com/QingXB.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/29206394"><img src="https://github.com/29206394.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tsdsj"><img src="https://github.com/Tsdsj.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/godlockin"><img src="https://github.com/godlockin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sLingli"><img src="https://github.com/sLingli.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/ustin-star"><img src="https://github.com/ustin-star.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/cod3hulk"><img src="https://github.com/cod3hulk.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/lxgxhsy"><img src="https://github.com/lxgxhsy.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/rebootcrab-blip"><img src="https://github.com/rebootcrab-blip.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zhaoxv210"><img src="https://github.com/zhaoxv210.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/serenNan"><img src="https://github.com/serenNan.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/IatomicreactorI"><img src="https://github.com/IatomicreactorI.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/quantai1314"><img src="https://github.com/quantai1314.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Git-creat7"><img src="https://github.com/Git-creat7.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/undownding"><img src="https://github.com/undownding.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/chrono-meta"><img src="https://github.com/chrono-meta.png" width="50" style="border-radius:50%" /></a>

我們歡迎貢獻！以下是參與方式:

1. **Fork** 本儲存庫
2. **建立** 功能分支:`git checkout -b feat/my-feature`
3. **提交** 清晰的 commit:`git commit -m "feat: add my feature"`
4. **Push** 到你的 fork:`git push origin feat/my-feature`
5. **發起** Pull Request

### 貢獻規範
- 遵循 Kotlin 編碼規範
- 新功能請新增測試
- 如有需要請更新文件
- PR 描述中引用相關 Issue

詳見 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 🔮 未來功能

Clawd Mobile 目前已支援透過區域網路或自建中繼即時觀察 Agent 並審批權限。接下來有兩個更大的能力正在路上——目標一致:**即使人不在電腦前,也能掌控你的 Agent。**

### 1. 🌐 伺服器中繼(出門在外也能審批)

現在的中繼需要你自己在 VPS 上部署。下一步是提供**開箱即用、始終在線的中繼**,讓手機無論身處何種網路(不同 Wi-Fi、行動數據、在路上)都能與桌面 Agent 保持連接。當你外出時 Agent 觸發權限請求,審批氣泡會推送到手機,你可以**隨時隨地 Allow / Deny**,無需處於同一區域網路,也無需手動架設伺服器。

- 透過行動網路在任意位置批准 / 拒絕權限請求
- 零設定連接 —— 無需自建 VPS
- 端到端加密,基於現有的 TOFU 憑證固定機制

### 2. 📬 內容推送(1:1 同步終端顯示)

除了動畫狀態,我們還希望手機能**1:1 鏡像終端實際顯示的內容**,這樣你可以直接閱讀 Agent 在做什麼,而不只是從桌寵的情緒去推測。具體範圍、傳輸格式和隱私模型**仍在討論中**,設計確定後會補充本節。

> 💡 對這兩個功能有想法?歡迎提 [issue](https://github.com/Bynlk/clawd-on-mobile/issues) 或 [discussion](https://github.com/Bynlk/clawd-on-mobile/discussions) —— 在它們成形階段,你的回饋非常寶貴。

---

## 🗺️ 路線圖

| 優先級 | 項目 | 狀態 |
|--------|------|------|
| ✅ | WebSocket 遷移（從 SSE） | 已完成 |
| ✅ | TOFU 憑證固定 | 已完成 |
| ✅ | 浮窗審批氣泡 | 已完成 |
| ✅ | 遠端中繼支援 | 已完成 |
| ✅ | 應用內語言切換 | 已完成 |
| ✅ | 安全加固 | 已完成 |
| 🔄 | Hilt 相依注入 | 計劃中 |
| 🔄 | Repository 模式 | 計劃中 |
| 🔄 | AbstractStreamingClient 測試 | 計劃中 |
| 🔮 | 伺服器中繼(隨時隨地審批) | 探索中 |
| 🔮 | 內容推送(1:1 終端鏡像) | 討論中 |

完整路線圖見 [android/docs/ROADMAP.md](android/docs/ROADMAP.md)。

---

## ❓ 常見問題

**Q: 需要安裝桌面端嗎？**
A: 是的。Clawd Mobile 是夥伴應用,需要連接到 PC 端執行的 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)。

**Q: 可以在家以外的網路使用嗎？**
A: 可以！v0.10.0 新增了遠端中繼支援。在 VPS 上部署中繼伺服器,即可從任何地方連接。

**Q: 支援哪些 AI Agent？**
A: 支援所有 Clawd on Desk 相容的 Agent — Claude Code、Codex、Cursor、Copilot、Gemini 等。

**Q: 寵物不動 / 一直顯示 idle**
A: 確保桌面端已連接且有活躍工作階段。在 App 設定頁檢查連線狀態。

**Q: 如何更新？**
A: 從 [Releases](https://github.com/Bynlk/clawd-on-mobile/releases) 下載最新 APK,覆蓋安裝即可,資料會保留。

---

## 👥 貢獻者

### Android 移植
- [@Bynlk](https://github.com/Bynlk) — Android 移植開發者 & 維護者

### 桌面端貢獻者
以下開發者為 Clawd 生態（桌面端 + 移動端）做出了貢獻:

| 貢獻者 | 貢獻內容 |
|--------|---------|
| [@rullerzhou-afk](https://github.com/rullerzhou-afk) (鹿鹿) | Clawd on Desk 原作者 |
| [@Ruller_Lulu](https://github.com/Ruller_Lulu) | 核心開發 |
| [@Yoimiya](https://github.com/Yoimiya) | 重大貢獻 |
| [@Lyu Bingrong](https://github.com/LyuBingrong) | 功能與修復 |
| [@hwasowl](https://github.com/hwasowl) | 功能與修復 |
| [@nmsn](https://github.com/nmsn) | 功能與修復 |
| [@zxypro](https://github.com/zxypro) | Telegram 審批狀態 |
| [@sLingli](https://github.com/sLingli) | Reasonix CLI 整合 |
| [@cod3hulk](https://github.com/cod3hulk) | tmux 焦點支援 |
| [@lxgxhsy](https://github.com/lxgxhsy) | Windows 焦點快取 |
| [@rebootcrab-blip](https://github.com/rebootcrab-blip) | Agent asar 打包修復 |
| [@ustin-star](https://github.com/ustin-star) | CodeWhale 配接器 |

> 🙏 **感謝所有為 Clawd 專案做出貢獻的開發者！** 無論是程式碼、文件、Bug 回報還是功能建議,每一份貢獻都讓這個專案變得更好。
>
> 如果你曾做過貢獻但名字不在列表中,請發 Issue 或 PR 新增自己。

---

## 📄 授權條款

- **程式碼**: [AGPL-3.0](LICENSE)
- **美術素材**: 版權保留（All Rights Reserved）

**Clawd** 角色是 [Anthropic](https://www.anthropic.com) 的財產。這是一個非官方的粉絲專案,與 Anthropic 無關,也未獲得 Anthropic 的認可。

---

## 🙏 致謝

- **[rullerzhou-afk](https://github.com/rullerzhou-afk)**（鹿鹿 / Ruller_Lulu）— [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的創作者,感謝你建立了這個精彩的專案並將其開源。

- **[Anthropic](https://www.anthropic.com)** — 創造了啟發這個專案的 Claude。

- **所有[貢獻者](#-貢獻者)** — 感謝你們的時間、程式碼和熱情。

- **開源社群** — 感謝讓這一切成為可能的工具和函式庫:Kotlin、Jetpack Compose、OkHttp、kotlinx.serialization、CameraX、ZXing 等。

---

<p align="center">
  <sub>⭐ 如果你喜歡這個專案,請在 <a href="https://github.com/Bynlk/clawd-on-mobile">GitHub</a> 上給它一個 Star！</sub>
</p>

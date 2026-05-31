# Clawd Mobile — Android 伴侣应用

[![Android Build](https://github.com/Bynlk/clawd-on-desk/actions/workflows/android.yml/badge.svg)](https://github.com/Bynlk/clawd-on-desk/actions/workflows/android.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE)
[![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-green.svg)](https://developer.android.com/about/versions/oreo)
[![API 26+](https://img.shields.io/badge/API-26%2B-brightgreen.svg)](https://developer.android.com/studio/releases/platforms#android-8.0)

通过局域网连接 [Clawd on Desk](https://github.com/Bynlk/clawd-on-desk) 桌面端，远程监控 AI 编码会话状态，随时审批权限请求，手机变身桌面宠物遥控器。

> **需要配合桌面端使用** — 前往 [Releases](https://github.com/Bynlk/clawd-on-desk/releases) 下载 `app-release.apk`。

---

## ✨ 功能特性

### 📱 核心功能

- **QR 扫码配对** — 扫描桌面端生成的二维码，自动获取 IP / 端口 / Token
- **手动连接** — 输入 IP/Port/Token，支持连接历史（最近 5 条）
- **Deep Link** — `clawd://host:port/token` 协议一键跳转连接
- **实时会话监控** — SSE 推送会话状态（工作中 / 思考中 / 空闲 / 休眠等）
- **远程审批** — Claude Code 请求权限时，手机弹出通知，一键允许 / 拒绝
- **会话重命名** — 长按会话标题自定义名称，本地持久化
- **工具输出预览** — 展示最近一次工具调用的输入摘要和输出片段

### 🐾 悬浮宠物

- **桌面浮窗** — `TYPE_APPLICATION_OVERLAY` 窗口，置顶显示在所有应用之上
- **状态动画** — 根据会话状态实时切换 GIF 动画（工作/思考/空闲/休眠等）
- **3 个角色** — Clawd（20 个 GIF）、Calico（12 个）、Cloudling（13 个）
- **空闲循环** — 无任务时自动切换 idle ↔ idle_reading 动画
- **完成庆祝** — 任务完成时播放 1.5s happy 插曲动画
- **手势操作** — 单击切换信息气泡、双击打开应用、拖拽移动位置
- **位置记忆** — 退出后自动保存位置，重启恢复
- **透明穿透** — Alpha 通道命中测试，透明像素不拦截触摸事件

### 🔔 智能通知

- **审批通知** — HIGH 优先级 + 振动，支持通知栏内联 Allow/Deny 按钮
- **状态通知** — 会话完成/失败/错误状态变化推送
- **断连告警** — SSE 连接断开/重连时发送 alert 通知
- **通知渠道** — 4 个独立渠道（approval/status/alert/service），可分别控制
- **点击恢复** — 点击超时通知可恢复已自动移除的审批请求

### 🎨 设计语言

- **Material 3** — 深色主题（背景 `#111318`，琥珀色强调 `#B45309`）
- **状态颜色体系** — working=绿、thinking=靛、error=红、idle=灰
- **25 个自绘图标** — 24dp, 2dp stroke, round caps/joins
- **中文支持** — 完整中文本地化（应用名、通知渠道、事件标签）

---

## 🛠 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Kotlin | 2.1.0 |
| UI 框架 | Jetpack Compose + Material 3 | BOM 2024.12.01 |
| 网络 | OkHttp SSE（Server-Sent Events） | 4.12.0 |
| 序列化 | kotlinx.serialization | 1.7.3 |
| 二维码 | CameraX + ZXing | 1.4.1 / 3.5.3 |
| GIF 加载 | Glide | 4.16.0 |
| 导航 | Navigation Compose | 2.8.5 |
| 构建 | Gradle + AGP | 8.11.1 / 8.7.3 |
| 最低版本 | Android 8.0（API 26） | — |
| 目标版本 | Android 15（API 35） | — |
| ABI | arm64-v8a | — |
| JVM Target | 17 | — |

### 关键依赖

| 依赖 | 用途 |
|------|------|
| `okhttp-sse` | SSE 长连接客户端 |
| `okhttp` | HTTP 请求（审批回传） |
| `kotlinx-serialization-json` | JSON 序列化/反序列化 |
| `compose-bom` | Jetpack Compose 统一版本管理 |
| `navigation-compose` | 单 Activity 导航 |
| `camera-camera2` + `camera-view` | 相机预览 |
| `zxing-android-embedded` | 二维码扫描 |
| `glide` | GIF 动画加载与缓存 |
| `lifecycle-runtime-compose` | Compose 生命周期感知 |
| `lifecycle-viewmodel-compose` | ViewModel 集成 |

---

## 🏗 架构设计

### 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                    MainActivity                           │
│  ┌────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ ScanScreen  │ │SessionsScreen│ │SettingsScreen│        │
│  └────────────┘ └──────┬───────┘ └──────────────┘        │
│                        │                                  │
│                 ApprovalViewModel                         │
│              (权限请求生命周期管理)                          │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────┐
│               WebSocketService (前台服务)                  │
│            ┌────────────────────────┐                     │
│            │    ClawdWebSocket      │                     │
│            │  (OkHttp SSE Client)   │                     │
│            └───────────┬────────────┘                     │
│                        │                                  │
│  ┌─────────────────────┴──────────────────────┐           │
│  │ StateFlow<ConnectionState>                 │           │
│  │ StateFlow<Map<sessionId, SessionData>>     │           │
│  │ SharedFlow<WsMessage>                      │           │
│  │ SharedFlow<PermissionRequestData>          │           │
│  └────────────────────────────────────────────┘           │
└───────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────┐
│              FloatingPetService (前台服务)                  │
│  ┌───────────────┐  ┌───────────────┐                     │
│  │FloatingPetView │  │ PetBubbleView │                     │
│  │  (GIF 浮窗)    │  │  (信息气泡)    │                     │
│  └───────┬───────┘  └───────────────┘                     │
│          │                                                │
│  ┌───────┴───────┐                                        │
│  │  PetGifLoader  │                                        │
│  │ (状态→GIF映射)  │                                        │
│  └───────────────┘                                        │
└───────────────────────────────────────────────────────────┘
                             │
                      PC 端 Electron
                 (SSE on LAN:23334)
```

### 分层职责

| 层 | 职责 | 零推断原则 |
|---|------|-----------|
| **PC 端** | 状态机运行、displayState 计算、badge/颜色/文本全部服务端生成 | ✅ |
| **网络层** | SSE 长连接、消息解析、自动重连（指数退避 1s→30s）、30s 看门狗 | — |
| **数据层** | SessionData 纯透传、SharedPreferences 持久化、连接历史 | ✅ |
| **UI 层** | 渲染 PC 端推送的 chipText/chipColor/dotColor，不做本地推断 | ✅ |
| **悬浮层** | 状态→GIF 动态解析、空闲循环、badge 完成动画 | 部分本地映射 |

### 设计决策

- **零推断原则** — 所有视觉状态（颜色、文本、badge）均由 PC 端计算，移动端纯透传渲染
- **SSE 而非 WebSocket** — 使用 Server-Sent Events 实现单向推送，审批回传走独立 HTTP POST
- **前台服务双保活** — `WifiLock` + `WakeLock` 防止网络中断和 CPU 休眠
- **纯 View 悬浮层** — WindowManager 叠加层使用传统 View 而非 Compose，避免生命周期问题

---

## 📂 项目结构

```
android/
├── app/src/main/
│   ├── java/com/clawd/mobile/
│   │   ├── MainActivity.kt              # 入口 Activity + 权限流 + Deep Link
│   │   ├── ClawdApp.kt                  # Application + 通知渠道
│   │   │
│   │   ├── data/                        # 数据层
│   │   │   ├── Session.kt               # SessionData 模型 + 状态优先级 + 事件标签
│   │   │   ├── ConnectionConfig.kt      # 连接配置 + URL 生成 + Deep Link 解析
│   │   │   ├── PrefsStore.kt            # SharedPreferences 封装
│   │   │   └── WsMessage.kt             # SSE 消息信封 + 权限/选择请求模型
│   │   │
│   │   ├── ws/                          # 网络层
│   │   │   ├── ClawdWebSocket.kt        # OkHttp SSE 客户端 + 消息处理 + 重连逻辑
│   │   │   └── ConnectionState.kt       # 连接状态枚举
│   │   │
│   │   ├── service/                     # 服务层
│   │   │   └── WebSocketService.kt      # SSE 前台服务（dataSync 类型）
│   │   │
│   │   ├── overlay/                     # 悬浮宠物层
│   │   │   ├── FloatingPetService.kt    # 悬浮宠物前台服务（specialUse 类型）
│   │   │   ├── FloatingPetView.kt       # 自定义 ImageView + 内容感知居中 + Alpha 命中
│   │   │   ├── PetBubbleView.kt         # 信息气泡（纯 View，非 Compose）
│   │   │   └── PetGifLoader.kt          # 状态→GIF 动态映射引擎
│   │   │
│   │   ├── notification/                # 通知层
│   │   │   ├── NotificationHelper.kt    # 通知构建器（审批/选择）
│   │   │   ├── StatusNotifier.kt        # 状态变化通知逻辑
│   │   │   ├── NotificationIcons.kt     # 彩色圆点图标生成
│   │   │   └── ApprovalReceiver.kt      # 通知按钮广播接收器
│   │   │
│   │   └── ui/                          # UI 层
│   │       ├── navigation/NavGraph.kt   # NavHost + 服务绑定 + 通知接线
│   │       ├── sessions/SessionsScreen.kt # 主界面 + 审批 BottomSheet + 底部导航
│   │       ├── scan/ScanScreen.kt       # CameraX + ZXing 二维码扫描
│   │       ├── manual/ManualScreen.kt   # 手动连接 + 连接历史
│   │       ├── settings/SettingsScreen.kt # 手风琴式设置页
│   │       ├── approval/ApprovalViewModel.kt # 审批请求生命周期管理
│   │       ├── components/ClawdIcons.kt # 25 个自绘矢量图标
│   │       └── theme/                   # Material 3 主题
│   │           ├── Color.kt             # 25+ 颜色常量
│   │           ├── Theme.kt             # 亮/暗主题配置
│   │           └── Type.kt              # 排版定义
│   │
│   ├── res/
│   │   ├── raw/                         # 43 个 GIF 动画资源
│   │   │   ├── clawd_*.gif              # 20 个 Clawd 动画
│   │   │   ├── calico_*.gif             # 12 个 Calico 动画
│   │   │   └── cloudling_*.gif          # 13 个 Cloudling 动画
│   │   ├── mipmap-*/                    # 启动图标（hdpi/mdpi/xhdpi/xxhdpi/xxxhdpi）
│   │   ├── values/strings.xml           # 英文字符串
│   │   ├── values-zh/strings.xml        # 中文字符串
│   │   └── xml/network_security_config.xml # 明文流量许可（LAN 通信）
│   │
│   └── AndroidManifest.xml              # 10 权限 + 1 Activity + 2 Service + 1 Receiver
│
├── app/src/test/                        # 单元测试
│   └── data/ConnectionConfigTest.kt     # 5 个 URL 解析/生成测试
│
├── build.gradle.kts                     # 根构建脚本
├── app/build.gradle.kts                 # App 构建脚本
├── gradle/libs.versions.toml            # 版本目录
├── release-keystore.jks                 # 签名密钥
└── README.md                            # 本文件
```

**源文件统计**: 26 个 Kotlin 源文件 + 1 个测试文件，43 个 GIF 资源。

---

## 📡 通信协议

### 连接方式

```
SSE 流:    GET  http://<host>:23334/mobile/stream?token=<token>
审批回传:  POST http://<host>:23334/mobile/approve
Deep Link: clawd://<host>:<port>/<token>
```

### SSE 消息类型（服务端 → 客户端）

| type | 说明 | 数据结构 |
|------|------|----------|
| `ping` | 心跳保活 | 无 |
| `connected` | 连接成功确认 | `{ version }` |
| `clear_sessions` | 清空本地会话缓存 | 无 |
| `snapshot` | 全量会话快照 | `{ sessions: Map<id, SessionData> }` |
| `state` | 单会话状态更新 | `{ id, ...SessionData }` |
| `tool_output` | 工具输出片段 | `{ id, output }` |
| `session_deleted` | 会话删除 | `{ id }` |
| `permission_request` | 权限审批请求 | `{ id, tool, input, suggestions, timeout }` |
| `elicitation_request` | 交互式选择请求 | `{ id, message, options }` |

### 审批回传（客户端 → 服务端）

```json
POST /mobile/approve
Content-Type: application/json

{
  "id": "request-id",
  "decision": "allow" | "deny",
  "suggestionIndex": 0
}
```

### Deep Link 格式

```
clawd://<host>:<port>/<token>
```

示例: `clawd://192.168.1.100:23334/abc123def456`

---

## 🐾 状态机与 GIF 映射

### 状态优先级

Android 端采用倒序优先级（数字越小 = 优先级越高），用于选取最高优先级 session：

| 优先级 | 状态 | 说明 |
|--------|------|------|
| 1 | `working`, `juggling` | 工作中 |
| 2 | `thinking` | 思考中 |
| 3 | `notification`, `attention`, `error` | 提示/注意/错误 |
| 4 | `sweeping`, `carrying` | 清扫/搬运 |
| 5 | `idle` | 空闲 |
| 6 | `sleeping` | 睡眠 |

### GIF 候选链

映射采用**动态候选链**机制：按优先级尝试加载，第一个存在的资源生效，不存在则降级到下一个。

```
working + sessions≥3  → [character_building, character_typing, character_idle]
working + sessions=2  → [character_headphones_groove, character_typing, character_idle]
working + sessions<2  → [character_typing, character_idle]

juggling + sessions≥2 → [character_juggling, character_typing, character_idle]
juggling + sessions<2 → [character_headphones_groove, character_typing, character_idle]

attention             → [character_attention, character_happy, character_idle]

其他状态               → [character_{state}, character_idle]
```

### 各角色 GIF 资源矩阵

| 动画 | Clawd | Calico | Cloudling |
|------|:-----:|:------:|:---------:|
| idle | ✅ | ✅ | ✅ |
| idle_reading | ✅ | ❌ | ✅ |
| typing | ✅ | ✅ | ✅ |
| thinking | ✅ | ✅ | ✅ |
| building | ✅ | ✅ | ✅ |
| juggling | ✅ | ✅ | ✅ |
| carrying | ✅ | ✅ | ✅ |
| sweeping | ✅ | ✅ | ✅ |
| conducting | ✅ | ✅ | ✅ |
| notification | ✅ | ✅ | ✅ |
| error | ✅ | ✅ | ✅ |
| happy | ✅ | ✅ | ❌ |
| sleeping | ✅ | ✅ | ✅ |
| attention | ❌ | ❌ | ✅ |
| headphones_groove | ✅ | ❌ | ❌ |
| debugger | ✅ | ❌ | ❌ |
| react_annoyed | ✅ | ❌ | ❌ |
| react_double_jump | ✅ | ❌ | ❌ |
| bubble | ✅ | ❌ | ❌ |

### 特殊行为

- **空闲循环** — `idle`（30s）→ `idle_reading`（5s）→ 循环（仅 clawd/cloudling）
- **Badge 完成动画** — session badge 从 `running` → `done` 时，播放 1.5s `happy` 插曲
- **过期 session** — 30s 无更新视为 idle

---

## 🔔 通知系统

### 通知渠道

| 渠道 ID | 优先级 | 用途 | 振动 |
|---------|--------|------|:----:|
| `clawd_approval` | HIGH | 权限审批请求 | ✅ |
| `clawd_status` | LOW | 会话状态变化 | ❌ |
| `clawd_alert` | HIGH | 断连/重连/错误 | ✅ |
| `clawd_service` | LOW | 前台服务常驻通知 | ❌ |

### 状态→颜色映射

| 状态 | 颜色 | 色值 |
|------|------|------|
| working | 绿色 | `#16A34A` |
| juggling | 琥珀色 | `#B45309` |
| thinking | 靛蓝色 | `#6366F1` |
| attention | 琥珀色 | `#B45309` |
| error | 红色 | `#EF4444` |
| notification | 琥珀色 | `#B45309` |
| idle | 灰色 | `#71717A` |
| sleeping | 浅灰色 | `#A1A1AA` |

---

## 🔐 权限清单

| 权限 | 用途 | 运行时请求 |
|------|------|:----------:|
| `INTERNET` | LAN 通信 | ❌ |
| `CAMERA` | 二维码扫描 | ✅ |
| `POST_NOTIFICATIONS` | 通知推送（Android 13+） | ✅ |
| `VIBRATE` | 通知振动 | ❌ |
| `WAKE_LOCK` | 保持 CPU 唤醒 | ❌ |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 防止 Doze 杀后台 | ✅ |
| `FOREGROUND_SERVICE` | 前台服务 | ❌ |
| `FOREGROUND_SERVICE_DATA_SYNC` | WebSocketService 类型 | ❌ |
| `FOREGROUND_SERVICE_SPECIAL_USE` | FloatingPetService 类型 | ❌ |
| `SYSTEM_ALERT_WINDOW` | 悬浮窗 | ✅ |

启动时按顺序弹窗请求 4 项运行时权限，每项带说明对话框（Allow / Skip）。

---

## 🔧 开发

### 环境要求

- Android Studio Hedgehog (2023.1.1) 或更高版本
- JDK 17
- Android SDK 35
- arm64-v8a 设备或模拟器

### 构建

```bash
# 构建 debug APK
cd android
./gradlew assembleDebug

# 构建 release APK（需要环境变量）
KEYSTORE_FILE=release-keystore.jks \
STORE_PASSWORD=xxx \
KEY_ALIAS=clawd \
KEY_PASSWORD=xxx \
./gradlew assembleRelease

# 安装到设备
./gradlew installDebug

# 运行单元测试
./gradlew test
```

### CI/CD

推送到 `main` 分支且修改 `android/` 目录下的文件时，GitHub Actions 自动：

1. 构建 debug + release APK
2. 使用 keystore 签名 release
3. 上传两个 APK 为 artifacts
4. 运行 lint 检查

#### GitHub Secrets

| Secret | 说明 |
|--------|------|
| `KEYSTORE_BASE64` | Keystore 文件的 Base64 编码 |
| `STORE_PASSWORD` | Keystore 密码 |
| `KEY_ALIAS` | Key 别名 |
| `KEY_PASSWORD` | Key 密码 |

---

## 📊 开发时间线

整个 Android 伴侣应用在 **约 48 小时** 内完成（2026-05-29 ~ 2026-05-31），共 48 次提交：

| 阶段 | 时间 | 重点 |
|------|------|------|
| **Day 1** | 05-29 | 初始创建：Gradle 脚手架、WebSocket 骨架、SVG 图标、可折叠卡片、审批 UI、通知系统 |
| **Day 2** | 05-30 | UI 重设计、性能优化（ML Kit→ZXing -12MB）、前台服务、SSE 迁移、权限桥接、心跳看门狗、电池优化、12 个 bug 修复 |
| **Day 3** | 05-31 | CI/CD 签名构建、版本号重置（0.1.0）、keystore 修复、README 编写、About 对齐桌面端 |

### 版本历史

| 版本 | versionCode | 说明 |
|------|-------------|------|
| 1.1.0 ~ 1.5.9 | 2 ~ 38 | 早期开发版本（跟随桌面端版本号） |
| 0.1.0 | 1 | CI/CD 签名构建建立，版本号重置 |
| 0.1.1 | 2 | CI release 测试 |
| 0.1.2 | 3 | keystore 路径修复 |
| **0.1.3** | **4** | **当前版本** — keystore 从 rootProject 解析 |

---

## 📋 已知技术债务

| 级别 | 项 | 说明 |
|------|---|------|
| **S** | ClawdWebSocket.kt | 类名误导（实际是 SSE），协议层与业务逻辑耦合，职责过重 |
| **A** | 零测试覆盖 | 仅 5 个 ConnectionConfig 单元测试，无 UI/集成测试 |
| **A** | 无 Room 数据库 | 全部走 SharedPreferences，会话数据无法持久化查询 |
| **B** | 静态单例模式 | WebSocketService.instance 紧耦合，不利于测试和解耦 |
| **B** | 版本号混乱 | 从 1.x 跳到 0.x，versionCode 不连续 |

---

## 📄 许可证

- **代码**: [AGPL-3.0](../LICENSE)
- **美术素材**: 版权保留（All Rights Reserved）

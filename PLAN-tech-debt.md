# 技术债务清理执行计划

> **目标**：SSE→WS 清理、Fork 代码隔离、测试覆盖率 100%
> **版本**：v0.9.0 → v1.0
> **预估总工时**：~40-50 小时（分 4 个阶段）
> **最后更新**：2026-06-18

---

## 执行状态总览

| 阶段 | 状态 | 完成度 | 备注 |
|------|------|--------|------|
| 阶段一：SSE 清理 | ✅ 已完成 | 100% | 2026-06-16 完成 |
| 阶段二：Fork 隔离 | ⚠️ 部分完成 | 40% | 2.1 已完成，2.2-2.6 未开始 |
| 阶段三：测试覆盖 | ⚠️ 部分完成 | 15% | 新功能有测试，旧模块未补全 |
| 阶段四：上游同步 | ⚠️ 部分完成 | 30% | 已同步 v0.10.0，流程未自动化 |

---

## 阶段一：SSE→WebSocket 残留清理（~3h）✅ 已完成

> 迁移的核心逻辑已完成，剩余的是命名、依赖和文档清理。风险最低，先做。

**完成时间**：2026-06-16（commit 202b8f4）

### 1.1 Android 变量重命名（~1.5h）✅

将所有 `sseClient` 重命名为 `streamingClient`，`_sseClient` → `_streamingClient`。

**完成**：所有 10 个 Kotlin 文件已重命名，commit 202b8f4。

**修改文件清单（10 个 Kotlin 文件）：**

| 文件 | 改动点 |
|------|--------|
| `service/WsConnectionService.kt` | 字段 `sseClient` → `streamingClient`，~16 处引用 |
| `ui/approval/ApprovalViewModel.kt` | 构造参数 + ~10 处引用 |
| `ui/navigation/NavGraph.kt` | `serviceManager.sseClient` → `streamingClient`，~3 处 |
| `ui/navigation/ServiceManager.kt` | `_sseClient` / `sseClient` StateFlow → `_streamingClient` / `streamingClient` |
| `ui/sessions/SessionsScreen.kt` | 参数名 + ~9 处引用 |
| `ui/sessions/SessionsViewModel.kt` | 参数名 + ~8 处引用 |
| `ui/settings/SettingsScreen.kt` | 参数名 + ~3 处引用 |
| `ui/settings/ConnectionStatusCard.kt` | 参数名 + ~2 处引用 |
| `ws/AbstractStreamingClient.kt` | KDoc 中 `SseClient` → `StreamingClient` |
| `ws/MessageHandler.kt` | KDoc 中 `SseClient` → `StreamingClient` |

**额外 KDoc 清理：**
- `ws/ParsedMessage.kt` — KDoc `SseClient.handleMessage` → `MessageHandler.handleMessage`
- `util/HttpClientProvider.kt` — KDoc `SseClient.disconnect` → `StreamingClient.disconnect`
- `ws/StreamingClient.kt` — KDoc "SSE or WebSocket" → "WebSocket"

**执行方式：** 全局搜索替换，然后 `./gradlew testDebugUnitTest` 验证。

### 1.2 测试文件重命名（~0.5h）✅

| 文件 | 改动 | 状态 |
|------|------|------|
| `android/app/src/test/.../ws/SseClientParsingTest.kt` | 重命名为 `MessageParserExtendedTest.kt` | ✅ 已完成 |

### 1.3 移除 okhttp-sse 依赖（~0.5h）✅

| 文件 | 改动 | 状态 |
|------|------|------|
| `android/gradle/libs.versions.toml` | 删除 `okhttp-sse` 版本声明 | ✅ 已完成 |
| `android/app/build.gradle.kts` | 删除 `implementation(libs.okhttp-sse)` | ✅ 已完成 |
| `android/app/gradle.lockfile` | 删除 `okhttp-sse` 条目 | ✅ 已完成 |

### 1.4 文档和字符串清理（~0.5h）✅

| 文件 | 改动 |
|------|------|
| `android/README.md` | 全面清理 SSE 相关描述、架构图、消息类型说明 |
| `android/app/src/main/res/values/strings.xml:82` | "SSE connection" → "WebSocket connection" |
| `android/app/src/main/res/values-en/strings.xml:82` | 同上 |
| `android/app/src/main/res/values-zh/strings.xml:82` | "SSE 连接" → "WebSocket 连接" |
| `android/docs/PLAN_P0_SECURITY.md` | wake lock tag `"clawd:sse"` → `"clawd:ws"` |
| `android/docs/ROADMAP.md` | 移除 `ClawdWebSocket → ClawdSseClient` 重命名计划（已完成反向） |
| `src/main.js:1467-1468` | 注释 "SSE" → "WebSocket" |
| `src/permission.js:951` | 注释 "SSE bridge" → "WebSocket bridge" |

**验证：** `grep -ri "sse" android/app/src/ src/ --include="*.kt" --include="*.js" --include="*.xml"` 确认无残留（文档目录可忽略）。

---

## 阶段二：Fork 代码隔离（~12h）⚠️ 40% 完成

> 目标：将 fork 对上游文件的修改从 19 个减少到 <5 个，代码隔离评分从 6.5/10 提升到 ≥8.5/10。

### 2.1 提取 `server.js` 中的 mobile 代码（~3h）✅

**当前状态：** `server.js` 被修改了 +212 行，mobile 逻辑散布在 `startHttpServer()` 中。

**目标：** 创建 `src/mobile-server-integration.js`，将所有 mobile 逻辑集中。

**完成**：`src/mobile-server-integration.js` 已创建（417 行），`server.js` 改动从 +212 行减少到 ~15 行调用。

**步骤：**
1. 创建 `src/mobile-server-integration.js`，导出：
   - `initMobileServer(ctx)` — 初始化 MobileWSServer、token 加载、HTTP server 创建
   - `startMobileServer(ctx)` — 启动 WS 升级监听
   - `stopMobileServer(ctx)` — 关闭 mobile server
   - `broadcastHookEvent(event)` — 广播 hook 事件
   - `resolveMobileApproval(ctx, id, approved)` — 审批解析
2. 在 `server.js` 中将 +212 行替换为 ~15 行调用：
   ```js
   const mobile = require("./mobile-server-integration");
   // 在 startHttpServer 适当位置：
   mobile.initMobileServer(serverCtx);
   mobile.startMobileServer(serverCtx);
   // 在 close/stop 位置：
   mobile.stopMobileServer(serverCtx);
   ```
3. 确保 `server-route-state.js` 通过 `ctx` 上的回调或引用获取 `mobileWS` 和 `broadcastHookEvent`，而不是直接 require

**验证：** `npm test` + 手动测试 Android 连接。

### 2.2 消除 `main.js` 猴补丁（~3h）✅

**当前状态：** `main.js:1469-1531` 用 monkey-patch 替换了 `_serverCtx.addPendingPermission` 和 `removePendingPermission`。

**目标：** 改为 `ctx` 上的回调钩子。

**完成**：`ctx.onPermissionAdded` 和 `ctx.onPermissionRemoved` 回调已实现，monkey-patch 已移除。

**步骤：**
1. 在 `server.js` 创建 serverCtx 时，添加两个可选回调槽位：
   ```js
   ctx.onPermissionAdded = null;   // (permId, meta) => void
   ctx.onPermissionRemoved = null; // (permId) => void
   ```
2. 修改 `server.js` 中 `addPendingPermission()` 和 `removePendingPermission()` 函数，在原有逻辑之后调用回调：
   ```js
   function addPendingPermission(...) {
     // ... 原有逻辑 ...
     if (typeof ctx.onPermissionAdded === "function") {
       ctx.onPermissionAdded(id, meta);
     }
   }
   ```
3. 在 `mobile-server-integration.js` 的 `initMobileServer(ctx)` 中设置回调：
   ```js
   ctx.onPermissionAdded = (id, meta) => { /* 广播到 mobile */ };
   ctx.onPermissionRemoved = (id) => { /* 清理 mobile 审批 */ };
   ```
4. 从 `main.js` 中删除 monkey-patch 代码块（~60 行）

**验证：** `npm test` + 手动测试权限气泡 + Android 审批流程。

### 2.3 提取 `server-route-state.js` 中的广播逻辑（~2h）❌ 未开始

**当前状态：** 每个状态变更点都插入了 mobile 广播代码块（+122 行）。

**目标：** 将广播逻辑提取为一个函数，`server-route-state.js` 只保留一行调用。

**步骤：**
1. 在 `mobile-server-integration.js` 中导出：
   ```js
   function onStateChange(ctx, sessionOrGlobal, changeType, data) {
     if (ctx.mobileWS) {
       ctx.mobileWS.broadcastState(sessionOrGlobal, changeType, data);
     }
     if (ctx.broadcastHookEvent) {
       ctx.broadcastHookEvent(changeType, data);
     }
   }
   ```
2. 在 `server-route-state.js` 中，将所有广播代码块替换为：
   ```js
   if (typeof ctx.onMobileStateChange === "function") {
     ctx.onMobileStateChange(sessionId, "state_change", stateData);
   }
   ```
3. 在 `mobile-server-integration.js` 的 `initMobileServer` 中设置 `ctx.onMobileStateChange`

**验证：** `npm test` + 手动测试状态同步。

### 2.4 提取 settings 相关改动（~2h）✅ 部分完成

**当前状态：** `settings-tab-mobile.js` 是完整重写（+252/-95），`settings-ipc.js`、`settings-i18n.js`、`settings.css` 都有大量改动。

**完成**：
- `src/mobile-settings-ipc.js` 已创建（130 行）
- `src/mobile-i18n.js` 已创建（87 行）
- `src/mobile-settings.css` 已创建（127 行）

**步骤：**
1. `settings-tab-mobile.js` — 已经是独立文件，确认是否可以作为独立模块加载而非替换原文件。如果上游有同名文件，需要改为 `settings-tab-mobile-companion.js` 并在 settings 系统中注册
2. `settings-ipc.js` — 提取 mobile IPC handler 为独立文件 `src/mobile-settings-ipc.js`，在 settings-ipc 中通过条件注册
3. `settings-i18n.js` — 移动 mobile i18n 字符串到 `src/mobile-i18n.js`，通过合并方式注入
4. `settings.css` — 移动 mobile 样式到 `src/mobile-settings.css`，通过 `<link>` 标签引入

**验证：** `npm test` + 手动测试设置页面 mobile tab。

### 2.5 添加 Feature Flag（~1h）✅

**步骤：**
1. 在 `src/prefs.js` 中添加 `MOBILE_COMPANION_ENABLED` 偏好（默认 `true`） ✅
2. 在所有 mobile 集成点添加 flag 检查 ✅
3. 在设置页面添加开关 ✅

**完成**：`mobileCompanionEnabled` 已在 `prefs.js` 中定义，`server.js` 使用 `ctx.mobileCompanionEnabled` 控制初始化。

### 2.6 清理剩余低风险改动（~1h）

| 文件 | 当前改动 | 处理方式 |
|------|----------|----------|
| `state.js` | 6 处 `typeof ctx.onSessionRemoved` | **保留** — 这是最干净的模式 |
| `state-priority.js` | +9/-1 | 评估是否可以通过配置注入 |
| `menu.js` | +9/-2 | 评估是否可以通过 menu 扩展点注册 |
| `state-session-snapshot.js` | `deriveMobileChipFields` | 提取到 `mobile-server-integration.js` |

---

## 阶段三：测试覆盖率提升（~20h）

> 目标：Android 从 35% 文件覆盖 → 100%，桌面端从 80% → 100%。
> 原则：先测纯逻辑，再测需要 mock 的，最后测 UI。

### 3.1 Android — 纯逻辑层补全（~4h）

这些文件无 Android 依赖，可直接 JUnit 测试。

| 优先级 | 源文件 | 测试文件 | 复杂度 |
|--------|--------|----------|--------|
| P0 | `overlay/TimedConsumeSet.kt` | `overlay/TimedConsumeSetTest.kt` | 低 — TTL 集合，纯逻辑 |
| P0 | `data/WsMessage.kt` | `data/WsMessageTest.kt` | 低 — data class |
| P0 | `ws/ParsedMessage.kt` | `ws/ParsedMessageTest.kt` | 低 — data class |
| P0 | `ws/CertFingerprintInfo.kt` | `ws/CertFingerprintInfoTest.kt` | 低 — data class |
| P0 | `util/ConnectionLog.kt` | `util/ConnectionLogTest.kt` | 低 — 日志工具 |
| P1 | `ui/sessions/SessionsUtils.kt` | `ui/sessions/SessionsUtilsTest.kt` | 低 — 工具函数 |
| P1 | `ws/StreamingClient.kt` | `ws/StreamingClientTest.kt` | 中 — 接口/抽象 |

### 3.2 Android — Manager/ViewModel 层补全（~5h）

这些文件有依赖但可通过 mock 或 fake 测试。

| 优先级 | 源文件 | 测试文件 | 依赖处理 |
|--------|--------|----------|----------|
| P0 | `ui/sessions/SessionsViewModel.kt` | `ui/sessions/SessionsViewModelTest.kt` | mock StreamingClient |
| P0 | `overlay/PetBubbleManager.kt` | `overlay/PetBubbleManagerTest.kt` | mock WindowManager, View |
| P0 | `overlay/PetWindowController.kt` | `overlay/PetWindowControllerTest.kt` | mock WindowManager |
| P0 | `overlay/PetGestureHandler.kt` | `overlay/PetGestureHandlerTest.kt` | mock MotionEvent |
| P1 | `ws/AbstractStreamingClient.kt` | `ws/AbstractStreamingClientTest.kt` | 用 WsClient 的 fake 子类 |
| P1 | `ws/MessageHandler.kt` | `ws/MessageHandlerTest.kt` | mock 各种 listener |
| P1 | `ui/navigation/ServiceManager.kt` | `ui/navigation/ServiceManagerTest.kt` | mock Context |

### 3.3 Android — Service/Receiver 层补全（~3h）

| 优先级 | 源文件 | 测试文件 | 方式 |
|--------|--------|----------|------|
| P1 | `overlay/FloatingPetService.kt` | `overlay/FloatingPetServiceTest.kt` | Robolectric 或提取逻辑到可测类 |
| P1 | `notification/ApprovalReceiver.kt` | `notification/ApprovalReceiverTest.kt` | Robolectric BroadcastReceiver |
| P2 | `overlay/FloatingPetView.kt` | `overlay/FloatingPetViewTest.kt` | 提取逻辑层，View 层 instrumented test |
| P2 | `overlay/PetBubbleView.kt` | `overlay/PetBubbleViewTest.kt` | 同上 |

### 3.4 Android — UI Compose 层（~5h）

Compose 屏幕测试使用 `createComposeRule()`。

| 优先级 | 源文件 | 测试文件 | 策略 |
|--------|--------|----------|------|
| P1 | `ui/sessions/SessionsScreen.kt` | `ui/sessions/SessionsScreenTest.kt` | 验证列表渲染、点击事件 |
| P1 | `ui/sessions/SessionCard.kt` | `ui/sessions/SessionCardTest.kt` | 验证状态显示 |
| P1 | `ui/sessions/EventTimeline.kt` | `ui/sessions/EventTimelineTest.kt` | 验证事件列表 |
| P1 | `ui/sessions/ApprovalSheet.kt` | `ui/sessions/ApprovalSheetTest.kt` | 验证审批 UI |
| P1 | `ui/sessions/BottomNav.kt` | `ui/sessions/BottomNavTest.kt` | 验证导航项 |
| P2 | `ui/settings/SettingsScreen.kt` | `ui/settings/SettingsScreenTest.kt` | 验证设置项渲染 |
| P2 | `ui/settings/PetSettings.kt` | `ui/settings/PetSettingsTest.kt` | 验证滑块/选择器 |
| P2 | `ui/settings/ConnectionStatusCard.kt` | `ui/settings/ConnectionStatusCardTest.kt` | 验证状态显示 |
| P2 | `ui/settings/NotificationSettings.kt` | `ui/settings/NotificationSettingsTest.kt` | 验证开关 |
| P2 | `ui/settings/LanguageSettings.kt` | `ui/settings/LanguageSettingsTest.kt` | 验证语言切换 |
| P2 | `ui/settings/AboutSection.kt` | `ui/settings/AboutSectionTest.kt` | 验证信息显示 |
| P2 | `ui/settings/DebugLogSection.kt` | `ui/settings/DebugLogSectionTest.kt` | 验证日志显示 |
| P2 | `ui/settings/AccordionSection.kt` | `ui/settings/AccordionSectionTest.kt` | 验证展开/折叠 |
| P3 | `ui/manual/ManualScreen.kt` | `ui/manual/ManualScreenTest.kt` | 验证输入/连接 |
| P3 | `ui/scan/ScanScreen.kt` | `ui/scan/ScanScreenTest.kt` | 验证扫码 UI |
| P3 | `ui/components/PermissionDialog.kt` | `ui/components/PermissionDialogTest.kt` | 验证对话框 |
| P3 | `ui/components/ClawdIcons.kt` | `ui/components/ClawdIconsTest.kt` | 验证图标渲染 |

### 3.5 Android — 不需要测试的文件（~0h）

以下文件为纯 UI 壳或 Android 框架入口，测试成本高于收益：

| 文件 | 原因 |
|------|------|
| `ClawdApp.kt` | Application 子类，只有初始化代码 |
| `MainActivity.kt` | Activity，只有 Compose 入口设置 |
| `ui/theme/Color.kt` | 纯颜色常量定义 |
| `ui/theme/Theme.kt` | 纯 Compose Theme 函数 |
| `ui/theme/Type.kt` | 纯字体定义 |
| `ui/navigation/NavGraph.kt` | 纯路由定义 |

**策略：** 这些文件标记为 `@Suppress("UnnecessaryAbstractClass")` 或在覆盖率配置中排除。目标是 **逻辑代码 100% 覆盖**，而非文件数 100%。

### 3.6 桌面端 — 补全缺失测试（~3h）

| 优先级 | 源文件 | 测试文件 | 复杂度 |
|--------|--------|----------|--------|
| P0 | `mobile-ws-server.js` | `test/mobile-ws-server.test.js` | 中 — WS 服务器核心 |
| P0 | `state-session-dedupe.js` | `test/state-session-dedupe.test.js` | 低 — 纯逻辑 |
| P0 | `server-agent-id.js` | `test/server-agent-id.test.js` | 低 |
| P1 | `settings-i18n.js` | `test/settings-i18n.test.js` | 中 — 字符串完整性 |
| P1 | `settings-tab-mobile.js` | `test/settings-tab-mobile.test.js` | 中 |
| P1 | `settings-ui-core.js` | `test/settings-ui-core.test.js` | 中 |
| P1 | `settings-theme-importer.js` | `test/settings-theme-importer.test.js` | 中 |
| P2 | `doctor-detectors/theme-health.js` | `test/doctor-theme-health.test.js` | 低 |
| P2 | `doctor-detectors/openclaw-entry-validator.js` | `test/doctor-openclaw-validator.test.js` | 低 |
| P2 | `hardware-buddy-settings.js` | `test/hardware-buddy-settings.test.js` | 低 |
| P2 | `mac-window.js` | `test/mac-window.test.js` | 中 — 平台相关 |
| P2 | 其余 8 个 settings-tab-*.js | 对应 test 文件 | 中 — UI 逻辑提取后可测 |

**Preload 脚本（7 个）：** 这些是 Electron IPC 桥接层，纯薄封装。策略是提取 IPC handler 到独立函数后测试，或在覆盖率配置中排除。

---

## 阶段四：上游同步能力（~5h）

> 目标：上游同步评分从 5.0/10 提升到 ≥7.0/10。

### 4.1 建立上游同步流程（~2h）

**步骤：**
1. 添加上游 remote：
   ```bash
   git remote add upstream https://github.com/rullerzhou-afk/clawd-on-desk.git
   ```
2. 创建同步脚本 `scripts/sync-upstream.sh`：
   ```bash
   #!/bin/bash
   git fetch upstream
   git checkout main
   git merge upstream/main --no-edit
   # 如果有冲突，暂停并提示
   ```
3. 在 `MODIFICATIONS.md` 中记录每个被修改的上游文件的原因和预期生命周期

### 4.2 创建上游兼容性测试（~2h）

**步骤：**
1. 为每个被修改的上游文件创建兼容性测试：
   - `test/compat-server.test.js` — 验证 `server.js` 的 mobile 扩展点签名不变
   - `test/compat-main.test.js` — 验证 `main.js` 的回调钩子签名不变
   - `test/compat-server-route-state.test.js` — 验证 state 路由的回调签名不变
   - `test/compat-state.test.js` — 验证 `onSessionRemoved` 钩子签名不变
2. 每个测试的模式：
   ```js
   test("server.js addPendingPermission signature compatibility", () => {
     // 验证函数接受预期的参数数量和类型
     // 如果上游改了签名，这个测试会失败
   });
   ```

### 4.3 创建 Fork Diff 审查清单（~1h）

**步骤：**
1. 创建 `docs/fork-diff-audit.md`，列出每个被修改的上游文件：
   - 修改原因
   - 修改行数
   - 隔离状态（已隔离 / 待隔离）
   - 上游合并时需要检查的点
2. 每次上游同步后按此清单审查

---

## 执行顺序和依赖关系

```
阶段一 (SSE 清理)           ──── 无依赖，立即开始
  │
  ├─ 1.1 变量重命名
  ├─ 1.2 测试文件重命名
  ├─ 1.3 移除依赖
  └─ 1.4 文档清理
  │
  ▼
阶段二 (Fork 隔离)           ──── 依赖阶段一完成（命名一致性）
  │
  ├─ 2.1 提取 server.js      ─┐
  ├─ 2.2 消除 monkey-patch    ├─ 按顺序执行，因为 2.2 依赖 2.1 的模块
  ├─ 2.3 提取广播逻辑        ─┘
  ├─ 2.4 提取 settings        ── 可与 2.1-2.3 并行
  ├─ 2.5 Feature Flag         ── 依赖 2.1-2.3
  └─ 2.6 清理剩余改动
  │
  ▼
阶段三 (测试覆盖)            ──── 依赖阶段二（隔离后的代码更易测试）
  │
  ├─ 3.1 Android 纯逻辑      ── 可立即开始
  ├─ 3.2 Android Manager/VM   ── 依赖 3.1
  ├─ 3.3 Android Service      ── 可与 3.2 并行
  ├─ 3.4 Android UI Compose   ── 可与 3.2 并行
  ├─ 3.5 排除不可测文件
  └─ 3.6 桌面端补全
  │
  ▼
阶段四 (上游同步)            ──── 依赖阶段二（隔离后才好同步）
  │
  ├─ 4.1 同步流程
  ├─ 4.2 兼容性测试
  └─ 4.3 审查清单
```

---

## 验收标准

| 阶段 | 验收条件 |
|------|----------|
| 阶段一 | `grep -ri "sse" android/app/src/ --include="*.kt"` 返回 0 结果；`okhttp-sse` 从依赖中移除；`./gradlew test` 通过 |
| 阶段二 | 被修改的上游文件从 19 个减少到 ≤5 个（`state.js` 钩子 + 少量不可避免的改动）；`main.js` 无 monkey-patch |
| 阶段三 | Android 逻辑代码行覆盖率 ≥70%（`./gradlew jacocoTestReport`）；桌面端所有非 UI 封装模块有测试 |
| 阶段四 | `git merge upstream/main` 可自动完成无冲突；兼容性测试全部通过 |

---

## 工时估算汇总

| 阶段 | 任务数 | 预估工时 |
|------|--------|----------|
| 阶段一：SSE 清理 | 4 | ~3h | ✅ 100% |
| 阶段二：Fork 隔离 | 6 | ~12h | ⚠️ 40% |
| 阶段三：测试覆盖 | 6 | ~20h | ⚠️ 15% |
| 阶段四：上游同步 | 3 | ~5h | ⚠️ 30% |
| **合计** | **19** | **~40h** | **~45%** |

---

## 附加工作：质量提升（2026-06-18）

**Spec**：`docs/plans/PLAN-quality-improvement.md`

**完成内容**：
- 修复 14 个测试失败 → 0 失败（5326 pass）
- 恢复 CI 自动触发（push + pull_request）
- 修复 ADMIN_TOKEN 安全漏洞
- 添加 LICENSE、CONTRIBUTING.md、docs/README.md
- 添加缺失 i18n keys（doctorAgentSummaryNoneActive、sessionHudSummaryContextUsage、agentIntegrationUninstallConfirm、rowAutoApproveAll 等）
- 清理 CSS（移除 size-bubble、size-ticks、size-slider-wrap）
- 补充 CSS（text-scale-readout、row-label-danger、volume-slider hover、prefers-reduced-motion）
- loadMobileState 异常日志

**预期评分提升**：74 → 83（+9）

---

## 附加工作：新功能开发（2026-06-18）

在执行技术债务计划的同时，完成了两个新功能的开发：

### 浮窗审批（PLAN-floating-approval.md）✅ ~99% 完成

**新增文件：**
- `overlay/ApprovalBubbleView.kt` — 审批气泡视图（337 行）
- `overlay/PetApprovalBubbleManager.kt` — 审批气泡管理器（420 行）

**修改文件：**
- `service/WsConnectionService.kt` — 新增 `approvalCompletedFlow`
- `notification/ApprovalWorker.kt` — emit 审批完成信号
- `overlay/FloatingPetService.kt` — 集成审批气泡管理器

**实现功能：**
- 小气泡提示 → 点击展开 → 滑动审批（50dp 阈值）
- FIFO 自动推进、倒计时、通知同步
- suggestionIndex 传递、角标数量
- elicitation 跳转 App
- 双 client 审批收集（LAN + Relay）

### 远程中继（PLAN-remote-relay.md）✅ ~95% 完成

**新增文件：**
- `relay/relay-server.js` — 生产级 relay server（378 行）
- `relay/deploy-relay.sh` — 一键部署脚本（178 行）
- `relay/Dockerfile` + `docker-compose.yml` + `nginx.conf`
- `relay/package.json`
- `src/relay-bridge-integration.js` — PC 端 bridge（299 行）
- `ws/ConnectionStrategy.kt` — 连接策略接口（61 行）
- `ws/SessionMerger.kt` — 双连接会话合并（120 行）
- `ui/settings/RelaySettings.kt` — Android Relay 设置 UI（140 行）

**修改文件：**
- `src/server.js` — relay bridge 初始化
- `src/settings-tab-mobile.js` — Relay 配置区域
- `src/mobile-i18n.js` — Relay i18n 字符串
- `src/prefs.js` — Relay 配置项
- `data/ConnectionConfig.kt` — 新增 relayUrl/relayToken/useRelay 字段
- `data/PrefsStore.kt` — Relay 配置持久化
- `ws/WsClient.kt` — 支持 ConnectionStrategy
- `ws/MessageParser.kt` + `MessageHandler.kt` + `ParsedMessage.kt` — peer 消息解析
- `service/WsConnectionService.kt` — 双连接管理 + SessionMerger
- `ui/settings/SettingsScreen.kt` — Relay AccordionSection
- `ui/sessions/SessionsScreen.kt` — 使用 mergedSessions
- `ui/sessions/SessionsViewModel.kt` — 支持 SessionMerger
- `ui/navigation/NavGraph.kt` — 传递 SessionMerger

**实现功能：**
- Relay Server 生产级改造（noServer + REST API + 限流 + TLS）
- Docker/systemd 一键部署
- PC 端 bridge 集成（指数退避重连）
- Android ConnectionStrategy 双连接架构
- SessionMerger 双连接会话合并
- RelaySettings UI（含状态检查）
- peer 消息解析 + relay 断线处理

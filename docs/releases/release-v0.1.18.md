# 🦀 Clawd Mobile v0.1.18

安卓移动端 + 桌面端联动更新。

## 📱 Android

### 通知系统重构
- 审批通知与 Elicitation 通知分离，互不干扰
- StatusNotifier 支持 per-session badge 追踪，精确触发完成/失败通知
- 通知 ID 采用确定性哈希，避免 PendingIntent 冲突

### 审批体验优化
- 通知栏点击可恢复被自动关闭的审批请求
- 支持从通知 Intent 直接还原完整请求数据，Activity 重建不丢失

### 桌宠状态机
- `consumedDoneSessions` 确保 Attention 动画只触发一次
- 睡眠序列完整对齐 PC 端（yawning → collapsing → sleeping → waking）
- 60 秒 idle 超时自动进入睡眠，与 PC 端 MOUSE_SLEEP_TIMEOUT 一致

### 连接与安全
- EncryptedSharedPreferences（AES-256-GCM）加密存储，自动从明文迁移
- OkHttpClient 全局共享单例，连接池复用
- proguard 补充 Tink/安全库混淆规则

### 构建
- 补全 `values-zh` 翻译缺失（修复 138 个 lint MissingTranslation 错误）
- lint 配置优化，忽略 `UnsafeImplicitIntentLaunch`（Receiver 已设置 exported=false）

## 🖥️ Server

### Badge 逻辑修复
- oneshot hookState（attention / error / notification）优先于 sessionState idle 判断
- 修复当 session 状态折叠为 idle 但 hookState 为 attention 时，badge 错误显示为 idle 而非 done 的问题

### 空安全
- `session !== null` 改为 `session != null`，覆盖 `Map.get()` 返回 undefined 的场景

## 🍎 Desktop

- dock 图标更新为高清透明背景螃蟹脸
- 清理一次性 `extract-dock-icon` 脚本

## 📦 下载

| 平台 | 文件 |
|------|------|
| Android | `clawd-mobile-0.1.18.apk` |
| Windows | `Clawd-on-Desk-Setup-0.8.1-x64.exe` / `arm64.exe` |
| macOS | `Clawd-on-Desk-0.8.1-x64.dmg` / `arm64.dmg` |
| Linux | `Clawd-on-Desk-0.8.1-x86_64.AppImage` / `amd64.deb` |

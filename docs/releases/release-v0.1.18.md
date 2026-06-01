# Clawd Mobile v0.1.18

## Android

- 补全 values-zh 翻译缺失，修复 lint MissingTranslation 138 errors
- lint 配置：忽略 UnsafeImplicitIntentLaunch（ApprovalReceiver exported=false）
- HttpClientProvider 共享 OkHttpClient 单例
- 审批通知：elicitation 分离，notification ID 偏移防冲突
- StatusNotifier：per-session badge 跟踪，done/interrupted 精确通知
- ApprovalViewModel：恢复被 dismiss 的请求，通知 tap 透传
- PetStateManager：consumedDoneSessions 单次触发，睡眠序列对齐 PC
- PrefsStore：EncryptedSharedPreferences 迁移逻辑
- proguard：补充 Tink/EncryptedSharedPreferences 规则

## Server

- badge 逻辑修复：oneshot hookState（attention/error/notification）优先于 sessionState idle 判断
- session null safety：`!== null` 改为 `!= null` 覆盖 undefined 场景

## Desktop

- dock 图标更新为高清透明背景版本
- 删除一次性 extract-dock-icon 脚本

## CI/CD

- GitHub Actions 构建配置更新
- 全平台构建通过（Windows/Mac/Linux/Android）

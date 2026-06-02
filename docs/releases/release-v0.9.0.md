## v0.9.0

### Overview

v0.9.0 是一个以 **Android 安全加固 + 质量提升 + 全量测试覆盖** 为核心的大版本。本次更新涵盖 Android 端 P0/P1/P2 三阶段系统性改进、桌面端 SVG 渲染架构升级、服务端 badge 逻辑修复，以及跨平台 3600+ 自动化测试的全面覆盖。

---

### 🔒 Security (P0 安全加固)

- **WakeLock 超时保护** — `WebSocketService` 的 WakeLock/WifiLock 添加 1 小时超时安全网，防止因 `onDestroy()` 未调用导致的永久持锁
- **ApprovalReceiver goAsync()** — 审批广播接收器改用 `goAsync()` + 协程，替代裸 Thread，解决进程被杀后请求静默丢失的问题
- **HttpClientProvider 线程安全** — `getClient()` 添加 `synchronized`，防止并发场景下创建多个 OkHttpClient 实例
- **allowBackup=false** — 禁止 ADB 备份应用数据
- **WebView 安全加固** — 禁用 `setAllowFileAccess`、`setAllowContentAccess`、`setJavaScriptEnabled`（默认关闭）
- **EncryptedSharedPreferences** — 敏感配置（token、连接信息）改用加密存储
- **SSE TLS 分级** — 公网连接强制 HTTPS，LAN 连接保留 HTTP

### 🛠 Improvements (P1 短期改进)

- **SafeExecutor 分级异常处理** — 区分可恢复/不可恢复异常，减少无用日志噪音
- **assetExists 真实检查** — SVG/APNG 资源存在性检查改为实际文件系统验证，回退链真正生效
- **onend 精确检测** — 动画结束事件使用精确匹配，避免误触发
- **PrefsStore 统一读写** — Pet 配置读写收敛到单一入口，消除散落的 SharedPreferences 调用
- **HTTP Client 统一** — 全局复用单一 OkHttpClient 实例，减少连接泄漏
- **Auth Header 规范化** — SSE/WebSocket 连接统一使用 `Authorization: Bearer` 头
- **证书固定** — 公网 SSE 连接添加证书固定，防止中间人攻击

### 🏗 Architecture (P2 质量提升)

- **SessionsScreen 拆分** — 902 行巨型文件拆分为 6 个职责清晰的模块
- **PermissionDialog 抽取** — 审批对话框独立为可复用组件
- **FloatingPetService 拆分** — 悬浮宠物服务按职责拆分为状态管理、渲染、交互三个模块
- **事件驱动架构** — 状态变更改用事件总线，消除轮询和手动同步
- **模板抽取** — SVG/APNG HTML 模板独立为 asset 文件，便于维护和测试
- **缓存上限** — 添加 LRU 缓存上限，防止内存无限增长
- **优先级统一** — 通知/审批/状态优先级使用统一枚举，消除魔法数字

### 🖥 Desktop

- **SVG overlay 渲染** — 悬浮宠物从 GIF 升级为 SVG/APNG WebView 渲染，支持透明背景和矢量缩放
- **Mac dock 图标** — 新增透明背景螃蟹脸 dock 图标
- **桌面端全量测试** — 新增 508 个测试，覆盖组件、路由、图标、状态管理
- **SvgLoader tier 逻辑修复** — 资源加载优先级链（SVG → APNG → fallback）正确回退

### 📱 Mobile (Server)

- **badge 逻辑修复** — oneshot hookState 优先于 sessionState idle 判断，修复 badge 状态不一致
- **SSE 路由匹配修复** — `req.url` 包含 query string 时正确匹配路由
- **SSE 连接日志增强** — doConnect/onOpen/onFailure 全链路可追踪
- **审批面板 UI** — Allow/Deny 按钮始终可见，suggestion 标签中文翻译
- **QR 解码异常日志** — 增加异常类名，便于定位解码失败原因
- **底部面板自动展开** — 收到审批请求时自动展开面板

### 🧪 Testing

- **Server 测试** — 130 个测试，覆盖 hook-parser、routes、middleware、db migration
- **Desktop TypeScript 测试** — 166 个测试，覆盖 router、components、icons、toast
- **Desktop Rust 测试** — 14 个测试，覆盖 router 编译、端口绑定、状态创建
- **Android 测试** — 197 个测试，覆盖 Repository、ViewModel、DTO、Entity、Domain Model
- **总计 3600+ 测试**，全平台通过

### 📝 Docs

- **STATE_MACHINE.md** — Agent 状态机单一事实来源文档
- **CONTRIBUTING.md** — 中文贡献指南，涵盖 setup、构建、测试、commit 规范
- **Android 分阶段计划** — P0 安全/P1 短期/P2 质量/P3 架构完整计划文档
- **architecture.md 更新** — 状态机图表更新，添加迁移策略说明

### ⚡ Performance

- **N+1 查询优化** — `enrichAgent()` 从 3N 查询重写为 1 查询 + 子查询
- **Database Migration** — Server/Desktop 添加基于 `user_version` 的迁移框架
- **WAL 模式** — 确认全平台 SQLite 使用 WAL 模式

### 🔧 CI/CD

- **GitHub Actions 更新** — Node.js 24、upload-artifact v7、gradlew executable 修复
- **Android 签名** — 签名密钥从硬编码改为 `local.properties` 读取
- **自动构建触发** — tag push 自动触发 Windows/macOS/Linux/Android 全平台构建

---

### Upgrade Notes

- **Android 签名配置迁移** — 如果你本地构建 Android，请创建 `android/local.properties` 并填入 `STORE_PASSWORD` 和 `KEY_PASSWORD`（参考 `android/local.properties.example`）
- **Database 自动迁移** — Server 和 Desktop 首次启动时自动执行数据库迁移（v1 → v2），添加 `idx_agents_status` 索引，无需手动操作
- **SSE 认证变更** — EventSource 连接现在支持 `?token=` query 参数（除 Bearer header 外），Android/Web 客户端已自动适配
- **/api/config 远程模式** — 远程模式下 `/api/config` 不再返回 token，仅返回 `{mode, port}`
- **状态机统一** — ERROR 状态现在允许恢复到 IDLE/RUNNING（之前 ERROR 是终态），三个平台行为已统一

---

### Known Limitations

- **ESLint 配置格式** — Server 端使用 ESLint v9，需要从 `.eslintrc.json` 迁移到 `eslint.config.js`（flat config），本次未处理
- **macOS/Linux 实机测试** — CI 构建产物可用，但 Windows 仍是主要验证环境
- **Remote SSH 终端聚焦** — 远程会话支持状态和权限透传，但终端聚焦仅限本地

---

### Contributors

- **@rullerzhou-afk** — Android 系统性评估、分阶段改进计划、P0/P1/P2 实施、全量测试、桌面端 SVG 架构
- **@Ruller_Lulu** — Server badge 修复、SSE 路由修复、桌面端组件测试、编译验证

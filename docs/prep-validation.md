# 移动端伴侣开发前验证报告

## 环境信息
- Node.js 版本: v24.11.1
- 操作系统: Windows 11 Pro (10.0.22631)
- 仓库分支: feat/mobile-companion-prep
- 仓库来源: zip 下载 (GitHub: rullerzhou-afk/clawd-on-desk)

## 现有代码分析

### HTTP 服务器 (`src/server.js`)
- 创建方式: `http.createServer` (原生 Node.js HTTP)
- 监听地址: `127.0.0.1:23333` (端口范围 23333-23337)
- `httpServer` 是 `startHttpServer()` 内的局部变量，未暴露到外部
- 路由:
  - `GET /state` → 健康检查 (`sendStateHealthResponse`)
  - `POST /state` → 状态更新 (`handleStatePost`)
  - `POST /permission` → 权限请求 (`handlePermissionPost`)
  - 其他路径 → 404
- 无 WebSocket 实现
- 集成点: 需在 `startHttpServer()` 中 `httpServer.listen()` 之前挂载 WS

### 状态路由 (`src/server-route-state.js`)
- `handleStatePost` 解析 JSON body (上限 4096 bytes)
- 校验 state 合法性 (`ctx.STATE_SVGS[state]`)
- 更新状态: `ctx.updateSession(sid, state, event, {...})` 或 `ctx.setState(state, svg)`
- 无广播机制 — 需在成功处理后添加 WS 广播调用

### Hook 脚本 (`hooks/clawd-hook.js`)
- 事件 → 状态映射 (`EVENT_TO_STATE`): idle/thinking/working/attention/error/juggling/sweeping/carrying/sleeping/notification
- 通过 `postStateToRunningServer()` 发送到本地 HTTP 服务器
- 无移动端输出逻辑

### 服务器配置 (`hooks/server-config.js`)
- 端口: 23333-23337
- Runtime config: `~/.clawd/runtime.json`
- HTTP 超时: 100ms (本地), 5000ms (远程)

### 现有依赖 (`package.json`)
- `electron-updater`, `htmlparser2`, `koffi` (运行时)
- `electron`, `electron-builder` (开发时)
- **未安装**: `ws`, `bonjour`

## WebSocket 原型测试
- 创建了 `test/prep-ws-echo.js` — 独立 HTTP+WS 回声服务器
- 使用端口 23338 (23333 被 Clawd 应用占用)
- 路径: `/test-ws`
- 测试结果:
  - WebSocket 连接成功
  - 收到 "Ready" 消息
  - 发送 "Hello from test client" 后收到 "Echo: Hello from test client"
  - HTTP `/state` 端点在 WS 旁边正常工作
- **结论**: `ws` 库可正常挂载到 `http.createServer` 实例上

## mDNS 广播测试
- 创建了 `test/prep-mdns-test.js` — 使用 `bonjour` 库发布和发现服务
- 服务名: "Clawd Desktop Test", 类型: `_clawd._tcp`, 端口: 23338
- 测试结果:
  - 服务发布成功
  - 自发现成功: `Found service: Clawd Desktop Test at DESKTOP-85FRS4T:23338`
- **结论**: `bonjour` 库在 Windows 上正常工作

## 阻塞问题
- 无

## 下一步
- 开始 Task 1: 创建 `src/mobile-ws-server.js` (MobileWSServer 类)
- 集成 WebSocket 到 `src/server.js`
- 添加 Token 鉴权
- 添加 mDNS 广播
- 开发 PWA 和安卓客户端

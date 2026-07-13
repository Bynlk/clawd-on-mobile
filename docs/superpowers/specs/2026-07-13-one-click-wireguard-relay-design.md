# 一键 WireGuard Relay 设计

> 状态：设计已确认，待实施
> 日期：2026-07-13
> 分支：`codex/one-click-wireguard-relay`

## 1. 目标

把现有 WireGuard Relay 骨架补成用户可直接使用的完整功能：

1. 首次在 PC 填写公网 IP、SSH 用户名、SSH 端口和密码，点击一次完成 VPS 部署。
2. Android 扫描 PC 显示的二维码后自动保存配置并完成配对。
3. 后续 PC 和 Android 各自点击一次“远程连接”，同时启动本地 WireGuard 隧道与 Relay WebSocket。
4. VPS 上的 WireGuard、Relay 和管理接口由 systemd 长期运行，部署成功后日常使用不再连接 SSH。
5. 重新配对另一台手机时，旧手机的 WireGuard Peer 和 Relay Token 立即失效。
6. 用户不需要安装 WireGuard App、命令行工具或其他额外软件。

一台 1 核、2 GB 内存、40 GB 存储、每月 1024 GB 流量的 Linux VPS 足够运行单用户 Relay。常态资源预计低于 200 MB 内存和 1 GB 磁盘；实际流量由同步的 Agent 内容量决定。

## 2. 范围

### 2.1 本次必须完成

- PC 一键密码 SSH 部署，始终显示 SSH 用户名和端口。
- SSH 首次连接的 TOFU 主机指纹确认与后续固定校验。
- VPS 安装 WireGuard、Node.js、Relay 程序及其 Node 依赖。
- VPS systemd 服务、最小防火墙开放和幂等修复/重部署。
- PC 配置及密钥安全持久化，重启 Clawd 后无需重新部署。
- PC 内置、免管理员权限、跨 Windows/macOS/Linux 的用户态 WireGuard 转发。
- Android 内嵌 WireGuard `VpnService`，且只代理 Clawd Mobile 自身流量。
- 二维码配对、Android 加密持久化、连接/断开状态与错误提示。
- 仅通过 WireGuard 内网访问的管理 API，用于免 SSH 重新配对。
- PC 和 Android 的连接顺序、超时、回滚和手动重连。
- 首版只允许一台 Android 手机。

### 2.2 明确不做

- 不提供托管 Relay；VPS 由用户自己拥有和维护。
- 不让网站或第三方服务接触 VPS、密钥、Token 或会话内容。
- 不在 Relay 层增加 TLS 或第二层内容加密；WireGuard 已提供传输加密与对端认证。
- 不代理 Android 上其他 App 的流量。
- 不支持多手机同时在线。
- 不保存 Agent 会话内容到 VPS；Relay 只做内存中的实时转发。
- 不在系统重启后自动打开 PC/Android 本地隧道；用户仍需点击“远程连接”。
- 不通过公网暴露 Relay 或管理 HTTP 端口。

## 3. 总体架构

```text
Android App
  WireGuard GoBackend + VpnService
  IncludedApplications=com.clawd.mobile
          │ UDP 51820
          ▼
Linux VPS
  wg-quick@clawd.service       10.8.0.1/24
  clawd-relay.service          10.8.0.1:7891
  Relay WebSocket + 内网管理 API
          ▲
          │ UDP 51820
PC Clawd
  内置 clawd-wg-tunnel sidecar
  本地 127.0.0.1 随机端口 → 10.8.0.1:7891
  RelayBridge → 本机 Mobile WebSocket Server
```

VPS 只从公网开放 SSH 端口和 WireGuard UDP 端口。Relay 的 WebSocket、健康检查和管理 API 只监听 `10.8.0.1:7891`。日常连接不需要启动或停止 VPS 服务；“远程连接”只控制 PC/Android 本地隧道与 WebSocket。

### 3.1 为什么 PC 使用内置用户态 sidecar

现有 `wg-pc-tunnel.js` 依赖系统 TUN、提权和平台 WireGuard 二进制，当前仅 Linux 路径完整，无法满足“用户不安装额外软件”和跨平台一致的一键体验。新路径增加一个随应用打包的 Go sidecar：

- 使用 `wireguard-go` 的 userspace netstack 建立 WireGuard Peer。
- 只把本机 `127.0.0.1:<随机端口>` 的 TCP 流量转发到 `10.8.0.1:7891`。
- 不创建系统 VPN、不改系统路由、不请求管理员权限。
- Windows、macOS、Linux 共用同一协议与生命周期。
- 配置通过 stdin 传入，stdout 只输出脱敏 JSON 状态，不把私钥写入临时文件。

现有桌面隧道模块保留用于兼容旧代码；一键连接改走 sidecar 后端。

### 3.2 Android 内置 WireGuard

Android APK 引入官方 `com.wireguard.android:tunnel` 库并使用 `GoBackend`。生成配置时在 `[Interface]` 写入：

```ini
IncludedApplications = com.clawd.mobile
```

官方后端会调用 `VpnService.Builder.addAllowedApplication()`，因此只有 Clawd Mobile 的 Relay 请求进入隧道。首次连接由 Android 系统弹出一次 VPN 授权；以后无需外部 WireGuard App。

## 4. 首次部署流程

### 4.1 PC 设置页

Settings 中保留独立的“远程连接”页，首次状态只显示四个必填字段：

- 公网 IP 或域名
- SSH 用户名，默认 `root`
- SSH 端口，默认 `22`
- SSH 密码，仅本次部署使用

主按钮为“一键部署”。WireGuard UDP 端口、内网段和 Relay 端口使用固定默认值 `51820`、`10.8.0.0/24`、`7891`，放在“重新部署/高级设置”中，首次流程不要求用户理解这些参数。

部署进度按以下阶段显示：

1. 连接 VPS
2. 确认 SSH 指纹
3. 上传 Relay 文件
4. 安装系统依赖
5. 配置 WireGuard
6. 配置 systemd 与防火墙
7. 启动并验证服务
8. 保存 PC 配置
9. 启动 PC 隧道
10. 生成 Android 配对二维码

SSH 密码只保存在部署调用的内存对象中，成功或失败后立即覆盖并删除。密码不进入 prefs、日志、进度事件、崩溃报告或二维码。

### 4.2 SSH 与上传

- 密码认证使用现有 `ssh2` 依赖，不调用外部 `sshpass`。
- `root` 用户直接执行安装器；普通用户使用同一 SSH 密码执行 `sudo -S -p '' bash`。
- 首次遇到未知主机密钥时显示 SHA-256 指纹确认框；接受后把指纹保存到 profile。
- 已保存指纹发生变化时停止部署，明确提示可能是 VPS 重装或中间人攻击。用户必须删除旧指纹并重新确认，不能自动覆盖。
- 在同一个 SSH 连接中通过 SFTP 上传安装脚本、Relay 源码、管理模块、`pair-registry.js` 和随桌面应用打包的 `ws` 依赖，然后执行安装器。
- 部署不依赖 VPS 上预先存在的 Git、Docker、npm 或项目仓库。

### 4.3 VPS 安装结果

安装器支持 apt、dnf、yum，并要求 systemd。它必须幂等，重复执行时复用服务器和 PC 密钥，除非执行“重新部署并重置全部密钥”。

固定目录：

```text
/opt/clawd-relay/app/                 Relay 程序和 Node 依赖
/etc/clawd-relay/relay.env            Relay/管理 Token，权限 0600
/etc/wireguard/clawd.conf             WireGuard 配置，权限 0600
/etc/wireguard/clawd/*.key            服务端、PC、手机密钥，权限 0600
/etc/systemd/system/clawd-relay.service
```

服务：

- `wg-quick@clawd.service`：开机启动并保持 WireGuard 接口。
- `clawd-relay.service`：依赖 WireGuard，绑定 `10.8.0.1:7891`，失败自动重启。

防火墙只新增 `51820/udp`。安装器不打开 `7891/tcp`。云厂商安全组不受 VPS 内脚本控制；若握手超时，UI 明确提示用户在云控制台放行所选 UDP 端口。

配置文件先写临时文件、验证后原子替换。修复/重部署失败时保留上一份可工作的配置和服务。

### 4.4 部署回传

安装器通过带边界标记的 JSON 回传：

```json
{
  "schemaVersion": 1,
  "endpoint": "203.0.113.10:51820",
  "subnet": "10.8.0.0/24",
  "relayUrl": "ws://10.8.0.1:7891",
  "pcConfig": "<wg-quick text>",
  "phoneConfig": "<wg-quick text>",
  "relayToken": "<random 256-bit token>",
  "managementToken": "<random 256-bit token>"
}
```

stdout/stderr 日志不能包含任何私钥或 Token。PC 解析后先安全保存，再清空原始回传缓冲区。

## 5. 配置与密钥存储

### 5.1 PC

公开 profile 继续通过 `prefs.js` 和 settings controller 保存，字段包括 VPS 地址、用户名、端口、WireGuard 端口、内网段、SSH 指纹、部署版本和最近部署时间。

以下内容进入独立 `wg-relay-secret-store.js`：

- PC WireGuard 私钥和完整配置
- 当前手机 WireGuard 配置，用于再次显示二维码
- Relay Token
- 管理 Token

秘密值先用 Electron `safeStorage.encryptString()` 加密，再写入 `app.getPath("userData")/wg-relay-secrets.json`。文件使用仅当前用户可读写的权限。Linux 若 Electron 只提供 `basic_text` 或无法加密，则拒绝持久化并中止部署收尾，不回退为明文。

### 5.2 Android

二维码中的 WireGuard 配置和 Relay Token 由现有 `EncryptedSharedPreferences` 保存，底层主密钥由 Android Keystore 管理。日志、通知、Compose state 的 `toString()` 均不得输出私钥或完整 Token。

## 6. 二维码配对

### 6.1 二维码格式

使用版本化 deep link：

```text
clawd://relay-pair?v=1&data=<base64url(JSON)>
```

JSON 内容：

```json
{
  "version": 1,
  "name": "My VPS",
  "wireGuard": {
    "privateKey": "...",
    "address": "10.8.0.3/32",
    "serverPublicKey": "...",
    "endpoint": "203.0.113.10:51820",
    "allowedIps": ["10.8.0.0/24"],
    "persistentKeepalive": 25
  },
  "relay": {
    "url": "ws://10.8.0.1:7891",
    "token": "..."
  },
  "issuedAt": 1783900800000
}
```

Android 解析器限制 deep link 总长度、只接受 `version=1`、合法 WireGuard key、合法 CIDR、单个私网 `/24` 路由、单个 Relay 内网 URL 和有效端口。扫描成功后覆盖旧的远程配置并显示 VPS 名称，不自动把二维码内容写入普通连接历史。

### 6.2 首次连接

扫描成功后 Android 显示“已配对，连接到远程 VPS”。用户点击一次“远程连接”：

1. 请求系统 VPN 权限；已授权则跳过。
2. 启动 WireGuard tunnel。
3. 等待后端进入 UP，并在 15 秒内观察到有效握手或可访问 Relay 健康检查。
4. 请求 `http://10.8.0.1:7891/health`。
5. 建立 Relay WebSocket。
6. WebSocket 完成认证后状态变为“远程已连接”。

任一步失败都关闭 WebSocket 和 tunnel，状态显示失败阶段与可执行建议。Android 重启后保留配对配置，但不自动开启 VPN。

## 7. 日常连接

### 7.1 PC

部署成功后的设置页收敛为一张状态卡：

- VPS 名称与公网 IP
- `未连接 / 启动隧道 / 验证 Relay / 已连接 / 连接失败`
- 主按钮：`远程连接` 或 `断开远程连接`
- 次要操作：`显示配对二维码`、`重新配对手机`、`修复/重新部署`、`删除配置`

点击“远程连接”后：

1. 从安全存储读取 PC 配置和 Token。
2. 启动 `clawd-wg-tunnel` sidecar。
3. 等待 sidecar 报告 WireGuard 就绪和本地转发端口。
4. 通过本地转发端口访问 VPS `/health`。
5. RelayBridge 连接同一本地端口，并连接本机 Mobile WebSocket Server。
6. 两端都就绪后显示“已连接”。

点击断开时先停止 RelayBridge，再停止 sidecar。任何异常退出都清理子进程、定时器和内存秘密。应用重启后不自动连接。

### 7.2 Android

Android 远程连接开关只控制 Relay client 与 WireGuard VPN，不影响现有 LAN client。LAN 与 Relay 可同时连接，现有 `SessionMerger` 继续按来源合并会话。

网络从 Wi-Fi 切到蜂窝数据时，WireGuard 的 `PersistentKeepalive=25` 和现有网络监听触发 Relay 重连；不要求重新扫描二维码。

## 8. 免 SSH 重新配对

Relay 进程同时提供仅内网可达的管理接口：

```text
GET  /api/manage/status
POST /api/manage/phone/rotate
```

管理接口必须同时满足：

1. 请求来自 PC WireGuard 地址 `10.8.0.2`。
2. `Authorization: Bearer <managementToken>` 正确。
3. 请求体通过大小、类型和版本校验。

`phone/rotate` 在 VPS 上按原子顺序执行：

1. 生成新手机 WireGuard 密钥对。
2. 更新持久 `clawd.conf`。
3. 用 `wg set` 删除旧手机 Peer 并加入新 Peer。
4. 生成新 Relay Token，原子更新 `relay.env` 与进程内 token。
5. 断开使用旧 Token 的 PC/手机 WebSocket。
6. 返回新手机配置和新 Relay Token给 PC。
7. PC 加密保存新 Token，重连 Relay，并生成新二维码。

只要第 1 至 4 步没有全部成功，就不提交轮换；旧配置继续工作。成功后旧手机同时失去 WireGuard Peer 和 Relay Token，即使保存了旧二维码也无法连接。日常重新配对不使用 SSH。

## 9. Relay 行为

- Relay 只在内存中维护 PC 与单台 phone 的连接，不写入消息正文。
- 单条消息大小限制与现有 Agent Console 协议保持兼容；不能沿用会截断合法终端事件的过小限制。
- 固定 Relay Token 必须真正校验客户端提交值；不能像现有代码一样把任意提交值替换成固定 token 后直接放行。
- 每个 token 只允许一个 PC 和一个 phone。相同 role 新连接替换旧连接。
- Token 轮换后立即关闭旧 pair。
- `/health` 返回版本、运行时间和就绪状态，但不返回密钥、Token 或会话内容。
- 管理 API 和 WebSocket 共用内网监听端口，不新增公网端口。

## 10. 错误与恢复

### 10.1 部署错误

- SSH 无法连接：显示 IP、端口、云防火墙检查建议。
- 密码错误或禁止密码登录：明确区分认证失败。
- SSH 指纹变化：阻止继续并提供“删除旧指纹后重新确认”。
- 无 root/sudo：提示该 SSH 用户需要 sudo 权限。
- 不支持的系统或无 systemd：停止且不写入“已部署”状态。
- WireGuard UDP 被云安全组拦截：部署成功但连接验证失败，提示放行 UDP。
- 安装中断：再次点击“修复/重新部署”，幂等脚本从现状恢复。

### 10.2 连接错误

- 安全存储缺失或损坏：禁止连接，要求重新部署或从仍有效的 VPS 修复。
- sidecar 启动失败：显示平台、架构和缺失二进制信息。
- WireGuard 无握手：回滚隧道并提示公网 UDP、Endpoint、VPS 服务状态。
- Relay 健康检查失败：回滚并提示修复部署。
- WebSocket 认证失败：回滚并提示 Token 不一致，可执行重新配对或修复。
- Android VPN 权限被拒绝：保持断开，不反复弹系统授权。

## 11. 文件边界

### 11.1 PC/Electron

- `src/wg-relay-secret-store.js`：safeStorage 加密、原子文件持久化和删除。
- `src/wg-relay-bundle.js`：枚举并上传完整 VPS Relay 文件集合。
- `src/wg-relay-deploy.js`：单 SSH 连接的 TOFU、SFTP、sudo、安装和验证编排。
- `src/wg-relay-profile.js`：profile 新字段、迁移与校验。
- `src/wg-relay-connection.js`：sidecar、健康检查、RelayBridge 的连接状态机。
- `src/wg-relay-ipc.js`：deploy/connect/disconnect/rotate/status IPC。
- `src/wg-relay-runtime.js`：状态与进度事件，不再作为唯一秘密存储。
- `src/relay-bridge-integration.js`：支持显式 URL/Token 启停。
- `src/settings-tab-wg-relay.js`：首次向导、部署后状态卡、二维码和恢复操作。
- `src/main.js`、`src/preload-settings.js`、`src/settings-ipc.js`：依赖注入与最小桥接。
- `package.json`、打包脚本和 GitHub Actions：构建并打包 sidecar 与 Relay 资源。

### 11.2 PC sidecar

- `sidecars/wg-relay-tunnel/`：Go module、WireGuard netstack、TCP forwarder、stdin/stdout 协议和单元测试。
- sidecar 产物覆盖 Windows x64/arm64、macOS x64/arm64、Linux x64/arm64；发布包只携带对应平台/架构产物。

### 11.3 VPS

- `relay/install-wg-relay.sh`：幂等安装、原子配置、systemd、防火墙与 readback。
- `relay/relay-server.js`：严格 token 验证、健康检查和管理路由。
- `relay/wg-management.js`：手机 Peer/Token 原子轮换。
- `relay/pair-registry.js`：单 PC/单手机 pair 与立即撤销。
- `relay/package.json`：VPS 运行依赖清单，依赖本身随应用上传。

### 11.4 Android

- `android/gradle/libs.versions.toml`、`android/app/build.gradle.kts`：内嵌 WireGuard tunnel 库。
- `AndroidManifest.xml`：合并/声明 VPN 前台服务所需权限与服务。
- `data/RelayPairingConfig.kt`：版本化二维码模型与严格校验。
- `data/PrefsStore.kt`：加密保存、读取和删除配对配置。
- `vpn/ClawdWireGuardTunnel.kt`：官方 GoBackend 的 Tunnel 实现。
- `vpn/WireGuardController.kt`：VPN 权限、启动、状态、握手与停止。
- `ui/scan/ScanScreen.kt`、`MainActivity.kt`：识别 relay-pair deep link。
- `ui/settings/RelaySettings.kt`：配对信息、远程连接按钮、状态和删除配置。
- `service/WsConnectionService.kt`：按“隧道 → 健康检查 → Relay”顺序连接并回滚。
- `ws/ConnectionStrategy.kt`：Relay URL 走 WireGuard 内网。

## 12. 测试与验收

### 12.1 自动测试

- Node：profile 迁移、safeStorage、秘密不落日志、TOFU、SFTP 清单、sudo、readback、连接状态机、管理 API、Token 轮换、IPC、设置页行为。
- Relay：错误 Token 拒绝、只允许 PC IP 管理、旧 Peer/Token 轮换后失效、消息不落盘、进程重启读取新 Token。
- Go sidecar：配置校验、stdin 秘密协议、TCP 转发、异常退出、跨平台交叉编译。
- Shell：`bash -n`、幂等 fixture、原子替换和 systemd unit 内容测试。
- Android：二维码解析/拒绝、EncryptedSharedPreferences、只包含本 App、VPN 授权状态机、连接顺序、失败回滚、设置 UI ViewModel。
- 构建：`npm test` 相关测试、sidecar `go test ./...`、Android `testDebugUnitTest`、`lintDebug`、`assembleDebug`、Electron 三平台打包配置检查。

### 12.2 必须通过的端到端验收

1. 全新 Linux VPS，仅输入 IP、用户名、端口、密码即可部署成功。
2. VPS 重启后 `wg-quick@clawd` 和 `clawd-relay` 自动恢复。
3. PC 重启 Clawd 后点击一次“远程连接”即可恢复，无 SSH。
4. Android 扫码、授权 VPN、点击一次即可通过蜂窝网络连接。
5. Android VPN 活跃时其他 App 的出口网络不变。
6. Android 能看到 Agent Console 多会话、Thinking、工具调用和结果，并可操作权限与会话。
7. Wi-Fi 与蜂窝切换后无需重新配对。
8. 重新配对后旧手机无法完成 WireGuard 握手，旧 Relay Token 也被拒绝。
9. VPS 公网扫描只能看到用户原有 SSH 端口和 WireGuard UDP 端口，看不到 Relay TCP 端口。
10. 删除 PC/Android 配置后，本地秘密和隧道均被清理；VPS 服务保持运行，除非用户执行重新部署。

真实 VPS smoke 是完成条件，不以单元测试代替。测试使用用户明确提供的测试 VPS，或项目维护者控制的临时测试 VPS；不会擅自使用第三方主机。

## 13. 风险与约束

- 云厂商安全组无法仅凭 SSH 自动修改；这是唯一可能需要用户在云控制台完成的网络步骤。
- Electron `safeStorage` 在部分无桌面密钥环的 Linux 环境可能退化为 `basic_text`；功能必须拒绝明文，而不是降低安全标准。
- WireGuard Android tunnel 库包含原生 `wg-go`，APK 体积会增加；首版保持当前仅 `arm64-v8a` ABI。
- Go sidecar 引入可重复构建和许可证归档要求；发布流程必须固定依赖版本并更新 NOTICE。
- 基线 `npm test` 已有与本功能无关的失败；验收需记录基线与最终差异，新增/相关测试必须全绿，不得以基线问题掩盖新回归。

## 14. 完成定义

只有当第 12 节自动测试与端到端验收全部有当前证据、设计中的 PC/VPS/Android 路径均可用、每次提交均已推送到 `Bynlk/clawd-on-mobile` 的当前功能分支，才把本功能标记为完成。任何仅有 UI、仅有部署脚本、仅有 Android VPN 或仅有 Relay 转发的局部结果都不算完成。

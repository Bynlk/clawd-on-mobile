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

SSH 密码只作为本次部署调用中的短生命周期引用，无论成功或失败都在 `finally` 中移除本地引用。JavaScript 字符串不可变，因此不承诺能原地覆盖其内存。密码不进入 prefs、日志、进度事件、崩溃报告或二维码。

### 4.2 SSH 与上传

- 密码认证使用现有 `ssh2` 依赖，不调用外部 `sshpass`。
- `root` 用户直接执行安装器；普通用户使用同一 SSH 密码执行 `sudo -S -p '' bash`。
- 首次遇到未知主机密钥时显示 SHA-256 指纹确认框；接受后把指纹保存到 profile。
- 已保存指纹发生变化时停止部署，明确提示可能是 VPS 重装或中间人攻击。用户必须删除旧指纹并重新确认，不能自动覆盖。
- 在同一个 SSH 连接中通过 SFTP 上传安装脚本、Relay 源码、管理模块、`pair-registry.js` 和随桌面应用打包的 `ws` 依赖，然后执行安装器。
- 部署不依赖 VPS 上预先存在的 Git、Docker、npm 或项目仓库。

### 4.3 VPS 安装结果

安装器支持 apt、dnf、yum，并要求 systemd。它必须幂等：默认重复执行复用服务器、PC、手机三组密钥和 Relay/管理两枚 Token；只有显式 `FORCE_RESET_ALL=1` 才同时重置上述全部秘密。兼容旧 SSH 部署参数时，`FORCE_PHONE_KEY=1` 等价于全量重置；日常只更换手机必须使用管理 API，不得借此重生成服务器或 PC 密钥。

固定目录：

```text
/opt/clawd-relay/releases/release-*/  同一 release 内的 app/ 与 node/
/opt/clawd-relay/current              原子指向当前完整 release 的符号链接
/opt/clawd-relay/app、node            仅路径不存在时创建的便利链接；legacy 实目录保留
/etc/clawd-relay/relay.env            Relay/管理 Token，权限 0600
/etc/wireguard/clawd.conf             WireGuard 配置，权限 0600
/etc/wireguard/clawd/*.key            服务端、PC、手机密钥，权限 0600
/etc/systemd/system/clawd-relay.service
```

服务：

- `wg-quick@clawd.service`：开机启动并保持 WireGuard 接口。
- `clawd-relay.service`：依赖 WireGuard，绑定 `10.8.0.1:7891`，失败自动重启。

防火墙只新增 `51820/udp`。安装器不打开 `7891/tcp`。云厂商安全组不受 VPS 内脚本控制；若握手超时，UI 明确提示用户在云控制台放行所选 UDP 端口。

配置文件先写同目录临时文件、验证后原子替换。Relay app 与验证过的 Node runtime 必须先共同写入一个完整版本化 release，再用同文件系统 rename 原子切换 `/opt/clawd-relay/current.new → /opt/clawd-relay/current`；systemd 只从 `current/node/bin/node` 启动 `current/app/relay-server.js`。已有 `/opt/clawd-relay/app`、`node` 实目录视为 legacy，只报告并保留；若 `current` 是意外实目录则关闭失败。安装器在任何变更前记录两个服务各自的 enabled/active 状态和现有防火墙规则；失败或信号中断时恢复旧文件、旧 `current` 和服务状态，只删除本轮新增的防火墙规则，并清理本轮临时目录。firewalld 的 permanent add 一成功就记录本轮所有权，即使首次 reload 失败，rollback 仍 remove 并再次 reload；已有规则不删除。

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
公网 endpoint 为全局 IPv6 时，回传和两份 WireGuard 配置统一使用 `[IPv6]:port`；IPv4 与域名继续使用 `host:port`。

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

同一个管理实例把完整的 snapshot→commit/rollback 事务串行化；后一请求只能在前一请求提交或回滚后取快照，前一请求失败不会阻塞队列。只要第 1 至 4 步没有全部成功，就不提交轮换；旧配置继续工作。成功后旧手机同时失去 WireGuard Peer 和 Relay Token，即使保存了旧二维码也无法连接。连续成功轮换会逐次关闭每个被取代 Token 的 pair。日常重新配对不使用 SSH。

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

## 15. 实施进度

### Task 1：公开 profile 迁移与 PC 加密秘密存储（2026-07-13）

- profile RED：`node --test test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js` 退出码 1；37 项中 5 项按预期失败，分别覆盖 SSH 指纹格式、密码认证默认值、`user@host` 迁移、显式新字段和旧 key-auth 兼容。
- secret-store RED：`node --test test/wg-relay-secret-store.test.js` 退出码 1，并出现预期的 `MODULE_NOT_FOUND`，证明测试先于模块实现执行。
- 实现：公开 profile 迁移为独立 `host`、`sshUsername`、`sshPort` 字段，新 profile 默认密码认证，未知字段和 `password`、配置、Token 均被剥离；合法旧 key-auth profile 保留兼容。
- 安全存储：每个 profile 的秘密对象经 `safeStorage.encryptString()` 后以 base64 blob 保存；临时文件权限为 `0600`，支持时执行 `fsync`，再原子重命名。不可加密、Linux `basic_text`、损坏 JSON 和非法输入均关闭失败，错误和日志不包含秘密。
- GREEN：`node --test test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js test/wg-relay-secret-store.test.js` 退出码 0；45 项全部通过，0 失败、0 跳过。
- 合规修复 RED：`node --test test/settings-actions-wg-relay.test.js` 退出码 1；20 项中 8 项按预期失败，证明 add、update、remove、applyReadback 会重新提交脏快照字段，并证明 `createdAt`、`serverPubKey`、`pcAddress` 和旧 readback 白名单不符合公开 profile 规范。
- 合规修复：所有产生 commit 的设置命令先规范化整个快照；update 仅保留 `sshHostFingerprint`、`endpoint`、`relayAddr`、`lastDeployedAt`、`deployVersion`，readback 仅持久化 `endpoint`、`relayAddr` 与部署元数据，最终结果再次经过公开 profile sanitizer。合法旧 key-auth 的 `identityFile` 继续保留。
- 合规修复 GREEN：`node --test test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js test/wg-relay-secret-store.test.js` 退出码 0；49 项全部通过，0 失败、0 跳过。
- 边界修复 RED：`node --test test/settings-actions-wg-relay.test.js` 退出码 1；21 项中 1 项按预期失败，证明显式空 `sshHostFingerprint` 被错误恢复。`node --test test/wg-relay-secret-store.test.js` 首次退出码 1，10 项中 2 项按预期失败，证明 `__proto__`、`constructor`、`toString` 与普通对象原型冲突；加入损坏 blob 用例后再次退出码 1，13 项中 1 项按预期失败。
- 边界修复：update 仅在 payload 未持有对应字段时恢复旧部署元数据；secret store 使用 null-prototype profile map，并在读取、删除时统一使用 `Object.hasOwn()`，磁盘 JSON 解析后也转换为 null-prototype map。非规范 base64 blob 被判定为损坏；Linux 仍只拒绝 `basic_text`，未知安全后端保持可用。
- 原子写测试：注入文件系统完整记录 `open → write → chmod → fsync → close → rename`，断言重命名严格发生在同步和关闭之后。
- 边界修复 GREEN：`node --test test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js test/wg-relay-secret-store.test.js` 退出码 0；55 项全部通过，0 失败、0 跳过。

### Task 2：单会话 SSH、TOFU 与完整 VPS bundle 上传（2026-07-13）

- bundle RED：`node --test test/wg-relay-bundle.test.js` 退出码 1，按预期出现 `MODULE_NOT_FOUND`；测试先使用临时 `appRoot` 提供假的 `relay-token-store.js` 与 `wg-management.js`，没有创建 Task 3 占位文件。
- bundle 实现：清单以固定顺序声明安装器、Relay server、pair registry、token store、management 模块，再以稳定代码点顺序递归加入根 `node_modules/ws` 的全部运行时文件。构建阶段完成父路径符号链接与 realpath containment 校验，并在任何网络活动前通过 `fs.readFileSync()` 捕获私有 Buffer 快照；SFTP 仅上传快照副本，不再读取本地路径。远端路径拒绝绝对路径和 `..`，目录为 `0755`，安装脚本为 `0755`，其他文件为 `0644`。桌面打包清单加入 `relay/**/*`。
- ssh2 RED：`node --test test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js` 退出码 1；25 项中原有 21 项通过，新增 4 项按预期因 `deployBundle is not a function` 失败。
- 单会话实现：一次 `Client.connect()` 完成 SHA-256 TOFU、SFTP 上传和一次安装 exec。已保存指纹精确匹配直接接受；未知指纹调用确认回调；已保存指纹变化直接拒绝且不再次确认。root 直接按上传路径执行安装器，普通用户使用 `sudo -S -p ''`，并先写入 sudo 密码。旧 `execScript` 导出与测试保持兼容。
- 编排 RED：`node --test test/wg-relay-deploy.test.js` 退出码 1；27 项中 17 项按预期失败，覆盖规范 `host`/`sshUsername`/`sshPort`、旧 `user@host`/`port` 回退、严格 readback 与脱敏错误。
- 编排实现：密码路径构建完整 bundle 后调用单会话 transport；只接受字段完整且无额外字段的 `schemaVersion=1` 回传，并校验 endpoint、私网 `/24`、同子网 `ws://` Relay URL、两份完整且地址不同的 WireGuard 配置，以及两个各含 64 个十六进制字符（256 bit）的 Token。进度只发出脱敏的 connect、host-key、upload、install、validate 阶段；stdout、stderr、密码和回传秘密不进入进度或错误。部署函数在 `finally` 中移除本地密码引用，不声称覆盖不可变 JavaScript 字符串内存。
- 边界 RED：两轮边界测试分别以 3 项预期失败证明 `ws` 根符号链接、打包遗漏、上传失败阶段、必需文件父目录符号链接、上传前文件替换和旧进度阶段兼容问题；单独 malformed JSON 用例以 1 项预期失败证明解析器错误细节不应进入返回错误。
- GREEN：`node --test test/wg-relay-bundle.test.js test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js` 退出码 0；48 项全部通过，0 失败、0 跳过。真实生产清单当前会明确报告缺少 Task 3 的 `relay/relay-token-store.js` 或 `relay/wg-management.js`，这是阶段边界，不以占位文件掩盖。
- 密钥部署兼容性审查 RED：`node --test --test-name-pattern="normalizes canonical SSH fields" test/wg-relay-deploy.test.js` 退出码 1；实际传给旧 `buildSshArgs` 的 host 为裸 `203.0.113.10`，而不是规范字段要求的 `deploy@203.0.113.10`。
- 密钥部署兼容性修复：key 与 password transport 共用一个基于既有 `splitHost()` 的 SSH target normalizer；规范 `host`/`sshUsername`/`sshPort` 转换为旧 builder 所需的 `user@host`/`port`，旧 `user@host`/`port` 输入保持原值。
- 密钥部署兼容性 GREEN：`node --test test/wg-relay-bundle.test.js test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js` 退出码 0；49 项全部通过，0 失败、0 跳过。
- 安全审查 bundle RED：`node --test test/wg-relay-bundle.test.js` 退出码 1；9 项中 2 项按预期失败，证明清单没有捕获 Buffer 且上传仍会读取已变更文件。进一步修改已暴露 Buffer 后再次运行，9 项中 1 项按预期失败，证明公开 Buffer 可反向修改上传内容。
- 安全审查 SSH RED：`node --test test/wg-ssh2-exec.test.js` 退出码 1；19 项中 8 项按预期失败，覆盖 SFTP 打开/上传超时后继续 exec、close-before-ready、活动 channel 未关闭、同步 TOFU 异常泄漏、延迟确认复活、sudo 密码换行与无限输出。
- 安全审查 readback RED：`node --test test/wg-relay-deploy.test.js` 退出码 1；47 项中 15 项按预期失败，覆盖额外路由、错误客户端地址、错误 Relay host/port、keepalive、未知/重复 directive、重复 section、相同 Token、不同服务器公钥、endpoint host/port 与 profile 不一致。补充大小写等价 Token 后再次 RED，证明同一 256-bit 值可绕过精确字符串比较。
- 安全审查映射 RED：筛选 stable transport code 用例运行后退出码 1；TOFU changed/unconfirmed/confirmation-failed 与 output-limit 的 4 个子用例全部缺少独立 reason/hint，且父级测试一并失败。
- 安全审查实现：单 SSH session 使用 settled/aborted 双状态并跟踪 verifier、SFTP 与 install channel；每次 await 后和副作用前重新检查，timeout/close 会关闭连接及活动资源，延迟回调只能一次性返回 false 且不能恢复流程。未知主机确认经 microtask 调用，三类 TOFU 错误使用稳定安全 code。非 root sudo 密码拒绝 CR/LF，安装 stdout+stderr 合计上限为 2 MiB，超限中止 channel。readback 只接受各一个 `[Interface]`/`[Peer]`、固定且不重复的 directive、profile/runtime 派生的精确 subnet/端口/地址/Relay URL/keepalive、相同服务器公钥，以及两个不同的 32-byte（64 个 hex 字符）Token；错误只返回字段名，不包含秘密。
- 安全审查 GREEN：`node --test test/wg-relay-bundle.test.js test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js` 退出码 0；82 项全部通过，0 失败、0 跳过。邻近 `wg-relay-ipc/profile/settings-actions/secret-store` 测试 74 项全部通过。
- 指纹失败顺序 RED：`node --test --test-name-pattern='preserves structured TOFU failures' test/wg-ssh2-exec.test.js` 退出码 1；changed、unknown reject、确认函数同步抛错 3 个子用例均证明 verifier 的 `callback(false)` 同步触发连接错误时，原始 ssh2 错误会抢先覆盖结构化 TOFU 原因。严格回传筛选命令退出码 1；60 项中 24 项按预期失败，覆盖非全局 IPv4/IPv6、非法 profile IP 字面量、相同客户端私钥及非规范 Relay URL。
- 指纹失败顺序修复：在调用 verifier 拒绝回调前保存结构化 host-key failure，连接 `error`/`close` 优先使用该失败；回调仍严格至多一次，清理和 promise 结算保持幂等。endpoint 仅接受全局可路由 IP 或合规域名；profile 为 IP 字面量时自身也必须全局可路由并与 endpoint 精确相同。WireGuard PC/phone 私钥必须不同，Relay URL 必须逐字等于 profile 子网 `.1` 与 runtime relay port 派生的 `ws://<host>:<port>`，不接受数字别名、凭据、斜杠、路径、查询或 fragment。
- 指纹失败顺序 GREEN：同步 verifier 回归命令退出码 0，4/4 项通过；严格回传筛选命令退出码 0，60/60 项通过；完整聚焦命令 `node --test test/wg-relay-bundle.test.js test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js` 退出码 0，128/128 项通过，0 失败、0 跳过。

### Task 3：持久 VPS 服务、严格 Relay 认证与手机轮换（2026-07-13）

- Relay RED：`node --test test/relay-auth-management.test.js test/relay-server-bind.test.js test/relay-managed-session-forwarding.test.js` 退出码 1；20 项中 11 项按预期失败，覆盖缺失 factory、错误默认绑定、Bearer 未严格验证和多手机 registry。
- Relay 实现：`createRelayServer({ bindAddr, port, tokenStore, management, log, now, remoteAddressOf })` 负责同端口 HTTP/WS、64 KiB WS 上限、Bearer 哈希后 timing-safe 比较、健康检查、握手滥用限制和可测试生命周期；CLI 仅在 `require.main === module` 下启动。registry 只保留一个 PC 和一个 phone，相同 role 新连接关闭旧连接，同时保留 `relay_forward` managed-session envelope，不持久化 payload。
- Relay GREEN：严格认证、单手机、managed-session、生产 spawn 和绑定测试 20/20 通过；补齐持久 token store/management CLI 接线后，Task 3 Relay 聚焦套件 37/37 通过。
- 管理事务 RED：`node --test test/relay-auth-management.test.js` 退出码 1；21 项中已有 5 项 Relay 测试通过，新增 16 项按预期因 token store/management 模块缺失而失败，覆盖 PC 源地址、管理 Bearer、body 类型/版本/大小、事务顺序和三个 rollback 阶段。
- 管理事务实现：`relay-token-store.js` 验证两个不同的 64-hex token，保留原始大小写用于 Bearer 精确比较，以 `0600` 临时文件、`fsync` 和同目录 rename 更新 `relay.env`，并保留管理 token 和全部运行环境字段。`wg-management.js` 按“生成候选 → 原子持久 WG/key 文件 → 更新 live peer → 持久 Relay token → 关闭旧 pair”提交；文件、live peer 或 token 阶段失败会恢复旧文件、旧 peer 和旧 token，响应只返回版本 1 的完整 phone config 与新 Relay token。
- 管理 API GREEN：只接受精确 `10.8.0.2` 或其规范 IPv4-mapped 地址，管理 token 使用 timing-safe 比较；`GET /api/manage/status` 和 `POST /api/manage/phone/rotate` 共用 Relay 私网端口，POST 仅接受小型版本 1 JSON，旧 `/api/start`、`/api/stop` 返回 404。管理与 token 测试 21/21 通过。
- Installer RED：`node --test test/install-wg-relay-script.test.js` 退出码 1；9 项中 7 项按预期失败，证明旧脚本会静默跳过 systemd/Relay、没有 Node 校验安装、未安装完整 bundle、未写严格 env 和未验证服务。自审再以 3/3 预期失败锁定可执行位、OpenSSL 依赖和 readback 构造前过早提交。
- Installer 实现：systemd、上传 app、bundled `node_modules/ws`、WireGuard 和 Node >=18 均为硬前置；Node 缺失或过旧时下载固定 Node 22 archive 并以官方 SHA-256 清单校验。Relay app 与 Node 共同安装到 `/opt/clawd-relay/releases/release-*` 并由 `current` 原子选中，env、WG 配置和 key 文件均为 `0600`；unit 使用 `/etc/clawd-relay/relay.env` 并提供 PC/phone IP、WG/密钥路径和 endpoint。只开放 WireGuard UDP，两个服务均执行 enable/restart/is-enabled/is-active 硬验证，失败恢复旧 current/config/unit/service 状态。
- Installer 初版 GREEN 的准确证据仅为 12/12 项 source contract（静态源码契约）通过，不能作为幂等、回滚或真实 shell 执行证明；固定 Node archive URL 的 HTTP 200 也只证明该归档当时存在。
- mixed-case Token 回归 RED/GREEN：Task 2 明确保留 mixed-case hex token；新增 token-store 用例先观察 lowercasing 失败，再改为保留原 token 字节、仅在“两个 token 是否同值”判断时忽略 hex 大小写，筛选测试 2/2 通过。
- 事务串行化 RED：两个可控 deferred 并发用例运行 2 项、失败 2 项，证明第二次轮换会在第一次事务尚未结束时进入生成/应用阶段。GREEN 后 2/2 通过：第二次快照包含第一次已提交手机公钥，按顺序关闭旧 Token 与第一次新 Token；第一次失败后第二次仍可成功。
- 双入口 RED/GREEN：新增规范入口 `runCli`、根入口兼容 wrapper 以及两个真实 spawn 严格 Bearer 回归；RED 时根入口缺失 Bearer 返回旧 `4000` 且规范入口未导出 `runCli`，GREEN 后新增 5/5 项通过。两个入口均不再含 query-token fallback、Token 前缀日志、`FIXED_TOKEN` 或 `pair.phones`。
- Installer 可执行夹具 RED：加入实际执行上传脚本、隔离文件系统 root 和命令 shim 后，15 项中 12 项静态 source contract 通过、3 项可执行用例按预期失败，失败点均为旧脚本不识别测试隔离入口；未触碰生产绝对路径。
- Installer 可执行夹具 GREEN：17/17 项通过，其中 13 项是 source contract，4 项是真实 shell fixture。可执行证据覆盖首次安装、默认重跑复用全部密钥/Token、`FORCE_RESET_ALL=1` 与旧 `FORCE_PHONE_KEY=1` 全量重置、10 个 mutation checkpoint 逐阶段失败恢复、已有防火墙规则保留、本轮新增规则撤销、enabled/active 独立恢复、版本化 app/node symlink 及无临时/失败 release 残留；静态契约不再被称为幂等或回滚证明。
- 非 root 部署权限 RED/GREEN：新增 executable fixture 断言先以 1/1 失败证明 `umask 077` 会把代码/runtime release 根目录留为 `0700`；修复后 `/opt/clawd-relay` 与 Node release 为 `0755`，秘密目录和文件仍为 `0700`/`0600`，筛选用例 1/1 通过。
- 上一轮聚焦验证：`bash -n relay/install-wg-relay.sh` 退出码 0；指定四个 Task 3 测试文件退出码 0，Relay 三文件 44/44、Installer 17/17。Task 2 邻接 bundle/SSH/deploy 128/128，排除既有越界 i18n 基线后的 11 个 Relay/mobile 邻近文件 242/242；`git diff --check` 退出码 0。
- 扩大邻近范围时，`test/settings-tab-wg-relay.test.js` 仍有 2 个既有失败：外部 `settings-i18n.js` 的 `sidebarWgRelay` 为 0/5。该文件不在 Task 3 授权范围，本次不以越界修改掩盖基线失败；聚焦 Task 3 为 0 失败。
- firewalld 边缘 RED/GREEN：两个 executable fixture 中 1 项按预期失败，证明 permanent add 成功而首次 reload 失败时规则残留；把本轮规则所有权记录移动到 add 成功之后、reload 之前，随后 2/2 通过，失败路径执行 remove+第二次 reload，预存规则路径不执行 remove。
- 完整 release 原子升级 RED/GREEN：4 个 executable fixture 初次 4/4 失败，分别证明旧实现没有统一 `current`、会尝试删除 legacy app/node 实目录、无法恢复旧 `current`、会接受 unexpected real `current`。改为同一 release 内的 app+node 与 `current.new` rename 后 4/4 通过；命令 shim 在任何 legacy 删除尝试发生时立即失败，systemd 只引用 `current`，post-switch 失败恢复旧 link。
- IPv6 readback RED/GREEN：mocked endpoint discovery 返回 `2606:4700:4700::1111` 时，真实 installer stdout 首先被 Task 2 `parseReadback` 以 endpoint 无效拒绝；改为 `[2606:4700:4700::1111]:51820` 后，readback 与 PC/phone 配置通过同一严格 parser，筛选用例 1/1 通过。
- 完整 release 的系统 Node symlink RED/GREEN：相对 `node → node-real` fixture 先以 1/1 失败证明保留 symlink 会把不完整 runtime 放入 release；改为 `cp -L` 并保持 executable mode 后筛选用例 1/1 通过。
- Installer 当前完整证据：`bash -n relay/install-wg-relay.sh` 退出码 0；13 项 source contract 与 11 项 executable fixture 合计 24/24 通过。source contract 仍只作为静态契约，幂等、rollback、legacy 保留、原子 `current`、firewalld、系统 Node symlink 与 IPv6 均由实际 shell fixture 证明。
- 本轮最终聚焦与邻近验证：用户指定的 `bash -n` 加四个 Task 3 测试文件命令退出码 0，68/68 通过；Task 2 bundle/SSH/deploy 邻接链 128/128，通过；11 个 Relay/mobile 邻近文件 242/242 通过。
- 运行时加固 RED：close-pending replacement 探针证明被替换的 phone/PC 在 close event 前仍可发送，且旧 phone 的 close 会错误广播断开；短周期心跳用例证明 Relay 没有发送 Android watchdog 可见的应用层 ping；64 KiB/65537 byte 双向与 Relay→mobile 用例分别暴露 envelope 上限和内层 payload 上限不一致。实现后 registry 只接受 current socket，`remove()` 明确报告是否移除当前角色，旧连接既不能转发也不能误报断开；Relay 每 30 秒以内发送既有 JSON ping，并在 phone raw、PC envelope wire、decoded inner 三处使用独立有界上限。
- 事务恢复与并发边界 RED：token/env 外部字段更新、stale CAS、`0644` env、跨进程锁竞争、live rollback 失败、file rollback 失败、live verification mismatch、hung key/command、partial HTTP body、forced close 以及 upgrade 前认证/限流筛选均先出现定向失败；修复后 Node management、token store 与 installer 共用 `/run/lock/clawd-relay.lock` 的 util-linux `flock` 内核锁，轮换队列和跨进程锁共同覆盖完整 snapshot→commit/compensate，env 在锁内 reload+CAS，补偿失败稳定返回 `rollback_failed` 并保持 unhealthy，只有显式认证 status 恢复且验证旧 live peer 后才能清除。生产 command 和 body 读取有界；管理轮换使用事务内部 deadline，HTTP 层不再以 `Promise.race` 提前返回；非法 path/role/Bearer/来源限流在 `handleUpgrade` 前返回 403/401/429，CLI 默认拒绝仅靠临时 `RELAY_TOKEN` 启动。
- Phase A GREEN：语法检查与 Relay/management/mobile 聚焦命令退出码 0，140/140 通过；Task 2 bundle/SSH/deploy 邻接命令退出码 0，128/128 通过；11 个 Relay/mobile 邻近文件退出码 0，242/242 通过。上述 Phase A 尚未把 installer 新边界计入通过证据。
- Phase B 初始 RED：定向命令运行 5 项、失败 5 项，分别证明 installer 缺少 mutation 前统一输入校验与共享锁、会把 UFW DENY/近似端口误判为已放行，并会优先复制系统 Node 而不是部署固定官方完整 runtime；两个单独 cache 用例各运行 1 项且失败 1 项，分别证明旧缓存读取会跟随不安全链接、会接受 checksum 正确但可写的 archive。
- Phase B installer 实现：所有端口、canonical private `/24`、force flags 和控制字符在 root mutation 前验证；trap 在获取 `/run/lock/clawd-relay.lock` 前安装，owner 匹配才释放，锁覆盖 dependency install、release/config/firewall/service/readback 全事务，早期失败和 SIGTERM 都清理锁与本轮目录。生产不再读取 system/current/legacy Node，固定从 `https://nodejs.org/dist/v22.17.0` 获取官方 SHA-256 manifest，拒绝不安全缓存链接，缓存 archive 为 `0444` 且每次重新校验，再把完整 runtime 解包进 staged release。
- Phase B firewall 实现：UFW 只把 exact `ALLOW` 视为已存在，IPv6 endpoint 要求 exact v6 coverage；firewalld 保持 permanent add 后立即记录本轮所有权、reload 并 query 验证；fallback 同时管理 iptables/ip6tables，并生成、启用、启动和验证 `clawd-relay-firewall.service` oneshot 以支持重启恢复。无可用后端退出 14；rollback 只撤销本轮新增的 family/rule，并恢复旧 firewall unit/service 状态。
- Phase B executable fixture：上传源使用仓库实际 `relay-server.js`、pair registry、token store、management 与实际 `node_modules/ws`；严格 `wg-quick` mock 校验 section、directive、地址和 key 语法；systemctl mock 解析生成 unit 的 `EnvironmentFile`/`ExecStart`，在 test-only loopback/ephemeral port 启动 canonical Relay，真实验证 secret-free `/health`、缺失 Bearer 的 HTTP 401 和有效 Bearer WebSocket。fixture 还执行 apt/dnf/yum、UFW allow/deny/near-port、firewalld、iptables+ip6tables reboot、无后端、x64/arm64、checksum mismatch、lock contention、早期 failure/SIGTERM、默认复用、全量 reset、legacy 目录保留和全部 mutation checkpoint rollback。
- Phase B installer GREEN：`bash -n relay/install-wg-relay.sh` 退出码 0；完整 installer 测试共 44 项，其中 43 通过、0 失败、1 项按 `CLAWD_RUN_PRIVILEGED_INSTALL_INTEGRATION=1` 显式保护而跳过。通过项由 14 项 source contract 与 29 项 executable fixture 组成；source contract 仅表示静态契约。当前 macOS fixture 没有运行 privileged Linux/真实 VPS Task 11 验证，不作该项已验证声明。
- Phase B 最终验证：用户指定的 `bash -n` 与四文件聚焦命令退出码 0，109 项中 108 通过、0 失败、1 项为上述明确的 privileged Linux skip；Task 2 bundle/SSH/deploy 邻接命令退出码 0，128/128 通过；11 个 Relay/mobile 邻接文件退出码 0，242/242 通过。
- Phase C 本地 WSS RED/GREEN：真实 HTTP server、真实本地 `WebSocketServer` 与真实 `ws` client 首先以 `Max payload size exceeded` 拒绝承载 65,536-byte inner payload 的 Relay envelope；共享 `RELAY_ENVELOPE_MAX` 后定向用例 1/1 通过，65,536 成功到达 local mobile handler，65,537 以 1009 拒绝，非 Relay 与 decoded inner 上限仍为 64 KiB。
- Phase C 心跳与预认证 RED/GREEN：两个定向用例初次 2/2 失败，分别观察到第三次错误 Bearer 仍返回 401 和三个 WebSocket protocol ping；修复后错误 Bearer 的有界 TTL per-source limiter 返回 429，合法连接使用独立 limiter，Relay 只重复发送现有 JSON `ping`，定向 2/2 通过且 protocol ping 数为 0。
- Phase C 事务 deadline/关闭 RED/GREEN：四个 deferred 定向用例初次 4/4 失败，错误仍为旧 `rotation_failed`/未定义，`close()` 未中止排空活动轮换且强制关闭错误返回成功。whole-transaction `AbortSignal`、补偿完成后返回、管理 shutdown drain 与显式 `shutdown_failed` 实现后，管理层和 HTTP/残留 socket 六项定向用例 6/6 通过；HTTP 不会在事务仍可能提交时先返回 504，活动轮换关闭后不会提交新 token。
- Phase C 锁与不确定提交：Node 与 installer 的 mkdir owner 锁已替换为同一 lock file 上的内核 `flock`；Node 保持 helper stdin 到 release，installer 以 fd 9 持锁。竞争 owner、持锁子进程 SIGKILL 后重取、installer contention 后重试均由 executable 测试通过；fixture 启动的测试 Relay 显式关闭继承 fd，避免把测试 shell 与 systemd 启动语义混淆。token rename 后 parent fsync 失败会标记 `commitUncertain`、从磁盘协调内存；管理补偿无条件 reload 并以 CAS 恢复旧 token，恢复 fsync 失败保持 unhealthy。
- Phase C live 验证 RED/GREEN：新增 exact old public key、`PHONE_IP/32`、new peer absent 用例后，重复 old-key 行首先按预期失败；拒绝重复 peer readback 后 5/5（含父级）通过。默认 verifier 使用 `wg show clawd allowed-ips`，不再只检查 key 是否存在。
- Phase C 当前验证：`bash -n relay/install-wg-relay.sh` 退出码 0；Relay/management/local WSS/mobile 七文件聚焦与邻接命令 207/207 通过；Task 2/SSH/部署/profile 邻接七文件 179/179 通过。installer 的首次安装、默认复用、全量 reset、flock contention 和 Node SIGKILL 重取锁筛选用例均已执行通过；完整 installer suite 留在 Phase D 修改完成后重新运行。当前 macOS 没有运行 privileged Linux/真实 VPS Task 11，不作已验证声明。
- Phase D 防火墙迁移 RED：新增 1 项 source contract 与 6 项 executable fixture 首次运行 7/7 失败，分别证明缺少 `0600` ownership metadata、inactive UFW 会阻止 firewalld fallback、firewalld permanent/runtime 漂移未修复、WG 端口变更遗留旧 UFW rule、iptables→UFW 后旧规则/unit/service 残留、迁移 rollback 无旧 metadata，以及 malformed/noncanonical/non-global endpoint 被接受。
- Phase D 防火墙实现：`/etc/clawd-relay/firewall.env` 以同目录临时文件、rename、文件/父目录 fsync 和 `0600` 保存 backend、port、IPv4/IPv6 rule ownership 与 unit ownership。新端口/后端规则及服务先验证，Relay/WG 服务成功后才删除 metadata 明确声明为 installer-owned 的旧规则；若随后失败，rollback 撤销新规则、重建已删旧规则、恢复旧 metadata/unit/service。UFW 只在精确 `Status: active` 时选用；firewalld 同时 query permanent/runtime，runtime 漂移触发 reload；离开 iptables 时停止、禁用并删除 installer firewall unit 与两族旧规则。
- Phase D endpoint RED/GREEN：`999.1.1.1`、非法 label、空 label、documentation IPv6 与非 RFC 5952 IPv6 fixture 首先被旧 installer 接受；使用 staged verified Node 的严格 parser 后全部以 17 拒绝并 rollback。只接受 canonical globally-routable IPv4/IPv6 或 lowercase 合规 hostname，IPv6 readback 保持方括号；既有全球 IPv4、全球 IPv6和合法域名路径继续通过。
- Phase D privileged guard RED/GREEN：guard 单测先以 `validatePrivilegedIntegration is not defined` 失败；实现后 1/1 通过。特权 integration 必须同时满足显式 opt-in、Linux、root、固定 `/root/.clawd-relay-disposable-vps` regular file、root ownership、`0600` 和与 `CLAWD_PRIVILEGED_VPS_NONCE` 完全匹配；缺少任一项即跳过或拒绝。测试只接受预先无 Clawd 状态的 disposable VPS，`finally` 删除 metadata 声明拥有的 firewall rule、停止/禁用测试服务、删除测试文件/lock，并验证 service、rule、文件和 `/var/tmp` backup 均已清理。
- Phase D 全量 installer 首轮：52 项中 50 通过、1 失败、1 privileged skip；唯一失败是合法第二个私网 fixture 在 20 秒 test harness 上限被杀死（`status=null`，stdout 停在正常安装步骤，无 installer error）。把 executable fixture 上限调为 60 秒后该用例独立通过；没有放宽生产 command/transaction deadline。
- Phase D 最终验证：用户指定的 `bash -n` 与四文件聚焦命令退出码 0，131 项中 130 通过、0 失败、1 项为 marker/nonce 保护的 privileged Linux skip；其中完整 installer suite 为 51 通过、0 失败、1 跳过。Task 2/SSH/部署/profile 邻接七文件 179/179 通过；Relay/mobile/managed-session 邻接 11 文件 228/228 通过。当前运行环境为 macOS，未运行 privileged Linux 或真实 VPS Task 11，不作该项已验证声明。

# 一键 WireGuard Relay 设计

> 状态：代码与自动验收完成；Android 真机蜂窝/分应用路由和 VPS 重启验收待执行
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
- 最终质量审查的轮换持久性 RED：提交前 live peer 核验与四个 journal 中断边界筛选共运行 6 项、失败 6 项；Relay 启动恢复门禁另运行 1 项、失败 1 项。实现使用 `0600` 原子 journal、文件与父目录 `fsync`，在 files/live/token 每个 mutation 前先持久记录 attempted phase；进程重启在监听端口前持有共享锁恢复旧配置、旧 peer 与旧 token。token 提交前必须从 live WireGuard readback 精确确认新 public key 仅绑定 `PHONE_IP/32` 且旧 key 不存在，成功关闭旧连接后才持久清除 journal。
- 最终质量审查的锁、心跳与限流 RED/GREEN：锁路径 symlink 与不安全 mode/owner/type 两项初次 2/2 失败；静默连接、replacement liveness 隔离和 authenticated-source 容量三项初次 3/3 失败。Node 现在以 `O_NOFOLLOW|O_CREAT` 打开 lock file 并用 `fstat` 验证 regular file、预期 owner 与 `0600`，生产 CLI 明确要求 uid 0；Relay 仅使用应用层 JSON ping，连续两个周期未收到 pong 或其他有效消息即 terminate，replacement/close 清除 socket liveness，并为 authenticated-source limiter 增加 TTL 清理和 4096 来源上限。定向回归 4/4 通过；Relay/management/local WSS/mobile 五文件邻接命令退出码 0，207/207 通过。
- 最终质量审查的 installer RED：生产 root/lock/probe/systemd sandbox 与真实 smoke 筛选共运行 13 项，1 项既有 non-regular guard 通过、12 项按预期失败；旧脚本会调用内部 sudo、跟随 lock symlink、修正而非拒绝不安全 mode、忽略 owner，并只依赖 `is-active`，端口冲突、严格鉴权失败和 restart counter 变化仍会提交。修复后生产 installer 要求整段以 uid 0 运行（`CLAWD_INSTALL_TEST_MODE=1` 隔离 fixture 例外），删除所有内部 sudo；打开 flock 前后检查 symlink、regular type、uid、`0600` 和 path/fd dev+inode 一致性。
- 最终质量审查的生产验收实现：systemd unit 增加 `NoNewPrivileges`、`PrivateTmp`、`ProtectHome`、`ProtectSystem=strict`、三个必要 `ReadWritePaths` 及仅 `CAP_NET_ADMIN` 的 capability 边界。installer 在 COMMITTED 前使用 staged verified Node 与 staged `ws` 执行真实 secret-free `/health`、无 Bearer HTTP 401、有效 Bearer WebSocket 探针，再连续校验 enabled/active 且 `MainPID:NRestarts` 三个周期不变；三种 executable 失败 fixture 均验证 rollback。SSH transport 的普通用户路径仍由 Task 2 以 `sudo -S -p '' env ... bash install-wg-relay.sh` 启动整个 root installer，本轮未修改该文件。
- installer 锁交互 RED/GREEN：真实 smoke 首先以 `lock_timeout` 证明 installer 持有全事务 flock 时，无 journal 的 Relay startup 不应再次抢锁；新增 management 定向用例初次 1/1 失败。初始化现在仅在 journal 存在时获取 flock 并恢复，无 journal 时在开放监听/轮换前直接完成；journal 存在时的四阶段恢复保持持锁。筛选 6/6 通过，installer 仍不提前释放事务锁。
- 最终验证：用户指定的 `bash -n` 与四个 Task 3 文件命令退出码 0，共 156 项中 155 通过、0 失败、1 项为 marker/nonce 保护的 privileged Linux skip；其中 installer 为 64 项中 63 通过、0 失败、1 跳过。Task 2 七文件邻接命令退出码 0，202/202 通过；mobile/Relay 四文件邻接命令退出码 0，134/134 通过；`git diff --check` 在提交前另行执行。当前运行环境为 macOS，未运行 privileged Linux 或真实 VPS Task 11，不作该项已验证声明。

### Task 4：跨平台用户态 WireGuard TCP-forward sidecar（2026-07-13）

- JSON 协议 RED：首次 `go test ./...` 退出码 1，`config_test.go` 的三个调用均以 `undefined: ParseConfig` 失败；最小 JSON decoder GREEN 后，未知字段、第二个 JSON 和尾随非空数据均被拒绝，尾随空白保留合法。
- 配置验证 RED：密钥筛选首先 8/8 个无效样例被旧最小 parser 接受；AllowedIP/Address 筛选随后 15/15 个无效样例被接受；Endpoint/ForwardAddress/Keepalive 筛选再观察到 22 个预期失败，并单独捕获括号内非 IPv6 被误当域名。实现使用 WireGuard `NoisePrivateKey`/`NoisePublicKey` 与规范 Base64、private-key clamp/nonzero 检查，以及 `net/netip` 的规范 RFC1918 IPv4 prefix、单 host `/32`、可用 host、子网包含和端口约束；默认路由、公网/IPv6 AllowedIP、跨出 RFC1918 的大网段和子网外转发均关闭失败。
- 严格 schema 审查 RED/GREEN：独立审查指出 `encoding/json` 默认接受重复字段和大小写不精确字段；新增回归先观察到 ambiguous field set 被接受，再改为先读取单个 `json.RawMessage`、逐 token 要求七个字段精确各出现一次，并继续在实际 struct decoder 上调用 `DisallowUnknownFields()`。多行 JSON 首先返回 `invalid_json`、无末尾换行 EOF 首先 2 秒不退出；有界读取修复后两项通过，且 EOF 前延迟写入的第二 JSON 返回脱敏 `trailing_data`，不会启动 runtime。
- Forwarder RED：`go test -run '^TestForwarder'` 退出码 1，按预期因 `closeWrite` 与 `StartForwarder` 未定义而 build failed。GREEN 使用真实 TCP socket 证明 listener 精确为 `127.0.0.1:0`、client→Relay 与 Relay→client 双向复制、client half-close 后仍能读取完整响应；12 个并发连接在 context cancellation 后 listener、两端连接及 copy worker 均在 2 秒门限内结束。
- userspace WireGuard/协议 RED：聚焦测试先因 `buildIPCConfig`、`StartTunnel`、`run` 与 runtime interfaces 未定义而 build failed；设备停止测试随后先稳定复现 2 秒不退出。实现以 `netstack.CreateNetTUN`、`device.NewDevice` 与 silent logger 建立不创建系统 TUN/路由、无需管理员权限的 userspace device；UAPI 固定 `replace_peers=true`，只写一个 public key 和一个私网 AllowedIP。`device.Wait()`、SIGINT/SIGTERM context、listener/device 启动或运行期失败均进入幂等清理；stdin 是一次性配置传输，只有读到 EOF 并确认严格单个 JSON、无尾随非空白后才启动 runtime，运行期 EOF 不再是停止信号。ready 为单行 `{"type":"ready","listen":"127.0.0.1:<port>"}`，错误只输出 `type/status/errorCode`。
- 取消竞态审查：独立 reviewer 指出 parent cancellation 与 forwarder `Wait()` 同时就绪可能误报 `listener_stopped`；加入已取消 context 重复回归，并在启动边界及 device/forwarder 完成分支优先识别预期 cancellation。stdout 脱敏测试覆盖未知 Token、两类 WireGuard key、Endpoint 与 ForwardAddress，测试和实现均不写 argv、env 或临时配置文件。
- 第二轮独立复审当时把 stdin EOF 定义成运行期退出，并据此要求 Task 5 manager 长期保持秘密 pipe；Task 5 跨语言审查证明该约定会与 manager 的 `stdin.end(JSON+"\n")` 直接冲突并让真实 sidecar ready 后立即退出。该旧结论已被本次阻断修复取代：EOF 只提交并封闭单个配置文档，停止只来自 SIGINT/SIGTERM、parent context 或 device/listener failure。
- 固定依赖：直接依赖 `golang.zx2c4.com/wireguard v0.0.0-20260522210424-ecfc5a8d5446`；完整解析图另固定 `github.com/google/btree v1.1.2`、`golang.org/x/crypto v0.37.0`、`golang.org/x/net v0.39.0`、`golang.org/x/sys v0.32.0`、`golang.org/x/time v0.7.0`、`golang.zx2c4.com/wintun v0.0.0-20230126152724-0fa3db229ce2` 和 `gvisor.dev/gvisor v0.0.0-20250503011706-39ed1f5ac29c`，`go.sum` 含每个 module 及其 go.mod 校验和。
- 许可证证据：分别对 Windows、macOS、Linux 执行 `go list -deps` 后取 module 联集，再直接读取 module cache 的 LICENSE/NOTICE。NOTICE 记录 wireguard-go/wintun 的 MIT 与实际 WireGuard LLC 源码版权行、gVisor/google-btree 的 Apache-2.0（两者 pinned module 均无上游 NOTICE 文件）、四个 Go x module 的 BSD-3-Clause 和 `Copyright 2009 The Go Authors.`；未根据名称猜测许可证。
- 首次提交时验证（不再作为完成依据）：当时 `go test ./...`、`go test -race ./...`、`go vet ./...` 与六目标构建均为退出码 0，但 2026-07-14 规格复审发现配置读取期间信号无法有界退出、域名 Endpoint 未转换为 wireguard-go 所需数字 `AddrPort`；据此撤销此前 Task 4“100%”结论。
- 复审修复的信号 RED：`go test -run '^TestProcessSignalsInterruptOpenConfigInput$' -count=1 -v` 退出码 1；真实构建并启动 sidecar、保持 stdin 打开的四个子用例（空输入/半份 secret × SIGINT/SIGTERM）均出现 `sidecar did not exit within 2 seconds`。实现改为让 context 与配置解码结果竞速，取消时关闭可关闭 reader 并立即结束进程生命周期；不记录、不输出半份配置。相同命令 GREEN，4/4 子用例在 2 秒内退出并完成 `Wait` 回收，stdout/stderr 不含 secret、字段名或 WireGuard key。Windows 跳过 POSIX signal 运行语义测试，生产代码继续参与 Windows 交叉构建。
- 复审修复的 DNS/IPC RED：`go test -run '^(TestConfigureDeviceResolvesHostnameToCanonicalNumericIPC|TestResolveEndpointReturnsStableRedactedErrors)$' -count=1` 退出码 1，按预期因 `configureDevice`、`resolveEndpointWithTimeout` 未定义而 build failed。实现注入 `LookupNetIP` resolver，在 `IpcSet` 前以 10 秒内部 deadline 解析域名；过滤、去重后固定 IPv4 优先并按 `netip.Addr.Compare` 排序，保留端口并使用 `netip.AddrPort` 规范化 IPv4/括号 IPv6。GREEN 覆盖 IPv4、IPv6、多结果确定性、空结果、解析失败、取消和超时；fake IPC 捕获证明只收到数字 endpoint，不含原域名。错误稳定为 `endpoint_resolution_failed`、`endpoint_resolution_canceled` 或 `endpoint_resolution_timeout`，不回显 hostname。数字 Endpoint 的已取消 context 用例随后先 RED（错误为 nil），在解析入口优先检查 context 后 GREEN。
- 启动取消相邻回归 RED/GREEN：`TestRunCancellationDuringTunnelStartIsNotReportedAsFailure` 首次退出码 1，观察到信号取消被误报为 `endpoint_resolution_canceled` 且进程返回 1；在设备启动错误分支优先识别 parent cancellation 后聚焦测试退出码 0，不再输出错误状态。
- 2026-07-14 复审修复验证：`go test ./...`、`go test -race ./...`、`go vet ./...`、`go mod verify` 均退出码 0；`go mod tidy` 后 `go.mod`/`go.sum` 无 diff。`GOOS=windows GOARCH=amd64/arm64`、`GOOS=darwin GOARCH=amd64/arm64`、`GOOS=linux GOARCH=amd64/arm64` 六目标 `go build` 均逐目标退出码 0，产物写入临时目录，工作树不保留二进制。
- 第二次状态（后续质量审查再次撤销为完成依据）：信号与域名 Endpoint 两项复审缺陷已修复并通过当时自动验证，但 2026-07-14 后续质量审查又发现 copy 错误路径可能永久等待，以及 self-peer 会被 wireguard-go 静默忽略，故不保留完成结论。
- copy 错误关闭 RED：`go test -run '^TestForwarderCopyFaultClosesBothDirections$' -count=1 -v` 退出码 1；注入 destination write error 与 `CloseWrite` error 的两个子用例均出现 `copy fault did not fully close the remote connection`，证明反向 `Read` 在对端保持打开时永久阻塞。GREEN 后 `copyHalf` 只在 clean EOF 执行 half-close，并把 copy/half-close error 返回协调层；首个错误通过 `sync.Once` 完整关闭两端，再等待另一 copy 被唤醒退出。tracked map 的删除即关闭所有权领取，shutdown 与 worker 不会重复关闭同一连接。
- copy 真实/压力证据：真实 TCP `SetLinger(0)` RST 在对端保持打开时可有界唤醒反向 copy；注入错误连接断言每个 remote `Close` 精确一次。100 次故障循环后 tracked connection 为 0，goroutine 与 `/dev/fd` 回到基线容差；该压力测试普通模式连续 20 次通过，三个故障用例在 race 模式连续 10 次通过。原有 clean half-close 双向响应与 12 并发 context cancellation 测试继续通过。
- self-peer/自指 RED：`go test -run '^(TestParseConfigRejectsSelfPeerPublicKeyWithoutExposingIt|TestParseConfigRejectsForwardAddressThatIsTheClientAddress)$' -count=1 -v` 退出码 1；客户端 private key 派生的 public key、普通 `/24` 内 ForwardAddress 等于客户端 Address、以及只能指向自身的 `/32` 三项均被旧校验接受。GREEN 使用标准库 X25519 派生本机 public key并常量时间比较，self-peer 稳定返回脱敏 `invalid_server_public_key`；ForwardAddress 与客户端 Address 相同稳定返回 `invalid_forward_address`。
- 真实 IpcGet RED/GREEN：真实 device 定向测试首先仅因 `parseIPCGetState` 未定义而 build failed；严格测试解析器实现后，`StartTunnel` 的真实 `IpcSet`/`IpcGet` 状态恰有 1 个预期 server peer、恰有 1 个预期 AllowedIP。解析器要求完整换行 framing、规范 lowercase hex key、规范数字 endpoint/prefix、mandatory peer status 字段，拒绝未知字段、重复 singleton、重复 AllowedIP、缺字段和 malformed line，错误不包含 private/public key。
- 本地双 userspace WG 集成：两个 `netstack.CreateNetTUN` device 仅通过 `127.0.0.1` UDP 和内核随机端口完成真实 WireGuard 握手；server netstack TCP listener 经 client netstack 与 `StartForwarder` 完成请求、half-close 和响应。该测试普通模式连续 25 次、race 模式连续 10 次通过，无需 DNS、互联网、管理员权限或 VPS，因此保留在 Task 4，而非延期到 Task 12。
- Windows 运行时边界：本轮仍只完成 Windows amd64/arm64 交叉编译；POSIX signal 子进程测试明确在 Windows 跳过，Windows 子进程关闭 runtime smoke 留到 Task 11 CI，不宣称 Windows 实机验证。未读取或使用真实 VPS 凭据，也未连接 VPS。
- 2026-07-14 质量修复最终验证：清除 Go test cache 后，`go test ./...`、`go test -race ./...`、`go vet ./...`、`go mod verify` 均退出码 0；`go mod tidy` 后 `go.mod`/`go.sum` 无 diff。`GOOS=windows GOARCH=amd64/arm64`、`GOOS=darwin GOARCH=amd64/arm64`、`GOOS=linux GOARCH=amd64/arm64` 六目标构建均退出码 0。依赖版本未变化，`NOTICE.md` 既有实际许可证清单仍准确；改动只涉及 Task 4 授权文件与本进度记录，未修改 Task 5+ 文件。
- Task 4 当前状态：本轮两个 Important 与两个 Minor 的代码/自动化证据已实现并通过上述验证，但不再使用百分比完成声明；整个一键 Relay 仍需 Task 5–12，Windows runtime smoke 明确等待 Task 11 CI，真实 VPS smoke 明确等待 Task 12。

### Task 5：Electron sidecar manager 与一键连接状态机（2026-07-14）

- sidecar manager RED：`node --test test/wg-relay-sidecar.test.js` 退出码 1，测试文件因 `src/wg-relay-sidecar.js` 不存在而以 `MODULE_NOT_FOUND` 失败，证明平台/架构路径、受控 dev/packaged 根、单 JSON stdin、严格逐行状态、输出上限、超时/退出、跨 chunk stderr 脱敏、有界停止、并发与 dispose 契约先于实现执行。
- 连接/Bridge/runtime RED：`node --test test/wg-relay-connection.test.js test/relay-bridge-integration.test.js test/wg-relay-runtime.test.js` 退出码 1；20 项中 9 通过、11 失败。连接模块缺失，RelayBridge 缺少 `configure()`/`waitUntilConnected()`，runtime 允许 stale attempt 覆盖并原样暴露非法错误码。
- sidecar manager 实现：`sidecarPathFor()` 只从绝对 app/resources 根解析 Windows/macOS/Linux × x64/arm64 的固定产物名；spawn 使用空 argv、最小环境和 pipe stdio，配置只写一个 JSON 文档并关闭 stdin。`parseStatusLine()` 只接受严格 ready/error schema，ready 仅允许 `127.0.0.1`/`::1` 有效端口。stdout/stderr 按字节、行数和单行长度有界，stderr 正文完全抑制；attempt generation、旧进程事件过滤、startup timeout、异常退出、sidecar error、幂等 stop/dispose、SIGTERM→有界强杀和可注入 Windows kill 路径均由测试覆盖。
- 一键连接实现：`createWgRelayConnection()` 按 profile 隔离 `connect`/`disconnect`/`status`/`dispose`，不自动启动；成功顺序固定为安全存储读取 → sidecar → loopback `/health` → RelayBridge configure/start/wait。失败与断开均按 bridge → sidecar 逆序回滚；重复 connect 合并，connect/disconnect race、stale completion 和旧 sidecar failure 由 generation 取消。健康检查只请求 sidecar ready 返回的 loopback forward endpoint，限制 deadline 和响应体，严格校验 `{version:1,status:"ok",uptimeSeconds}`，拒绝 non-2xx、重定向、非 loopback 和超限响应。
- RelayBridge/runtime 实现：RelayBridge 新增显式 `configure({url,token})`、幂等 `start()`/`waitUntilConnected(timeoutMs)`/`stop()`，Relay 与本地 mobile socket 均 open 后才 connected；认证/连接/超时使用稳定码，旧 socket 晚事件受 generation 和 socket identity 双重门禁，Token 不进入日志或 failure。legacy `init(prefs)` 保留且清理 prefs listeners。runtime 的公开状态严格限制为 `idle`、`starting_tunnel`、`verifying_relay`、`connecting_relay`、`connected`、`disconnecting`、`failed`；公开代次字段只有非负安全整数 `generation`，不保留 `attempt` 别名，非法状态、非法或 stale generation 均拒绝且不 emit。
- 复审补强 RED/GREEN：筛选 `probeRelayHealth|prompt process exit|while stop is in flight` 首次退出码 1，3/3 失败，分别证明非法高端口抛出裸 TypeError、termination timer 未走可清理注入、stop 期间重复 start 未合并；最小修复后相同 3/3 通过。另一个健康响应超限用例先暴露 `destroy()` 同步 error 抢先覆盖 `health_response_too_large`，调整 settle→destroy 顺序后筛选通过。
- 定向 GREEN：`node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/relay-bridge-integration.test.js test/wg-relay-runtime.test.js` 退出码 0；57/57 通过，0 失败、0 跳过。四个生产文件另经 `node --check` 全部退出码 0。
- 邻接 GREEN：本地运行 mobile server/WS/managed bridge、Relay auth/management/forwarding/server bind，以及 WG profile/secret/deploy/IPC 共 11 个测试文件，退出码 0；388/388 通过，0 失败、0 跳过。未读取或使用真实 VPS 凭据，未连接 VPS。
- stdin 阻断 RED：修改 Go 生命周期测试后运行聚焦命令退出码 1；配置尚未 EOF 就启动 tunnel、无换行 JSON EOF 后立即退出、延迟第二 JSON 在 EOF 前已进入 runtime 三项按预期失败。配置传输未完成时的真实 SIGINT/SIGTERM 四个子用例仍 4/4 通过，证明修复不能牺牲有界信号取消。
- 跨语言 RED：Node manager 构建并启动 `go test -c` 生成的真实 Go helper binary，manager 确认执行 `stdin.end()`；旧 Go 生命周期在 ready 后退出并让 manager 收到 `sidecar_protocol_error`，筛选命令 2 项中 fake manager 契约通过、真实 Go 契约 1 项失败。
- stdin 协议修复：`readConfigStream` 以 64 KiB 上限等待完整 EOF，再把全部字节交给既有严格 `ParseConfig`；第二 JSON、尾随非空白、半份 JSON 和超限输入均在 `startTunnel` 前失败。运行期删除 stdin watcher/EOF select，只保留 parent context、device done 与 forwarder done；配置读取期间 context 仍关闭可关闭 reader 并有界退出。
- 跨语言 GREEN：相同 Node 筛选 2/2 通过；真实 Go helper 在 stdin EOF 后保持 ready/未退出至少 150ms，只有 manager `stop()` 发 SIGTERM 后才清理并完成进程回收。该测试不连接公网/VPS，tunnel/forwarder 使用 Go protocol test fixture。
- 阻断修复最终验证：`go test ./... -count=1`、`go test -race ./... -count=1`、`go vet ./...` 均退出码 0；Task 5 Node 四文件 59/59 通过，其中包含上述跨语言真实 binary smoke；mobile/Relay/WG 邻接 11 文件 388/388 通过。`GOOS=windows/darwin/linux` × `GOARCH=amd64/arm64` 六目标 `go build -trimpath` 全部退出码 0，产物仅写临时目录。未读取或使用真实 VPS 凭据，未连接 VPS。Windows 实机 signal/kill runtime smoke 仍按原计划等待 Task 11 CI。
- 规格审查 RED：执行 `node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/wg-relay-runtime.test.js`，共 88 项，65 通过、23 失败。失败直接证明 connect 期间 sidecar failure 未立即让 generation/attempt 失效，health/bridge 晚完成仍可返回 connected；固定格式 regex 会接受未知恶意 errorCode；runtime 仍公开 `attempt` 并接受非法状态/generation；stdout 会跳过空行并把退出时残余误报为 unexpected exit。
- 规格审查实现：sidecar、connection、runtime 共用显式已知 errorCode allowlist，覆盖 Task 4 Go sidecar 与 Task 5 manager/health/Relay 错误；未知、64 字符、超长或 secret-like 值在各边界 fail closed 为 `sidecar_failed`/`connection_failed`，异常 message 不进入公开错误、状态或日志。sidecar failure 现在同步 invalidate 当前 connection generation，触发 `AbortController`，异步 stage 与 invalidation 竞速；rollback/finalize promise 去重保证 bridge stop → sidecar stop 精确一次，disconnect/dispose 竞态保留原始 connect rejection 且最终公开状态按新 generation 收敛。stdout 的每个分隔行（含空行）均必须是合法 JSON status，退出时任意残余空白或 partial JSON 均为 `sidecar_protocol_error`。
- 规格审查中间 GREEN：执行 `node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/wg-relay-runtime.test.js test/wg-relay-ipc.test.js`，共 107 项，102 通过、5 失败；两个失败来自 rejection handler 在测试中挂载过晚，另外两个断言仍期待旧 regex/空行语义，父级 subtest 因子项失败计为第五项。修正测试时序与旧断言后，相同完整命令为 107/107 通过、0 失败、0 跳过。
- 规格审查 Task 5 最终命令（精确四文件）：

  ```sh
  node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/relay-bridge-integration.test.js test/wg-relay-runtime.test.js
  ```

  退出码 0，共 97 项，97 通过、0 失败、0 跳过；其中 sidecar 单文件为 33/33，并真实覆盖 stdout 字节/行数/单行上限、leading/trailing/cross-chunk blank line 与退出残余。
- 规格审查 mobile/Relay/WG 邻接命令（精确 11 文件）：

  ```sh
  node --test test/mobile-server-integration.test.js test/mobile-ws-server.test.js test/managed-session-mobile-bridge.test.js test/relay-managed-session-forwarding.test.js test/relay-server-bind.test.js test/relay-auth-management.test.js test/wg-relay-ipc.test.js test/wg-relay-secret-store.test.js test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js test/wg-relay-deploy.test.js
  ```

  退出码 0，共 388 项，388 通过、0 失败、0 跳过。
- 规格审查 Go 与跨语言验证：在 `sidecars/wg-relay-tunnel` 执行 `go test ./... -count=1`、`go test -race ./... -count=1`、`go vet ./...`，三个命令均退出码 0，普通/race 均报告唯一 Go package `ok`，vet 无输出。仓库根执行 `node --test --test-name-pattern='Node manager and the real Go protocol keep running after stdin EOF until stop' test/wg-relay-sidecar.test.js`，退出码 0、1/1 通过；该用例由 Node manager 构建并启动真实 Go protocol test binary，确认 manager `stdin.end(JSON+"\n")` 后进程持续存活，只有 `stop()` 才终止。
- 规格审查六目标构建命令：在 `sidecars/wg-relay-tunnel` 创建临时输出目录，逐项执行 `GOOS=windows GOARCH=amd64 go build -trimpath -o "$out/clawd-wg-tunnel-windows-amd64.exe" .`、`GOOS=windows GOARCH=arm64 go build -trimpath -o "$out/clawd-wg-tunnel-windows-arm64.exe" .`、`GOOS=darwin GOARCH=amd64 go build -trimpath -o "$out/clawd-wg-tunnel-darwin-amd64" .`、`GOOS=darwin GOARCH=arm64 go build -trimpath -o "$out/clawd-wg-tunnel-darwin-arm64" .`、`GOOS=linux GOARCH=amd64 go build -trimpath -o "$out/clawd-wg-tunnel-linux-amd64" .`、`GOOS=linux GOARCH=arm64 go build -trimpath -o "$out/clawd-wg-tunnel-linux-arm64" .`；六个目标均退出码 0，`find` 精确列出 6 个产物，shell trap 随后删除临时目录。未读取或使用真实 VPS 凭据，未连接 VPS；Windows 实机 signal/kill runtime smoke 仍等待 Task 11 CI。
- 规格审查静态验证：执行 `for file in src/wg-relay-error-codes.js src/wg-relay-sidecar.js src/wg-relay-connection.js src/relay-bridge-integration.js src/wg-relay-runtime.js src/wg-relay-ipc.js; do node --check "$file"; done`，6/6 文件退出码 0；提交前执行 `git diff --check`，退出码 0。
- IPC 兼容语义复审 RED：IPC handler 不负责把旧 `attempt` 字段迁移为 `generation`，也不应给 SSH/VPS 部署虚构本地连接代次或状态；需要保留的兼容改动只有 `wgRelay:tunnel-up` 把旧 `connecting` 阶段映射为七态中的 `starting_tunnel`。新增区分测试后执行 `node --test test/wg-relay-ipc.test.js`，共 19 项，18 通过、1 失败；唯一失败为 deploy 仍广播 `starting_tunnel`，同轮 tunnel-up 映射测试通过。
- IPC 兼容语义修复：删除 `wgRelay:deploy` 调用 SSH deploy 前的 `setStatus(starting_tunnel)`；部署进度继续只经 `wgRelay:progress` 广播，成功仍可收敛为 `idle`，失败仍可收敛为 `failed`。`wgRelay:tunnel-up` 的 `starting_tunnel` 写入保持不变。相同 IPC 单文件命令 GREEN 为 19/19 通过、0 失败、0 跳过。
- IPC 语义修复最终验证：执行 `node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/relay-bridge-integration.test.js test/wg-relay-runtime.test.js test/wg-relay-ipc.test.js`，退出码 0，共 116 项，116 通过、0 失败、0 跳过；复跑上列精确 11 文件 mobile/Relay/WG 邻接命令，退出码 0，共 388 项，388 通过、0 失败、0 跳过。再次对上列 6 个生产 JS 文件执行 `node --check`，6/6 退出码 0；`git diff --check` 退出码 0。未读取或使用真实 VPS 凭据，未连接 VPS。
- Task 5 生命周期质量审查 RED：`node --test --test-name-pattern='failure and synchronous upper-layer stop share one bounded termination' test/wg-relay-sidecar.test.js` 为 0/1 通过，实际 kill 序列为 `TERM,TERM,KILL,KILL`；`node --test --test-name-pattern='same-profile reconnect|duplicate disconnect and dispose' test/wg-relay-connection.test.js` 为 0/2 通过，分别观察到 new-start 早于 old-stop-complete 与 Promise 未合并；`node --test --test-name-pattern='same-generation Relay reopens|replacing an unhealthy local' test/relay-bridge-integration.test.js` 为 0/2 通过，观察到 local socket 被覆盖泄漏且旧 socket/timer 未清；legacy late-config/disable-race 筛选同为 0/2 通过。资源释放的 `clearConfig and dispose scrub`、100 次 record release 与 dispose generation 三个独立筛选均为 0/1 通过；health agent 筛选为 0/1 通过，观察到 `agent` 未设置；七态 settings browser 筛选为 0/1 通过，首先观察到 `idle` 显示裸 key。
- Task 5 生命周期质量修复：每个 sidecar attempt 只创建一个 `terminatePromise`，`_fail` 在 emit 前建立终止，stop/dispose 复用，故每代至多一次 TERM 与一次必要 KILL。connection 以 per-profile stopping tombstone/queued connect 串行 release，不阻塞其他 profile；disconnect/dispose Promise 合并。record release 幂等执行 detach → bridge stop/clearConfig/dispose → sidecar stop/dispose，并从 active/allBridges/allSidecars 移除；100 次循环后对象 config token 为空、failure listeners 为 0，connection dispose 不再二次触碰旧对象。health 明确使用 `agent:false` 与 `Connection: close`，成功、HTTP 失败、AbortSignal 取消后服务端连接均归零。
- RelayBridge/legacy 质量修复：同 generation Relay reopen 复用 OPEN 或 CONNECTING local socket；替换不健康 socket 时先关闭并保留到 close/stop 回收，清 local reconnect timer，stop 覆盖当前及 replacement-in-progress 集合。legacy `init(prefs)` 统一进入 generation/revision-aware reconcile runner：enabled 但配置稍后补齐会启动；变更按 stop→重新校验 enabled/config/generation→start；禁用赢过异步 restart。`clearConfig()`/`dispose()` 清 url/token、socket、timer、prefs listeners 与 EventEmitter listeners，重复清理不增加 generation。
- settings 最小兼容：不改 runtime 七态、不新增 i18n key；`starting_tunnel`/`verifying_relay`/`connecting_relay` 复用已有 `remoteSshStatus_connecting`，`disconnecting` 复用 `remoteSshDisconnect`，idle/connected/failed 复用对应已有状态文案。四个 busy 状态禁用 Tunnel Up/Down、deploy 与 regen 重复操作。新增真实渲染 sandbox/browser 用例 GREEN 为 1/1。修改前完整 settings 命令 `node --test test/settings-tab-wg-relay.test.js` 为 12 项中 10 通过、2 失败；修改后为 13 项中 11 通过、2 失败，失败仍精确是既有 `settings-i18n.js` 缺少五语言 `sidebarWgRelay`/WG Relay key，故本次状态映射未新增失败，也未以 Task 5 名义扩张 Task 7 全量文案。
- Task 5 质量修复最终 Node 验证：`node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/relay-bridge-integration.test.js test/wg-relay-runtime.test.js test/wg-relay-ipc.test.js` 退出码 0，129/129 通过；上列精确 11 文件 mobile/Relay/WG 邻接命令退出码 0，388/388 通过；`node --test --test-name-pattern='Node manager and the real Go protocol keep running after stdin EOF until stop' test/wg-relay-sidecar.test.js` 退出码 0，真实 Node→Go smoke 1/1 通过。
- Task 5 质量修复最终 Go/静态验证：在 `sidecars/wg-relay-tunnel` 执行 `go test ./... -count=1` 与 `go test -race ./... -count=1`，普通/race 均报告唯一 package `ok`；`go vet ./...` 退出码 0、无输出。执行 `for file in src/wg-relay-error-codes.js src/wg-relay-sidecar.js src/wg-relay-connection.js src/relay-bridge-integration.js src/wg-relay-runtime.js src/wg-relay-ipc.js src/settings-tab-wg-relay.js; do node --check "$file"; done` 为 7/7 退出码 0，`git diff --check` 退出码 0。未读取或使用真实 VPS 凭据，未连接 VPS；整个一键功能仍处于实施中，未将 Task 6–12 标为完成。

### Task 6：Electron deploy/connect/rotate IPC 与安全持久化集成（2026-07-14）

- 初始 RED：`node --test test/wg-relay-pairing-qr.test.js` 因 `src/wg-relay-pairing-qr.js` 不存在以 `MODULE_NOT_FOUND` 退出；新 Task 6 IPC 合同用例 10/10 失败，preload 边界用例 3/3 失败，main 集成用例 4/4 失败。后续状态消息脱敏与 pending deploy dispose 两个定向回归也分别先观察到失败，证明测试先于对应实现运行。
- IPC 与边界：`IPC_CHANNELS` 明确列出 `wgRelay:deploy`、`connect`、`disconnect`、`rotate-phone`、`delete-local`、`pairing-qr`、`status`、`list-statuses` 八个新合同；`LEGACY_CHANNELS` 另列当前 Task 7 前 UI 仍使用的 `tunnel-up`、`tunnel-down`、`tunnel-status`，测试断言完整 handler 集合恰为 8+3。profile 先经 canonical public sanitize；SSH password 只存在于单次调用参数并在 `finally` 清除。未知 SSH host key 只可经注入的 Electron dialog 明确确认 TOFU，已保存指纹不匹配直接拒绝。settingsController 是唯一 public profile writer；renderer 只收到 public profile、PNG data URL 和仅含 `profileId/status/generation/errorCode` 的值级 allowlist 状态，固定 progress 阶段同样不复制 message/hint/token-like 字段。完全未知 disconnect 在无 public profile、durable recovery 或 active/stopping 状态时直接返回 generation 0 idle 并清 runtime，不调用 connection manager；recovery read 失败则固定 fail closed，未知 ID 不进入内存 recovery map。
- 不可逆 commitPoint：deploy 在远端 exit 0/readback 响应后视为已提交；无法证明远端未提交的 SSH/transport 失败同样保留 prepared 并禁止旧凭据，只有显式 `remoteCommitted=false` 或 host-key/password 等确定请求前失败才删除 tombstone。rotate 以管理 POST 收到 HTTP 2xx 为远端提交点；请求已发送后超时/断连也按不确定提交处理，只有 loopback/auth 校验、明确非 2xx 等可证明 pre-commit 的分支才删除 prepared。每次远端请求前执行 safeStorage encrypt/decrypt roundtrip 与真实 temp/chmod/fsync/rename 可写 preflight，随后原子持久化 `prepared`，完成 fsync 后才允许 SSH/POST。远端响应先把 bounded raw candidate 加密更新为 `remote_committed`，再做完整 readback/phone 业务校验和主 secrets 前滚，绝不恢复旧 secrets、旧 token 或旧 QR。
- durable recovery journal：secret store 向后兼容读取 v1/v2，并在下一次写时原子升级为 v3 `{version:3,revision,profiles,recovery}`；两个 map 都是 profileId → 独立 safeStorage 密文 blob，磁盘不含 private key/token/raw candidate。每次写使用同目录随机唯一 temp，以 `O_CREAT|O_EXCL|O_NOFOLLOW` 和 `0600` 打开，fd 经 `fchmod/fstat` 验证 regular/owner/mode，文件 fsync、rename 后再 fsync 父目录；target、lock、userData 目录的 symlink/non-regular/owner/mode 均 fail closed，失败清理只删除本次创建且 inode 相同的 temp。所有 read-modify-write 由同目录安全 `O_EXCL` lock 串行化，live lock 有界超时，完整 dead-PID stale lock 才可回收；24 个独立 Node writer 的 48 次 mutation 最终 revision=48 且无丢失。顶层 JSON/schema 损坏仍全局阻断；合法 profile ID 的 malformed base64/decrypt 失败只阻断该 entry，原 blob 在其他 profile 写入时原样保留，recovery list 仍列出坏 ID供 IPC profile-local fail closed。主 secrets write+readback 与必要 public profile write 都成功后才删除 journal；candidate journal 更新失败时 durable prepared 仍保留，当前进程另用 `recoveryBundles` 暂存 candidate。
- 跨实例前滚与部分成功：IPC 注册时加载 journal 但不 auto-connect；每次 `connect`、`pairing-qr`、`status` 都重新读取 durable recovery。valid `remote_committed` deploy candidate 必须通过精确字段集、pc/phone Config、endpoint/subnet/Relay URL、WG keys、两个不同 Token 的完整 readback validator；rotate candidate 合并旧 pcConfig/managementToken 后再通过严格 phone/Relay 模型。验证并写回主 secrets 后才允许 probe/连接。prepared、invalid、corrupt 或不可解密记录统一返回 `remote_commit_recovery_required`，禁止 Task 5 manager 读取旧 credential；另一实例执行 delete-local 后，durable journal 消失会使旧进程 recovery cache 失效，不能复活 profile。稳定 post-commit 结果继续使用 `partial_success + retryable` 与 `local_storage_retry_required`、`public_profile_retry_required`、`connection_retry_required`、`pairing_qr_retry_required`。
- deploy CAS/rotate/配对模型：deploy 开始把 sanitized public profile 与“是否已存在”写入 prepared/committed journal。远端提交后先写验主 secrets，再由 settingsController 的单个 `wgRelay.commitDeploy` 命令在 `wgRelay` lockKey 内原子 compare+merge+commit：当前 topology 与起始 host/SSH/WG 字段不一致或既有 profile 已删除时保留 durable recovery、返回 `profile_conflict_recovery_required` 且不连接；仅 label 等非拓扑编辑会保留，部署只 patch fingerprint/endpoint/relayAddr/time/version，绝不复活 profile。rotate 仅通过 sidecar loopback forward endpoint 调用 WireGuard 内网管理 API，Bearer、deadline、请求/响应大小、content-type、no redirect 和关闭连接均有界。phone INI 精确一个 `[Interface]`/`[Peer]`，允许标准 `#`/`;` 整行注释但不剥离 inline 注释，仍拒绝重复/未知/被污染字段。QR 使用既有 `qrcode` 生成 8 KiB 内的 version 1 deep link；主进程不缓存 PNG，每次从当前 public profile 与加密 secrets 按需生成，renderer 不获得 raw payload。
- RelayBridge/main：app ready 后按真实 `userDataPath/resourcesPath/isPackaged/platform/arch` 创建 secret store、sidecar、Task 5 connection manager 与 IPC，不启动任何 profile。Task 6 main integration 与 legacy `src/server.js` 生产入口都注入 `getLocalToken/getLocalPort` provider；RelayBridge 每次建立本地 socket 时读取当前 Mobile Server token 和实际动态端口。真实集成测试使用真实 RelayBridge、真实 MobileWSServer 与随机 loopback 端口验证认证，token 不进入日志/status。safeStorage unavailable 或 Linux `basic_text` 时功能稳定 fail closed，但主 app 可运行。
- delete/quit：delete-local 在任何破坏性副作用前，先把该 profile 的既有 prepared/committed recovery 原子替换并 fsync 为精确的无 secret 记录 `{version:1,phase:"delete_pending",operation:"delete"}`；写入失败立即返回 `delete_prepare_failed`，不 disconnect、不删除 secret/public/QR/runtime，也不改变旧 journal。墓碑落盘后才串行执行 disconnect → secret/public/QR/runtime 清理，全部成功后最后移除 recovery；任一步或最终 journal remove 失败都保留 `delete_pending`。IPC 初始化以及每次 connect/pairing/status/rotate recovery probe 遇到该 phase 时只能继续幂等删除，绝不能前滚旧 candidate 或复活 profile，排队中的 connect/quit 同样受每 profile 串行队列约束。runtime 的单 profile `removeStatus()` 清 status 与 pcConfig；删除后的 late status event 会被 tombstone 同步再次清除。正常 quit 的 flush 只是 durable journal 的补充；prepared/invalid 已安全落盘时不得因为无法自动前滚而永久阻止退出。
- 极端恢复边界：prepared tombstone 在远端请求前完成文件与父目录 fsync，因此请求期间强杀、崩溃、断电或 OS 终止后，新实例仍会阻止旧 credentials。若远端已成功但 raw candidate journal 更新与主 secret 写入都失败，重启后至少保留 prepared，返回 `remote_commit_recovery_required`；此时可能需要 SSH/远端 repair 才能恢复可用连接，但绝不会误用旧 token。只有存储硬件/文件系统在文件与父目录 fsync 成功后仍违反持久性保证，或 journal 被外部破坏，才超出 Electron 可保证边界。
- 本轮规格审查 RED：secret preflight 定向用例先为 0/1；commitPoint IPC 初始 19 项中 8 失败；动态 Mobile token 0/1；真实 main Bridge 0/1；最小状态 schema 0/1；非法 phone topology 0/2；runtime clear 0/2；deploy failure allowlist 0/1。独立复审新增并复现：canonical public sanitize commitPoint 0/1、HTTP 2xx invalid/timeout commit 标记 0/2、legacy server token provider 0/1、stale old-token reconnect 0/1、队列当前 profile/recovery/delete/quit 0/4、生产 progress 与 late runtime 0/2。每项均先观察到预期失败，再做最小实现。
- durable journal 复审 RED/GREEN：secret store v1 migration、跨实例 encrypted recovery、remove/corrupt 三项先 0/3，v2 API 后 3/3；deploy prepared/raw helper/invalid rotate 四项先 0/4，修复后 4/4；真实文件跨两个 store/IPC 实例的 valid candidate、prepared、invalid candidate 三项先 0/3，durable load/forward 后 3/3，全部验证 `oldCredentialAttempted=false`；注册后 journal 三 probe 先 0/1，逐次 resync 后 1/1。后续独立审查的 ambiguous deploy、双实例 delete cache、ambiguous rotate、durable prepared quit、完整 deploy schema、重启非法 candidate、父目录 fsync、超限 candidate 旧连接/QR 清理、profile-local recovery read failure 均先按定向测试观察到 RED，再逐项 GREEN；main 启动 prepared journal 用例验证 0 次 auto-connect。
- delete_pending 复审 RED：定向命令 `node --test --test-name-pattern='delete-local aborts|delete_pending survives|repeated delete-local remains|delete_pending is durable|disconnects first' test/wg-relay-ipc.test.js` 为 0/5；失败分别证明旧实现未在 disconnect 前写 durable tombstone、tombstone 写失败仍产生删除副作用、final remove 失败会留下旧 committed candidate、部分删除不保留删除意图，以及 delete/connect/quit 竞态没有 durable gate。最小状态机实现后相同命令为 5/5；真实 secret store 跨两个 IPC/store 实例验证实例 A 最终 remove 失败后 `journalSurvived=true`，实例 B 启动只继续删除且 profile/secrets 均未复活、从未调用旧 credential connect。
- bounded quit abort：每个 deploy/rotate 都持有 operation AbortController，IPC dispose 在等待 per-profile queue 前先 abort。signal 贯穿 IPC → deploy → password ssh2 bundle/compat exec、key-auth `spawnAndWait` 与管理 HTTP；取消会清 timer/signal/stream listener，关闭 SFTP、销毁 active channel/client/request 或 SIGTERM child，并固定返回 `deploy_aborted`/`rotate_aborted`。远端是否提交不确定时 prepared journal 保留并阻断旧 credential；明确尚未发请求才可删除。真实 never-ready fake ssh2、late SFTP、active installer、hung HTTP 和 hung key child 均无需测试 gate 即有界退出，late callback 不再恢复操作。
- 本轮六项质量审查 RED：secret-store 全文件命令为 16/24，8 项按预期失败并覆盖 schema revision、单 entry 隔离、随机 no-follow temp、store/lock/tmp symlink、权限/类型、live/dead lock 与 24 进程丢更新；IPC/QR 定向为 1/8，7 项失败覆盖 8+3 channels、label/topology/delete CAS、5000 unknown disconnect、QR cache 和 INI 注释；abort 定向为 0/7，never-ready ssh2 实际等满 5 秒，key child 另为 0/1；原子 settings CAS 为 0/2；recovery-read DoS 与 active installer listener 各为 0/1。每组都先复现目标失败再做最小修复。
- 本轮质量审查 GREEN：Task 6/secret/deploy/SSH/main/QR/settings 十文件精确命令为 289/289、0 失败、0 跳过；真实 Bridge 筛选为 1/1。Task 1–5 WG/Relay/settings 邻接 15 文件为 480/480、0 失败、0 跳过（原 451 项继续通过）。24 个独立 Node 进程并发写入筛选探针为 1/1；SSH/key child/HTTP/IPC dispose 取消链路筛选为 10/10，其中 never-ready SSH 的 dispose 探针约 182 ms，低于 2 秒目标。对全部 changed JS 执行 `node --check`，并执行 `git diff --check`，均退出码 0。本状态保持“Task 6 实现待复审”，不提前标为完成。
- 本 Task 未读取或使用真实 VPS 凭据，未连接或访问真实 VPS；未修改 Task 7 UI、Android、打包或 CI。整个一键 Relay 仍处于实施中，Task 7–12 尚未标为完成。

### Task 7：PC 最小步骤一键部署向导与已部署状态卡（2026-07-14）

- 初始基线与 RED：修改前 `node --test test/settings-tab-wg-relay.test.js` 为 13 项中 11 通过、2 失败，两个失败精确为五种桌面语言全部缺少 `sidebarWgRelay` 与 WG Relay 设置文案；没有把它们误归为本轮新回归。先仅修改测试后，同一文件 14/14 按预期失败；browser 新增的 Task 7 两项也 2/2 失败，证明旧多 profile/旧 tunnel UI 不满足四字段、Task 6 API、进度、状态卡、QR 与生命周期合同。
- 首次/未部署向导：页面收敛为单张卡，只显示公网 IP/域名、SSH 用户名、SSH 端口和 SSH 密码；用户名/端口默认 `root`/`22`。首次路径固定使用 `51820`、`10.8.0.0/24`、`7891`，仅在修复/高级卡中展示。主按钮只调用 `window.wgRelay.deploy({ profile, password })`；公开 profile 不含 password，renderer 不调用 settings command、旧 tunnel API 或本地二维码生成 API。
- 密码与错误边界：password 只存在于当前 input、同步 deploy 参数和随即清空的局部变量；提交后立即清空 input，无论 Promise 成败，不写 view/profile/prefs/dataset/log。输入使用 `type=password`、`autocomplete=new-password`。renderer 只按稳定 `errorCode` 选择五语言安全文案；细分 sidecar/health/Relay/connection code 映射到本地化类别，忽略 raw message、stderr 和未知 secret-like 内容。
- 进度与日常状态：生产的 11 个 SSH/install progress step 映射为用户既定的 10 阶段，显示 pending/current/completed/failed 并使用 `aria-live`。部署结果再收敛保存、PC 连接和 QR 三阶段。部署后只显示一张 VPS 名称/公网地址状态卡；七态 `idle/starting_tunnel/verifying_relay/connecting_relay/connected/disconnecting/failed` 独立本地化，主操作只走 `connect`/`disconnect`。
- 配对、修复与删除：二维码只在用户点击后调用 `pairingQr`，dialog 带 title/alt/敏感数据警告、初始焦点和 Escape；关闭、切换页面、重新配对替换或删除成功时都把旧 `<img>` 的 `src` 属性/属性值和 renderer 引用清空。重新配对先确认“旧手机立即失效”，调用 `rotatePhone` 并在 busy 状态替换 QR；修复重新要求 SSH 密码且不复用旧值；删除确认明确 VPS 服务继续运行，只调用 `deleteLocal`。
- 恢复、busy 与竞态：`remote_commit_recovery_required`、`profile_conflict_recovery_required` 及同类 recovery code 无论来自 `status` 还是 `errorCode` 都显示“需要修复/重新部署”并禁用连接。任一 operation 或四个 runtime busy 状态会禁用重复/破坏动作；双击复用同一个 renderer in-flight Promise。每次 rerender 先退订旧 status/progress listener，`onExit`/`dispose` 再清理 listener 与 QR。view epoch 阻止切页后的 deploy late result 写回；status revision 阻止初始 `status()` 的迟到成功或拒绝覆盖更新的实时事件；已有未部署 profile 的成功结果在 settings broadcast 到达前使用 public profile override 显示状态卡。
- 响应式与可访问性：所有 label 关联 input，按钮显式 `type=button`，错误与进度使用 `aria-live`，QR 使用 modal 语义和 alt；focus-visible 清晰。`420px` 以下（覆盖 320px）全部动作/字段单列，长公网地址和错误 `overflow-wrap:anywhere`；所有 viewport 单位按 `--clawd-text-zoom` 补偿，并提供 `prefers-reduced-motion`。
- i18n：en/zh/zh-TW/ko/ja 的 Task 7 keyset 完全一致，无裸 key fallback；英文与简体中文使用产品既定“一键部署 / 远程连接 / 旧手机立即失效 / VPS 服务继续运行”语义，其余三种语言提供可理解翻译。既有两个 WG i18n 失败已修复。browser 基线另有四个与 Task 7 无关的 General 页 source-format 断言；核对生产行为后只把它们改成等价的空白无关语义 regex，没有修改 General 生产代码。
- 后续审查 RED/GREEN：recovery code 从 `status` 字段进入时先 0/1，修复后 1/1；已有未部署 profile 的即时收敛、initial status late resolve、runtime bridge 缺失全禁用先 0/3，修复后 3/3；initial status late reject 先 0/1，修复后 1/1；health 子码安全本地化先 0/1，修复后 1/1。两轮独立自审分别覆盖 A–G 规格一致性和 secret/QR/race/listener 边界；当前工具环境没有可调用的 reviewer subagent，因此不伪称已完成 AGENTS.md 要求的子代理交叉审查，整体状态保持“Task 1-7 实现待双审查”。
- 最终 GREEN：`node --test test/settings-tab-wg-relay.test.js test/settings-renderer-browser-env.test.js test/i18n.test.js test/settings-tab-remote-ssh.test.js test/doctor-modal-no-active-integrations.test.js` 退出码 0，共 184 项，184 通过、0 失败、0 跳过；其中 Task 7 聚焦文件为 20/20，browser 全文件为 143/143。`node --test test/wg-relay-preload.test.js test/wg-relay-ipc.test.js test/main-wg-relay-integration.test.js test/settings-ipc.test.js test/settings-actions-wg-relay.test.js test/wg-relay-runtime.test.js test/wg-relay-connection.test.js` 退出码 0，共 169 项，169 通过、0 失败、0 跳过。对两个生产 JS 与两个改动测试 JS 执行 `node --check` 全部退出码 0；`git diff --check` 退出码 0；授权范围检查只列出 Task 7 允许的 6 个文件。
- Important 质量审查 RED：先只增强既有 20 项行为 harness，不增加 DOM/前端依赖。初始定向运行分别在 `validate` 后最后三阶段仍 pending、status rejection 不重试、blocking storage error 仍保留禁用 Connect、repair form 被 status event 重建、QR 未 inert/focus trap/回焦、rotate/delete 没有 renderer owner modal，以及 CSS 缺少正式 light/dark 语义 token 处失败。第二轮收紧又先复现完整 rerender 后焦点仍留在已脱离 DOM 的 QR close、secret-store preflight/verification 与本地卡片对应的 `profile_not_found` 未分类为 repair-required，以及 `.wg-relay-progress-state` 的 `opacity: 0.72` 使 token 计算高估实际对比度。
- overlay 与危险确认：WG Relay view 现在只有一个 overlay owner；confirm 开始同步捕获 owner token、epoch、profileId、status revision 并占用同一个 busy/in-flight record，双击返回同一 result Promise。取消按钮默认聚焦，Tab/Shift+Tab 在 owner dialog 内循环。rerender、onExit、dispose 会把 pending confirm 结算为 false 并移除 capture listener；Promise 返回后必须再次匹配 token/record、epoch、profile、revision 和 busy 才能调用 rotate/delete。每个关闭路径只移除自己的 backdrop；旧 QR close 或旧 confirm 按钮不能清除/执行新 owner。
- QR 与 repair 生命周期：QR 记录触发按钮，打开时把设置内容设为 `inert` 并保存/设置 `aria-hidden`，Escape、关闭、替换、rerender 和 dispose 都清 PNG `src`、capture listener、inert/ARIA 与 renderer 引用；原节点仍在时立即回焦，完整 rerender 时按非敏感按钮文案在新 DOM 完成后回焦。FakeDOM 增加 connected/contains/focus/inert/remove-listener 和真实正反向 Tab 行为。repair 的非秘密 draft 按 profileId 存在 view Map，input 事件实时更新；密码仍只存在当前 DOM input。status event 与初始 status settle 只 patch 已挂载状态卡，不替换 repair 节点，因此 host/port/subnet/password 和焦点保持到 submit/cancel/tab switch，提交立刻清密码。
- status、恢复分类与进度：status request 每次带 profile/epoch/revision/attempt identity，settle 只清自己的 identity；Promise rejection、同步 throw 与 malformed result 都按 80/240 ms 最多重试两次（总计三次），timer 受 epoch/revision 约束并在退出时取消，实时 status 仍优先于 late request。`secure_storage_unavailable`、`secret_store_read_failed`、secret-store preflight/verification、`secrets_not_found`、`profile_not_found` 和 recovery/conflict code 统一显示 repair-required，主按钮变为 Repair，不保留可点击 Connect。Task 6 当前没有独立 QR progress 事件，故 renderer 不虚构定时阶段：生产 `validate:ok` 证明远端验证结束并把 save 置 current；持久化完成后才可能收到 `starting_tunnel/verifying_relay/connecting_relay`，据此完成 save 并把 pc_connect 置 current，释放旧连接的 `disconnecting` 不算 PC connect 证据；`connected` 完成 pc_connect 并把 qr 置 current；仅 deploy 原子 Promise 返回包含 QR 的成功结果后完成 qr。没有修改 Task 6 核心 IPC。
- 对比度与本轮 GREEN：settings light/dark 根分别正式定义 WG Relay neutral/warning/success/danger text/background、current text 与 progress background token；测试以纯函数解析实际 hex/rgba，把半透明背景合成到各主题 `--panel-bg` 后计算 WCAG contrast。warning/success/danger/neutral 状态与 pending/current progress 小文本均不低于 4.5:1，本组最低为 light pending 的 4.90:1；progress state 不再叠加降低前景对比度的 opacity。最终聚焦文件 20/20、Task 7 组合 184/184、Task 6 邻接 169/169，均为 0 失败、0 跳过。本轮状态继续保持“Task 1-7 实现待双审查”，不提前标记完成。
- 剩余复审 NodeList RED/GREEN：FakeDOM 的 `querySelectorAll` 改为 NodeList-like，只提供 iterator、`forEach`、`item`、数字索引和 `length`，明确不提供 `filter/find/every`。新增语义探针先在 renderer 直接调用 NodeList `.filter/.find` 处 RED；生产文件全部 8 处 `querySelectorAll` 随后先经 `Array.from` 再做 Array 操作或遍历，QR Tab trap、完整 rerender 回焦、onExit 密码清理与 listener 清理在该 FakeDOM 下继续 GREEN。聚焦文件因此从 20 项增为 21 项。
- save current 序列 RED/GREEN：Task 6 真实远端末端事件为 `validate:start/fail/ok`；新增序列断言先证明 `validate:ok` 后 save 仍为 pending。renderer 现在只在真实 `validate:ok` 且 save 尚 pending 时置 `save=current`，不使用定时器，也不把 `readback` 或旧连接的 `disconnecting` 当成本地保存/PC 连接证据；`starting_tunnel/verifying_relay/connecting_relay` 才完成 save 并置 `pc_connect=current`，`connected` 完成 PC 连接并置 QR current，含 QR 的 deploy 成功结果最终完成 QR。最终 Task 7 原 184 项加新探针为 185/185，Task 6 邻接保持 169/169，均 0 失败、0 跳过；状态仍为“Task 1-7 实现待双审查”。
- 本 Task 未读取、请求或使用真实 VPS 地址/凭据，未访问 VPS；测试只使用保留域名和明确的 unit-test-only 占位值。未修改 Task 6 核心 IPC/main、Android、打包或 CI。

### Task 8：Android versioned QR 配对与加密持久化（2026-07-14）

- PC schema 与跨语言 fixture：实现前完整读取 `src/wg-relay-pairing-qr.js` 与 `test/wg-relay-pairing-qr.test.js`，Android 字段顺序和语义精确对应 `version/name/wireGuard/relay/issuedAt`。固定向量由当前 PC `buildPairingDeepLink()` 使用显式 fixture key、RFC 5737 Endpoint 和固定时间生成；Android 测试先校验完整 URI 的 SHA-256 `6176404493ba1fc27408cfa52c0683da476ddf087dbd59556aaab10cdd96000f`，再逐字段断言解析结果。另一项集成测试直接调用仓库已有 Node 与当前 PC encoder，只输出并比较 SHA-256，不输出 URI/fixture secrets，防止两端 schema 静默漂移。
- parser RED/GREEN：新增测试后聚焦命令先在 `RelayPairingConfig`、typed error 等符号不存在处编译失败；实现后 11 个 parser 用例与跨语言用例 GREEN。解析器限制 URI 8 KiB、JSON 6 KiB及字段长度，只接受精确 `clawd://relay-pair?v=1&data=<canonical base64url JSON>`；拒绝大小写混淆、userinfo/fragment、重复/额外 query、非规范 base64url、非规范/尾随 JSON、duplicate semantic JSON key、未知字段、missing/wrong type 和未知版本。`Json` 使用 `ignoreUnknownKeys=false`、`explicitNulls=false`，duplicate key 在反序列化前由有界结构扫描器拒绝。
- WireGuard/Relay 安全模型：两份 WG key 必须为规范非零 32-byte base64 且不同；Address 必须是私有 `/24` 派生的 `.3/32`，AllowedIPs 精确且仅有同一私网 `.0/24`，Relay URL 精确为该子网 `.1:7891` 的 `ws://`；Endpoint 只接受合法 domain、IPv4 或括号 IPv6 与 `1..65535` 端口，keepalive 精确为 PC schema 的 `25`，Token 精确 64 hex。模型全为不可变值，所有 `toString()` 与稳定异常只暴露安全 code/`REDACTED`，不回显 URI、key 或 token。
- 持久化 RED/GREEN：`PrefsStoreTest` 先因 `save/load/clear/hasRelayPairing` 不存在而编译失败；实现使用既有 `EncryptedSharedPreferences`，完整 pairing 保存为一个带 `storageVersion=1` 的 blob，不进入普通 config/history/manual 字段。替换先原子 commit pairing、严格 readback，再清 obsolete `relay_url/relay_token`；commit、readback 或 manual cleanup 失败均尝试恢复旧 pairing/manual。后续时序审查新增两项先 RED，证明旧实现过早删除 manual 且 cleanup failure 未回滚；调整后 `PrefsStoreTest` 42/42 GREEN。损坏、未知版本、decrypt failure 均 fail closed且不影响 LAN config/history，clear 幂等；旧 manual URL/token 绝不合成 WireGuard pairing。
- 扫码/deep link 路由 RED/GREEN：集成测试先因 scan result、coordinator 与 deep-link router 不存在而编译失败。`ScanScreen` 现在区分 LAN、Relay 与 typed invalid Relay；本地化错误只显示稳定类别并允许重新扫描。`MainActivity` 同时接受 camera 和 `ACTION_VIEW`，成功保存后只发非敏感整数 Settings 请求，Relay 分支不调用 `WsConnectionService.start`，也不启动 VPN。原始 deep link 不写 log、Toast 或 saved state；saved state 只保存非敏感整数导航请求 ID。语义 fingerprint 每次进程启动都从 EncryptedSharedPreferences 解出的规范 pairing 字段重新计算；失败不覆盖旧 pairing，相同配置在 onNewIntent、rotation、重复扫描或进程重启后均不重复保存/导航。
- 一次性 Settings 导航：用户明确授权最小扩展 `NavGraph.kt` 和对应测试。默认 `startDestination` 仍为 `sessions`；graph 未就绪时不消费请求，成功后按 `navigate(settings) → Activity 清零 pending → rememberSaveable 记录 consumed` 顺序执行，已经位于 Settings 时只消费不叠栈。导航测试最初因 decision/helper 不存在而 RED；启动时序与 rotation 顺序的两个复审测试也分别先 RED，最终 7/7 GREEN。
- Task 8 三项规格审查 RED/GREEN：冷启动测试先因 `initialPairing`、`initialStorageUnavailable` 与 `hasRelayPairingBlob` 不存在而编译失败；实现字段长度分隔的 SHA-256 语义 fingerprint 后，新 coordinator 对 storage round-trip 的相同对象返回 duplicate、不同字段正常保存，存在但 corrupt/decrypt failure 的 blob 阻断覆盖。IPv4-mapped IPv6 的 Android 与真实 PC encoder 两项先 0/2，JDK mapped address 兼容后 GREEN；括号 host 仍要求含冒号、无 zone 且能作为 IP literal 解析。keepalive 精确值测试先 0/1，Android 从 `1..120` 收紧到仅 `25` 后 GREEN，`0/1/24/26/120/121` 全部拒绝。
- semantic duplicate 复审 RED/GREEN：集成测试直接调用当前 PC `buildPairingDeepLink()`，对同一规范配置生成两个仅 `issuedAt` 不同的 URI，并用新 coordinator 模拟冷启动。旧 fingerprint 因包含 `issuedAt` 将第二张码误判为新配置而 RED；实现仅从 fingerprint 排除 freshness-only `issuedAt` 后返回 duplicate，save/navigate 均为 0。`version`、label/name、WG private/server key、Endpoint、Address/AllowedIPs/keepalive 及 Relay URL/token 仍全部参与长度分隔的 SHA-256；PC 向量另验证 label、relay token、private key、endpoint 或私网子网拓扑任一变化均产生不同 fingerprint 并正常原子替换。
- 初版聚焦验证：在 `android/` 执行 `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=$HOME/.local/android ./gradlew testDebugUnitTest --tests '*RelayPairing*' --tests '*PrefsStoreTest*`，退出码 0，共 72 项，72 通过、0 失败、0 跳过；组成是 parser 11、跨语言/路由 integration 12、导航 7、PrefsStore 42。后续质量修复继续扩展到下述 100 项。
- 初版 Android 邻接/编译/lint 验证：相同环境执行组合命令 `./gradlew testDebugUnitTest lintDebug assembleDebug`，退出码 0；当时完整单测共 623/623（34 suites）、0 失败、0 跳过。该证据已由本轮最终验证取代。
- 初版两轮自审覆盖 parser/schema/secret 泄漏与 persistence/navigation/rotation 时序；随后已使用独立 subagent 完成规格与质量交叉审查，不再保留“待双审查”结论。
- 本 Task 未读取、请求或使用真实 VPS 地址/凭据，未访问 VPS；测试仅使用 RFC 地址和显式 fixture secrets。未修改 WireGuard 依赖/VPN（Task 9）、远程连接 UI（Task 10）、打包或 CI。
- Task 8 durable journal 质量修复：`PrefsStoreTest` 的 fake `Editor` 采用真实 staging，并把当前进程 `memoryValues` 与重启后可见的 `durableValues` 分离。依据 Android `SharedPreferences.commit()` 文档契约，`false` 表示没有成功写入持久存储，但进程内 map 仍可先看到 staged 值；fake 不再允许与契约矛盾的 `result=false` 且完整 durable write。新增 marker commit=false 时内存可见 committed/candidate、rollback 同样失败、随后模拟进程重启的用例，要求保存返回 false 且只恢复 previous。prepared/committed journal、完整 candidate/previous readback、rollback 与 cleanup 的每次 commit 都检查结果；损坏或混合状态 fail closed。
- Task 8 外部确认与重建竞态修复：外部 URI 被读取并立即从 Activity Intent 清除，解析出的 config 在任何可取消 IO 前同步进入不使用 `SavedStateHandle` 的 retained `ViewModel`。`PREPARING/AWAITING_CONFIRMATION/CONFIRMING` phase 与递增 attempt token 使新 Activity 的同 config 恢复也能废弃旧 callback；`CancellationException` 不再被转换成存储失败。确认保存中重建时，未保存则续接 confirm，已保存则由当前 attempt 补发 Settings 导航；外部 coordinator 不在 token 校验前导航。Bundle 仍只保存非敏感整数，确认框只显示名称和 Endpoint。
- Task 8 camera 生命周期修复：analyzer 以 `AtomicBoolean` claim/disposed gate 保证一次消费，主线程 callback 在执行前再次检查 disposed。`CameraBindingLifecycle` 分离 analyzer attach 与成功 bind：未绑定的迟到 provider callback 只 `clearAnalyzer`；成功绑定后只调用 `cameraProvider.unbind(preview, imageAnalysis)` 精确释放本次 use case，不再使用会影响新页面的 `unbindAll()`。线程交错测试覆盖 bind return 与 dispose 竞速并断言 clear/精确 unbind 各一次。provider 获取或 bind 失败显示可重试提示；重复 pairing 显示“已配对”并可重新扫描，不保存、不导航且不会卡在永久 claimed 的黑屏。
- Task 8 TDD 证据：事务、外部确认、Activity 重建、取消传播、attempt token、Camera provider failure 和精确解绑均先出现缺符号编译失败或目标断言失败；相机真实线程交错测试还先观察到合法的 unbind/clear 反向顺序，随后把断言收敛为各一次而不强制无意义顺序。最终聚焦命令强制 `--rerun-tasks` 后为 100/100、0 failure/error/skipped。
- Task 8 独立双审查：规格审查四轮复演 URI 清除后立即旋转、commit 后取消、保存失败后旋转和新链接覆盖旧异步结果；最终为 0 Critical、0 Important、0 Minor。质量审查推动修复 commit=false 内存/磁盘模型、CameraX 全局 unbind、取消与恢复竞态；统一存储契约后的最终复审同样为 0 Critical、0 Important、0 Minor。Task 8 规格与质量均通过。
- Task 8 最终验证：`./gradlew --no-daemon testDebugUnitTest --rerun-tasks` 退出码 0，XML 汇总 35 suites、651/651、0 failure/error/skipped；`./gradlew --no-daemon lintDebug --rerun-tasks` 退出码 0，31/31 tasks；`./gradlew --no-daemon assembleDebug --rerun-tasks` 退出码 0，41/41 tasks并生成 debug APK。PC `node --test test/wg-relay-pairing-qr.test.js` 为 7/7。`git diff --check` 退出码 0，授权范围仅为 Task 8 Android 文件与本进度记录；未访问 VPS、未使用真实凭据、未修改 Task 9+。

### Task 9：Android 内置 WireGuard（2026-07-14）

- 依赖与配置：固定引入官方 `com.wireguard.android:tunnel:1.0.20230706`；`WireGuardConfigFactory` 只生成一个 Peer、一个私有 `/24` AllowedIP，并通过 `IncludedApplications=com.clawd.mobile` 限制仅本 App 流量进入 VPN，不设置 DNS 或默认路由。
- 生命周期：`ClawdWireGuardTunnel` 使用稳定名称 `clawd-remote`；`WireGuardController` 覆盖未配对、权限请求、启动、已连接、失败、停止和已断开状态，重复 start/stop 合并或幂等，权限拒绝不触碰 backend，错误只暴露稳定错误码。
- TDD 证据：配置与控制器测试分别先因目标类型不存在而 RED；实现后 `./gradlew testDebugUnitTest --tests '*WireGuard*' --rerun-tasks` 为 10/10 通过、0 failure/error。
- Manifest 与主流程复验：`:app:processDebugMainManifest --rerun-tasks` 通过；合并 Manifest 中唯一官方 `GoBackend$VpnService` 为 `exported=false` 且受 `android.permission.BIND_VPN_SERVICE` 保护。主流程使用已有 JDK 17 复跑 `./gradlew --no-daemon testDebugUnitTest --tests '*WireGuard*' :app:processDebugMainManifest`，退出码 0、BUILD SUCCESSFUL。
- 未访问 VPS、未读取或使用真实凭据；真机 VPN 授权、握手及仅本 App 路由的运行时验收统一留到 Task 12。

### Task 10：Android 一键远程连接、回滚与设置界面（2026-07-14）

- 一键事务：`RemoteConnectionCoordinator` 严格执行 `VPN start → 私网 /health → Relay connect`，断开与所有失败路径严格执行 `Relay disconnect → VPN stop`；15 秒总连接超时、重复 connect/disconnect 合并、连接中取消、generation 防迟到完成及仅在用户连接意图仍有效时的网络切换重试均有协程测试。
- LAN/Relay 独立：Service 只在显式 `REMOTE_CONNECT` 时启动远程事务，系统重启只恢复既有 LAN 行为，不自动打开远程隧道；Relay 使用独立 client 与 `SessionMerger` tag，断开远程不清 LAN。内网 cleartext 仅允许固定 `10.8.0.1`，其他目标继续由 base config 拒绝。
- VPN 权限：`VpnService.prepare(applicationContext)` 由 Service 判断，因此 VPN 已授权后的后台网络重试不依赖 Activity；Activity host 只保留 `ActivityResultLauncher`。launcher 经可注入的 main dispatcher 投递，并在 Activity recreation 后只允许当前 host 接收。两项原测试分别先以接口多余 `prepare` 和缺少 dispatcher RED，修复后 `WsConnectionServiceTest` 12/12 GREEN。
- 健康检查与回传契约：Android 对固定 `http://10.8.0.1:7891/health` 使用 5 秒 IO timeout、禁止 redirect、最多读取 1024 bytes；只接受 2xx、`version=1`、`status=ok` 及设计允许的非负 `uptimeSeconds`，拒绝 malformed、错误类型、未知字段、非 2xx 与超限正文，错误不回显正文。先以缺少 validator 编译 RED；又以真实 VPS `uptimeSeconds` schema 运行时 RED 捕获跨端冲突，修复后定向 GREEN。
- 设置刷新与删除：NavGraph 把已消费的非敏感配对 request id 作为单调 refresh revision 传入 Settings；`RelayPairingSnapshotLoader` 只在 revision 改变时重新从加密 prefs 读取，因此停留设置页重新扫码也会刷新。loader 测试先缺符号 RED 后 GREEN。删除严格等待本次新断开终态后才清配对；初始旧 `FAILED` 不再被误当本次结果，该竞态测试先缺 helper RED 后 GREEN。
- Service 销毁：正常显式 stop 在 `stopSelf()` 前等待远程逆序清理；onDestroy fallback 改为由 Service 自身 scope 持有、`UNDISPATCHED` 启动的 cleanup job，完成 disconnect 后才销毁 Relay、清状态并取消 scope，不再创建立即失去所有权的临时 scope。所有权测试先缺 helper RED 后 GREEN。
- 最终 Android 验证：`./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug --rerun-tasks` 退出码 0，XML 汇总 39 suites、688/688、0 failure/error/skipped；lint 与 debug APK 均构建成功。无 Android 真机或 emulator system image，蜂窝漫游、系统 VPN 授权和其他 App 出口保持不变仍必须由真机完成，不以 JVM 测试冒充。
- 独立质量复审：首轮为 0 Critical、2 Important。有效项指出 `NonCancellable` cleanup 的 Relay/VPN I/O 可无界挂起；新增每步默认 5 秒 timeout，并在 `finally` 必然完成共享 cleanup result，hung cleanup 测试先因缺参数 RED 后 GREEN，且 Relay 超时后仍继续尝试 VPN stop。另一项建议 REMOTE_DISCONNECT 后 stop foreground Service；结合 `ServiceManager.initialize()` 始终持有同一 LAN client 复核后撤销，因为释放共享 locks/stopSelf 会破坏 LAN 与当前 UI 生命周期。复审最终为 0 Critical、0 Important。

### Task 11：sidecar 打包、CI 与 VPS smoke（2026-07-14）

- 打包：新增六个固定桌面目标的 Go sidecar 构建与校验脚本；electron-builder 只复制当前平台/架构产物，并在打包前验证文件存在、非空及 Unix 可执行位。保留复数构建命令并补齐计划约定的 `build:wg-relay-sidecar` 单数兼容命令。
- CI：桌面 workflow 对 Windows/macOS/Linux 六目标构建并校验，实际打包 job 在 electron-builder 前再次生成并验证当前目标；Android workflow 强制运行单测、lint 与 debug assembly，不再允许跳过单测。原有 tag release、产物与 draft release 行为保持不变。
- 运维验收：新增 `scripts/smoke-wg-relay-vps.sh`，通过环境变量接收测试 VPS 地址/用户/端口、TTY 或 CI secret 接收密码，不接受地址参数，不使用 `sshpass`、`set -x` 或关闭主机校验。脚本覆盖两次幂等部署、systemd enable/active、Relay 私网监听、公网 Relay TCP 拒绝、sidecar `/health`、手机轮换及旧 key/token 拒绝；临时 readback 与 askpass 文件均为 `0700/0600` 范围并在退出时删除。
- TDD 与主流程验证：初始 16 项中 15 项按缺失实现 RED；完成后 `node --test test/verify-wg-relay-sidecars.test.js test/wg-relay-packaging.test.js` 为 16/16 通过。单数命令契约另先以 `undefined` 断言 RED，再补兼容别名并回归 16/16。`bash -n`、两个 JS `node --check`、两份 workflow YAML 解析、smoke 可执行位与 `git diff --check` 均通过。
- 全量邻接修复：首次 `npm test` 暴露旧 sidecar 合同测试仍要求 prebuild 命令只能等于单一 verifier；该 RED 与新增双 sidecar 打包门禁不一致。测试更新为逐目标要求“原 sidecar verifier → WireGuard Relay verifier”的精确顺序后，`verify-sidecar-binaries`、WG verifier 与 packaging 三文件 22/22 通过。
- 实际产物：在当前 macOS arm64 主机执行 sidecar build 与 verify，生成的 `darwin-arm64/clawd-wg-tunnel` 非空且可执行，校验 1/1 通过。真实 VPS 执行保留到 Task 12，本文档与仓库未记录任何真实地址、密码、配置、私钥或 Token。
- 真实 smoke 首轮 RED：VPS 尚未部署前，macOS 长 `TMPDIR` 使 SSH ControlMaster socket 超过 Unix path 上限，流程在 SSH connection 阶段以 255 退出且脱敏。新增源合同测试先 RED；控制 socket 改为独立的 root-local `/tmp/cwgr.XXXXXX/s` 短路径、目录 `0700` 并纳入 trap 清理后，聚焦测试与 `bash -n` 均 GREEN。
- 真实 smoke 第二轮 RED：SSH 已连接但 macOS bsdtar 把 `com.apple.provenance` xattr 写入上传流，远端 GNU tar 对未知扩展头以 2 退出，安装器尚未运行且 VPS 保持旧 WireGuard 状态。新增 `--no-xattrs` 源合同先 RED，上传 tar 显式禁用扩展属性后聚焦测试与 `bash -n` GREEN。
- 真实 smoke 可诊断性：上传兼容修复后仍出现无阶段信息的退出码 2；新增只输出固定 `phase`、数字退出码和脱敏声明的 `ERR` trap 合同，明确禁止转储 installer stderr/readback。该合同先 RED，最小诊断实现后聚焦测试与 `bash -n` GREEN。
- Debian 实机锁文件 RED/GREEN：受控手动运行把 readback/stderr 留在 VPS root-only 文件后，确认 installer 在任何真实空锁文件上退出 21；GNU `stat %F` 返回 `regular empty file`，旧实现错误要求英文字符串精确等于 `regular file`。fixture shim 改为真实 GNU 语义后首装测试按预期 RED；生产校验改为 `test -f`、同 inode、root owner 与 `0600`，不再依赖本地化类型文本。锁安全与首装聚焦 7/7 GREEN。
- Debian 实机 WireGuard 验证 RED/GREEN：锁修复后安装推进到 WireGuard config validation 并退出 18；真实 `wg-quick strip` 要求传入文件 basename 是合法接口名，旧 `.clawd.tmp.<随机>.conf` 必然被拒。fixture 增加真实 basename 门禁后首装按预期 RED；生产改在同一安全目录的临时子目录中复制为 `clawd.conf` 后验证，再原子替换正式配置。首装与 malformed-config 聚焦 2/2 GREEN。
- Smoke 阶段可见性：安装器已在实机成功但完整 smoke 仍由本地编排层退出；新增固定 allowlist 阶段进度输出，内容不含地址、凭据或 readback。源合同先 RED，`set_phase` 实现后聚焦测试与 `bash -n` GREEN，用于定位剩余编排边界。
- macOS Bash 3.2 远端命令 RED/GREEN：阶段输出确认失败位于 idempotent deployment 1/2；受严格 host 字符白名单保护的命令仍人为加入两层单引号，旧 Bash 的 replacement quoting 生成远端语法错误。源合同先 RED；安全 host assignment 与固定远端路径移除内部引号，只由 `shell_quote` 包裹整条命令后聚焦测试与 `bash -n` GREEN。
- macOS Bash 3.2 systemd 检查 RED/GREEN：两次幂等部署均成功后，旧 `REMOTE_CHECK_COMMAND="$(cat <<'REMOTE_CHECKS' ...)"` 会在本机展开 heredoc 内的远端 `$(wg ...)`，导致 smoke 在 systemd 检查阶段退出。源合同先锁定禁止 command substitution；改为 Bash 3.2 可用的 `IFS= read -r -d '' ... || true` literal heredoc 后，聚焦 smoke 合同 1/1 与 `bash -n` 均通过，远端命令只在 VPS 执行。
- macOS Bash 3.2 shell quoting RED/GREEN：真实 smoke 再次稳定复现 systemd 检查远端 `bash -c` 在首个 `sed -n '...'` 处语法失败；最小复现确认旧 `${value//...}` 在 Bash 3.2 生成带反斜杠的 `\\'\"\\'\"\\'`，而不是合法单引号边界。新增测试直接提取生产 `shell_quote`，以含 multiline、command substitution、single-quoted sed/awk 的固定命令执行双层 Bash 语法检查并先 RED；改用 Bash 3.2 原生 `printf '%q'` 后，三项 smoke 聚焦测试与 `bash -n` 全部通过。
- 真实 VPS smoke GREEN：在用户明确授权的 Debian 12 VPS 上，当前脚本完整退出 0；两次幂等部署、WireGuard/Relay systemd enabled+active、Relay 仅私网监听且公网 TCP 拒绝、当前 macOS arm64 sidecar 经 WireGuard 访问 `/health`、手机轮换后旧 WireGuard key 与旧 Relay token 均拒绝、新 key/token 可用，全部显示 `[PASS]`。输出只含固定阶段和脱敏 checklist；此前 root-only 手动诊断文件及临时 staging 已删除，未重启 VPS、未改动其他业务服务、未记录地址或任何秘密。

### Task 12：全量验证、审查与完成审计（2026-07-14）

- Node 功能范围：WG Relay、installer、Relay server/bridge、managed-session forwarding、设置页、打包与 sidecar 邻接共 711 项中 710 通过、0 失败、1 项为 marker/nonce 保护的 privileged disposable-VPS skip。整仓 `npm test` 仍有功能前已记录的缺 Electron 安装体、缺 `hardware-buddy-settings.js`、旧 permission sanitizer、缺本地化 README、`server-start-http` 等基线失败；全并发下唯一 WG installer rollback fixture 抖动，随后单独复跑 1/1 通过，不作为新回归。
- Go sidecar：`go test ./...`、`go test -race ./...`、`go vet ./...`、`go mod verify` 全部退出 0；Windows x64/ARM64、macOS x64/ARM64、Linux x64/ARM64 六目标均重新 build 并逐目标 verify 成功。
- Android：最终 `testDebugUnitTest lintDebug assembleDebug --rerun-tasks` 退出 0，39 suites、688/688；GitHub Android Build run `29323644826` 在当前 `28c7db9` 上的 lint、unit tests、debug APK 均为 success。
- 真实 VPS：脱敏 smoke 完整退出 0，证明首次/重复部署、长期 systemd enable+active、私网 Relay、公网 7891 拒绝、PC sidecar health、手机 key/token 轮换与旧凭据拒绝；未重启 VPS，未动其他业务服务。
- 秘密与范围：当前 commit 的 tracked files 不含真实 VPS 地址/凭据 marker；无 `git push upstream`、无 Relay TCP 7891 firewall rule；Android WireGuard 配置只有 `IncludedApplications=com.clawd.mobile`，network security 仅给 `10.8.0.1` 放行 cleartext。所有提交均推送到 `origin=https://github.com/Bynlk/clawd-on-mobile.git` 的 `codex/one-click-wireguard-relay`，未 merge、未 push upstream。
- 最终审查：Task 10 独立质量审查首轮 0 Critical/2 Important，修复无界 cleanup 后复审为 0/0；foreground Service 项结合共享 LAN 生命周期后撤销。最终 PC 分片审查为 0/0；Android/打包分片初报“六个 Electron 安装包”后，依据计划只要求六目标 WireGuard sidecar build/verify 且 Linux ARM64 Electron app 不在既有 release 架构中，复核撤销为 0/0。VPS 核心此前已完成多轮事务/installer 安全审查并以真实 smoke 复验；本轮额外分片未完整读完，不伪称新的完整 VPS 审查。
- 尚缺直接证据：没有可用 Android 真机，因此系统 VPN 首次授权、蜂窝连接、Wi-Fi↔蜂窝漫游和“其他 App 出口不变”未执行；依照既定约束也未重启用户 VPS。代码、自动测试、CI 与非重启真实 VPS smoke 均已完成，但第 12.2 节对应真机/重启条目保持待人工验收。

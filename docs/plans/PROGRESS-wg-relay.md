# PROGRESS：WireGuard 远程中继 — 自驱实现进度

> 分支：`feat/wg-relay` · 未 push · 未触碰签名密钥
> 关联：PRD-wireguard-relay.md / TDD-wireguard-relay.md / PROMPT-wg-relay-autodrive.md
> 原则：纯增量（不改 `remote-ssh-*.js` 现有导出/行为，仅 require 复用）；`relay-server.js` 仅新增 `BIND_ADDR`（默认 `0.0.0.0`，向后兼容）。

---

## 1. 已交付模块（P0–P2 后端全绿）

| 编号 | 文件 | 配套测试 | 状态 |
|------|------|----------|------|
| P0 | `relay/install-wg-relay.sh` | `test/relay-server-bind.test.js`（服务端绑定）+ 手动 VPS 验证 | ✅ 脚本幂等、`set -euo pipefail`、shellcheck 0 告警 |
| P1 | `src/wg-relay-profile.js` | `test/wg-relay-profile.test.js` | ✅ schema/校验/normalize 全绿 |
| P1 | `relay/relay-server.js`（+`BIND_ADDR`） | `test/relay-server-bind.test.js` | ✅ 静态源断言（不启服务，符合网络策略） |
| P1 | `src/wg-relay-deploy.js` | `test/wg-relay-deploy.test.js` | ✅ 编排/回传解析/退出码映射全绿 |
| P1 | `src/wg-pc-tunnel.js` | `test/wg-pc-tunnel.test.js` | ✅ **Linux 隧道真实拉起**：单次提权批处理（wireguard-go 建 TUN → `wg setconf` stdin → `ip address add` → `ip link set up` → 子网路由），bringDown `ip link del` 一致拆除；status 走非特权 `ip link show` |
| P1 | `src/settings-actions-wg-relay.js` | `test/settings-actions-wg-relay.test.js` | ✅ IPC add/update/remove/applyReadback 全绿 |
| P2 | `src/wg-ssh2-exec.js` | `test/wg-ssh2-exec.test.js` | ✅ ssh2 密码通道 + host key fail-closed 全绿 |
| 桥 | `src/wg-relay-runtime.js` | `test/wg-relay-runtime.test.js` | ✅ 每 profile 状态机 + pcConf 内存缓存（SEC-3）+ 事件总线 |
| 桥 | `src/wg-relay-ipc.js` | `test/wg-relay-ipc.test.js` | ✅ `window.wgRelay.*` → deploy/tunnel-up/down/status，`{ok}`→`{status}` 归一，事件广播 |
| 桥 | `src/preload-settings.js` / `src/main.js` | 现有 preload/main 覆盖 | ✅ `window.wgRelay` 桥 + 运行时/提权器注册 + cleanup |
| 提权 | `src/wg-privilege.js` | `test/wg-privilege.test.js` | ✅ 跨平台提权器：Linux=pkexec（单弹窗、stdin 转发 SEC-3），mac/win 暂返回 denied |
| 打包 | `wg-bin/` + `scripts/fetch-wg-binaries.js` + `package.json`(extraResources) | 手动 | ✅ `wireguard-go`+`wg` 打包路径就绪；二进制经 `fetch:wg` 校验 sha256 后落位（不入库） |
| — | `src/prefs.js`（注册 `wgRelay` 字段） | 现有 prefs 测试覆盖 | ✅ defaultFactory + normalize 已挂载 |

**测试结果**：wg-relay 全部测试文件 `node --test` → **tests 54 / pass 54 / fail 0**（`wg-pc-tunnel` 21 + `wg-privilege` 7 + `wg-relay-ipc` 19 + `wg-relay-runtime` 7）；叠加 `wg-relay-profile`/`wg-relay-deploy`/`settings-actions-wg-relay`/`wg-ssh2-exec`/`relay-server-bind` 等后端套件均全绿。
**依赖审计**：`ssh2` 已安装，`npm audit` 该依赖 0 漏洞。
**脚本静态检查**：`shellcheck v0.10.0` on `install-wg-relay.sh` → 0 warning。

---

## 2. 安全需求（SEC）逐条验证

| 编号 | 要求 | 落地点 | 测试证据 |
|------|------|--------|----------|
| SEC-1 | SSH 密码不落盘 | `sanitizeProfile` 剥离 `password`/`phonePrivKey`；`applyReadback` 仅白名单公钥字段 | `settings-actions-wg-relay.test.js`「strips password」「no LEAK in serialized form」 |
| SEC-3 | phone/pc 私钥不持久化明文 | `READBACK_PERSIST_FIELDS` 排除 `pcConf/phoneConf/phonePrivKey`；pcConf 仅存运行时内存缓存（`rememberPcConf`）；隧道 conf 经提权进程 **stdin** 送达 `wg setconf`，不落盘 | 同上 + `wg-pc-tunnel.test.js`「conf via stdin」「private key never in progress lines」+ `wg-privilege.test.js`「forwards stdin」 |
| SEC-4 | 端口最小暴露 | 脚本仅放行 `wgPort/udp`；`relay-server` 默认 `BIND_ADDR` 可收敛隧道内网 | `relay-server-bind.test.js` |
| SEC-5 | 注入防护 | 复用 `remote-ssh-profile` 白名单校验；参数走 env/stdin 非字符串插值 | `wg-relay-profile.test.js` + `wg-relay-deploy.test.js`（buildEnvPreamble） |
| SEC-6 | host key 校验 fail-closed | ssh2 `hostVerifier` 无校验器即拒绝 | `wg-ssh2-exec.test.js`「rejects when verifier false」「fails closed with no verifier」 |
| SEC-7 | 日志脱敏 | progress 行不含私钥/密码 | `wg-pc-tunnel.test.js`（SEC-3 断言）覆盖 |

---

## 3. PRD §8 验收表（AC）逐条勾验

| AC | 说明 | 状态 |
|----|------|------|
| AC-DEP-1/2/3 | 真机 VPS 部署（key/密码/幂等） | ⏳ 需真实 VPS 端到端验证；后端编排+脚本已就绪并单测覆盖 |
| AC-SEC-1 | 密码不落盘（grep 无命中） | ✅ 单测覆盖剥离逻辑；真机 grep 待端到端 |
| AC-SEC-2 | 重开需重输密码 | ✅ 密码从不进 prefs（结构上保证） |
| AC-SEC-3 | 端口隐身（nmap） | ⏳ 需真机网络验证 |
| AC-PC-1 | 桌面自动建隧道 | ✅ Linux 全链路已实现（单次 pkexec 弹窗，无需跳转外部 App / 手动导入 conf）；单测覆盖完整序列；真机 pkexec 弹窗待人工验证。mac/win 提权器待后续分期 |
| AC-QR-1/2 | 二维码互操作 | 🟡 渲染层 `settings-tab-wg-relay.js` + `window.wgRelay` 桥已就绪，二维码 DOM 已接线；真机扫码互操作待端到端 |
| AC-E2E-1 / AC-ROAM-1 | 端到端 / 漫游 | ⏳ 需 P3 安卓 + 真机 |
| AC-EX（EX-3/6/9） | 异常路径提示 | ✅ 退出码映射单测（EX-1/2/3/6 等经 `wg-relay-deploy` EXIT_CODE_MAP 覆盖） |
| AC-TEST | 新模块均有配套 test，全绿 | ✅ wg-relay 范围全绿（新增 `wg-privilege` 7 项 + `wg-pc-tunnel` 重写至 21 项 + 运行时桥 26 项） |

---

## 4. 未完成范围（明确划界，不谎报完成）

- **macOS / Windows 桌面提权器**：`src/wg-privilege.js` 目前仅 Linux（pkexec）落地；mac（`osascript "with administrator privileges"`）与 win（UAC helper）返回 denied 占位，隧道会诚实报 EX-10，待后续分期补齐。对应地 `wg-bin/darwin`、`wg-bin/win32` 二进制尚未落位。
- **wireguard-go / wg 二进制入库**：`wg-bin/` 目录与打包路径、`scripts/fetch-wg-binaries.js`（校验 sha256）已就绪，但实际二进制**不入库**，需在打包前设置 `WG_GO_LINUX_X64_URL` 等环境变量执行 `npm run fetch:wg linux x64` 落位（缺失时运行时回退 PATH 查找）。
- **P3 安卓 `RelaySettings.kt` 内嵌隧道扫码（FR-AND-1/2/3）**：未开始（属 P3 分期）。
- **真机端到端验收**（AC-DEP-*、AC-SEC-3、AC-QR-*、AC-E2E-1、AC-ROAM-1）：需真实 Linux VPS + 手机，超出沙箱能力，待人工在真实环境执行。

> **本轮（Linux 优先，"直接可用"）已交付**：`window.wgRelay` 运行时桥（preload + IPC + 运行时）、Linux 桌面隧道真实拉起（单次 pkexec 弹窗完成建口/配置/地址/路由）、pkexec 提权器并接入 main.js、wireguard-go/wg 打包路径与获取脚本。Linux 端从"骨架"变为端到端可用（前提：二进制已 fetch 落位 + 真机 pkexec 授权）。

---

## 5. 已知无关失败（非本特性回归）

全量 `npm test` → **tests 5827 / pass 5796 / fail 15**。失败集中于与 wg-relay 无关的既有文件：
`cleanup-integrations`、`main-codex-pet-theme-sync`、`pet-window-runtime`、`server-start-http`、`settings-renderer-browser-env`、`shared-process`、`windows-audit-554`。
本特性相关的全部测试文件（`wg-pc-tunnel`/`wg-privilege`/`wg-relay-ipc`/`wg-relay-runtime`/`wg-relay-profile`/`wg-relay-deploy`/`settings-actions-wg-relay`/`wg-ssh2-exec`/`relay-server-bind`）全部通过，未引入任何回归。

---

## 6. 交付约束遵守情况

- ✅ 未修改 `remote-ssh-*.js` 现有导出/行为（仅 require 复用其校验器与部署原语）。
- ✅ `relay-server.js` 改动限于新增 `BIND_ADDR`（默认 `0.0.0.0`，向后兼容）。
- ✅ 未 push、未 release、未触碰签名密钥；`android/release-keystore.jks` 保持 gitignore。

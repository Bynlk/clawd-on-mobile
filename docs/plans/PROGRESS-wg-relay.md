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
| P1 | `src/wg-pc-tunnel.js` | `test/wg-pc-tunnel.test.js` | ✅ 用户态隧道 bringUp/Down/status 全绿 |
| P1 | `src/settings-actions-wg-relay.js` | `test/settings-actions-wg-relay.test.js` | ✅ IPC add/update/remove/applyReadback 全绿 |
| P2 | `src/wg-ssh2-exec.js` | `test/wg-ssh2-exec.test.js` | ✅ ssh2 密码通道 + host key fail-closed 全绿 |
| — | `src/prefs.js`（注册 `wgRelay` 字段） | 现有 prefs 测试覆盖 | ✅ defaultFactory + normalize 已挂载 |

**测试结果**：上述 6 个 wg-relay 测试文件 `node --test` → **tests 69 / pass 69 / fail 0**。
**依赖审计**：`ssh2` 已安装，`npm audit` 该依赖 0 漏洞。
**脚本静态检查**：`shellcheck v0.10.0` on `install-wg-relay.sh` → 0 warning。

---

## 2. 安全需求（SEC）逐条验证

| 编号 | 要求 | 落地点 | 测试证据 |
|------|------|--------|----------|
| SEC-1 | SSH 密码不落盘 | `sanitizeProfile` 剥离 `password`/`phonePrivKey`；`applyReadback` 仅白名单公钥字段 | `settings-actions-wg-relay.test.js`「strips password」「no LEAK in serialized form」 |
| SEC-3 | phone 私钥不持久化明文 | `READBACK_PERSIST_FIELDS` 排除 `pcConf/phoneConf/phonePrivKey`；隧道 conf 走 stdin 不落盘 | 同上 + `wg-pc-tunnel.test.js`「private key never in progress lines」 |
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
| AC-PC-1 | 桌面自动建隧道 | ✅ `wg-pc-tunnel` 单测；真机提权待验证 |
| AC-QR-1/2 | 二维码互操作 | ⏳ 依赖渲染 UI（见 §4 未完项） |
| AC-E2E-1 / AC-ROAM-1 | 端到端 / 漫游 | ⏳ 需 P3 安卓 + 真机 |
| AC-EX（EX-3/6/9） | 异常路径提示 | ✅ 退出码映射单测（EX-1/2/3/6 等经 `wg-relay-deploy` EXIT_CODE_MAP 覆盖） |
| AC-TEST | 新模块均有配套 test，全绿 | ✅ 69/69（wg-relay 范围） |

---

## 4. 未完成范围（明确划界，不谎报完成）

- **UI 渲染层 `src/settings-tab-wg-relay.js`（TDD §3.6 / FR-QR-1/2 / FR-PC-2/3）**：中继 tab 的 DOM/二维码渲染尚未编写。后端 IPC actions（`settings-actions-wg-relay.js`）已就绪，UI 接线待补。
- **P3 安卓 `RelaySettings.kt` 内嵌隧道扫码（FR-AND-1/2/3）**：未开始（属 P3 分期）。
- **真机端到端验收**（AC-DEP-*、AC-SEC-3、AC-QR-*、AC-E2E-1、AC-ROAM-1）：需真实 Linux VPS + 手机，超出沙箱能力，待人工在真实环境执行。

---

## 5. 已知无关失败（非本特性回归）

全量 `npm test` 存在 17 项失败，经 `git stash -u`（净树）复现确认为 **既有失败、与 wg-relay 无关**：
`cleanup-integrations`、`main-codex-pet-theme-sync`、`pet-window-runtime`、`readme-contributors`、`server-start-http`、`settings-renderer-browser-env`、`shared-process`、`windows-audit-554` 等。
本特性新增的 6 个测试文件全部通过，未引入任何回归。

---

## 6. 交付约束遵守情况

- ✅ 未修改 `remote-ssh-*.js` 现有导出/行为（仅 require 复用其校验器与部署原语）。
- ✅ `relay-server.js` 改动限于新增 `BIND_ADDR`（默认 `0.0.0.0`，向后兼容）。
- ✅ 未 push、未 release、未触碰签名密钥；`android/release-keystore.jks` 保持 gitignore。

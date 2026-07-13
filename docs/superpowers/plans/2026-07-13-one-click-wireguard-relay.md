# One-Click WireGuard Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete first-deploy and daily-connect flow where PC deploys a private VPS Relay once over password SSH, Android pairs by QR, and both clients later connect without SSH or external WireGuard software.

**Architecture:** The VPS runs persistent kernel WireGuard and a Relay/management Node service bound only to the WireGuard address. PC uses an app-bundled cross-platform userspace WireGuard TCP-forward sidecar; Android uses the official embedded WireGuard Go backend with `IncludedApplications=com.clawd.mobile`. Public profile data stays in settings, while private configs and tokens use Electron safeStorage or Android EncryptedSharedPreferences.

**Tech Stack:** Electron/CommonJS, Node.js test runner, ssh2/SFTP, ws, Bash/systemd, Go wireguard-go userspace netstack, Kotlin/Compose, Android VpnService, JUnit/MockK.

---

## Delivery rules

- Work only in `/Users/new/Documents/clawd-on-mobile/fork-source/.worktrees/one-click-wireguard-relay` on `codex/one-click-wireguard-relay`.
- Before every push, confirm `origin` is `https://github.com/Bynlk/clawd-on-mobile.git`; never push `upstream`.
- Use TDD: add one focused failing test, run it and observe the intended failure, implement the minimum behavior, then run the focused and neighboring suites.
- Every commit uses Chinese `动作：描述` format and is pushed immediately with `git push origin codex/one-click-wireguard-relay`.
- Update the completion record in `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md` with each implementation commit.
- Do not log SSH passwords, WireGuard private keys, Relay Tokens, management Tokens, or complete QR payloads.

## Planned file map

### Electron

- `src/wg-relay-profile.js`: public profile schema and legacy migration.
- `src/wg-relay-secret-store.js`: safeStorage-backed encrypted secret file.
- `src/wg-relay-bundle.js`: deterministic VPS upload manifest and SFTP upload.
- `src/wg-ssh2-exec.js`: one SSH session, TOFU callback, SFTP and sudo execution.
- `src/wg-relay-deploy.js`: deployment orchestration and readback validation.
- `src/wg-relay-sidecar.js`: PC sidecar lifecycle and JSON-line protocol.
- `src/wg-relay-connection.js`: tunnel, health, RelayBridge orchestration.
- `src/relay-bridge-integration.js`: explicit config/start/stop support.
- `src/wg-relay-ipc.js`: deploy/connect/disconnect/rotate/delete handlers.
- `src/wg-relay-runtime.js`: connection state and redacted progress.
- `src/settings-tab-wg-relay.js`: first-run wizard and deployed state card.
- `src/preload-settings.js`, `src/main.js`, `src/settings-i18n.js`, `src/settings.css`: bridge, dependency injection, copy and presentation.

### VPS

- `relay/install-wg-relay.sh`: atomic idempotent system installation.
- `relay/relay-server.js`: factory-based WebSocket/HTTP server with strict token authentication.
- `relay/relay-token-store.js`: mutable token plus atomic env persistence.
- `relay/wg-management.js`: PC-only phone Peer rotation transaction.
- `relay/pair-registry.js`: exactly one PC and one phone per token.

### PC sidecar

- `sidecars/wg-relay-tunnel/go.mod`, `go.sum`: pinned Go dependency graph.
- `sidecars/wg-relay-tunnel/main.go`: stdin config, status JSON and process lifecycle.
- `sidecars/wg-relay-tunnel/config.go`: strict input validation.
- `sidecars/wg-relay-tunnel/forward.go`: netstack WireGuard plus loopback TCP forwarding.
- `sidecars/wg-relay-tunnel/*_test.go`: validation and forwarding lifecycle tests.

### Android

- `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts`: embedded WireGuard library.
- `android/app/src/main/AndroidManifest.xml`: merged VPN service requirements.
- `data/RelayPairingConfig.kt`: QR payload model and validation.
- `data/PrefsStore.kt`: encrypted pairing persistence.
- `vpn/ClawdWireGuardTunnel.kt`: WireGuard `Tunnel` adapter.
- `vpn/WireGuardController.kt`: permission and backend state machine.
- `service/RemoteConnectionCoordinator.kt`: VPN → health → WebSocket ordering and rollback.
- `service/WsConnectionService.kt`: coordinator integration without disturbing LAN.
- `ui/scan/ScanScreen.kt`, `MainActivity.kt`: scan/deep-link routing.
- `ui/settings/RelaySettings.kt`, `SettingsScreen.kt`: paired state and one-click remote connection UI.
- `res/values*/strings.xml`: localized states and errors.

### Build and verification

- `scripts/build-wg-relay-sidecar.js`: local target build helper.
- `scripts/verify-wg-relay-sidecars.js`: packaged target verification.
- `.github/workflows/build.yml`, `.github/workflows/android.yml`: cross-platform and Android gates.
- `scripts/smoke-wg-relay-vps.sh`: repeatable real-VPS acceptance script.

---

### Task 1: Public profile migration and encrypted PC secret store

**Files:**
- Modify: `src/wg-relay-profile.js`
- Modify: `src/settings-actions-wg-relay.js`
- Create: `src/wg-relay-secret-store.js`
- Modify: `test/wg-relay-profile.test.js`
- Create: `test/wg-relay-secret-store.test.js`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing profile migration tests**

Add cases proving `root@203.0.113.10` becomes `host=203.0.113.10`, `sshUsername=root`, `sshPort=22`, that explicit new fields round-trip, and that `sshHostFingerprint` accepts only `SHA256:<base64>`.

```js
const migrated = sanitizeProfile({
  id: "wg-1", label: "VPS", host: "root@203.0.113.10", port: 22,
  authMethod: "password", wgPort: 51820, wgSubnet: "10.8.0.0/24",
});
assert.equal(migrated.host, "203.0.113.10");
assert.equal(migrated.sshUsername, "root");
assert.equal(migrated.sshPort, 22);
```

- [ ] **Step 2: Run RED profile tests**

Run: `node --test test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js`

Expected: FAIL because `sshUsername`, `sshPort`, and fingerprint validation are not implemented.

- [ ] **Step 3: Implement normalized public fields**

Use this canonical shape and strip all unknown/private fields:

```js
{
  id, label, host, sshUsername, sshPort,
  authMethod: "password",
  wgPort, wgSubnet, sshHostFingerprint,
  endpoint, relayAddr, lastDeployedAt, deployVersion,
}
```

Preserve legacy key-auth profiles for compatibility, but create new profiles as password-auth and never persist `password`, `pcConfig`, `phoneConfig`, `relayToken`, or `managementToken`.

- [ ] **Step 4: Write failing secret-store tests**

Cover encrypted write/read/remove, atomic rename, `0600`, corrupt JSON, unavailable safeStorage, Linux `basic_text`, and secret redaction. Use an injected fake safeStorage:

```js
const store = createWgRelaySecretStore({ safeStorage, userDataPath: tempDir, fs });
store.write("wg-1", { pcConfig: "PrivateKey = secret", relayToken: "token" });
assert.deepEqual(store.read("wg-1"), { pcConfig: "PrivateKey = secret", relayToken: "token" });
assert.doesNotMatch(fs.readFileSync(file, "utf8"), /secret|token/);
```

- [ ] **Step 5: Run RED secret-store tests**

Run: `node --test test/wg-relay-secret-store.test.js`

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 6: Implement the secret store**

Export:

```js
createWgRelaySecretStore({ safeStorage, userDataPath, fs, platform })
// methods: isAvailable(), write(profileId, secrets), read(profileId), remove(profileId), clear()
```

Write one encrypted base64 blob per profile to `wg-relay-secrets.json.tmp`, chmod it, fsync where supported, then rename. Reject non-object secrets and fail closed when encryption is unavailable.

- [ ] **Step 7: Run GREEN tests and neighboring settings tests**

Run: `node --test test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js test/wg-relay-secret-store.test.js`

Expected: all tests pass.

- [ ] **Step 8: Record, commit and push**

Update the design progress record, then run:

```bash
git add src/wg-relay-profile.js src/settings-actions-wg-relay.js src/wg-relay-secret-store.js test/wg-relay-profile.test.js test/settings-actions-wg-relay.test.js test/wg-relay-secret-store.test.js docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md
git commit -m "新增：安全保存中继配置"
git push origin codex/one-click-wireguard-relay
```

### Task 2: One-session SSH, TOFU and complete VPS bundle upload

**Files:**
- Create: `src/wg-relay-bundle.js`
- Modify: `src/wg-ssh2-exec.js`
- Modify: `src/wg-relay-deploy.js`
- Create: `test/wg-relay-bundle.test.js`
- Modify: `test/wg-ssh2-exec.test.js`
- Modify: `test/wg-relay-deploy.test.js`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing deterministic bundle tests**

Assert the manifest contains the installer, Relay server, pair registry, management modules, token store, and every runtime file under root `node_modules/ws`; reject symlinks and `..` paths.

```js
assert.deepEqual(manifest.map(x => x.remotePath).slice(0, 3), [
  "install-wg-relay.sh", "app/relay-server.js", "app/pair-registry.js",
]);
```

- [ ] **Step 2: Run RED bundle tests**

Run: `node --test test/wg-relay-bundle.test.js`

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement bundle enumeration and SFTP upload API**

Export `buildRelayBundleManifest({ appRoot })` and `uploadRelayBundle({ sftp, manifest, remoteRoot, onProgress })`. Upload buffers read through `fs.readFileSync` so packaged asar resources work; create directories with `0755`, scripts with `0755`, and other files with `0644`.

- [ ] **Step 4: Write failing SSH session tests**

Use a fake ssh2 Client to prove one `connect()` call performs host-key verification, SFTP upload and one install exec. Cover root command `bash /tmp/.../install-wg-relay.sh` and non-root command `sudo -S -p '' bash ...` with the password written before the command input.

- [ ] **Step 5: Run RED SSH tests**

Run: `node --test test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js`

Expected: FAIL because current transport only executes stdin and cannot upload.

- [ ] **Step 6: Implement one-session deploy transport**

Export:

```js
deployBundle({ host, port, username, password, expectedFingerprint,
  confirmHostKey, manifest, installEnv, onProgress, timeoutMs })
```

The host verifier computes SHA-256, accepts an exact saved fingerprint, calls `confirmHostKey(info)` only for an unknown host, and rejects changed fingerprints without presenting an overwrite shortcut. Return `{ code, stdout, stderr, acceptedFingerprint }` without logging streams.

- [ ] **Step 7: Integrate deployment orchestration**

Replace the password path in `wg-relay-deploy.js` with bundle deployment. Parse and validate `schemaVersion=1`, endpoint, CIDRs, Relay URL, both configs and both 256-bit tokens before returning. Always remove password references in `finally` and emit redacted progress stages.

- [ ] **Step 8: Run GREEN focused tests**

Run: `node --test test/wg-relay-bundle.test.js test/wg-ssh2-exec.test.js test/wg-relay-deploy.test.js`

Expected: all tests pass.

- [ ] **Step 9: Record, commit and push**

Commit: `新增：一键上传并部署中继服务`

Push immediately to `origin codex/one-click-wireguard-relay`.

### Task 3: Persistent VPS services, strict Relay authentication and phone rotation

**Files:**
- Modify: `relay/install-wg-relay.sh`
- Refactor: `relay/relay-server.js`
- Create: `relay/relay-token-store.js`
- Create: `relay/wg-management.js`
- Modify: `relay/pair-registry.js`
- Modify: `relay/package.json`
- Modify: `test/relay-server-bind.test.js`
- Modify: `test/relay-managed-session-forwarding.test.js`
- Create: `test/relay-auth-management.test.js`
- Create: `test/install-wg-relay-script.test.js`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing strict-token and single-phone tests**

Start the Relay factory on loopback with injected tokens. Prove missing/wrong Bearer values receive close code `4001`, one PC and one phone can pair, a replacement phone closes the prior phone, and payloads are forwarded without storage.

- [ ] **Step 2: Run RED Relay tests**

Run: `node --test test/relay-auth-management.test.js test/relay-managed-session-forwarding.test.js`

Expected: FAIL because current `FIXED_TOKEN` substitutes rather than verifies and registry supports multiple phones.

- [ ] **Step 3: Refactor Relay into a testable server factory**

Export:

```js
createRelayServer({ bindAddr, port, tokenStore, management, log, now })
// returns { listen(), close(), address(), pairs }
```

Keep CLI startup under `if (require.main === module)`. Parse the submitted Bearer token, compare it with `tokenStore.current()` using `crypto.timingSafeEqual`, and never print token prefixes.

- [ ] **Step 4: Write failing management transaction tests**

Cover exact PC source address, management Bearer token, request size, successful rotation order, command failure rollback, atomic env update, and immediate closure of the old pair.

```js
const result = await management.rotatePhone({ remoteAddress: "10.8.0.2" });
assert.equal(result.phoneConfig.includes("PrivateKey"), true);
assert.notEqual(result.relayToken, oldToken);
assert.deepEqual(calls, ["generate", "persist-wg", "apply-live", "persist-token", "close-old"]);
```

- [ ] **Step 5: Implement token store and management module**

`relay-token-store.js` keeps the active token in memory and atomically writes `/etc/clawd-relay/relay.env`. `wg-management.js` validates the source address and management token, generates keys with injected `wg`, prepares a complete candidate config, commits persistent/live WireGuard changes, rotates the Relay token, and returns the new phone config. On pre-commit failure it leaves old state untouched; on post-commit failure it restores saved files and live peer.

- [ ] **Step 6: Write failing installer content tests**

Assert the installer requires systemd, installs Node when absent, writes `EnvironmentFile=/etc/clawd-relay/relay.env`, binds `10.8.0.1`, enables both services, never opens TCP 7891, emits schemaVersion 1 and secret fields only inside the readback marker, and uses temp-file rename.

- [ ] **Step 7: Run RED installer tests**

Run: `node --test test/install-wg-relay-script.test.js`

Expected: FAIL against the current optional/skipped Relay service logic.

- [ ] **Step 8: Implement the idempotent installer**

Make Relay source presence, Node, systemd and WireGuard mandatory. Generate 32-byte hex tokens with `openssl rand -hex 32`, install files under the design paths, create both units, apply only UDP firewall rules, start and verify `wg-quick@clawd` then `clawd-relay`, and emit validated readback. Preserve prior configs until all candidate files validate.

- [ ] **Step 9: Run GREEN VPS tests and syntax check**

Run:

```bash
bash -n relay/install-wg-relay.sh
node --test test/relay-auth-management.test.js test/relay-server-bind.test.js test/relay-managed-session-forwarding.test.js test/install-wg-relay-script.test.js
```

Expected: all checks pass.

- [ ] **Step 10: Record, commit and push**

Commit: `新增：持久中继与手机密钥轮换`

Push immediately to the fork branch.

### Task 4: Cross-platform userspace WireGuard TCP-forward sidecar

**Files:**
- Create: `sidecars/wg-relay-tunnel/go.mod`
- Create: `sidecars/wg-relay-tunnel/go.sum`
- Create: `sidecars/wg-relay-tunnel/main.go`
- Create: `sidecars/wg-relay-tunnel/config.go`
- Create: `sidecars/wg-relay-tunnel/forward.go`
- Create: `sidecars/wg-relay-tunnel/config_test.go`
- Create: `sidecars/wg-relay-tunnel/forward_test.go`
- Create: `sidecars/wg-relay-tunnel/protocol_test.go`
- Modify: `NOTICE.md`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Initialize the pinned module and write failing config tests**

The stdin schema is one JSON document:

```go
type Config struct {
    PrivateKey, Address, ServerPublicKey, Endpoint, AllowedIP, ForwardAddress string
    KeepaliveSeconds int
}
```

Tests reject unknown JSON fields, malformed keys, non-private `/24`, forward targets outside AllowedIP, non-UDP endpoints, and keepalive outside 1–120.

- [ ] **Step 2: Run RED Go config tests**

Run: `cd sidecars/wg-relay-tunnel && go test ./...`

Expected: FAIL because parser and validator are absent.

- [ ] **Step 3: Implement strict config parsing**

Use `json.Decoder.DisallowUnknownFields()`, require EOF after one object, parse keys with the WireGuard key package, parse CIDRs with `net/netip`, and expose `ParseConfig(io.Reader) (Config, error)`.

- [ ] **Step 4: Write failing forwarder lifecycle tests**

Inject a dial function so tests prove loopback-only listener allocation, bidirectional byte copying, half-close handling, context cancellation and no secret output. Assert the ready line shape:

```json
{"type":"ready","listen":"127.0.0.1:43127"}
```

- [ ] **Step 5: Run RED forwarder tests**

Run: `cd sidecars/wg-relay-tunnel && go test ./...`

Expected: FAIL because forwarder/main protocol are absent.

- [ ] **Step 6: Implement netstack WireGuard and loopback forwarder**

Use wireguard-go userspace netstack to create a virtual TUN with the PC address, apply one peer and AllowedIP, and use the netstack TCP dialer for the Relay target. Listen only on `127.0.0.1:0`; emit ready after WireGuard device setup and listener bind. Emit only `{type,status,errorCode}` records, never config values.

- [ ] **Step 7: Verify Go tests, race detector and cross-builds**

Run:

```bash
cd sidecars/wg-relay-tunnel
go test ./...
go test -race ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=darwin GOARCH=arm64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```

Expected: all commands exit 0.

- [ ] **Step 8: Record licenses, commit and push**

Pin the resolved module versions in `go.mod/go.sum`, record Apache-2.0/WireGuard notices in `NOTICE.md`, commit as `新增：内置跨平台 WireGuard 隧道`, and push immediately.

### Task 5: Electron sidecar manager and one-click connection state machine

**Files:**
- Create: `src/wg-relay-sidecar.js`
- Create: `src/wg-relay-connection.js`
- Modify: `src/relay-bridge-integration.js`
- Modify: `src/wg-relay-runtime.js`
- Create: `test/wg-relay-sidecar.test.js`
- Create: `test/wg-relay-connection.test.js`
- Modify: `test/relay-bridge-integration.test.js`
- Modify: `test/wg-relay-runtime.test.js`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing sidecar-manager tests**

Mirror existing sidecar test patterns. Cover platform/arch path resolution, stdin config then close, ready JSON parsing, startup timeout, unexpected exit, stop escalation, and stderr redaction across chunk boundaries.

- [ ] **Step 2: Run RED sidecar tests**

Run: `node --test test/wg-relay-sidecar.test.js`

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement sidecar manager**

Export `WgRelaySidecar`, `sidecarPathFor()`, and `parseStatusLine()`. `start(config)` resolves only a packaged/dev binary, spawns with no secret argv/env, writes one JSON config to stdin, waits for ready, and returns `{ listen }`. `stop()` sends SIGTERM then kills after a bounded timeout.

- [ ] **Step 4: Write failing connection-order and rollback tests**

Use fakes to require exact order:

```js
assert.deepEqual(calls, ["secret-read", "sidecar-start", "health", "bridge-start"]);
```

Test sidecar failure, health timeout, bridge authentication failure, disconnect order, duplicate connect coalescing, stale attempt cancellation and no automatic startup.

- [ ] **Step 5: Run RED connection tests**

Run: `node --test test/wg-relay-connection.test.js test/relay-bridge-integration.test.js`

Expected: FAIL because explicit one-click orchestration is absent.

- [ ] **Step 6: Implement explicit RelayBridge configuration**

Add `configure({ url, token })`, `start()`, `waitUntilConnected(timeoutMs)` and `stop()` without writing prefs. Preserve legacy `init(prefs)` for old manual Relay settings.

- [ ] **Step 7: Implement connection manager and statuses**

`createWgRelayConnection()` exposes `connect(profileId)`, `disconnect(profileId)`, `status(profileId)`, and `dispose()`. It reads secure config, starts sidecar, maps the sidecar loopback endpoint to Relay/health URLs, validates `/health`, starts RelayBridge, then emits `connected`. On failure it stops bridge and sidecar in reverse order.

- [ ] **Step 8: Run GREEN PC runtime tests**

Run: `node --test test/wg-relay-sidecar.test.js test/wg-relay-connection.test.js test/relay-bridge-integration.test.js test/wg-relay-runtime.test.js`

Expected: all tests pass.

- [ ] **Step 9: Record, commit and push**

Commit: `新增：桌面端一键远程连接`

Push immediately.

### Task 6: Electron deploy/connect/rotate IPC and secure persistence

**Files:**
- Modify: `src/wg-relay-ipc.js`
- Modify: `src/preload-settings.js`
- Modify: `src/main.js`
- Modify: `src/settings-ipc.js`
- Modify: `test/wg-relay-ipc.test.js`
- Create: `test/wg-relay-preload.test.js`
- Create: `test/main-wg-relay-integration.test.js`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing IPC contract tests**

Require handlers:

```text
wgRelay:deploy
wgRelay:connect
wgRelay:disconnect
wgRelay:rotate-phone
wgRelay:delete-local
wgRelay:pairing-qr
wgRelay:status
wgRelay:list-statuses
```

Prove deploy confirms TOFU, writes secrets before public readback, auto-connects PC, returns QR data but no raw secret object, and clears the caller password. Prove rotate uses the in-tunnel management API, updates encrypted secrets, reconnects with the new token and invalidates cached QR.

- [ ] **Step 2: Run RED IPC tests**

Run: `node --test test/wg-relay-ipc.test.js test/wg-relay-preload.test.js test/main-wg-relay-integration.test.js`

Expected: FAIL because new handlers/API do not exist.

- [ ] **Step 3: Implement IPC handlers and preload surface**

Expose methods matching the handler names plus status/progress listeners. Keep settings controller as the only public profile writer. The main process owns safeStorage, password use, secrets, QR payload generation and management token; renderer receives only a QR data URL and redacted status.

- [ ] **Step 4: Wire main-process lifecycle**

After Electron ready, instantiate secret store, sidecar manager and connection manager, register IPC, and dispose them before app quit. Inject `dialog.showMessageBox` for unknown host fingerprints. Never initialize or auto-connect a profile at startup.

- [ ] **Step 5: Run GREEN IPC/main tests**

Run: `node --test test/wg-relay-ipc.test.js test/wg-relay-preload.test.js test/main-wg-relay-integration.test.js test/settings-ipc.test.js`

Expected: these four files pass with zero failures.

- [ ] **Step 6: Record, commit and push**

Commit: `新增：中继部署与配对接口`

Push immediately.

### Task 7: Minimal-step PC settings wizard and deployed state card

**Files:**
- Refactor: `src/settings-tab-wg-relay.js`
- Modify: `src/settings-i18n.js`
- Modify: `src/settings.css`
- Modify: `test/settings-tab-wg-relay.test.js`
- Modify: `test/settings-renderer-browser-env.test.js`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing browser/UI source tests**

Prove first-run renders public IP, SSH username, SSH port and password plus one primary deploy button; defaults are root/22; password autocomplete is off and never enters profile payload. Prove deployed state renders one connect/disconnect button and secondary QR, rotate, repair and delete actions.

- [ ] **Step 2: Run RED UI tests**

Run: `node --test test/settings-tab-wg-relay.test.js test/settings-renderer-browser-env.test.js`

Expected: WG tests fail because the current profile list/key-auth form and separate tunnel button remain.

- [ ] **Step 3: Implement the first-run wizard**

Use a single card with local in-memory password. On deploy, call `window.wgRelay.deploy({ profile, password })`, immediately clear the input, render the ten progress states, and transition to deployed state only after PC auto-connect and QR creation succeed.

- [ ] **Step 4: Implement deployed state and recovery actions**

The primary button calls connect/disconnect. QR retrieval occurs on demand. Rotate requires confirmation that the old phone will stop working. Repair requests the SSH password again. Delete disconnects and deletes local secrets/profile but leaves VPS services running.

- [ ] **Step 5: Add complete i18n and responsive styling**

Add every key to all supported desktop language packs. Ensure keyboard focus, disabled/busy states, long IP/error wrapping and QR sensitive-data warning.

- [ ] **Step 6: Run GREEN UI tests**

Run: `node --test test/settings-tab-wg-relay.test.js test/settings-renderer-browser-env.test.js test/settings-i18n*.test.js`

Expected: WG-specific assertions pass; record unrelated baseline assertions separately.

- [ ] **Step 7: Record, commit and push**

Commit: `更新：远程连接一键部署界面`

Push immediately.

### Task 8: Android versioned QR pairing and encrypted persistence

**Files:**
- Create: `android/app/src/main/java/com/clawd/mobile/data/RelayPairingConfig.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/data/PrefsStore.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/MainActivity.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ui/scan/ScanScreen.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/data/RelayPairingConfigTest.kt`
- Modify: `android/app/src/test/java/com/clawd/mobile/data/PrefsStoreTest.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/integration/RelayPairingIntegrationTest.kt`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing QR parser tests**

Cover valid `clawd://relay-pair?v=1&data=...`, total/payload size limits, base64url, unknown version, malformed keys, public AllowedIPs, wrong phone address, non-WG Relay URL and unknown JSON fields.

- [ ] **Step 2: Run RED Android parser tests**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*RelayPairingConfigTest*'`

Expected: FAIL because the model/parser do not exist.

- [ ] **Step 3: Implement immutable pairing model and parser**

Use serializable nested data classes and `Json { ignoreUnknownKeys = false }`. Export `RelayPairingConfig.fromDeepLink(raw)` returning a typed result with stable error codes; keep `toString()` redacted.

- [ ] **Step 4: Write failing persistence/migration tests**

Prove save/load/delete, no addition to ordinary connection history, replacement of old pairing, and migration from manual `relay_url/relay_token` without inventing a WireGuard config.

- [ ] **Step 5: Implement encrypted pairing persistence**

Add `saveRelayPairing`, `loadRelayPairing`, `clearRelayPairing`, and `hasRelayPairing` to the existing encrypted prefs store. Remove obsolete manual token fields only after a successful full-pair save.

- [ ] **Step 6: Route camera and deep links**

ScanScreen distinguishes LAN `ConnectionConfig` and Relay pairing results. MainActivity accepts the relay-pair deep link from camera or Android intent, stores it and navigates to settings without starting VPN automatically.

- [ ] **Step 7: Run GREEN Android pairing tests**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*RelayPairing*' --tests '*PrefsStoreTest*'`

Expected: all selected tests pass.

- [ ] **Step 8: Record, commit and push**

Commit: `新增：安卓扫码配对中继`

Push immediately.

### Task 9: Embedded Android WireGuard restricted to Clawd Mobile

**Files:**
- Modify: `android/gradle/libs.versions.toml`
- Modify: `android/app/build.gradle.kts`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/java/com/clawd/mobile/vpn/ClawdWireGuardTunnel.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/vpn/WireGuardConfigFactory.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/vpn/WireGuardController.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/vpn/WireGuardConfigFactoryTest.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/vpn/WireGuardControllerTest.kt`
- Modify: `NOTICE.md`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Add the pinned official tunnel dependency and failing config tests**

Pin `com.wireguard.android:tunnel:1.0.20230706`. Assert generated config contains exactly one `IncludedApplications` entry equal to `com.clawd.mobile`, one private `/24` AllowedIP, one Peer and no DNS/default route.

- [ ] **Step 2: Run RED VPN tests**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*WireGuardConfigFactoryTest*'`

Expected: FAIL because the factory is absent.

- [ ] **Step 3: Implement config factory and Tunnel adapter**

Build official WireGuard `Config` objects from validated pairing data. `ClawdWireGuardTunnel` has the stable name `clawd-remote`, tracks state callbacks and never exposes config in logs.

- [ ] **Step 4: Write failing controller state tests**

Inject a Backend adapter and permission launcher. Cover `UNPAIRED`, `PERMISSION_REQUIRED`, `STARTING`, `UP`, `FAILED`, `STOPPING`, `DOWN`; duplicate starts coalesce; permission denial stays down; stop is idempotent; backend error is mapped to a stable user error.

- [ ] **Step 5: Implement WireGuardController**

Wrap `GoBackend`, expose `StateFlow<RemoteTunnelState>`, `prepareIntent()`, `onPermissionResult(granted)`, `start(pairing)`, `stop()`, and `statistics()`. Never request VPN permission from a background-only context.

- [ ] **Step 6: Verify manifest merge and GREEN tests**

Run:

```bash
cd android
./gradlew testDebugUnitTest --tests '*WireGuard*'
./gradlew :app:processDebugMainManifest
```

Inspect the merged manifest to confirm the WireGuard VpnService exists and is non-exported.

- [ ] **Step 7: Record license, commit and push**

Commit: `新增：安卓内置 WireGuard 隧道`

Push immediately.

### Task 10: Android one-click remote connection, rollback and settings UI

**Files:**
- Create: `android/app/src/main/java/com/clawd/mobile/service/RemoteConnectionCoordinator.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/service/WsConnectionService.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ws/ConnectionStrategy.kt`
- Refactor: `android/app/src/main/java/com/clawd/mobile/ui/settings/RelaySettings.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ui/settings/SettingsScreen.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/MainActivity.kt`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/src/main/res/values-en/strings.xml`
- Modify: `android/app/src/main/res/values-zh/strings.xml`
- Create: `android/app/src/test/java/com/clawd/mobile/service/RemoteConnectionCoordinatorTest.kt`
- Modify: `android/app/src/test/java/com/clawd/mobile/service/WsConnectionServiceTest.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/ui/settings/RelaySettingsStateTest.kt`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing coordinator order/rollback tests**

Require exact success order `vpn.start → health.check → relay.connect`, exact disconnect order `relay.disconnect → vpn.stop`, and rollback on VPN, health or WebSocket failures. Cover 15-second timeout, cancellation, network change retry and no auto-connect after process restart.

- [ ] **Step 2: Run RED coordinator tests**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*RemoteConnectionCoordinatorTest*'`

Expected: FAIL because coordinator does not exist.

- [ ] **Step 3: Implement coordinator and service actions**

Add `ACTION_REMOTE_CONNECT` and `ACTION_REMOTE_DISCONNECT`. Coordinator loads pairing, starts VPN, checks `http://10.8.0.1:7891/health`, then configures/connects only the Relay client. LAN client remains independent and SessionMerger keeps both sources.

- [ ] **Step 4: Write failing settings-state tests**

Prove unpaired UI shows scan guidance, paired UI shows VPS name and one connect button, connecting disables destructive actions, connected shows disconnect, and delete stops the connection then clears pairing.

- [ ] **Step 5: Implement settings UI and VPN permission handoff**

Replace manual URL/Token fields. MainActivity owns the Activity Result launcher for `VpnService.prepare()` and resumes the pending coordinator start only on grant. RelaySettings observes coordinator state and renders localized stage/error text.

- [ ] **Step 6: Run GREEN Android feature tests**

Run:

```bash
cd android
./gradlew testDebugUnitTest --tests '*RemoteConnectionCoordinatorTest*' --tests '*WsConnectionServiceTest*' --tests '*RelaySettingsStateTest*' --tests '*ConnectionStrategyTest*'
```

Expected: all selected tests pass.

- [ ] **Step 7: Record, commit and push**

Commit: `新增：安卓一键远程连接`

Push immediately.

### Task 11: Sidecar packaging, CI gates and operator smoke script

**Files:**
- Create: `scripts/build-wg-relay-sidecar.js`
- Create: `scripts/verify-wg-relay-sidecars.js`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `.github/workflows/build.yml`
- Modify: `.github/workflows/android.yml`
- Create: `scripts/smoke-wg-relay-vps.sh`
- Create: `test/verify-wg-relay-sidecars.test.js`
- Create: `test/wg-relay-packaging.test.js`
- Modify: `README.md`
- Modify: `android/README.md`
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`

- [ ] **Step 1: Write failing packaging tests**

Assert stable target names for Windows x64/arm64, macOS x64/arm64 and Linux x64/arm64; package resources include only the current target; Relay source and `ws` runtime files are included; every build command runs verification first.

- [ ] **Step 2: Run RED packaging tests**

Run: `node --test test/verify-wg-relay-sidecars.test.js test/wg-relay-packaging.test.js`

Expected: FAIL because scripts/resources are absent.

- [ ] **Step 3: Implement build and verify scripts**

`npm run build:wg-relay-sidecar -- --target <target>` sets GOOS/GOARCH and writes to `wg-relay-sidecars/<target>/clawd-wg-tunnel[.exe]`. Verification checks file existence, nonzero size and executable mode where applicable. Add current target under electron-builder `extraResources`.

- [ ] **Step 4: Add CI gates**

Desktop workflow builds/tests all six sidecar targets and runs Node WG tests. Android workflow runs unit tests, lint and debug assembly with the embedded tunnel library. Keep existing release behavior unchanged and upload diagnostic artifacts only on failure.

- [ ] **Step 5: Add real VPS smoke script**

The script accepts `CLAWD_TEST_VPS_HOST`, `CLAWD_TEST_VPS_USER`, `CLAWD_TEST_VPS_PORT` and reads the password from a prompt or CI secret. It deploys twice, verifies systemd enable/active, checks only WG UDP is exposed, starts the PC sidecar, checks `/health`, rotates phone, verifies old key/token rejection, and prints a redacted checklist.

- [ ] **Step 6: Document exact user flow and requirements**

README documents four-field first deployment, QR pairing, later one-click use, cloud UDP firewall caveat, supported OS/architectures and the 1C2G VPS recommendation. Do not document manual token entry as the primary path.

- [ ] **Step 7: Run GREEN packaging and workflow tests**

Run:

```bash
node --test test/verify-wg-relay-sidecars.test.js test/wg-relay-packaging.test.js
npm run build:wg-relay-sidecar -- --target darwin-arm64
npm run verify:wg-relay-sidecars
```

Expected: all commands pass on the current host.

- [ ] **Step 8: Record, commit and push**

Commit: `配置：打包并验证远程连接组件`

Push immediately.

### Task 12: Full verification, code review and completion audit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md`
- Modify only if evidence requires fixes: all files changed by Tasks 1–11

- [ ] **Step 1: Run focused Node suites**

Run all `wg-relay`, Relay bridge/server, managed-session forwarding, settings and packaging tests individually. Expected: zero failures in the focused scope.

- [ ] **Step 2: Run Go verification**

Run `go test ./...`, `go test -race ./...`, and all six cross-builds from the sidecar module. Expected: zero failures.

- [ ] **Step 3: Run Android verification**

Run:

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Run full Node regression suite and compare baseline**

Run `npm test`, capture exact pass/fail counts, and compare each failure to the recorded pre-feature baseline. Fix every new failure; do not claim unrelated baseline failures are resolved unless verified.

- [ ] **Step 5: Run secret and scope audits**

Search tracked files and test logs for fixture secrets, private keys, passwords and real Tokens. Verify no code pushes to upstream, no Relay port firewall opening exists, Android config has only `com.clawd.mobile`, and startup paths do not auto-connect.

- [ ] **Step 6: Run independent spec-compliance review**

Give a fresh reviewer the design, implementation plan and branch diff. Fix all Critical/Important findings, re-run affected tests, and request re-review until approved.

- [ ] **Step 7: Run real Linux VPS smoke**

Use only a VPS explicitly authorized for testing. Execute the smoke script, reboot the VPS, repeat PC connect, test Android over cellular, confirm another Android app keeps its normal route, rotate the phone and verify the old phone is rejected.

- [ ] **Step 8: Complete requirement-by-requirement audit**

For every acceptance item in design section 12, link current command output, runtime observation or CI run. Mark the spec complete only when every item has direct evidence.

- [ ] **Step 9: Commit fixes/progress and push after each commit**

Use Chinese messages describing each verified fix. The final documentation commit is:

```bash
git add docs/superpowers/specs/2026-07-13-one-click-wireguard-relay-design.md
git commit -m "更新：完成一键远程连接验收"
git push origin codex/one-click-wireguard-relay
```

- [ ] **Step 10: Final branch verification**

Confirm clean status, local HEAD equals `origin/codex/one-click-wireguard-relay`, and GitHub Actions for the pushed HEAD are green. Do not merge or push to upstream.

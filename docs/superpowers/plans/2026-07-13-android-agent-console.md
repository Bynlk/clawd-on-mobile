# Android Agent Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete fork-local Android Agent Console described by `docs/superpowers/specs/2026-07-12-android-agent-console-design.md`.

**Architecture:** Clawd on Desk owns bundled PTY-backed managed sessions and a bounded, sequenced in-memory event history. The existing authenticated mobile WebSocket protocol carries capabilities, history chunks, live deltas, input leases, input, interrupts, and session creation through either LAN or the existing opaque Relay. Android keeps an ordered repository per session and renders one Compose chat console with structured rich-text cards plus raw-terminal fallback.

**Tech Stack:** Electron/Node.js, `node-pty`, Node test runner, WebSocket JSON protocol, Kotlin 2.1, coroutines/StateFlow, kotlinx.serialization, Jetpack Compose Material 3, JUnit/MockK/Turbine.

---

## Baseline note

`npm test` on commit `a481c6b` has pre-existing failures unrelated to this feature (permission sanitizer exports, missing root localized READMEs, server port expectations, and stale settings-renderer source assertions). New desktop tests must pass in isolation and the final run must show no new failures. Android tests cannot run in the current macOS environment until a JDK 17 runtime is available; source-level Kotlin verification and CI workflow coverage remain required, and the final handoff must state this environment limitation if it persists.

### Task 1: Sequenced managed-session event store

**Files:**
- Create: `src/managed-session-store.js`
- Create: `test/managed-session-store.test.js`

- [ ] **Step 1: Write failing store tests**

Test a per-session monotonic sequence, byte/record eviction, history pagination after a sequence, reset signaling when the requested sequence was evicted, and process-lifetime-only state:

```js
const store = new ManagedSessionStore({ maxRecords: 3, maxBytes: 1024, now: () => 42 });
store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });
assert.equal(store.append("s1", { kind: "assistant_text", text: "one" }).sequence, 1);
assert.deepStrictEqual(store.historyAfter("s1", 0).records.map((r) => r.sequence), [1]);
```

- [ ] **Step 2: Run `node --test test/managed-session-store.test.js` and verify missing-module failure**
- [ ] **Step 3: Implement `ManagedSessionStore` with `createSession`, `listSessions`, `append`, `historyAfter`, `updateSession`, `removeSession`, and `clear`**
- [ ] **Step 4: Re-run the focused test and `git diff --check`**
- [ ] **Step 5: Commit and push to `origin codex/android-agent-console`**

### Task 2: PTY managed-session runtime and agent catalog

**Files:**
- Create: `src/managed-agent-catalog.js`
- Create: `src/managed-session-runtime.js`
- Create: `src/managed-terminal-normalizer.js`
- Create: `test/managed-agent-catalog.test.js`
- Create: `test/managed-session-runtime.test.js`
- Create: `test/managed-terminal-normalizer.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `agents/registry.js`

- [ ] **Step 1: Write failing catalog tests**

Require only enabled agents with an executable launch command and only normalized, existing directories from `process.cwd()`, the user home, and current session CWDs:

```js
assert.deepStrictEqual(catalog.listAgents().map((a) => a.id), ["codex"]);
assert.throws(() => catalog.resolveCreateRequest({ agentId: "missing", cwd: "/tmp" }), /agent_not_available/);
```

- [ ] **Step 2: Write failing runtime tests with an injected fake PTY provider**

Cover spawn, output sequencing, input, resize, interrupt, exit, invalid session, and cleanup without invoking a real shell.

- [ ] **Step 3: Write failing normalizer tests**

Cover ANSI stripping for semantic text, carriage-return progress replacement, fenced code, unified diff classification, visible `Thinking` classification, and `terminal_delta` fallback.

- [ ] **Step 4: Implement catalog, normalizer, and runtime against injected dependencies**

The runtime API is:

```js
runtime.create({ agentId, cwd, cols, rows });
runtime.write(sessionId, data);
runtime.resize(sessionId, cols, rows);
runtime.interrupt(sessionId);
runtime.listSessions();
runtime.historyAfter(sessionId, sequence, limit);
runtime.dispose();
```

- [ ] **Step 5: Add `node-pty` as a runtime dependency and lazy-load it only when the production provider is used**
- [ ] **Step 6: Run all three focused test files**
- [ ] **Step 7: Commit and push**

### Task 3: Mobile protocol, content-sync gate, and single-writer lease

**Files:**
- Create: `src/managed-session-mobile-bridge.js`
- Create: `test/managed-session-mobile-bridge.test.js`
- Modify: `src/mobile-ws-server.js`
- Modify: `src/mobile-server-integration.js`
- Modify: `src/server.js`
- Modify: `src/main.js`
- Modify: `test/mobile-ws-server.test.js`

- [ ] **Step 1: Write failing bridge tests**

Cover default-disabled sync, capability snapshot, session creation, history chunks below 48 KiB, live deltas, ACK tracking, lease acquisition/release, first-writer-wins, stale lease release on disconnect, input rejection without a lease, interrupt, resize, and explicit error frames.

- [ ] **Step 2: Write failing WebSocket client-identity tests**

Require `MobileWSServer` to expose stable `clientId` metadata to message handlers and a `send(ws, payload)` helper while preserving current broadcast behavior.

- [ ] **Step 3: Implement `ManagedSessionMobileBridge` and WebSocket server helpers**

Handle these protocol types exactly:

```text
managed_capabilities_request / managed_capabilities
managed_content_sync_set / managed_content_sync_state
managed_sessions_request / managed_sessions_snapshot
managed_session_create / managed_session_created
managed_session_history_request / managed_session_history_chunk
managed_session_ack
managed_session_input
managed_session_resize
managed_session_interrupt
managed_session_input_lease_acquire
managed_session_input_lease_release
managed_session_input_lease_changed
managed_session_delta
managed_session_error
```

- [ ] **Step 4: Wire the runtime into `main.js` → `server.js` → `mobile-server-integration.js` and dispose it on shutdown**
- [ ] **Step 5: Run focused desktop protocol tests**
- [ ] **Step 6: Commit and push**

### Task 4: Relay multiple-phone forwarding without persistence

**Files:**
- Modify: `relay/relay-server.js`
- Modify: `relay-server.js`
- Create: `test/relay-managed-session-forwarding.test.js`

- [ ] **Step 1: Write failing relay tests**

Connect one PC and two phones under one token, verify PC frames reach both phones, each phone frame reaches the PC, disconnecting one phone leaves the other connected, and no message payload is retained in pair state or status output.

- [ ] **Step 2: Replace the single `phone` slot with a bounded phone set while retaining one PC per token**
- [ ] **Step 3: Keep root and deployable Relay implementations behaviorally identical**
- [ ] **Step 4: Run relay tests and existing relay bind tests**
- [ ] **Step 5: Commit and push**

### Task 5: Android protocol models and ordered repository

**Files:**
- Create: `android/app/src/main/java/com/clawd/mobile/console/ConsoleModels.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/console/ConsoleRepository.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/console/ConsoleRepositoryTest.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ws/ParsedMessage.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ws/MessageParser.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ws/MessageHandler.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ws/StreamingClient.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ws/AbstractStreamingClient.kt`

- [ ] **Step 1: Write failing parser/repository tests**

Cover every managed protocol response, deduplication by sequence, ordered merge of history and live deltas, history reset, session switching state, capability updates, lease state, command errors, and ACK generation.

- [ ] **Step 2: Add serializable console models and typed parsed messages**
- [ ] **Step 3: Implement `ConsoleRepository` using `StateFlow` and the existing `StreamingClient.sendMessage` path**
- [ ] **Step 4: Integrate parsed messages through a dedicated console event flow without coupling them to pet session state**
- [ ] **Step 5: Run Android focused tests when JDK 17 is available; otherwise perform Kotlin compile checks in CI and record the local limitation**
- [ ] **Step 6: Commit and push**

### Task 6: Android ChatGPT-style rich console UI

**Files:**
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/ConsoleScreen.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/ConsoleViewModel.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/ConsoleMessageCard.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/DiffCard.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/ToolCallCard.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/RawTerminalCard.kt`
- Create: `android/app/src/main/java/com/clawd/mobile/ui/console/CreateSessionSheet.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/ui/console/ConsoleFormattingTest.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ui/navigation/NavGraph.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ui/sessions/BottomNav.kt`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/src/main/res/values-zh/strings.xml`

- [ ] **Step 1: Write failing pure formatting tests for Markdown spans, code blocks, diff lines/counts, and terminal fallback**
- [ ] **Step 2: Implement virtualized session switcher and timeline**
- [ ] **Step 3: Implement user/assistant/thinking/tool/diff/code/error/raw-terminal cards with copy and expansion**
- [ ] **Step 4: Implement composer, raw-control sheet, interrupt, approval handoff, lease indicator, and create-session sheet**
- [ ] **Step 5: Add a Console navigation item and preserve existing Sessions/Devices/Settings behavior**
- [ ] **Step 6: Run focused tests/compile and inspect Compose previews or screenshots where available**
- [ ] **Step 7: Commit and push**

### Task 7: Default-off sync preference and background behavior

**Files:**
- Modify: `android/app/src/main/java/com/clawd/mobile/data/PrefsStore.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ui/settings/SettingsScreen.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/service/WsConnectionService.kt`
- Modify: `android/app/src/main/java/com/clawd/mobile/ui/navigation/ServiceManager.kt`
- Create: `android/app/src/test/java/com/clawd/mobile/console/ConsoleSyncPreferenceTest.kt`
- Modify: Android localized string resources

- [ ] **Step 1: Write failing tests proving sync defaults false and enabling it sends an explicit gate message**
- [ ] **Step 2: Add the warning-backed setting and persist it in encrypted preferences**
- [ ] **Step 3: Request capabilities/sessions/history after connection only when enabled**
- [ ] **Step 4: Keep socket/notifications active in background while deferring rendering and requesting missing history on return**
- [ ] **Step 5: Run focused tests and commit/push**

### Task 8: Packaging, documentation, and completion audit

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/android.yml`
- Modify: `README.md`
- Modify: `android/README.md`
- Create: `docs/project/android-agent-console.md`

- [ ] **Step 1: Ensure Electron Builder packages the PTY native module for supported targets and add an explicit native-module rebuild script**
- [ ] **Step 2: Ensure Android CI runs unit tests, lint, and debug assembly with JDK 17**
- [ ] **Step 3: Document managed-session boundaries, default-off privacy warning, WSS requirement, multi-device lease behavior, and Relay non-persistence**
- [ ] **Step 4: Run all new desktop tests, relevant existing mobile/relay tests, `git diff --check`, Android tests/lint/build in CI-capable environment, and a requirement-by-requirement audit against the design acceptance criteria**
- [ ] **Step 5: Commit and push final documentation/CI changes**
- [ ] **Step 6: Verify `git status` clean and `git ls-remote origin codex/android-agent-console` matches local HEAD; never push upstream**

# Remote Connection Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed WireGuard Relay settings card with a state-driven Remote Connection tab that makes first deployment, daily PC connection, Android pairing, repair, and deployment failure mutually clear while preserving every existing backend and IPC contract.

**Architecture:** Add a browser/CommonJS-compatible pure view-model that classifies safe error domains, derives one of six finite page modes, selects the only primary action, and summarizes deployment progress without DOM access or secrets. Keep IPC calls, listener ownership, password inputs, confirmations, and QR scrubbing in the existing tab module, but make its render functions consume the view-model instead of independently inferring state. The visual layer becomes a setup form, a focused deployment/failure surface, or a three-domain daily summary with native disclosures for technical details and advanced management.

**Tech Stack:** Electron 41 renderer, browser-compatible CommonJS JavaScript, Node.js built-in test runner, hand-built DOM test harness, HTML/CSS, desktop localization for `en`, `zh`, `zh-TW`, `ko`, and `ja`.

---

## Delivery rules

- Work only in `/Users/new/Documents/clawd-on-mobile/fork-source/.worktrees/one-click-wireguard-relay` on `codex/one-click-wireguard-relay`.
- Before every commit and push, verify that `origin` is exactly `https://github.com/Bynlk/clawd-on-mobile.git`, the current branch is `codex/one-click-wireguard-relay`, and no backend, IPC, VPS installer, Android, or protocol file entered the diff.
- Use strict TDD for each behavioral slice: write a focused test, run it and observe the expected failure, implement only enough production behavior to pass, then run the focused and neighboring suites.
- Use Chinese `动作：描述` commit messages. Immediately after every successful commit, run `git push origin codex/one-click-wireguard-relay`; never push `upstream`, merge, or create a pull request.
- Preserve commits `42ff8c6` and `5fbcee4`; do not rewrite history or revert unrelated fixes.
- Never retain an SSH password outside the live password input and the immediate `window.wgRelay.deploy({ profile, password })` call. Clear the input synchronously on submit, cancel, rerender, tab exit, and disposal.
- Do not claim the full repository suite is green. Record focused results separately from the known unrelated historical `npm test` failures.

## File map and responsibilities

- Create `src/settings-wg-relay-view-model.js`: pure page modes, error-domain classification, progress mapping, domain rows, primary/secondary action selection, and secret-dependent visibility.
- Create `test/settings-wg-relay-view-model.test.js`: exhaustive finite-state, progress, error-domain, and immutability tests without a fake browser.
- Modify `src/settings-tab-wg-relay.js`: retain IPC/listener/dialog ownership while replacing mixed conditional DOM with view-model-driven setup, deployment, failure, daily, and repair renders.
- Modify `test/settings-tab-wg-relay.test.js`: load the pure view-model into the VM harness and cover DOM structure, one-primary-action invariants, Enter submission, password clearing, failure cleanup, action visibility, focus, and listener races.
- Modify `src/settings.html`: load `settings-wg-relay-view-model.js` immediately before `settings-tab-wg-relay.js`.
- Modify `src/settings.css`: replace the old status-card/progress-list styling with deployment summary, domain rows, callout, disclosures, responsive/text-scale, focus-visible, contrast, and reduced-motion styling.
- Modify `src/settings-i18n.js`: add and update every Remote Connection string in all five desktop languages.
- Modify this plan as an execution record by checking completed steps and recording exact verification evidence.
- Do not modify `src/wg-relay-ipc.js`, `src/wg-relay-deploy.js`, `src/wg-relay-runtime.js`, `src/preload-settings.js`, `relay/**`, `android/**`, or any protocol/installer file unless a test proves an existing contract was accidentally changed; the intended implementation requires no such changes.

---

### Task 1: Pure Remote Connection page view-model

**Files:**
- Create: `test/settings-wg-relay-view-model.test.js`
- Create: `src/settings-wg-relay-view-model.js`
- Modify: `src/settings.html`
- Modify: `docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md`

- [x] **Step 1: Write the failing six-mode state matrix tests**

Create `test/settings-wg-relay-view-model.test.js` with table-driven assertions for Setup, Deploying, Ready, Connected, Repair required, and Deployment failure. The test API is fixed as follows:

```js
const {
  PAGE_MODES,
  PROGRESS_STAGES,
  createDeploymentProgress,
  applyDeploymentProgress,
  classifyWgRelayError,
  deriveWgRelayPageModel,
} = require("../src/settings-wg-relay-view-model");

const setup = deriveWgRelayPageModel({
  hasDeployedProfile: false,
  status: { status: "idle" },
  operation: null,
  deploymentFailure: null,
  errorCode: null,
  repairFormOpen: false,
  runtimeAvailable: true,
  progressStates: createDeploymentProgress(),
});
assert.equal(setup.mode, PAGE_MODES.SETUP);
assert.deepEqual(setup.primaryAction, {
  kind: "deploy",
  labelKey: "wgRelayDeploy",
  disabled: false,
});
assert.deepEqual(setup.rows, []);

const connected = deriveWgRelayPageModel({
  hasDeployedProfile: true,
  host: "relay.example.test",
  status: { status: "connected" },
  operation: null,
  deploymentFailure: null,
  errorCode: null,
  repairFormOpen: false,
  runtimeAvailable: true,
  progressStates: createDeploymentProgress(),
});
assert.equal(connected.mode, PAGE_MODES.CONNECTED);
assert.deepEqual(connected.rows.map((row) => row.kind), ["vps", "computer", "android"]);
assert.equal(connected.primaryAction.kind, "disconnect");
assert.deepEqual(connected.secondaryActions.map((action) => action.kind), [
  "rotate-phone", "repair", "delete-local",
]);
```

Add separate assertions that Ready uses `connect`, Deploying uses a disabled `deploying` primary representation, Repair required uses only `repair` as the primary action, Deployment failure uses `retry-deploy`, and opening the repair form suppresses the daily primary action so the repair submit remains the sole accent action.

- [x] **Step 2: Run the state matrix test and verify RED**

Run: `node --test test/settings-wg-relay-view-model.test.js`

Expected: FAIL with `MODULE_NOT_FOUND` for `src/settings-wg-relay-view-model.js`.

- [x] **Step 3: Write failing error-domain and secret-availability tests**

Add one table that fixes the public classification contract:

```js
const cases = [
  ["deploy_failed", "deployment", "deploy_failed", false],
  ["secret_store_read_failed", "secure-storage", "secret_store_read_failed", true],
  ["secret_store_preflight_failed", "secure-storage", "secure_storage_unavailable", true],
  ["connection_timeout", "pc-tunnel", "connection_failed", false],
  ["sidecar_protocol", "pc-tunnel", "sidecar_failed", false],
  ["health_timeout", "relay-health", "health_failed", false],
  ["relay_closed", "relay-health", "relay_failed", false],
  ["pairing_qr_failed", "pairing", "pairing_qr_failed", false],
  ["not-a-public-code", "unknown", "unknown", false],
];
for (const [code, domain, safeCode, requiresRepair] of cases) {
  assert.deepEqual(classifyWgRelayError(code), {
    domain,
    safeCode,
    requiresRepair,
    secretsAvailable: !requiresRepair,
  });
}
```

Also prove that every repair-required model omits `show-pairing-qr` and `rotate-phone`, exposes a single error descriptor, retains `delete-local` under advanced management, and never leaks the raw backend code as user-facing text.

- [x] **Step 4: Write failing pure progress tests**

Prove the mapper is immutable, maps the existing raw IPC stages, exposes one current sentence plus overall completion, and removes pending detail rows after failure:

```js
const initial = createDeploymentProgress();
assert.deepEqual(initial, ["current", ...Array(9).fill("pending")]);
const uploaded = applyDeploymentProgress(initial, { step: "upload", status: "ok" });
assert.deepEqual(initial, ["current", ...Array(9).fill("pending")]);
assert.deepEqual(uploaded.slice(0, 4), ["complete", "complete", "complete", "pending"]);

const failed = applyDeploymentProgress(uploaded, { step: "install", status: "fail" });
const model = deriveWgRelayPageModel({
  hasDeployedProfile: false,
  status: { status: "idle" },
  operation: null,
  deploymentFailure: { errorCode: "deploy_failed", context: "setup" },
  errorCode: "deploy_failed",
  repairFormOpen: false,
  runtimeAvailable: true,
  progressStates: failed,
});
assert.equal(model.mode, PAGE_MODES.DEPLOYMENT_FAILURE);
assert.deepEqual(model.progress.detailStages.map((stage) => stage.state), [
  "complete", "complete", "complete", "failed",
]);
assert.equal(model.progress.detailStages.some((stage) => stage.state === "pending"), false);
```

Cover `host-key`, `validate → save current`, PC connection status progression, and successful completion across the existing ten public stage keys without changing IPC payloads.

- [x] **Step 5: Implement the minimal browser/CommonJS view-model**

Implement the module with this stable export shape and no DOM, localization, IPC, timers, or secret values:

```js
"use strict";

function buildSettingsWgRelayViewModelExports() {
  const PAGE_MODES = Object.freeze({
    SETUP: "setup",
    DEPLOYING: "deploying",
    READY: "ready",
    CONNECTED: "connected",
    REPAIR_REQUIRED: "repair-required",
    DEPLOYMENT_FAILURE: "deployment-failure",
  });
  const PROGRESS_STAGES = Object.freeze([
    "connect", "fingerprint", "upload", "dependencies", "wireguard",
    "relay", "verify", "save", "pcConnect", "qr",
  ]);
  const RAW_PROGRESS_STAGE = Object.freeze({
    connect: 0, "host-key": 1, upload: 2, install: 3, detect: 3,
    "install-wg": 4, "gen-keys": 4, "write-conf": 4,
    "start-service": 5, firewall: 5, readback: 6, validate: 6,
    save: 7, persist: 7, "pc-connect": 8, pc_connect: 8, qr: 9,
  });
  const RUNTIME_BUSY_STATUSES = new Set([
    "starting_tunnel", "verifying_relay", "connecting_relay", "disconnecting",
  ]);
  const ERROR_DEFINITIONS = Object.freeze({
    invalid_profile: ["deployment", "invalid_profile", false],
    password_required: ["deployment", "password_required", false],
    runtime_unavailable: ["deployment", "runtime_unavailable", false],
    deploy_failed: ["deployment", "deploy_failed", false],
    deploy_aborted: ["deployment", "deploy_aborted", false],
    remote_commit_recovery_required: ["deployment", "remote_commit_recovery_required", true],
    profile_conflict_recovery_required: ["deployment", "profile_conflict_recovery_required", true],
    secure_storage_unavailable: ["secure-storage", "secure_storage_unavailable", true],
    secret_store_read_failed: ["secure-storage", "secret_store_read_failed", true],
    secret_store_preflight_failed: ["secure-storage", "secure_storage_unavailable", true],
    secret_store_verification_failed: ["secure-storage", "secure_storage_unavailable", true],
    secrets_not_found: ["secure-storage", "secrets_not_found", true],
    profile_not_found: ["secure-storage", "profile_not_found", true],
    local_storage_retry_required: ["secure-storage", "local_storage_retry_required", false],
    public_profile_retry_required: ["deployment", "public_profile_retry_required", false],
    connection_retry_required: ["pc-tunnel", "connection_retry_required", false],
    connection_failed: ["pc-tunnel", "connection_failed", false],
    sidecar_failed: ["pc-tunnel", "sidecar_failed", false],
    health_failed: ["relay-health", "health_failed", false],
    relay_failed: ["relay-health", "relay_failed", false],
    pairing_qr_retry_required: ["pairing", "pairing_qr_retry_required", false],
    pairing_qr_failed: ["pairing", "pairing_qr_failed", false],
    rotate_failed: ["pairing", "rotate_failed", false],
    rotate_aborted: ["pairing", "rotate_aborted", false],
    invalid_profile_id: ["secure-storage", "invalid_profile_id", false],
    delete_prepare_failed: ["secure-storage", "delete_prepare_failed", false],
    delete_failed: ["secure-storage", "delete_failed", false],
    unknown: ["unknown", "unknown", false],
  });

  function createDeploymentProgress() {
    return PROGRESS_STAGES.map((_stage, index) => index === 0 ? "current" : "pending");
  }

  function applyDeploymentProgress(states, payload) {
    const next = PROGRESS_STAGES.map((_stage, index) => (
      ["pending", "current", "complete", "failed"].includes(states && states[index])
        ? states[index]
        : "pending"
    ));
    const index = payload && RAW_PROGRESS_STAGE[payload.step];
    if (!Number.isInteger(index)) return next;
    for (let cursor = 0; cursor < index; cursor++) {
      if (next[cursor] !== "failed") next[cursor] = "complete";
    }
    if (payload.status === "fail") next[index] = "failed";
    else if (payload.status === "ok") next[index] = "complete";
    else next[index] = "current";
    if (payload.step === "validate" && payload.status === "ok" && next[7] === "pending") {
      next[7] = "current";
    }
    return next;
  }

  function classifyWgRelayError(code) {
    const normalized = typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code)
      ? code
      : "unknown";
    let definition = ERROR_DEFINITIONS[normalized];
    if (!definition && normalized.startsWith("health_")) {
      definition = ["relay-health", "health_failed", false];
    } else if (!definition && (normalized.startsWith("relay_") || normalized === "local_connect_failed")) {
      definition = ["relay-health", "relay_failed", false];
    } else if (!definition && (normalized.startsWith("connection_") || normalized === "secret_invalid")) {
      definition = ["pc-tunnel", "connection_failed", false];
    } else if (!definition && (
      normalized.startsWith("sidecar_") || normalized.startsWith("device_")
      || normalized.startsWith("endpoint_") || normalized.startsWith("listener_")
      || normalized === "listen_failed" || normalized === "stdin_failed"
      || normalized === "trailing_data" || normalized === "duplicate_ready"
      || normalized.startsWith("invalid_")
    )) {
      definition = ["pc-tunnel", "sidecar_failed", false];
    }
    definition ||= ERROR_DEFINITIONS.unknown;
    return {
      domain: definition[0],
      safeCode: definition[1],
      requiresRepair: definition[2],
      secretsAvailable: !definition[2],
    };
  }

  function progressModel(states, mode) {
    const normalized = PROGRESS_STAGES.map((_stage, index) => (
      ["pending", "current", "complete", "failed"].includes(states && states[index])
        ? states[index]
        : "pending"
    ));
    let currentIndex = normalized.findIndex((state) => state === "failed");
    if (currentIndex < 0) currentIndex = normalized.findIndex((state) => state === "current");
    if (currentIndex < 0) currentIndex = Math.max(0, normalized.lastIndexOf("complete"));
    const completedCount = normalized.filter((state) => state === "complete").length;
    const allStages = PROGRESS_STAGES.map((key, index) => ({ key, state: normalized[index] }));
    return {
      currentStage: PROGRESS_STAGES[currentIndex],
      currentState: normalized[currentIndex],
      completedCount,
      total: PROGRESS_STAGES.length,
      percent: Math.round((completedCount / PROGRESS_STAGES.length) * 100),
      detailStages: mode === PAGE_MODES.DEPLOYMENT_FAILURE
        ? allStages.filter((stage) => stage.state !== "pending")
        : allStages,
    };
  }

  function deriveWgRelayPageModel(input = {}) {
    const status = input.status && typeof input.status === "object" ? input.status : { status: "idle" };
    const statusName = typeof status.status === "string" ? status.status : "idle";
    const statusDefinition = ERROR_DEFINITIONS[statusName];
    const sourceError = input.deploymentFailure && input.deploymentFailure.errorCode
      ? input.deploymentFailure.errorCode
      : (status.errorCode
        || (statusDefinition && statusDefinition[2] ? statusName : null)
        || input.errorCode
        || null);
    const error = sourceError ? classifyWgRelayError(sourceError) : null;
    const operation = typeof input.operation === "string" ? input.operation : null;
    const busy = Boolean(operation);
    let mode;
    if (operation === "deploy") mode = PAGE_MODES.DEPLOYING;
    else if (input.deploymentFailure) mode = PAGE_MODES.DEPLOYMENT_FAILURE;
    else if (!input.hasDeployedProfile) mode = PAGE_MODES.SETUP;
    else if (error && error.requiresRepair) mode = PAGE_MODES.REPAIR_REQUIRED;
    else if (statusName === "connected" || statusName === "disconnecting" || operation === "disconnect") {
      mode = PAGE_MODES.CONNECTED;
    } else mode = PAGE_MODES.READY;

    let primaryAction = null;
    if (mode === PAGE_MODES.SETUP) {
      primaryAction = { kind: "deploy", labelKey: "wgRelayDeploy", disabled: !input.runtimeAvailable };
    } else if (mode === PAGE_MODES.DEPLOYING) {
      primaryAction = { kind: "deploying", labelKey: "wgRelayDeploying", disabled: true };
    } else if (mode === PAGE_MODES.DEPLOYMENT_FAILURE) {
      primaryAction = { kind: "retry-deploy", labelKey: "wgRelayTryDeployAgain", disabled: !input.runtimeAvailable };
    } else if (!input.repairFormOpen && mode === PAGE_MODES.REPAIR_REQUIRED) {
      primaryAction = { kind: "repair", labelKey: "wgRelayRepair", disabled: busy || !input.runtimeAvailable };
    } else if (!input.repairFormOpen && mode === PAGE_MODES.CONNECTED) {
      primaryAction = {
        kind: "disconnect",
        labelKey: operation === "disconnect" || statusName === "disconnecting"
          ? "wgRelayDisconnecting"
          : "wgRelayDisconnect",
        disabled: busy || !input.runtimeAvailable || RUNTIME_BUSY_STATUSES.has(statusName),
      };
    } else if (!input.repairFormOpen && mode === PAGE_MODES.READY) {
      primaryAction = {
        kind: "connect",
        labelKey: operation === "connect" || RUNTIME_BUSY_STATUSES.has(statusName)
          ? "wgRelayConnecting"
          : "wgRelayConnect",
        disabled: busy || !input.runtimeAvailable || RUNTIME_BUSY_STATUSES.has(statusName),
      };
    }

    const secretsAvailable = !(error && error.requiresRepair);
    const isDailyMode = [
      PAGE_MODES.READY, PAGE_MODES.CONNECTED, PAGE_MODES.REPAIR_REQUIRED,
    ].includes(mode);
    const rows = input.hasDeployedProfile && isDailyMode ? [
      {
        kind: "vps",
        state: mode === PAGE_MODES.REPAIR_REQUIRED ? "repair-required" : "configured",
        labelKey: "wgRelayVpsRow",
        statusKey: mode === PAGE_MODES.REPAIR_REQUIRED
          ? "wgRelayRepairRequiredTitle"
          : "wgRelayVpsConfigured",
        supportingText: typeof input.host === "string" ? input.host : "",
      },
      {
        kind: "computer",
        state: statusName,
        labelKey: "wgRelayComputerRow",
        statusKey: "wgRelayStatus_" + statusName,
      },
      {
        kind: "android",
        state: secretsAvailable ? "pairing-available" : "unavailable",
        labelKey: "wgRelayAndroidRow",
        statusKey: secretsAvailable ? "wgRelayAndroidPairingAvailable" : "wgRelayAndroidUnavailable",
        action: secretsAvailable && mode !== PAGE_MODES.REPAIR_REQUIRED ? {
          kind: "show-pairing-qr",
          labelKey: "wgRelayShowQr",
          disabled: busy || !input.runtimeAvailable,
        } : null,
      },
    ] : [];

    const secondaryActions = !input.hasDeployedProfile || !isDailyMode || input.repairFormOpen ? [] : (
      mode === PAGE_MODES.REPAIR_REQUIRED
        ? [{ kind: "delete-local", labelKey: "wgRelayDelete", disabled: busy || !input.runtimeAvailable }]
        : [
          { kind: "rotate-phone", labelKey: "wgRelayRotatePhone", disabled: busy || !input.runtimeAvailable },
          { kind: "repair", labelKey: "wgRelayRepair", disabled: busy || !input.runtimeAvailable },
          { kind: "delete-local", labelKey: "wgRelayDelete", disabled: busy || !input.runtimeAvailable },
        ]
    );

    return {
      mode,
      rows,
      primaryAction,
      secondaryActions,
      error,
      progress: mode === PAGE_MODES.DEPLOYING || mode === PAGE_MODES.DEPLOYMENT_FAILURE
        ? progressModel(input.progressStates, mode)
        : null,
    };
  }

  return {
    PAGE_MODES,
    PROGRESS_STAGES,
    createDeploymentProgress,
    applyDeploymentProgress,
    classifyWgRelayError,
    deriveWgRelayPageModel,
  };
}

const exportsObject = buildSettingsWgRelayViewModelExports();
if (typeof module !== "undefined" && module.exports) module.exports = exportsObject;
if (typeof globalThis !== "undefined") globalThis.ClawdSettingsWgRelayViewModel = exportsObject;
```

- [x] **Step 6: Load the view-model before the tab and run GREEN tests**

Insert `<script src="settings-wg-relay-view-model.js"></script>` immediately before the tab script in `src/settings.html`, then run:

`node --test test/settings-wg-relay-view-model.test.js test/settings-window.test.js test/settings-renderer-browser-env.test.js`

Expected: all selected tests pass, and `settings.html` still loads the renderer after both modules.

- [x] **Step 7: Review scope, commit, and immediately push**

Run:

```bash
git diff --check
git diff --name-only
git remote get-url origin
git branch --show-current
```

Expected: only the four Task 1 files are changed; origin and branch match the delivery rules.

Then run:

```bash
git add src/settings-wg-relay-view-model.js src/settings.html test/settings-wg-relay-view-model.test.js docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md
git commit -m "新增：远程连接页面状态模型"
git push origin codex/one-click-wireguard-relay
```

Immediately confirm local HEAD equals `origin/codex/one-click-wireguard-relay`.

### Task 2: Focused setup, deployment, and deployment-failure DOM

**Files:**
- Modify: `test/settings-tab-wg-relay.test.js`
- Modify: `src/settings-tab-wg-relay.js`
- Modify: `docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md`

- [x] **Step 1: Make the DOM harness load the pure view-model**

Read `settings-wg-relay-view-model.js` next to `TAB_SOURCE`, execute it first in the same VM context, and assert `ClawdSettingsWgRelayViewModel.deriveWgRelayPageModel` exists before initializing the tab. Keep the existing fake DOM, race, focus-trap, and listener helpers unchanged except where native form/details/progress semantics require small properties.

- [x] **Step 2: Write failing Setup and Enter-submission tests**

Replace the first-use expectation with one native form containing exactly four required inputs, one password hint associated by `aria-describedby`, and exactly one accent submit button:

```js
const form = harness.content.querySelector(".wg-relay-setup-form");
assert.ok(form);
assert.equal(form.querySelectorAll("input").length, 4);
assert.equal(form.querySelectorAll("button").length, 1);
assert.equal(form.querySelector("button").type, "submit");
assert.equal(form.querySelectorAll(".accent").length, 1);
assert.equal(form.querySelector("#wg-relay-password").getAttribute("aria-describedby"),
  "wg-relay-password-hint");

setInput(form.querySelector("#wg-relay-host"), "relay.example.test");
setInput(form.querySelector("#wg-relay-password"), "unit-test-only");
form.dispatchEvent({ type: "submit", bubbles: false });
assert.equal(harness.calls.deploy.length, 1);
assert.equal(form.querySelector("#wg-relay-password").value, "");
```

Verify validation emits one adjacent `role="alert"`, never serializes the password into the profile/dataset/view-model, and retains the host, username, and port draft.

- [x] **Step 3: Run Setup tests and verify RED**

Run: `node --test --test-name-pattern='first-use|one-click deploy|Enter|password' test/settings-tab-wg-relay.test.js`

Expected: FAIL because the current setup uses a section with a click-only `type="button"` and renders progress inside the form.

- [x] **Step 4: Write failing Deploying surface tests**

Start a deferred deployment and assert the form is replaced, not disabled in place:

```js
assert.equal(harness.content.querySelector(".wg-relay-setup-form"), null);
const surface = harness.content.querySelector(".wg-relay-deployment-surface");
assert.ok(surface);
assert.equal(surface.querySelectorAll("input").length, 0);
assert.ok(surface.querySelector(".wg-relay-current-step"));
assert.ok(surface.querySelector("progress"));
const details = surface.querySelector("details");
assert.ok(details);
assert.equal(details.open, false);
assert.equal(details.querySelectorAll(".wg-relay-progress-stage").length, 10);
assert.equal(surface.querySelectorAll(".accent").length, 1);
assert.equal(surface.querySelector(".accent").disabled, true);
```

Emit existing raw `wgRelay:progress` payloads and verify only the current sentence and progress value change while the disclosure remains closed by default.

- [x] **Step 5: Write failing deployment-failure regression tests**

Resolve a deployment with `{ status: "error", errorCode: "deploy_failed" }` after a failed `install` stage. Assert the result has one localized alert, one `Try deployment again` primary action, a closed details disclosure with only completed/failed rows, and zero pending rows:

```js
const failure = harness.content.querySelector(".wg-relay-deployment-failure");
assert.ok(failure);
assert.equal(failure.querySelectorAll(".wg-relay-action-callout").length, 1);
assert.equal(failure.querySelector(".wg-relay-action-callout").getAttribute("role"), "alert");
assert.equal(failure.querySelectorAll(".wg-relay-progress-stage.is-pending").length, 0);
assert.equal(failure.querySelectorAll(".accent").length, 1);
buttonByText(failure, "TRY_DEPLOY_AGAIN").dispatchEvent({ type: "click", bubbles: false });
assert.equal(harness.content.querySelector("#wg-relay-host").value, "relay.example.test");
assert.equal(harness.content.querySelector("#wg-relay-password").value, "");
assert.equal(harness.content.querySelector(".wg-relay-progress"), null);
```

Add a no-progress failure case proving the UI never renders ten pending rows even if the backend rejects before emitting a stage.

- [x] **Step 6: Run deployment tests and verify RED**

Run: `node --test --test-name-pattern='deploy|progress|failure' test/settings-tab-wg-relay.test.js`

Expected: FAIL because the setup form remains visible during deployment and `progressVisible` remains true after failure.

- [x] **Step 7: Implement view-model-driven setup/deployment/failure rendering**

Replace `progressVisible`, `PROGRESS_STAGES`, `RAW_PROGRESS_STAGE`, `applyProgress`, and ad hoc failure rendering with:

```js
const modelApi = root.ClawdSettingsWgRelayViewModel;

const view = {
  // Existing lifecycle, status, dialog, draft, and busy fields remain.
  progressStates: modelApi.createDeploymentProgress(),
  deploymentFailure: null,
  deploymentContext: "setup",
};

function pageModel(profile) {
  return modelApi.deriveWgRelayPageModel({
    hasDeployedProfile: isDeployed(profile),
    host: profile && profile.host,
    status: profile ? statusFor(profile) : { status: "idle" },
    operation: view.busy && view.busy.kind,
    deploymentFailure: view.deploymentFailure,
    errorCode: view.errorCode,
    repairFormOpen: view.repairOpen,
    runtimeAvailable: Boolean(window.wgRelay),
    progressStates: view.progressStates,
  });
}
```

Use `<form>` submit handlers for setup and repair, set `view.deploymentFailure = null` before invoking deploy, replace the form with `renderDeploymentSurface(model)` while busy, set a failure record in both resolved-error and rejected paths, and have `retry-deploy` clear only the failure/progress state. Preserve the non-password draft and synchronously blank the detached password input in `finally`.

- [x] **Step 8: Run GREEN setup/deployment tests and lifecycle regressions**

Run:

```bash
node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js
node --test test/settings-renderer-browser-env.test.js test/settings-window.test.js test/wg-relay-preload.test.js
```

Expected: all selected tests pass; late deploy completion after tab exit still cannot mutate the view, and listeners/dialogs are still cleaned up.

- [x] **Step 9: Review scope, commit, and immediately push**

Verify diff, origin, branch, and focused test output. Then run:

```bash
git add src/settings-tab-wg-relay.js test/settings-tab-wg-relay.test.js docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md
git commit -m "重构：聚焦远程连接部署流程"
git push origin codex/one-click-wireguard-relay
```

Immediately confirm local and origin branch HEADs match.

### Task 3: Three-domain daily page and single-action repair

**Files:**
- Modify: `test/settings-tab-wg-relay.test.js`
- Modify: `src/settings-tab-wg-relay.js`
- Modify: `docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md`

- [x] **Step 1: Write failing daily three-row and one-primary-action tests**

For every safe runtime state (`idle`, three connecting states, `connected`, `disconnecting`, and `failed`), assert the configured page has exactly three domain rows in order and one accent action:

```js
const rows = Array.from(card.querySelectorAll(".wg-relay-domain-row"));
assert.deepEqual(rows.map((row) => row.dataset.domain), ["vps", "computer", "android"]);
assert.equal(rows[0].querySelector(".wg-relay-domain-name").textContent, "VPS_RELAY");
assert.equal(rows[1].querySelector(".wg-relay-domain-name").textContent, "THIS_COMPUTER");
assert.equal(rows[2].querySelector(".wg-relay-domain-name").textContent, "ANDROID");
assert.equal(card.querySelectorAll(".accent").length, 1);
assert.ok(buttonByText(rows[2], "SHOW_QR"));
const advanced = card.querySelector(".wg-relay-advanced-management");
assert.equal(advanced.open, false);
assert.deepEqual(buttons(advanced).map((button) => button.textContent), [
  "ROTATE_PHONE", "REPAIR", "DELETE",
]);
```

Verify the VPS row supporting text is the host, the computer row owns Connect/Disconnect as the only primary page action, the Android QR action is not accent styled, and normal daily pages contain no deployment progress nodes.

- [x] **Step 2: Run daily layout tests and verify RED**

Run: `node --test --test-name-pattern='deployed|daily|three|primary|advanced' test/settings-tab-wg-relay.test.js`

Expected: FAIL because the current status card mixes one badge and four peer secondary buttons without domain rows or disclosure.

- [x] **Step 3: Write failing Repair-required matrix tests**

For each repair code, assert one callout and one recommended action, with no duplicate failed badge/error/recovery blocks and no secret-dependent phone actions:

```js
assert.equal(card.querySelectorAll(".wg-relay-action-callout").length, 1);
assert.equal(card.querySelector(".wg-relay-action-callout").getAttribute("role"), "alert");
assert.equal(card.querySelectorAll(".wg-relay-error").length, 0);
assert.equal(card.querySelectorAll(".wg-relay-recovery").length, 0);
assert.equal(card.querySelectorAll(".accent").length, 1);
assert.equal(card.querySelector(".accent").textContent, "REPAIR");
assert.equal(buttonByText(card, "SHOW_QR"), null);
assert.equal(buttonByText(card, "ROTATE_PHONE"), null);
assert.ok(buttonByText(card, "DELETE"));
```

Click Repair and prove the inline repair form becomes the only accent action, exposes the current advanced network defaults, submits on `submit`, and retains the existing status-patch invariant: a pushed status event must not replace or clear the live password input.

- [x] **Step 4: Write failing action-availability and busy-state tests**

Cover these exact rules:

- a missing runtime bridge disables all visible operations;
- Connect/Disconnect remains one click from the first viewport;
- pairing QR is available only on the Android row when secrets are usable;
- rotate, repair, and delete exist only inside Advanced management during daily use;
- connect/disconnect/QR/rotate/delete operations coalesce double clicks;
- busy labels are localized and disabled without changing button width or adding another accent action;
- repair-required and deployment-failure modes each expose only their recommended primary action;
- QR and confirmation focus traps, Escape cleanup, source scrubbing, stale-owner protection, and destructive confirmation text remain unchanged.

- [x] **Step 5: Run repair/action tests and verify RED**

Run: `node --test --test-name-pattern='recovery|repair|busy|pairing|rotate|delete|focus' test/settings-tab-wg-relay.test.js`

Expected: FAIL on duplicate repair messaging, visible secret-dependent actions, and peer-level maintenance controls.

- [x] **Step 6: Implement the daily rows and repair rendering from the view-model**

Replace `renderStatusCard` with `renderDailyPage(parent, profile, model)`. Build rows from `model.rows`, store only the minimal live nodes needed by `updateStatusMount`, and apply later status events through a fresh `pageModel(profile)` without replacing an open repair form. Use this DOM outline:

```html
<section class="section wg-relay-daily-card">
  <div class="wg-relay-domain-list">
    <div class="wg-relay-domain-row" data-domain="vps">...</div>
    <div class="wg-relay-domain-row" data-domain="computer">...</div>
    <div class="wg-relay-domain-row" data-domain="android">...</div>
  </div>
  <div class="wg-relay-callout-mount"></div>
  <div class="wg-relay-primary-mount"></div>
  <details class="wg-relay-advanced-management">
    <summary>...</summary>
    <div class="wg-relay-secondary-actions">...</div>
  </details>
</section>
```

Each row must include an `aria-hidden="true"` shape marker plus explicit localized status text. Render at most one `role="alert"` callout from `model.error`, omit QR/rotation nodes when absent from the model, keep Delete destructive but secondary, and remove the old `wg-relay-status-badge`, `wg-relay-recovery`, and stacked-error inference.

- [x] **Step 7: Run GREEN DOM, race, focus, and lifecycle tests**

Run:

```bash
node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js
node --test test/wg-relay-preload.test.js test/wg-relay-runtime.test.js test/wg-relay-connection.test.js
```

Expected: all selected tests pass; initial status response/rejection races still cannot overwrite a newer pushed status, and dialog/listener cleanup remains bounded.

- [x] **Step 8: Review scope, commit, and immediately push**

After diff/remote/branch verification, run:

```bash
git add src/settings-tab-wg-relay.js test/settings-tab-wg-relay.test.js docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md
git commit -m "重构：拆分远程连接日常状态"
git push origin codex/one-click-wireguard-relay
```

Immediately confirm local and origin branch HEADs match.

### Task 4: Presentation, localization, and accessibility gates

**Files:**
- Modify: `test/settings-tab-wg-relay.test.js`
- Modify: `test/settings-wg-relay-view-model.test.js`
- Modify: `src/settings.css`
- Modify: `src/settings-i18n.js`
- Modify: `docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md`

- [x] **Step 1: Write failing all-language key coverage tests**

Require every language in `SUPPORTED_LANGS` to define nonempty, non-key fallbacks for these new/updated concepts:

```js
const required = [
  "wgRelayDeploy", "wgRelayDeploying", "wgRelayTryDeployAgain",
  "wgRelayDeploymentFailedTitle", "wgRelayShowDetails", "wgRelayProgressOverall",
  "wgRelayVpsRow", "wgRelayComputerRow", "wgRelayAndroidRow",
  "wgRelayVpsConfigured", "wgRelayAndroidPairingAvailable", "wgRelayAndroidUnavailable",
  "wgRelayAdvancedManagement", "wgRelayConnect", "wgRelayDisconnect",
  "wgRelayConnecting", "wgRelayDisconnecting", "wgRelayRepairRequiredTitle",
];
```

Pin the primary English/Chinese product wording:

```js
assert.equal(strings.en.wgRelayDeploy, "Deploy remote connection");
assert.equal(strings.zh.wgRelayDeploy, "部署远程连接");
assert.equal(strings.en.wgRelayVpsRow, "VPS Relay");
assert.equal(strings.zh.wgRelayComputerRow, "这台电脑");
assert.equal(strings.en.wgRelayAdvancedManagement, "Advanced management");
assert.equal(strings.zh.wgRelayAdvancedManagement, "高级管理");
```

- [x] **Step 2: Run localization tests and verify RED**

Run: `node --test --test-name-pattern='languages|localization' test/settings-tab-wg-relay.test.js test/settings-wg-relay-view-model.test.js`

Expected: FAIL because the new daily/progress/disclosure keys are absent and the old primary copy says `One-click deploy`.

- [x] **Step 3: Add complete copy for all five desktop languages**

Update `WG_RELAY_STRINGS.en`, `.zh`, `["zh-TW"]`, `.ko`, and `.ja` together. Use concise product language, preserve existing safe error translations, and translate these behaviors consistently:

- Deploy remote connection / deploying / try again;
- current step, overall progress, and Show details;
- VPS Relay, This computer, Android, configured, pairing available/unavailable;
- Connect this computer / Disconnect / connecting / disconnecting;
- Advanced management;
- Repair required and one recommended action;
- destructive and QR security confirmations already present.

- [x] **Step 4: Write failing CSS, structure, and accessibility tests**

Extend source/CSS assertions to require:

```js
assert.match(TAB_SOURCE, /createElement\("form"\)/);
assert.match(TAB_SOURCE, /createElement\("details"\)/);
assert.match(TAB_SOURCE, /createElement\("summary"\)/);
assert.match(TAB_SOURCE, /createElement\("progress"\)/);
assert.match(TAB_SOURCE, /aria-describedby/);
assert.match(TAB_SOURCE, /aria-live/);
assert.match(css, /\.wg-relay-domain-row/);
assert.match(css, /\.wg-relay-action-callout/);
assert.match(css, /\.wg-relay-advanced-management/);
assert.match(css, /@media\s*\(max-width:\s*420px\)/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
```

At runtime assert labels point to inputs, one callout uses `role="alert"`, progress exposes an accessible label/value, disclosure summaries are keyboard-native, every visible button has text, statuses include text plus an aria-hidden shape marker, and each rendered mode contains at most one `.accent` action. Retain the existing WCAG AA calculations for light/dark neutral, warning, success, danger, current, complete, and failed text.

- [x] **Step 5: Run style/accessibility tests and verify RED**

Run: `node --test --test-name-pattern='accessibility|a11y|CSS|contrast|primary' test/settings-tab-wg-relay.test.js`

Expected: FAIL because the old CSS targets status badges, peer actions, and an always-visible ten-row grid.

- [x] **Step 6: Replace the Remote Connection CSS block**

Keep the existing semantic color tokens and implement these concrete layout behaviors:

- a `min(100%, 680px)` page width with cards that never horizontally overflow under text scaling;
- a bordered three-row domain list with fixed shape/status column, flexible label/supporting copy, and a non-accent Android row action;
- one full or fit-content accent primary action in the first viewport;
- a compact current-step/progress surface whose native details disclosure is closed by default;
- a single warning/danger callout with `overflow-wrap:anywhere`;
- Advanced management buttons in a secondary grid and Delete using the danger token;
- visible two-pixel focus rings for inputs, buttons, and summaries;
- one-column stacking at 420 px, no clipped labels at increased text scale, and no essential motion;
- QR modal sizing/scrubbing styles retained.

Remove obsolete `.wg-relay-status-badge`, `.wg-relay-recovery`, and daily use of the persistent progress-grid selectors while retaining stage styles inside deployment disclosures.

- [x] **Step 7: Run GREEN localization, DOM, contrast, text-scale, and reduced-motion tests**

Run:

```bash
node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js test/i18n.test.js test/text-scale.test.js
node --test test/settings-renderer-browser-env.test.js test/settings-window.test.js
```

Expected: all selected tests pass with no naked localization key, contrast below 4.5:1, duplicate accent action, or stale progress row.

Verification evidence:

```text
node --test --test-name-pattern='languages|localization' test/settings-tab-wg-relay.test.js test/settings-wg-relay-view-model.test.js
PASS: 2/2

node --test --test-name-pattern='accessibility|a11y|CSS|contrast|primary' test/settings-tab-wg-relay.test.js
PASS: 2/2

node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js test/i18n.test.js test/text-scale.test.js
PASS: 67/67

node --test test/settings-renderer-browser-env.test.js test/settings-window.test.js
PASS: 153/153
```

- [x] **Step 8: Review scope, commit, and immediately push**

After diff/remote/branch verification, run:

```bash
git add src/settings.css src/settings-i18n.js test/settings-tab-wg-relay.test.js test/settings-wg-relay-view-model.test.js docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md
git commit -m "更新：完善远程连接界面与文案"
git push origin codex/one-click-wireguard-relay
```

Immediately confirm local and origin branch HEADs match.

Committed and pushed as:

```text
9927b4a 更新：完善远程连接界面与文案
HEAD == origin/codex/one-click-wireguard-relay == 9927b4a26fc0fe97659b2a315816b2ea4d3bc78c
```

### Task 5: Verification, independent review, real desktop smoke, and restart

**Files:**
- Modify only if evidence requires a scoped fix: files changed in Tasks 1–4
- Modify: `docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md`

- [x] **Step 1: Run the complete focused Remote Connection suite**

Run:

```bash
node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js test/wg-relay-preload.test.js test/settings-renderer-browser-env.test.js test/settings-window.test.js test/i18n.test.js test/text-scale.test.js
node --test test/wg-relay-profile.test.js test/wg-relay-runtime.test.js test/wg-relay-connection.test.js test/wg-relay-ipc.test.js test/main-wg-relay-integration.test.js
node --test test/relay-bridge-integration.test.js test/mobile-server-integration.test.js
```

Expected: zero failures in every selected suite. Record exact pass/test counts from fresh output.

Verification evidence:

```text
node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js test/wg-relay-preload.test.js test/settings-renderer-browser-env.test.js test/settings-window.test.js test/i18n.test.js test/text-scale.test.js
PASS: 223/223

node --test test/wg-relay-profile.test.js test/wg-relay-runtime.test.js test/wg-relay-connection.test.js test/wg-relay-ipc.test.js test/main-wg-relay-integration.test.js
PASS: 152/152

node --test test/relay-bridge-integration.test.js test/mobile-server-integration.test.js
PASS: 73/73
```

- [x] **Step 2: Prove backend/IPC/Android/protocol scope stayed untouched**

Run:

```bash
git diff 5fbcee4 --name-only
git diff 5fbcee4 -- src/wg-relay-ipc.js src/wg-relay-deploy.js src/wg-relay-runtime.js src/preload-settings.js relay android
git diff --check
```

Expected: only plan, pure view-model, tab, HTML, CSS, localization, and desktop test files differ; the scoped backend/IPC/VPS/Android diff is empty.

Audit evidence:

```text
git diff 5fbcee4 --name-only
docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md
src/settings-i18n.js
src/settings-tab-wg-relay.js
src/settings-wg-relay-view-model.js
src/settings.css
src/settings.html
test/settings-renderer-browser-env.test.js
test/settings-tab-wg-relay.test.js
test/settings-wg-relay-view-model.test.js

git diff 5fbcee4 -- src/wg-relay-ipc.js src/wg-relay-deploy.js src/wg-relay-runtime.js src/preload-settings.js relay android
EMPTY

git diff --check
PASS
```

- [x] **Step 3: Run full repository tests and report the baseline honestly**

Run: `npm test`

Capture the exact pass/fail/skipped counts and failing file/assertion names. Compare failures with the branch's known historical missing-file/assertion baseline, fix any new failure caused by this work, and explicitly report unrelated existing failures rather than describing the entire repository as green.

Result:

```text
npm test
NOT GREEN. A fresh complete run exited 1 after the long installer-script tail.

The failure inventory remained confined to the known unrelated baseline:
- test/hardware-buddy-settings.test.js cannot load ../src/hardware-buddy-settings.js;
- test/permission-sanitizers.test.js has historical missing exports and stale assertions;
- test/permission-telegram-approval.test.js expects an older result shape;
- test/readme-contributors.test.js cannot load README.ko-KR.md / README.zh-CN.md.

A focused rerun of those four files reported 90 tests: 53 pass, 37 fail,
0 skipped. No Remote Connection or Mobile settings test entered the failure list.
```

- [x] **Step 4: Run independent spec-compliance and code review**

Give a fresh reviewer the approved spec, this plan, `git diff 5fbcee4`, and focused test output. Require review of finite-state correctness, stale progress, secrets/action visibility, status-response race protection, password clearing, dialog focus/scrubbing, localization completeness, accessibility, and forbidden-scope changes. Fix every Critical or Important finding with a new failing regression test first, rerun affected suites, commit using a Chinese message, and immediately push that commit to origin.

Review result:

```text
Reviewed spec acceptance criteria against:
- pure state matrix/progress/error tests in test/settings-wg-relay-view-model.test.js
- DOM/a11y/lifecycle tests in test/settings-tab-wg-relay.test.js
- browser environment tests in test/settings-renderer-browser-env.test.js
- localization/text-scale tests in test/i18n.test.js and test/text-scale.test.js
- diff scope audit from 5fbcee4
- real desktop screenshot observation

No Critical or Important finding remained.
```

- [x] **Step 5: Launch the actual Electron 41 desktop and open Remote Connection**

Use the existing cached Electron binary; do not download simulators or large components and do not rebuild Android. Stop only the existing desktop process for this worktree, launch the app directly from this worktree, open Settings → Remote Connection, and verify the real Chromium renderer has no console/runtime error.

For a configured profile, visually verify in the first viewport:

- VPS Relay, This computer, and Android appear as three distinct rows;
- only Connect this computer or Disconnect is accent styled;
- Android QR is a row action;
- Advanced management is closed by default;
- no deployment stages appear during daily use;
- the current status and primary action are visible without scrolling.

For an observable repair/failure state, verify only one callout and one recommended action appear, and no ten pending rows remain. Do not alter or expose real secrets merely to manufacture a state.

Smoke evidence:

```text
node launch.js
FAILED to spawn because require("electron") returned a path with a trailing newline (ENOENT).

env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
PASS: desktop process launched; state/mobile servers started; hooks sync completed; no renderer crash observed.

env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --open-settings-window
PASS: Settings window opened via second-instance request.
```

Visual observation after granting Accessibility:

```text
Clawd Settings → 远程连接 is visible.
The page shows three rows: VPS Relay, 这台电脑, Android.
Repair-required state shows one callout, one primary 修复 / 重新部署 action, and Advanced management collapsed.
Android pairing actions are hidden while repair is required.
No ten-row deployment progress list appears during daily/repair-required state.
```

- [x] **Step 6: Inspect a rendered screenshot at normal and increased text scale**

Capture the Settings window or inspect it through the desktop UI. Check normal scale and the application's supported increased text scale for clipping, horizontal overflow, focus visibility, first-viewport primary action placement, and disclosure usability. If visual evidence exposes a defect, add the smallest automated regression test, fix it, rerun focused suites, and repeat the smoke.

Evidence:

```text
/tmp/clawd-wg-smoke/electron-front.png captured the Settings → Remote Connection repair-required state at normal desktop scale. Layout fit in the first viewport with no horizontal overflow or clipped primary action. Text-scale/responsive behavior is covered by focused tests:
node --test test/settings-wg-relay-view-model.test.js test/settings-tab-wg-relay.test.js test/i18n.test.js test/text-scale.test.js
PASS: 67/67
```

- [x] **Step 7: Complete the acceptance audit and execution record**

Re-read every acceptance criterion in `docs/superpowers/specs/2026-07-14-remote-connection-tab-redesign.md` and link it in this plan to one of: a pure-state test, DOM/a11y test, focused command, diff audit, or desktop observation. Check every completed step and record any known unrelated full-suite failures without weakening the focused result.

Acceptance audit:

1. New user four-field setup + one deploy action: `first-use form renders exactly four labelled required fields with safe defaults`, view-model Setup case.
2. Deploying current step + collapsed details: `deploy progress renders ten fixed localized stages and current/completed/failed states`.
3. Configured three rows: `ready and connected pages expose VPS, computer, and Android rows in order`, daily DOM test, desktop observation.
4. One first-viewport connect/disconnect primary: view-model Ready/Connected cases and daily DOM `.accent` assertions.
5. Repair one error/action, hidden invalid phone actions: view-model repair-required test, DOM recovery test, desktop observation.
6. Maintenance/destructive under Advanced management: view-model secondary actions and daily DOM disclosure test.
7. No stale progress during daily/failure: pure progress failure test and DOM tests for daily no `.wg-relay-progress` plus deployment failure without ten pending rows.
8. Scope boundary: `git diff 5fbcee4 -- src/wg-relay-ipc.js src/wg-relay-deploy.js src/wg-relay-runtime.js src/preload-settings.js relay android` was empty.

Follow-up fresh-install review and source audit:

```text
Root cause confirmed:
- the developer VPS host came from that machine's persisted public profile;
- a fresh prefs snapshot has wgRelay.profiles=[] and empty legacy Relay fields;
- no developer host is present in source, Git inputs, or desktop packaging inputs.

TDD review fixes:
- Mobile hides the legacy Relay editor when all three legacy settings are empty,
  while enabled-only, URL-only, and token-only snapshots retain the compatibility editor;
- all five desktop languages define the complete legacy Relay copy, use Connection
  Token rather than Admin Token, and format online/failure status without hard-coded Chinese;
- both legacy inputs have programmatic label associations;
- light/dark input boundaries, primary action text/background, and focus rings use
  contrast-tested WG Relay tokens;
- Repair is a native form with Enter submission, an associated password hint, and the
  same single high-contrast primary action treatment;
- invalid SSH ports report invalid profile rather than password required;
- Connect and Disconnect switch to localized busy labels immediately, before a status push;
- leaving the tab clears its runtime-only status cache, so a later return rechecks
  secrets before restoring QR or phone-rotation actions.

Fresh verification:
- focused desktop UI/i18n/lifecycle: 233/233 pass;
- backend/runtime/IPC/Relay/Mobile integration: 225/225 pass;
- packaging, Relay bundle, and deploy boundaries: 117/117 pass;
- focused Remote Connection + Mobile matrix: 51/51 pass;
- git diff --check: pass;
- forbidden backend/IPC/VPS installer/Relay protocol/Android diff: empty.

Full npm test remains non-green for the pre-existing baseline. Re-running the four
known files produced 90 tests: 53 pass, 37 fail. Failures are the missing
src/hardware-buddy-settings.js module, historical permission-sanitizer exports/assertions,
one Telegram approval assertion difference, and missing README.ko-KR.md / README.zh-CN.md.

Real Electron 41 cold-start smoke (800x528 CSS viewport, isolated --user-data-dir):
- Setup values are [empty host, root, 22, empty password]; exactly one deploy action;
- primary action is fully visible, content has no overflow, alert/progress counts are zero;
- Mobile has no legacy editor for fresh prefs;
- temporarily injected legacy prefs expose two labelled inputs and localized Connection Token;
- Repair shows three domain rows, one callout, one recommended action, no QR/progress,
  and opens a seven-field native form with one submit action;
- light and dark computed input/button styles meet the automated contrast gates;
- console warning/error and runtime exception collections were empty.

Final hands-on inspection through the real Electron accessibility tree and Chromium
renderer confirmed the same from-zero Setup at 100% text scale. At 125%, all four
fields remained unclipped with no horizontal overflow; the primary action was fully
reachable after an 84px vertical scroll. Returning to 100% restored it to the first
viewport. At that checkpoint, the fresh Mobile page still reported its pre-existing
"Mobile token not available" connection-info failure because main.js did not supply
getMobileToken / getMobileWS to registerSettingsIpc.

The user's final desktop inspection brought that visible Mobile failure and the
duplicated Remote Connection / Mobile sidebar icons into follow-up scope. The Network
panel entries named `settings-tab-*.js` are the expected statically loaded Settings
modules, not duplicate visible tabs; there are eleven top-level sidebar tabs plus the
Doctor indicator. The two actual defects were:

- `settings-icons.js` had no `wg-relay` or `mobile` entries, so both tab IDs used the
  same wrench placeholder;
- `registerSettingsIpc` received neither live Mobile Server accessor even though
  `mobileIntegration` already owned both, so connection info always saw a null token.

TDD follow-up added the missing tab IDs to the real renderer-derived icon matrix and a
main-process wiring regression before implementation. `main.js` now supplies lazy,
null-safe `getMobileWS` and `getMobileToken` accessors to the existing Settings IPC
registration. No IPC channel, handler payload, Mobile Server lifecycle, Android code,
WireGuard backend, installer, or Relay protocol changed.

Fresh follow-up evidence:

- desktop UI, localization, lifecycle, Remote Connection, Mobile, icon, and preload
  suites: 240/240 pass;
- Settings IPC, Mobile IPC, WG Relay runtime/connection/main integration, RelayBridge,
  and Mobile Server integration suites: 256/256 pass;
- packaging configuration, desktop/Android boundary, Remote SSH/Relay deploy, bundle,
  and sidecar verification suites: 174/174 pass;
- independent follow-up review found no Critical or Important issue; its targeted
  checks passed 38/38 and Relay/Mobile lifecycle checks passed 87/87;
- the four known unrelated baseline files still report 90 tests: 53 pass and 37 fail,
  with the same missing module/README and historical permission assertions;
- Electron renderer reload reported 0 warnings, 0 errors, and 0 exceptions;
- real Mobile render contained the QR, PWA, and connection-information cards with no
  error/loading node or horizontal overflow;
- real Remote Connection render remained `[empty host, root, 22, empty password]`, one
  primary action, zero alert/progress/pending rows, and no content overflow.

Screenshot evidence:
- /tmp/clawd-wg-smoke/fresh-remote-dark-final.png
- /tmp/clawd-wg-smoke/fresh-remote-light-final.png
- /tmp/clawd-wg-smoke/repair-form-final.png
- /tmp/clawd-wg-final-remote-review.png
- /tmp/clawd-wg-final-remote-125.png
- /tmp/clawd-wg-final-fresh-mobile.png
- /tmp/clawd-mobile-settings-after-wiring-masked.png
- /tmp/clawd-wg-final-remote-after-icons.png
```

- [ ] **Step 8: Commit the final verification record and immediately push**

If the execution record or verification fixes changed files, first verify remote/branch/diff and run all affected tests, then run:

```bash
git add -f docs/superpowers/plans/2026-07-14-remote-connection-tab-redesign.md docs/superpowers/specs/2026-07-14-remote-connection-tab-redesign.md
git add src/mobile-i18n.js src/mobile-settings.css src/settings-i18n.js src/settings-tab-mobile.js src/settings-tab-wg-relay.js src/settings-wg-relay-view-model.js src/settings.css
git add test/settings-tab-mobile.test.js test/settings-tab-wg-relay.test.js test/settings-wg-relay-view-model.test.js
git commit -m "更新：完成远程连接页面验收"
git push origin codex/one-click-wireguard-relay
```

Do not create an empty commit. Immediately confirm the local HEAD and origin branch match.

- [ ] **Step 9: Restart the desktop app for user review**

Terminate the smoke instance only if needed, launch a clean desktop instance from the same worktree, leave Settings → Remote Connection visible, and verify the process remains running. Do not merge, open a pull request, or push any remote other than origin.

- [ ] **Step 10: Final repository handoff checks**

Run:

```bash
git status --short --branch
git branch --show-current
git remote -v
git rev-parse HEAD
git rev-parse origin/codex/one-click-wireguard-relay
```

Expected: clean worktree; current branch `codex/one-click-wireguard-relay`; origin URLs point only to `Bynlk/clawd-on-mobile`; local and origin HEADs are identical. Report the focused pass counts, exact full-suite baseline failures, desktop smoke result, changed file boundary, pushed commits, and running desktop state.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  PAGE_MODES,
  PROGRESS_STAGES,
  createDeploymentProgress,
  applyDeploymentProgress,
  classifyWgRelayError,
  deriveWgRelayPageModel,
} = require("../src/settings-wg-relay-view-model");

const ROOT = path.join(__dirname, "..");
const VIEW_MODEL_PATH = path.join(ROOT, "src", "settings-wg-relay-view-model.js");
const SETTINGS_HTML_PATH = path.join(ROOT, "src", "settings.html");

function input(overrides = {}) {
  return {
    hasDeployedProfile: true,
    host: "relay.example.test",
    status: { status: "idle" },
    operation: null,
    deploymentFailure: null,
    errorCode: null,
    repairFormOpen: false,
    runtimeAvailable: true,
    progressStates: createDeploymentProgress(),
    ...overrides,
  };
}

test("exports the fixed page modes and ten progress stages", () => {
  assert.deepEqual(PAGE_MODES, {
    SETUP: "setup",
    DEPLOYING: "deploying",
    READY: "ready",
    CONNECTED: "connected",
    REPAIR_REQUIRED: "repair-required",
    DEPLOYMENT_FAILURE: "deployment-failure",
  });
  assert.deepEqual(PROGRESS_STAGES, [
    "connect",
    "fingerprint",
    "upload",
    "dependencies",
    "wireguard",
    "relay",
    "verify",
    "save",
    "pcConnect",
    "qr",
  ]);

  const first = createDeploymentProgress();
  const second = createDeploymentProgress();
  assert.deepEqual(first, ["current", ...Array(9).fill("pending")]);
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
});

test("derives all six modes and their only primary action", () => {
  const cases = [
    {
      name: "setup",
      overrides: { hasDeployedProfile: false },
      mode: PAGE_MODES.SETUP,
      primaryAction: { kind: "deploy", labelKey: "wgRelayDeploy", disabled: false },
    },
    {
      name: "deploying",
      overrides: { hasDeployedProfile: false, operation: "deploy" },
      mode: PAGE_MODES.DEPLOYING,
      primaryAction: { kind: "deploying", labelKey: "wgRelayDeploying", disabled: true },
    },
    {
      name: "ready",
      overrides: {},
      mode: PAGE_MODES.READY,
      primaryAction: { kind: "connect", labelKey: "wgRelayConnect", disabled: false },
    },
    {
      name: "connected",
      overrides: { status: { status: "connected" } },
      mode: PAGE_MODES.CONNECTED,
      primaryAction: { kind: "disconnect", labelKey: "wgRelayDisconnect", disabled: false },
    },
    {
      name: "repair-required",
      overrides: { status: { status: "failed", errorCode: "secrets_not_found" } },
      mode: PAGE_MODES.REPAIR_REQUIRED,
      primaryAction: { kind: "repair", labelKey: "wgRelayRepair", disabled: false },
    },
    {
      name: "deployment-failure",
      overrides: {
        hasDeployedProfile: false,
        deploymentFailure: { errorCode: "deploy_failed", context: "setup" },
      },
      mode: PAGE_MODES.DEPLOYMENT_FAILURE,
      primaryAction: {
        kind: "retry-deploy",
        labelKey: "wgRelayTryDeployAgain",
        disabled: false,
      },
    },
  ];

  for (const entry of cases) {
    const model = deriveWgRelayPageModel(input(entry.overrides));
    assert.equal(model.mode, entry.mode, entry.name);
    assert.deepEqual(model.primaryAction, entry.primaryAction, entry.name);
  }
});

test("uses the documented mode priority", () => {
  assert.equal(deriveWgRelayPageModel(input({
    operation: "deploy",
    deploymentFailure: { errorCode: "deploy_failed" },
  })).mode, PAGE_MODES.DEPLOYING);

  assert.equal(deriveWgRelayPageModel(input({
    hasDeployedProfile: false,
    deploymentFailure: { errorCode: "deploy_failed" },
  })).mode, PAGE_MODES.DEPLOYMENT_FAILURE);

  assert.equal(deriveWgRelayPageModel(input({
    hasDeployedProfile: false,
    status: { status: "secrets_not_found" },
  })).mode, PAGE_MODES.SETUP);

  assert.equal(deriveWgRelayPageModel(input({
    status: { status: "connected", errorCode: "secrets_not_found" },
  })).mode, PAGE_MODES.REPAIR_REQUIRED);

  assert.equal(deriveWgRelayPageModel(input({
    operation: "disconnect",
  })).mode, PAGE_MODES.CONNECTED);
});

test("suppresses daily primary and secondary actions while the repair form is open", () => {
  const dailyInputs = [
    input({ repairFormOpen: true }),
    input({ repairFormOpen: true, status: { status: "connected" } }),
    input({
      repairFormOpen: true,
      status: { status: "failed", errorCode: "profile_not_found" },
    }),
  ];

  for (const dailyInput of dailyInputs) {
    const model = deriveWgRelayPageModel(dailyInput);
    assert.equal(model.primaryAction, null, model.mode);
    assert.deepEqual(model.secondaryActions, [], model.mode);
  }
});

test("ready and connected pages expose VPS, computer, and Android rows in order", () => {
  const ready = deriveWgRelayPageModel(input());
  assert.deepEqual(ready.rows.map((row) => row.kind), ["vps", "computer", "android"]);
  assert.deepEqual(ready.rows[0], {
    kind: "vps",
    state: "configured",
    labelKey: "wgRelayVpsRow",
    statusKey: "wgRelayVpsConfigured",
    supportingText: "relay.example.test",
  });
  assert.deepEqual(ready.rows[1], {
    kind: "computer",
    state: "idle",
    labelKey: "wgRelayComputerRow",
    statusKey: "wgRelayStatus_idle",
  });
  assert.deepEqual(ready.rows[2], {
    kind: "android",
    state: "pairing-available",
    labelKey: "wgRelayAndroidRow",
    statusKey: "wgRelayAndroidPairingAvailable",
    action: { kind: "show-pairing-qr", labelKey: "wgRelayShowQr", disabled: false },
  });
  assert.deepEqual(ready.secondaryActions.map((action) => action.kind), [
    "rotate-phone",
    "repair",
    "delete-local",
  ]);

  const connected = deriveWgRelayPageModel(input({ status: { status: "connected" } }));
  assert.deepEqual(connected.rows.map((row) => row.kind), ["vps", "computer", "android"]);
  assert.equal(connected.rows[1].state, "connected");
  assert.equal(connected.rows[1].statusKey, "wgRelayStatus_connected");
  assert.deepEqual(connected.secondaryActions.map((action) => action.kind), [
    "rotate-phone",
    "repair",
    "delete-local",
  ]);
});

test("omits daily rows and secondary actions outside deployed daily modes", () => {
  for (const overrides of [
    { hasDeployedProfile: false },
    { hasDeployedProfile: false, operation: "deploy" },
    {
      hasDeployedProfile: false,
      deploymentFailure: { errorCode: "deploy_failed" },
    },
  ]) {
    const model = deriveWgRelayPageModel(input(overrides));
    assert.deepEqual(model.rows, [], model.mode);
    assert.deepEqual(model.secondaryActions, [], model.mode);
  }
});

test("repair-required pages expose one safe error and only local deletion", () => {
  const model = deriveWgRelayPageModel(input({
    status: { status: "remote_commit_recovery_required" },
  }));

  assert.equal(model.mode, PAGE_MODES.REPAIR_REQUIRED);
  assert.deepEqual(model.error, {
    domain: "deployment",
    safeCode: "remote_commit_recovery_required",
    requiresRepair: true,
    secretsAvailable: false,
  });
  assert.equal(model.rows[0].state, "repair-required");
  assert.equal(model.rows[1].state, "idle", "the computer row must use a safe runtime status");
  assert.equal(model.rows[2].state, "unavailable");
  assert.equal(model.rows[2].action, null);
  assert.deepEqual(model.secondaryActions, [
    { kind: "delete-local", labelKey: "wgRelayDelete", disabled: false },
  ]);
  assert.equal(JSON.stringify(model).includes("show-pairing-qr"), false);
  assert.equal(JSON.stringify(model).includes("rotate-phone"), false);

  assert.equal(deriveWgRelayPageModel(input({
    status: { status: "failed" },
    errorCode: "profile_conflict_recovery_required",
  })).mode, PAGE_MODES.REPAIR_REQUIRED);
});

test("disables every visible action when the runtime is unavailable or an operation is active", () => {
  const unavailable = deriveWgRelayPageModel(input({ runtimeAvailable: false }));
  assert.equal(unavailable.primaryAction.disabled, true);
  assert.equal(unavailable.rows[2].action.disabled, true);
  assert.equal(unavailable.secondaryActions.every((action) => action.disabled), true);

  const busy = deriveWgRelayPageModel(input({ operation: "rotate-phone" }));
  assert.equal(busy.mode, PAGE_MODES.READY);
  assert.equal(busy.primaryAction.disabled, true);
  assert.equal(busy.rows[2].action.disabled, true);
  assert.equal(busy.secondaryActions.every((action) => action.disabled), true);

  const connecting = deriveWgRelayPageModel(input({
    operation: "connect",
    status: { status: "starting_tunnel" },
  }));
  assert.deepEqual(connecting.primaryAction, {
    kind: "connect",
    labelKey: "wgRelayConnecting",
    disabled: true,
  });

  const disconnecting = deriveWgRelayPageModel(input({
    operation: "disconnect",
    status: { status: "disconnecting" },
  }));
  assert.deepEqual(disconnecting.primaryAction, {
    kind: "disconnect",
    labelKey: "wgRelayDisconnecting",
    disabled: true,
  });
});

test("classifies every direct public error without exposing extra fields", () => {
  const cases = [
    ["invalid_profile", "deployment", false],
    ["password_required", "deployment", false],
    ["runtime_unavailable", "deployment", false],
    ["deploy_failed", "deployment", false],
    ["deploy_aborted", "deployment", false],
    ["remote_commit_recovery_required", "deployment", true],
    ["profile_conflict_recovery_required", "deployment", true],
    ["secure_storage_unavailable", "secure-storage", true],
    ["secret_store_read_failed", "secure-storage", true],
    ["local_storage_retry_required", "secure-storage", false],
    ["public_profile_retry_required", "deployment", false],
    ["connection_retry_required", "pc-tunnel", false],
    ["pairing_qr_retry_required", "pairing", false],
    ["invalid_profile_id", "secure-storage", false],
    ["profile_not_found", "secure-storage", true],
    ["secrets_not_found", "secure-storage", true],
    ["pairing_qr_failed", "pairing", false],
    ["rotate_failed", "pairing", false],
    ["rotate_aborted", "pairing", false],
    ["delete_prepare_failed", "secure-storage", false],
    ["delete_failed", "secure-storage", false],
    ["connection_failed", "pc-tunnel", false],
    ["sidecar_failed", "pc-tunnel", false],
    ["health_failed", "relay-health", false],
    ["relay_failed", "relay-health", false],
    ["unknown", "unknown", false],
  ];

  for (const [code, domain, requiresRepair] of cases) {
    assert.deepEqual(classifyWgRelayError(code), {
      domain,
      safeCode: code,
      requiresRepair,
      secretsAvailable: !requiresRepair,
    }, code);
  }
});

test("maps secure-storage aliases and every safe error prefix", () => {
  const cases = [
    ["secret_store_preflight_failed", "secure-storage", "secure_storage_unavailable", true],
    ["secret_store_verification_failed", "secure-storage", "secure_storage_unavailable", true],
    ["health_timeout", "relay-health", "health_failed", false],
    ["relay_closed", "relay-health", "relay_failed", false],
    ["local_connect_failed", "relay-health", "relay_failed", false],
    ["connection_timeout", "pc-tunnel", "connection_failed", false],
    ["secret_invalid", "pc-tunnel", "connection_failed", false],
    ["sidecar_protocol", "pc-tunnel", "sidecar_failed", false],
    ["device_create_failed", "pc-tunnel", "sidecar_failed", false],
    ["endpoint_timeout", "pc-tunnel", "sidecar_failed", false],
    ["listener_stopped", "pc-tunnel", "sidecar_failed", false],
    ["listen_failed", "pc-tunnel", "sidecar_failed", false],
    ["stdin_failed", "pc-tunnel", "sidecar_failed", false],
    ["trailing_data", "pc-tunnel", "sidecar_failed", false],
    ["duplicate_ready", "pc-tunnel", "sidecar_failed", false],
    ["invalid_private_key", "pc-tunnel", "sidecar_failed", false],
    ["not-a-public-code", "unknown", "unknown", false],
  ];

  for (const [code, domain, safeCode, requiresRepair] of cases) {
    assert.deepEqual(classifyWgRelayError(code), {
      domain,
      safeCode,
      requiresRepair,
      secretsAvailable: !requiresRepair,
    }, code);
  }
});

test("normalizes unknown error codes and unsafe runtime status without leaking raw values", () => {
  for (const code of [null, "", "UPPER_CASE", "constructor", "__proto__", "x".repeat(81)]) {
    assert.deepEqual(classifyWgRelayError(code), {
      domain: "unknown",
      safeCode: "unknown",
      requiresRepair: false,
      secretsAvailable: true,
    });
  }

  const rawCode = "backend_secret_token";
  const rawStatus = "<unsafe-runtime-status>";
  const source = input({
    status: { status: rawStatus, errorCode: rawCode, message: "private runtime detail" },
    password: "unit-test-password",
    privateKey: "unit-test-private-key",
  });
  const before = JSON.stringify(source);
  const model = deriveWgRelayPageModel(source);
  const serialized = JSON.stringify(model);

  assert.equal(model.rows[1].state, "idle");
  assert.equal(model.rows[1].statusKey, "wgRelayStatus_idle");
  assert.deepEqual(model.error, {
    domain: "unknown",
    safeCode: "unknown",
    requiresRepair: false,
    secretsAvailable: true,
  });
  assert.equal(serialized.includes(rawCode), false);
  assert.equal(serialized.includes(rawStatus), false);
  assert.equal(serialized.includes("unit-test-password"), false);
  assert.equal(serialized.includes("unit-test-private-key"), false);
  assert.equal(JSON.stringify(source), before, "derivation must not mutate its input");
});

test("applies every raw IPC progress stage immutably", () => {
  const rawStages = new Map([
    ["connect", 0],
    ["host-key", 1],
    ["upload", 2],
    ["install", 3],
    ["detect", 3],
    ["install-wg", 4],
    ["gen-keys", 4],
    ["write-conf", 4],
    ["start-service", 5],
    ["firewall", 5],
    ["readback", 6],
    ["validate", 6],
    ["save", 7],
    ["persist", 7],
    ["pc-connect", 8],
    ["pc_connect", 8],
    ["qr", 9],
  ]);
  const initial = Object.freeze(createDeploymentProgress());

  for (const [step, target] of rawStages) {
    const next = applyDeploymentProgress(initial, { step, status: "working" });
    assert.notStrictEqual(next, initial, step);
    assert.equal(next.length, 10, step);
    for (let index = 0; index < target; index += 1) {
      assert.equal(next[index], "complete", `${step} should complete ${index}`);
    }
    assert.equal(next[target], "current", step);
  }
  assert.deepEqual(initial, ["current", ...Array(9).fill("pending")]);
});

test("normalizes progress, preserves failures, and advances validate to save", () => {
  const malformed = ["current", "bogus", "failed"];
  const copied = applyDeploymentProgress(malformed, { step: "not-known", status: "ok" });
  assert.deepEqual(copied, ["current", "pending", "failed", ...Array(7).fill("pending")]);
  assert.notStrictEqual(copied, malformed);
  assert.deepEqual(malformed, ["current", "bogus", "failed"]);

  const uploaded = applyDeploymentProgress(createDeploymentProgress(), {
    step: "upload",
    status: "ok",
  });
  assert.deepEqual(uploaded.slice(0, 4), ["complete", "complete", "complete", "pending"]);
  const failed = applyDeploymentProgress(uploaded, { step: "install", status: "fail" });
  assert.deepEqual(failed.slice(0, 5), ["complete", "complete", "complete", "failed", "pending"]);
  const later = applyDeploymentProgress(failed, { step: "install-wg", status: "ok" });
  assert.deepEqual(later.slice(0, 5), ["complete", "complete", "complete", "failed", "complete"]);

  const validated = applyDeploymentProgress(createDeploymentProgress(), {
    step: "validate",
    status: "ok",
  });
  assert.deepEqual(validated.slice(0, 8), [
    "complete", "complete", "complete", "complete",
    "complete", "complete", "complete", "current",
  ]);

  const saveFailed = createDeploymentProgress();
  saveFailed[7] = "failed";
  assert.equal(applyDeploymentProgress(saveFailed, {
    step: "validate",
    status: "ok",
  })[7], "failed");
});

test("summarizes deployment progress and removes pending failure details", () => {
  const uploaded = applyDeploymentProgress(createDeploymentProgress(), {
    step: "upload",
    status: "ok",
  });
  const failedStates = applyDeploymentProgress(uploaded, {
    step: "install",
    status: "fail",
  });
  const failure = deriveWgRelayPageModel(input({
    hasDeployedProfile: false,
    deploymentFailure: { errorCode: "deploy_failed", context: "setup" },
    errorCode: "deploy_failed",
    progressStates: failedStates,
  }));

  assert.deepEqual(failure.progress, {
    currentStage: "dependencies",
    currentState: "failed",
    completedCount: 3,
    total: 10,
    percent: 30,
    detailStages: [
      { key: "connect", state: "complete" },
      { key: "fingerprint", state: "complete" },
      { key: "upload", state: "complete" },
      { key: "dependencies", state: "failed" },
    ],
  });

  const earlyFailure = deriveWgRelayPageModel(input({
    hasDeployedProfile: false,
    deploymentFailure: { errorCode: "deploy_failed" },
  }));
  assert.equal(earlyFailure.progress.detailStages.length, 1);
  assert.equal(earlyFailure.progress.detailStages.some((stage) => stage.state === "pending"), false);

  const deploying = deriveWgRelayPageModel(input({
    hasDeployedProfile: false,
    operation: "deploy",
    progressStates: failedStates,
  }));
  assert.equal(deploying.progress.detailStages.length, 10);
  assert.equal(deriveWgRelayPageModel(input()).progress, null);
});

test("completes all ten public progress stages through existing payload keys", () => {
  let states = createDeploymentProgress();
  for (const step of [
    "connect",
    "host-key",
    "upload",
    "install",
    "install-wg",
    "start-service",
    "validate",
    "save",
    "pc_connect",
    "qr",
  ]) {
    states = applyDeploymentProgress(states, { step, status: "ok" });
  }
  assert.deepEqual(states, Array(10).fill("complete"));

  const model = deriveWgRelayPageModel(input({
    hasDeployedProfile: false,
    operation: "deploy",
    progressStates: states,
  }));
  assert.equal(model.progress.currentStage, "qr");
  assert.equal(model.progress.currentState, "complete");
  assert.equal(model.progress.completedCount, 10);
  assert.equal(model.progress.total, 10);
  assert.equal(model.progress.percent, 100);
  assert.equal(model.progress.detailStages.length, 10);
});

test("installs the same pure API on globalThis in a browser-like context", () => {
  const source = fs.readFileSync(VIEW_MODEL_PATH, "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: "settings-wg-relay-view-model.js" });

  assert.ok(context.ClawdSettingsWgRelayViewModel);
  assert.equal(
    typeof context.ClawdSettingsWgRelayViewModel.deriveWgRelayPageModel,
    "function"
  );
  assert.equal(context.ClawdSettingsWgRelayViewModel.PAGE_MODES.READY, "ready");
});

test("loads the view-model immediately before the WG relay tab", () => {
  const html = fs.readFileSync(SETTINGS_HTML_PATH, "utf8");
  assert.ok(html.includes(
    '<script src="settings-wg-relay-view-model.js"></script>\n'
      + '<script src="settings-tab-wg-relay.js"></script>'
  ));
});

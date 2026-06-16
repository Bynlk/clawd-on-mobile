"use strict";

const test = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const systemActions = require("../src/settings-actions-system");

test("settings system actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(systemActions).sort(), [
    "autoStartWithClaude",
    "createRepairDoctorIssue",
    "installHooks",
    "manageClaudeHooksAutomatically",
    "openAtLogin",
    "repairLocalServer",
    "restartClawd",
    "uninstallHooks",
  ]);
  assert.strictEqual(systemActions.autoStartWithClaude.lockKey, systemActions.manageClaudeHooksAutomatically.lockKey);
  assert.strictEqual(systemActions.installHooks.lockKey, systemActions.uninstallHooks.lockKey);
});

test("settings system actions keep auto-start inert when hook management is disabled", () => {
  const calls = [];
  const result = systemActions.autoStartWithClaude.effect(true, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false },
    installAutoStart: () => calls.push("install"),
    uninstallAutoStart: () => calls.push("uninstall"),
  });

  assert.deepStrictEqual(result, { status: "ok", noop: true });
  assert.deepStrictEqual(calls, []);
});

test("settings system actions sync hooks before starting the watcher", async () => {
  const calls = [];
  const result = await systemActions.manageClaudeHooksAutomatically.effect(true, {
    snapshot: prefs.getDefaults(),
    syncClaudeHooksNow: async () => {
      calls.push("sync");
    },
    startClaudeSettingsWatcher: () => calls.push("start"),
    stopClaudeSettingsWatcher: () => calls.push("stop"),
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, ["sync", "start"]);
});

test("settings system actions restore the watcher when hook uninstall fails", async () => {
  const calls = [];
  const result = await systemActions.uninstallHooks(null, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    stopClaudeSettingsWatcher: () => calls.push("stop"),
    uninstallClaudeHooksNow: async () => {
      calls.push("uninstall");
      throw new Error("locked");
    },
    startClaudeSettingsWatcher: () => calls.push("start"),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /locked/);
  assert.deepStrictEqual(calls, ["stop", "uninstall", "start"]);
});

test("settings system actions route Doctor repairs through injected cross-module actions", async () => {
  const calls = [];
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({
    repairAgentIntegration: async (payload, deps) => {
      calls.push({ kind: "agent", payload, deps });
      return { status: "ok", message: "agent repaired" };
    },
    setBubbleCategoryEnabled: (payload, deps) => {
      calls.push({ kind: "bubble", payload, deps });
      return { status: "ok", commit: { permissionBubblesEnabled: true } };
    },
  });
  const deps = { snapshot: prefs.getDefaults() };

  const agentResult = await repairDoctorIssue({ type: "agent-integration", agentId: "codex" }, deps);
  const bubbleResult = await repairDoctorIssue({ type: "permission-bubble-policy" }, deps);

  assert.deepStrictEqual(agentResult, { status: "ok", message: "agent repaired" });
  assert.deepStrictEqual(bubbleResult, {
    status: "ok",
    commit: { permissionBubblesEnabled: true },
  });
  assert.strictEqual(calls[0].kind, "agent");
  assert.strictEqual(calls[0].payload.agentId, "codex");
  assert.strictEqual(calls[0].deps, deps);
  assert.deepStrictEqual(calls[1], {
    kind: "bubble",
    payload: { category: "permission", enabled: true },
    deps,
  });
});

test("settings system actions normalize local server repair failures", async () => {
  const result = await systemActions.repairLocalServer(null, {
    repairLocalServer: async () => false,
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /Local server repair failed/);
});

test("settings system actions require restart confirmation", () => {
  const calls = [];
  const result = systemActions.restartClawd({}, {
    restartClawd: () => calls.push("restart"),
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /confirmation/);
  assert.deepStrictEqual(calls, []);
});

// ── autoStartWithClaude ────────────────────────────────────────────

test("autoStartWithClaude.effect installs auto-start when value is true", () => {
  const calls = [];
  const result = systemActions.autoStartWithClaude.effect(true, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    installAutoStart: () => calls.push("install"),
    uninstallAutoStart: () => calls.push("uninstall"),
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, ["install"]);
});

test("autoStartWithClaude.effect uninstalls auto-start when value is false", () => {
  const calls = [];
  const result = systemActions.autoStartWithClaude.effect(false, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    installAutoStart: () => calls.push("install"),
    uninstallAutoStart: () => calls.push("uninstall"),
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, ["uninstall"]);
});

test("autoStartWithClaude.effect returns error when deps are missing", () => {
  const result = systemActions.autoStartWithClaude.effect(true, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires installAutoStart/);
});

test("autoStartWithClaude.effect returns error when installAutoStart throws", () => {
  const result = systemActions.autoStartWithClaude.effect(true, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    installAutoStart: () => { throw new Error("disk full"); },
    uninstallAutoStart: () => {},
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /disk full/);
});

test("autoStartWithClaude.effect returns error when uninstallAutoStart throws", () => {
  const result = systemActions.autoStartWithClaude.effect(false, {
    snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
    installAutoStart: () => {},
    uninstallAutoStart: () => { throw new Error("permission denied"); },
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /permission denied/);
});

test("autoStartWithClaude.validate rejects non-boolean values", () => {
  assert.strictEqual(systemActions.autoStartWithClaude.validate(true).status, "ok");
  assert.strictEqual(systemActions.autoStartWithClaude.validate(false).status, "ok");
  assert.strictEqual(systemActions.autoStartWithClaude.validate("yes").status, "error");
  assert.strictEqual(systemActions.autoStartWithClaude.validate(1).status, "error");
  assert.strictEqual(systemActions.autoStartWithClaude.validate(null).status, "error");
});

// ── manageClaudeHooksAutomatically ─────────────────────────────────

test("manageClaudeHooksAutomatically.effect stops watcher when value is false", () => {
  const calls = [];
  const result = systemActions.manageClaudeHooksAutomatically.effect(false, {
    snapshot: prefs.getDefaults(),
    syncClaudeHooksNow: async () => calls.push("sync"),
    startClaudeSettingsWatcher: () => calls.push("start"),
    stopClaudeSettingsWatcher: () => calls.push("stop"),
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, ["stop"]);
});

test("manageClaudeHooksAutomatically.effect returns error when stopClaudeSettingsWatcher throws", () => {
  const result = systemActions.manageClaudeHooksAutomatically.effect(false, {
    snapshot: prefs.getDefaults(),
    syncClaudeHooksNow: async () => {},
    startClaudeSettingsWatcher: () => {},
    stopClaudeSettingsWatcher: () => { throw new Error("watcher error"); },
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /watcher error/);
});

test("manageClaudeHooksAutomatically.effect returns error when required deps are missing", () => {
  const result = systemActions.manageClaudeHooksAutomatically.effect(true, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires/);
});

test("manageClaudeHooksAutomatically.effect returns error when deps are null", () => {
  const result = systemActions.manageClaudeHooksAutomatically.effect(false, null);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires/);
});

test("manageClaudeHooksAutomatically.effect returns ok when agent is disabled (no sync)", async () => {
  const calls = [];
  const snapshot = { ...prefs.getDefaults(), agents: { "claude-code": { enabled: false } } };
  const result = await systemActions.manageClaudeHooksAutomatically.effect(true, {
    snapshot,
    syncClaudeHooksNow: async () => calls.push("sync"),
    startClaudeSettingsWatcher: () => calls.push("start"),
    stopClaudeSettingsWatcher: () => calls.push("stop"),
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, []); // no sync or start since agent disabled
});

test("manageClaudeHooksAutomatically.effect handles syncClaudeHooksNow rejection", async () => {
  const result = await systemActions.manageClaudeHooksAutomatically.effect(true, {
    snapshot: prefs.getDefaults(),
    syncClaudeHooksNow: async () => { throw new Error("sync failed"); },
    startClaudeSettingsWatcher: () => {},
    stopClaudeSettingsWatcher: () => {},
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /sync failed/);
});

// ── openAtLogin ────────────────────────────────────────────────────

test("openAtLogin.effect calls setOpenAtLogin with value", () => {
  const calls = [];
  const result = systemActions.openAtLogin.effect(true, {
    setOpenAtLogin: (v) => calls.push(v),
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, [true]);
});

test("openAtLogin.effect calls setOpenAtLogin with false", () => {
  const calls = [];
  const result = systemActions.openAtLogin.effect(false, {
    setOpenAtLogin: (v) => calls.push(v),
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, [false]);
});

test("openAtLogin.effect returns error when setOpenAtLogin dep is missing", () => {
  const result = systemActions.openAtLogin.effect(true, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires setOpenAtLogin/);
});

test("openAtLogin.effect returns error when deps is null", () => {
  const result = systemActions.openAtLogin.effect(true, null);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires setOpenAtLogin/);
});

test("openAtLogin.effect returns error when setOpenAtLogin throws", () => {
  const result = systemActions.openAtLogin.effect(true, {
    setOpenAtLogin: () => { throw new Error("platform error"); },
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /platform error/);
});

test("openAtLogin.validate rejects non-boolean values", () => {
  assert.strictEqual(systemActions.openAtLogin.validate(true).status, "ok");
  assert.strictEqual(systemActions.openAtLogin.validate(false).status, "ok");
  assert.strictEqual(systemActions.openAtLogin.validate("true").status, "error");
});

// ── installHooks ───────────────────────────────────────────────────

test("installHooks returns error when deps are missing", async () => {
  const result = await systemActions.installHooks(null, null);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires syncClaudeHooksNow/);
});

test("installHooks returns error when syncClaudeHooksNow dep is missing", async () => {
  const result = await systemActions.installHooks(null, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires syncClaudeHooksNow/);
});

test("installHooks calls syncClaudeHooksNow and returns ok", async () => {
  const calls = [];
  const result = await systemActions.installHooks(null, {
    syncClaudeHooksNow: async () => calls.push("sync"),
  });
  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, ["sync"]);
});

test("installHooks returns error when syncClaudeHooksNow throws", async () => {
  const result = await systemActions.installHooks(null, {
    syncClaudeHooksNow: async () => { throw new Error("hook error"); },
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /hook error/);
});

test("installHooks.lockKey matches manageClaudeHooksAutomatically.lockKey", () => {
  assert.strictEqual(systemActions.installHooks.lockKey, systemActions.manageClaudeHooksAutomatically.lockKey);
});

// ── uninstallHooks ─────────────────────────────────────────────────

test("uninstallHooks returns error when deps are missing", async () => {
  const result = await systemActions.uninstallHooks(null, null);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires uninstallClaudeHooksNow/);
});

test("uninstallHooks returns error when only uninstallClaudeHooksNow is provided", async () => {
  const result = await systemActions.uninstallHooks(null, {
    uninstallClaudeHooksNow: async () => {},
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires uninstallClaudeHooksNow/);
});

test("uninstallHooks returns ok and commits manageClaudeHooksAutomatically false on success", async () => {
  const calls = [];
  const result = await systemActions.uninstallHooks(null, {
    snapshot: { manageClaudeHooksAutomatically: true },
    stopClaudeSettingsWatcher: () => calls.push("stop"),
    uninstallClaudeHooksNow: async () => calls.push("uninstall"),
  });
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit, { manageClaudeHooksAutomatically: false });
  assert.deepStrictEqual(calls, ["stop", "uninstall"]);
});

test("uninstallHooks does not restore watcher on failure when manageClaudeHooksAutomatically was false", async () => {
  const calls = [];
  const result = await systemActions.uninstallHooks(null, {
    snapshot: { manageClaudeHooksAutomatically: false },
    stopClaudeSettingsWatcher: () => calls.push("stop"),
    uninstallClaudeHooksNow: async () => { calls.push("uninstall"); throw new Error("fail"); },
    startClaudeSettingsWatcher: () => calls.push("start"),
  });
  assert.strictEqual(result.status, "error");
  // uninstall was called (and threw), but no "start" since manageClaudeHooksAutomatically was false
  assert.ok(calls.includes("stop"));
  assert.ok(!calls.includes("start"));
});

test("uninstallHooks.lockKey matches installHooks.lockKey", () => {
  assert.strictEqual(systemActions.uninstallHooks.lockKey, systemActions.installHooks.lockKey);
});

// ── repairLocalServer ──────────────────────────────────────────────

test("repairLocalServer returns error when dep is missing", async () => {
  const result = await systemActions.repairLocalServer(null, null);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires repairLocalServer dep/);
});

test("repairLocalServer returns error when dep function is missing", async () => {
  const result = await systemActions.repairLocalServer(null, {});
  assert.strictEqual(result.status, "error");
});

test("repairLocalServer returns ok on truthy result", async () => {
  const result = await systemActions.repairLocalServer(null, {
    repairLocalServer: async () => ({ status: "ok", message: "repaired" }),
  });
  assert.strictEqual(result.status, "ok");
});

test("repairLocalServer returns error on non-ok status object", async () => {
  const result = await systemActions.repairLocalServer(null, {
    repairLocalServer: async () => ({ status: "error", message: "timeout" }),
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /timeout/);
});

test("repairLocalServer returns error on non-ok status without message", async () => {
  const result = await systemActions.repairLocalServer(null, {
    repairLocalServer: async () => ({ status: "error" }),
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /Local server repair failed/);
});

test("repairLocalServer returns error when dep throws", async () => {
  const result = await systemActions.repairLocalServer(null, {
    repairLocalServer: async () => { throw new Error("crash"); },
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /crash/);
});

// ── restartClawd ───────────────────────────────────────────────────

test("restartClawd calls deps.restartClawd and returns ok when confirmed", () => {
  const calls = [];
  const result = systemActions.restartClawd({ confirmed: true }, {
    restartClawd: () => calls.push("restart"),
  });

  assert.strictEqual(result.status, "ok");
  assert.match(result.message, /restarting/);
  assert.deepStrictEqual(calls, ["restart"]);
});

test("restartClawd returns error when deps.restartClawd is missing", () => {
  const result = systemActions.restartClawd({ confirmed: true }, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /requires deps.restartClawd/);
});

test("restartClawd returns error when deps is null", () => {
  const result = systemActions.restartClawd({ confirmed: true }, null);
  assert.strictEqual(result.status, "error");
});

test("restartClawd returns error when deps.restartClawd throws", () => {
  const result = systemActions.restartClawd({ confirmed: true }, {
    restartClawd: () => { throw new Error("cannot restart"); },
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /cannot restart/);
});

// ── createRepairDoctorIssue ────────────────────────────────────────

test("createRepairDoctorIssue returns error for theme-health type", async () => {
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({});
  const result = await repairDoctorIssue({ type: "theme-health" }, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /Theme health/);
});

test("createRepairDoctorIssue routes local-server type to repairLocalServer", async () => {
  const calls = [];
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({});
  const result = await repairDoctorIssue({ type: "local-server" }, {
    repairLocalServer: async () => { calls.push("repair"); return true; },
  });
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, ["repair"]);
});

test("createRepairDoctorIssue routes restart-clawd type to restartClawd", async () => {
  const calls = [];
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({});
  const result = await repairDoctorIssue({ type: "restart-clawd", confirmed: true }, {
    restartClawd: () => calls.push("restart"),
  });
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, ["restart"]);
});

test("createRepairDoctorIssue returns error for unknown type", async () => {
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({});
  const result = await repairDoctorIssue({ type: "unknown-issue" }, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /Unknown Doctor repair target/);
});

test("createRepairDoctorIssue returns error for missing type", async () => {
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({});
  const result = await repairDoctorIssue({}, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /missing/);
});

test("createRepairDoctorIssue returns error for non-object payload", async () => {
  const repairDoctorIssue = systemActions.createRepairDoctorIssue({});
  const result = await repairDoctorIssue(null, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /must be an object/);
});

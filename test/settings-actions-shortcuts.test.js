"use strict";

const test = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const shortcutCommands = require("../src/settings-actions-shortcuts");

function makeDeps(overrides = {}) {
  const snapshot = overrides.snapshot || prefs.getDefaults();
  const registered = new Set(overrides.registered || []);
  const calls = { register: [], unregister: [] };
  const globalShortcut = {
    register(accelerator, handler) {
      calls.register.push({ accelerator, handler });
      if (overrides.failRegister && overrides.failRegister.has(accelerator)) return false;
      registered.add(accelerator);
      return true;
    },
    unregister(accelerator) {
      calls.unregister.push(accelerator);
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
  return {
    deps: {
      snapshot,
      globalShortcut,
      shortcutHandlers: {
        togglePet: () => {},
      },
    },
    calls,
    registered,
  };
}

test("settings shortcut actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(shortcutCommands).sort(), [
    "registerShortcut",
    "resetAllShortcuts",
    "resetShortcut",
  ]);
});

test("settings shortcut actions register persistent shortcuts with rollback-safe ordering", () => {
  const snapshot = prefs.validate({
    shortcuts: {
      togglePet: "Ctrl+J",
    },
  });
  const { deps, calls, registered } = makeDeps({
    snapshot,
    registered: [snapshot.shortcuts.togglePet],
  });

  const result = shortcutCommands.registerShortcut({
    actionId: "togglePet",
    accelerator: "Ctrl+K",
  }, deps);

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.shortcuts.togglePet, "CommandOrControl+K");
  assert.deepStrictEqual(calls.register.map((call) => call.accelerator), ["CommandOrControl+K"]);
  assert.deepStrictEqual(calls.unregister, ["CommandOrControl+J"]);
  assert.deepStrictEqual([...registered].sort(), ["CommandOrControl+K"]);
});

test("settings shortcut actions reject contextual conflicts before touching globalShortcut", () => {
  const snapshot = prefs.getDefaults();
  const { deps, calls } = makeDeps({ snapshot });

  const result = shortcutCommands.registerShortcut({
    actionId: "permissionAllow",
    accelerator: snapshot.shortcuts.permissionDeny,
  }, deps);

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /already bound to permissionDeny/);
  assert.deepStrictEqual(calls.register, []);
  assert.deepStrictEqual(calls.unregister, []);
});

test("registerShortcut rejects null payload", () => {
  const result = shortcutCommands.registerShortcut(null, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /payload must be an object/);
});

test("registerShortcut rejects non-object payload", () => {
  const result = shortcutCommands.registerShortcut("bad", {});
  assert.strictEqual(result.status, "error");
});

test("registerShortcut rejects unknown actionId", () => {
  const result = shortcutCommands.registerShortcut({ actionId: "nonexistent" }, {});
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /unknown shortcut action/);
});

test("registerShortcut rejects non-string actionId", () => {
  const result = shortcutCommands.registerShortcut({ actionId: 42 }, {});
  assert.strictEqual(result.status, "error");
});

test("registerShortcut returns error when accelerator is missing from payload", () => {
  const snapshot = prefs.getDefaults();
  const { deps } = makeDeps({ snapshot });
  const result = shortcutCommands.registerShortcut({ actionId: "permissionAllow" }, deps);
  // accelerator is required
  assert.strictEqual(result.status, "error");
});

test("registerShortcut accepts null accelerator to unbind a non-persistent shortcut", () => {
  const snapshot = prefs.getDefaults();
  const { deps } = makeDeps({ snapshot });
  const result = shortcutCommands.registerShortcut({ actionId: "permissionAllow", accelerator: null }, deps);
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.shortcuts.permissionAllow, null);
});

test("registerShortcut rejects dangerous accelerator", () => {
  const snapshot = prefs.getDefaults();
  const { deps } = makeDeps({ snapshot });
  const result = shortcutCommands.registerShortcut({ actionId: "permissionAllow", accelerator: "CommandOrControl+C" }, deps);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /reserved accelerator/);
});

test("registerShortcut rejects invalid accelerator format", () => {
  const snapshot = prefs.getDefaults();
  const { deps } = makeDeps({ snapshot });
  const result = shortcutCommands.registerShortcut({ actionId: "permissionAllow", accelerator: "NotARealAccelerator!!!" }, deps);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /invalid accelerator format/);
});

test("registerShortcut returns noop when same accelerator on persistent action with no failure", () => {
  const snapshot = prefs.getDefaults();
  const { deps, calls } = makeDeps({ snapshot, registered: [snapshot.shortcuts.togglePet] });
  const result = shortcutCommands.registerShortcut({ actionId: "togglePet", accelerator: snapshot.shortcuts.togglePet }, deps);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.noop, true);
  // Should not touch globalShortcut since noop
  assert.deepStrictEqual(calls.register, []);
});

test("registerShortcut retries same accelerator on persistent action with prior failure", () => {
  const snapshot = prefs.getDefaults();
  const { deps, calls } = makeDeps({ snapshot });
  // Simulate a prior failure on togglePet
  deps.getShortcutFailure = (id) => id === "togglePet" ? "system conflict" : null;
  deps.clearShortcutFailure = () => {};
  const result = shortcutCommands.registerShortcut({ actionId: "togglePet", accelerator: snapshot.shortcuts.togglePet }, deps);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.noop, true);
  // Should attempt re-registration
  assert.ok(calls.register.length > 0);
});

test("registerShortcut fails when system conflict blocks persistent shortcut change", () => {
  const snapshot = prefs.getDefaults();
  const { deps } = makeDeps({
    snapshot,
    registered: [snapshot.shortcuts.togglePet],
    failRegister: new Set(["CommandOrControl+Alt+K"]),
  });
  const result = shortcutCommands.registerShortcut({ actionId: "togglePet", accelerator: "CommandOrControl+Alt+K" }, deps);
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /system conflict/);
});

test("resetShortcut resets to default accelerator", () => {
  const defaults = prefs.getDefaults();
  const currentShortcut = "CommandOrControl+Alt+X";
  const snapshot = prefs.validate({ shortcuts: { permissionAllow: currentShortcut } });
  const { deps } = makeDeps({ snapshot, registered: [currentShortcut] });
  const result = shortcutCommands.resetShortcut({ actionId: "permissionAllow" }, deps);
  assert.strictEqual(result.status, "ok");
  // Should reset to the default value
  assert.strictEqual(result.commit.shortcuts.permissionAllow, defaults.shortcuts.permissionAllow);
});

test("resetShortcut rejects null payload", () => {
  const result = shortcutCommands.resetShortcut(null, {});
  assert.strictEqual(result.status, "error");
});

test("resetShortcut rejects unknown actionId", () => {
  const result = shortcutCommands.resetShortcut({ actionId: "bogus" }, {});
  assert.strictEqual(result.status, "error");
});

test("resetAllShortcuts returns noop when already at defaults", () => {
  const snapshot = prefs.getDefaults();
  const { deps } = makeDeps({ snapshot });
  const result = shortcutCommands.resetAllShortcuts({}, deps);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.noop, true);
});

test("resetAllShortcuts commits default shortcuts when current differs", () => {
  const snapshot = prefs.validate({ shortcuts: { permissionAllow: "CommandOrControl+Alt+X" } });
  const { deps } = makeDeps({ snapshot, registered: ["CommandOrControl+Alt+X"] });
  const result = shortcutCommands.resetAllShortcuts({}, deps);
  assert.strictEqual(result.status, "ok");
  assert.ok(result.commit);
  assert.deepStrictEqual(result.commit.shortcuts, prefs.getDefaults().shortcuts);
});

test("registerShortcut reports failure when globalShortcut.register throws", () => {
  const snapshot = prefs.getDefaults();
  const failures = [];
  const deps = {
    snapshot,
    globalShortcut: {
      register() { throw new Error("system conflict"); },
      unregister() {},
      isRegistered() { return false; },
    },
    shortcutHandlers: { togglePet: () => {} },
    reportShortcutFailure: (id, msg) => failures.push({ id, msg }),
    clearShortcutFailure: () => {},
  };
  const result = shortcutCommands.registerShortcut({ actionId: "togglePet", accelerator: "CommandOrControl+Alt+K" }, deps);
  assert.strictEqual(result.status, "error");
});

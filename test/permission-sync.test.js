"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

// ── Module loader ──────────────────────────────────────────────────────────

function loadPermissionModule(electronOverride) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronOverride || {
        BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
        globalShortcut: {
          register() { return true; },
          unregister() {},
          isRegistered() { return false; },
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

// ── Context factory ────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    sessions: new Map(),
    hideBubbles: false,
    petHidden: false,
    doNotDisturb: false,
    bubbleFollowPet: false,
    win: null,
    lang: "en",
    permDebugLog: null,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getSettingsSnapshot: () => ({}),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    focusTerminalForSession: () => {},
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionUpdateBubble: () => {},
    subscribeShortcuts: () => () => {},
    isAgentPermissionsEnabled: () => true,
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    onPermissionsChanged: () => {},
    onPermissionResolved: () => {},
    ...overrides,
  };
}

// ── Fake bubble helper ─────────────────────────────────────────────────────

function createFakeBubble() {
  const bubble = {
    _destroyed: false,
    _sent: [],
    isDestroyed() { return bubble._destroyed; },
    destroy() { bubble._destroyed = true; },
    webContents: {
      send(channel, ...args) { bubble._sent.push([channel, ...args]); },
    },
  };
  return bubble;
}

// ── Pure function tests (via __test) ───────────────────────────────────────

describe("shouldSuppressCodexNotifyBubble", () => {
  let permission;

  it("loads the permission module", () => {
    permission = loadPermissionModule();
  });

  it("returns true when ctx.doNotDisturb is true", () => {
    const suppress = permission.__test.shouldSuppressCodexNotifyBubble(
      makeCtx({ doNotDisturb: true })
    );
    assert.strictEqual(suppress, true);
  });

  it("returns true when notification policy is disabled", () => {
    const suppress = permission.__test.shouldSuppressCodexNotifyBubble(
      makeCtx({
        getBubblePolicy: (kind) => {
          if (kind === "notification") return { enabled: false, autoCloseMs: 30000 };
          return { enabled: true, autoCloseMs: 0 };
        },
      })
    );
    assert.strictEqual(suppress, true);
  });

  it("returns true when isAgentPermissionsEnabled('codex') returns false", () => {
    const suppress = permission.__test.shouldSuppressCodexNotifyBubble(
      makeCtx({ isAgentPermissionsEnabled: (agent) => agent !== "codex" })
    );
    assert.strictEqual(suppress, true);
  });

  it("returns false when all conditions are favorable", () => {
    const suppress = permission.__test.shouldSuppressCodexNotifyBubble(
      makeCtx({
        doNotDisturb: false,
        isAgentPermissionsEnabled: () => true,
        getBubblePolicy: () => ({ enabled: true, autoCloseMs: 30000 }),
      })
    );
    assert.strictEqual(suppress, false);
  });

  it("returns false when isAgentPermissionsEnabled is not a function (defaults to enabled)", () => {
    // Source: typeof ctx.isAgentPermissionsEnabled !== "function" evaluates to true,
    // so codexBubblesEnabled = true (short-circuit) and the bubble is NOT suppressed.
    const suppress = permission.__test.shouldSuppressCodexNotifyBubble(
      makeCtx({ isAgentPermissionsEnabled: undefined })
    );
    assert.strictEqual(suppress, false);
  });

  it("returns true when hideBubbles is true (fallback policy, no getBubblePolicy)", () => {
    // With no getBubblePolicy function, getPolicy falls back to !ctx.hideBubbles.
    // hideBubbles=true means policy.enabled=false, so suppression kicks in.
    const suppress = permission.__test.shouldSuppressCodexNotifyBubble(
      makeCtx({ hideBubbles: true, getBubblePolicy: undefined })
    );
    assert.strictEqual(suppress, true);
  });
});

// ── computeBubbleStackLayout ───────────────────────────────────────────────

describe("computeBubbleStackLayout", () => {
  let permission;

  it("loads the permission module", () => {
    permission = loadPermissionModule();
  });

  const BW = 340;
  const MARGIN = 8;
  const GAP = 6;
  const FHD = { x: 0, y: 0, width: 1920, height: 1080 };

  function layout(opts) {
    return permission.__test.computeBubbleStackLayout({
      bubbleWidth: BW,
      margin: MARGIN,
      gap: GAP,
      ...opts,
    });
  }

  it("returns empty array for empty bubbleHeights", () => {
    const bounds = layout({
      followPet: false,
      bubbleHeights: [],
      workArea: FHD,
    });
    assert.deepStrictEqual(bounds, []);
  });

  it("positions single bubble at bottom-right when followPet is false", () => {
    const bounds = layout({
      followPet: false,
      bubbleHeights: [200],
      workArea: FHD,
    });
    assert.deepStrictEqual(bounds, [
      { x: 1572, y: 872, width: BW, height: 200 },
    ]);
  });

  it("stacks multiple bubbles upward when followPet is false", () => {
    const bounds = layout({
      followPet: false,
      bubbleHeights: [200, 200, 200],
      workArea: FHD,
    });
    assert.deepStrictEqual(bounds, [
      { x: 1572, y: 460, width: BW, height: 200 },
      { x: 1572, y: 666, width: BW, height: 200 },
      { x: 1572, y: 872, width: BW, height: 200 },
    ]);
  });

  it("positions below pet when enough vertical room (followPet with hitRect)", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: [150, 150, 150],
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    });
    // Below pet: y starts at hitBottom (500), stacks downward.
    assert.strictEqual(bounds[0].y, 500);
    assert.strictEqual(bounds[1].y, 500 + 150 + GAP);
    assert.strictEqual(bounds[2].y, 500 + (150 + GAP) * 2);
    // x centered on pet: hitCx - bw/2 = 860 - 170 = 690.
    for (const b of bounds) assert.strictEqual(b.x, 690);
  });

  it("positions on the right side of pet when not enough below room", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: [200, 200, 200],
      workArea: FHD,
      hitRect: { left: 800, top: 900, right: 920, bottom: 1000 },
    });
    // Right side: x = hitRight (920).
    for (const b of bounds) assert.strictEqual(b.x, 920);
    // Visual order: oldest above newest.
    for (let i = 0; i < bounds.length - 1; i++) {
      assert.ok(bounds[i].y < bounds[i + 1].y);
    }
  });

  it("positions on the left side when right has less room", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: [200, 200, 200],
      workArea: FHD,
      hitRect: { left: 1700, top: 900, right: 1820, bottom: 1000 },
    });
    // Left side: x = hitLeft - bw = 1700 - 340 = 1360.
    for (const b of bounds) assert.strictEqual(b.x, 1360);
  });

  it("falls back to corner when neither side has enough width", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: [200, 200, 200],
      workArea: { x: 0, y: 0, width: 600, height: 1080 },
      hitRect: { left: 250, top: 900, right: 350, bottom: 1000 },
    });
    // Corner fallback: x = wa.width - bw - margin = 600 - 340 - 8 = 252.
    for (const b of bounds) assert.strictEqual(b.x, 252);
  });

  it("handles degenerate case where totalH overflows the work area", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: Array(8).fill(200),
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    });
    assert.strictEqual(bounds.length, 8);
    // Oldest pinned at margin (top of work area).
    assert.strictEqual(bounds[0].y, MARGIN);
    // Newest overflows the bottom.
    assert.ok(
      bounds[7].y + bounds[7].height > FHD.y + FHD.height,
      "newest must overflow when stack is taller than the screen"
    );
    // Visual order preserved.
    for (let i = 0; i < bounds.length - 1; i++) {
      assert.ok(bounds[i].y < bounds[i + 1].y);
    }
  });
});

// ── syncPermissionShortcuts (via initPermission) ───────────────────────────

describe("syncPermissionShortcuts", () => {
  function createHarness(ctxOverrides = {}) {
    const registered = [];
    const reported = [];
    const cleared = [];
    const fakeElectron = {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: {
        register(accel, handler) {
          registered.push({ accel, handler });
          return true;
        },
        unregister() {},
        isRegistered() { return false; },
      },
    };
    const initPermission = loadPermissionModule(fakeElectron);
    const ctx = makeCtx({
      reportShortcutFailure: (id, reason) => reported.push([id, reason]),
      clearShortcutFailure: (id) => cleared.push(id),
      ...ctxOverrides,
    });
    const api = initPermission(ctx);
    return { api, registered, reported, cleared };
  }

  it("registers allow/deny shortcuts when actionable permissions exist", () => {
    const { api, registered } = createHarness();
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
    });
    api.syncPermissionShortcuts();
    const accels = registered.map((r) => r.accel);
    assert.ok(accels.includes("CommandOrControl+Shift+Y"), "allow shortcut registered");
    assert.ok(accels.includes("CommandOrControl+Shift+N"), "deny shortcut registered");
  });

  it("unregisters shortcuts when no actionable permissions exist", () => {
    const { api, registered } = createHarness();
    // First, register with a permission present.
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
    });
    api.syncPermissionShortcuts();
    assert.strictEqual(registered.length, 2, "shortcuts registered initially");
    // Clear permissions and sync again.
    api.pendingPermissions.length = 0;
    api.syncPermissionShortcuts();
    // Target is null, so unregister is called instead of register.
    // The registered count should not increase.
    assert.strictEqual(registered.length, 2, "no new registrations after clearing");
  });

  it("does not register when petHidden is true", () => {
    const { api, registered } = createHarness({ petHidden: true });
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
    });
    api.syncPermissionShortcuts();
    assert.strictEqual(registered.length, 0, "no shortcuts registered when pet is hidden");
  });

  it("does not register when bubbles are hidden (policy disabled)", () => {
    // Override getBubblePolicy to return disabled, matching the hideBubbles intent.
    const reported = [];
    const registered = [];
    const fakeElectron = {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: {
        register(accel, handler) { registered.push({ accel, handler }); return true; },
        unregister() {},
        isRegistered() { return false; },
      },
    };
    const initPermission = loadPermissionModule(fakeElectron);
    const ctx = makeCtx({
      hideBubbles: true,
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }),
      reportShortcutFailure: (id, reason) => reported.push([id, reason]),
      clearShortcutFailure: () => {},
    });
    const api = initPermission(ctx);
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
    });
    api.syncPermissionShortcuts();
    assert.strictEqual(registered.length, 0, "no shortcuts registered when policy disabled");
  });

  it("handles globalShortcut.register failure (calls reportShortcutFailure)", () => {
    const reported = [];
    const fakeElectron = {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: {
        register() { return false; },
        unregister() {},
        isRegistered() { return false; },
      },
    };
    const initPermission = loadPermissionModule(fakeElectron);
    const ctx = makeCtx({
      reportShortcutFailure: (id, reason) => reported.push([id, reason]),
    });
    const api = initPermission(ctx);
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
    });
    api.syncPermissionShortcuts();
    assert.strictEqual(reported.length, 2, "both shortcuts reported as failed");
    const ids = reported.map((r) => r[0]);
    assert.ok(ids.includes("permissionAllow"));
    assert.ok(ids.includes("permissionDeny"));
    for (const [, reason] of reported) {
      assert.strictEqual(reason, "system conflict");
    }
  });

  it("handles verifyUnregister failure (rolls back new registration)", () => {
    const reported = [];
    const unregisteredAccels = [];
    const fakeElectron = {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: {
        register() { return true; },
        unregister(accel) { unregisteredAccels.push(accel); },
        isRegistered() { return true; }, // simulate unregister failure
      },
    };
    const initPermission = loadPermissionModule(fakeElectron);
    const ctx = makeCtx({
      reportShortcutFailure: (id, reason) => reported.push([id, reason]),
    });
    const api = initPermission(ctx);
    // First, register shortcuts by adding a permission and syncing.
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
    });
    api.syncPermissionShortcuts();
    assert.strictEqual(reported.length, 0, "no failures on first sync");
    // Now remove all permissions and sync again — verifyUnregister will fail
    // because isRegistered returns true after unregister.
    api.pendingPermissions.length = 0;
    api.syncPermissionShortcuts();
    assert.ok(reported.length > 0, "rollback failure reported");
    const switchFailed = reported.filter((r) => r[1] === "switch failed");
    assert.strictEqual(switchFailed.length, 2, "both shortcuts report switch failed");
  });
});

// ── dismissPermissionsByAgent (via initPermission) ─────────────────────────

describe("dismissPermissionsByAgent", () => {
  function createHarness() {
    const fakeElectron = {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: {
        register() { return true; },
        unregister() {},
        isRegistered() { return false; },
      },
    };
    const initPermission = loadPermissionModule(fakeElectron);
    const api = initPermission(makeCtx());
    return api;
  }

  it("returns 0 for empty/null agentId", () => {
    const api = createHarness();
    assert.strictEqual(api.dismissPermissionsByAgent(null), 0);
    assert.strictEqual(api.dismissPermissionsByAgent(""), 0);
    assert.strictEqual(api.dismissPermissionsByAgent(undefined), 0);
  });

  it("returns 0 when no matching permissions", () => {
    const api = createHarness();
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 200,
      suggestions: [],
      sessionId: "s1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
      agentId: "other-agent",
    });
    assert.strictEqual(api.dismissPermissionsByAgent("target-agent"), 0);
    assert.strictEqual(api.pendingPermissions.length, 1, "non-matching permission preserved");
  });

  it("dismisses matching permissions and returns count", () => {
    const api = createHarness();
    const bubble1 = createFakeBubble();
    const bubble2 = createFakeBubble();
    api.pendingPermissions.push(
      { bubble: bubble1, measuredHeight: 200, suggestions: [], sessionId: "s1", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "codex" },
      { bubble: bubble2, measuredHeight: 200, suggestions: [], sessionId: "s2", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "codex" }
    );
    const dismissed = api.dismissPermissionsByAgent("codex");
    assert.strictEqual(dismissed, 2);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("dismisses passive notify entries for matching agent", () => {
    const api = createHarness();
    const notifyBubble = createFakeBubble();
    api.pendingPermissions.push({
      bubble: notifyBubble,
      measuredHeight: 100,
      suggestions: [],
      sessionId: "notify1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
      agentId: "codex",
      isCodexNotify: true,
    });
    const dismissed = api.dismissPermissionsByAgent("codex");
    assert.strictEqual(dismissed, 1);
    assert.strictEqual(api.pendingPermissions.length, 0);
    assert.ok(
      notifyBubble._sent.some((s) => s[0] === "permission-hide"),
      "passive notify bubble receives hide event"
    );
  });

  it("does not dismiss permissions for other agents", () => {
    const api = createHarness();
    api.pendingPermissions.push(
      { bubble: createFakeBubble(), measuredHeight: 200, suggestions: [], sessionId: "s1", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "codex" },
      { bubble: createFakeBubble(), measuredHeight: 200, suggestions: [], sessionId: "s2", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "other-agent" }
    );
    const dismissed = api.dismissPermissionsByAgent("codex");
    assert.strictEqual(dismissed, 1);
    assert.strictEqual(api.pendingPermissions.length, 1);
    assert.strictEqual(api.pendingPermissions[0].agentId, "other-agent");
  });
});

// ── dismissInteractivePermissionBubbles (via initPermission) ───────────────

describe("dismissInteractivePermissionBubbles", () => {
  function createHarness() {
    const fakeElectron = {
      BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
      globalShortcut: {
        register() { return true; },
        unregister() {},
        isRegistered() { return false; },
      },
    };
    const initPermission = loadPermissionModule(fakeElectron);
    const api = initPermission(makeCtx());
    return api;
  }

  it("returns 0 when no interactive permissions", () => {
    const api = createHarness();
    // Only passive notifications present.
    api.pendingPermissions.push({
      bubble: createFakeBubble(),
      measuredHeight: 100,
      suggestions: [],
      sessionId: "n1",
      toolName: "Bash",
      res: {},
      createdAt: Date.now(),
      isCodexNotify: true,
    });
    assert.strictEqual(api.dismissInteractivePermissionBubbles(), 0);
    assert.strictEqual(api.pendingPermissions.length, 1, "passive notification preserved");
  });

  it("dismisses all interactive permissions (not codex/kimi notify)", () => {
    const api = createHarness();
    const bubble1 = createFakeBubble();
    const bubble2 = createFakeBubble();
    api.pendingPermissions.push(
      { bubble: bubble1, measuredHeight: 200, suggestions: [], sessionId: "s1", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "codex" },
      { bubble: bubble2, measuredHeight: 200, suggestions: [], sessionId: "s2", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "cc" }
    );
    const dismissed = api.dismissInteractivePermissionBubbles();
    assert.strictEqual(dismissed, 2);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("preserves passive notification entries while dismissing interactive ones", () => {
    const api = createHarness();
    const interactiveBubble = createFakeBubble();
    const notifyBubble = createFakeBubble();
    const kimiBubble = createFakeBubble();
    api.pendingPermissions.push(
      { bubble: interactiveBubble, measuredHeight: 200, suggestions: [], sessionId: "s1", toolName: "Bash", res: {}, createdAt: Date.now(), agentId: "codex" },
      { bubble: notifyBubble, measuredHeight: 100, suggestions: [], sessionId: "n1", toolName: "Bash", res: {}, createdAt: Date.now(), isCodexNotify: true },
      { bubble: kimiBubble, measuredHeight: 100, suggestions: [], sessionId: "n2", toolName: "Bash", res: {}, createdAt: Date.now(), isKimiNotify: true }
    );
    const dismissed = api.dismissInteractivePermissionBubbles();
    assert.strictEqual(dismissed, 1, "only interactive permission dismissed");
    assert.strictEqual(api.pendingPermissions.length, 2, "both passive notifications remain");
    assert.strictEqual(api.pendingPermissions[0].isCodexNotify, true);
    assert.strictEqual(api.pendingPermissions[1].isKimiNotify, true);
  });
});

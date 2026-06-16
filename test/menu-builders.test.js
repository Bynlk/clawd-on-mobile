"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function makeCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    hideBubbles: false,
    soundMuted: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    petHidden: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true }),
    getDisableMiniMode: () => false,
    openSettingsWindow: () => {},
    togglePetVisibility: () => {},
    enableDoNotDisturb: () => {},
    disableDoNotDisturb: () => {},
    enterMiniViaMenu: () => {},
    exitMiniMode: () => {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds: () => {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    getPixelSizeFor: () => ({ width: 320, height: 320 }),
    repositionBubbles: () => {},
    syncHitWin: () => {},
    flushRuntimeStateToPrefs: () => {},
    reapplyMacVisibility: () => {},
    clampToScreenVisual: (x, y) => ({ x, y }),
    bringPetToPrimaryDisplay: () => {},
    ...overrides,
  };
}

function makeFakeElectron(overrides = {}) {
  return {
    app: {
      quit: () => {},
      setActivationPolicy: () => {},
      dock: { show: () => {}, hide: () => {} },
    },
    BrowserWindow: function BrowserWindow() {},
    Menu: {
      buildFromTemplate(template) {
        return { template };
      },
    },
    Tray: function Tray() {},
    nativeImage: {
      createFromPath() {
        return {
          resize() { return this; },
          setTemplateImage() {},
        };
      },
    },
    screen: {
      getAllDisplays: () => [],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    ...overrides,
  };
}

// Helper: set up ctx.tray so buildTrayMenu does not bail out early.
function attachFakeTray(ctx, fakeElectron) {
  const TrayCtor = fakeElectron.Tray;
  ctx.tray = new TrayCtor();
  ctx.tray.setToolTip = () => {};
  ctx.tray.setContextMenu = () => {};
  ctx.tray.destroy = () => {};
}

// Helper: find the last captured template from Menu.buildFromTemplate.
function captureTemplate(fakeElectron) {
  let captured = null;
  const orig = fakeElectron.Menu.buildFromTemplate;
  fakeElectron.Menu.buildFromTemplate = function (template) {
    captured = template;
    return orig.call(this, template);
  };
  return {
    get template() { return captured; },
  };
}

// Helper: recursively search a template array for an item whose label matches.
function findByLabel(items, label) {
  for (const item of items) {
    if (item.label === label) return item;
    if (item.submenu) {
      const found = findByLabel(item.submenu, label);
      if (found) return found;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// 1. isMiniSupported (tested through buildMiniModeMenuItem's enabled)
// ──────────────────────────────────────────────────────────────────
describe("isMiniSupported (via buildMiniModeMenuItem enabled state)", () => {
  it("returns enabled=true when getActiveThemeCapabilities returns miniMode:true", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getActiveThemeCapabilities: () => ({ miniMode: true }),
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1]; // second item in tray menu
    assert.strictEqual(miniItem.enabled, true);
  });

  it("returns enabled=false when getActiveThemeCapabilities returns miniMode:false", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getActiveThemeCapabilities: () => ({ miniMode: false }),
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.enabled, false);
  });

  it("returns enabled=true when getActiveThemeCapabilities returns null (defaults to true)", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getActiveThemeCapabilities: () => null,
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.enabled, true);
  });

  it("returns enabled=false when miniDisabled is true", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getDisableMiniMode: () => true,
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.enabled, false);
  });
});

// ──────────────────────────────────────────────────────────────────
// 2. buildMiniModeMenuItem
// ──────────────────────────────────────────────────────────────────
describe("buildMiniModeMenuItem", () => {
  it('shows "Mini Mode" label when not in mini mode', () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniMode: () => false });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.label, "Mini Mode");
  });

  it('shows "Exit Mini Mode" label when in mini mode', () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniMode: () => true });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.label, "Exit Mini Mode");
  });

  it("is disabled during mini transition", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniTransitioning: () => true });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.enabled, false);
  });

  it("is disabled when doNotDisturb is true and not in mini mode", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      doNotDisturb: true,
      getMiniMode: () => false,
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    assert.strictEqual(miniItem.enabled, false);
  });

  it("calls exitMiniMode when clicked in mini mode", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    let exitCalled = false;
    let enterCalled = false;
    const ctx = makeCtx({
      getMiniMode: () => true,
      exitMiniMode: () => { exitCalled = true; },
      enterMiniViaMenu: () => { enterCalled = true; },
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    miniItem.click();
    assert.strictEqual(exitCalled, true);
    assert.strictEqual(enterCalled, false);
  });

  it("calls enterMiniViaMenu when clicked in normal mode", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    let enterCalled = false;
    const ctx = makeCtx({
      getMiniMode: () => false,
      enterMiniViaMenu: () => { enterCalled = true; },
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    miniItem.click();
    assert.strictEqual(enterCalled, true);
  });

  it("returns undefined when clicked while miniDisabled", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    let enterCalled = false;
    const ctx = makeCtx({
      getMiniMode: () => false,
      getDisableMiniMode: () => true,
      enterMiniViaMenu: () => { enterCalled = true; },
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const miniItem = cap.template[1];
    const result = miniItem.click();
    assert.strictEqual(result, undefined);
    assert.strictEqual(enterCalled, false);
  });
});

// ──────────────────────────────────────────────────────────────────
// 3. buildBringToPrimaryDisplayMenuItem
// ──────────────────────────────────────────────────────────────────
describe("buildBringToPrimaryDisplayMenuItem", () => {
  // In the tray menu, the bring-to-primary item is at index 10
  // (after settings, openDashboard).
  function getBringItem(cap) {
    return cap.template[10];
  }

  it("is enabled when not in mini mode and bringPetToPrimaryDisplay is a function", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getMiniMode: () => false,
      getMiniTransitioning: () => false,
      bringPetToPrimaryDisplay: () => {},
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const item = getBringItem(cap);
    assert.strictEqual(item.enabled, true);
    assert.strictEqual(item.label, "Bring Pet to Primary Display");
  });

  it("is disabled when in mini mode", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getMiniMode: () => true,
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const item = getBringItem(cap);
    assert.strictEqual(item.enabled, false);
  });

  it("is disabled when mini is transitioning", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      getMiniTransitioning: () => true,
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const item = getBringItem(cap);
    assert.strictEqual(item.enabled, false);
  });

  it("is disabled when bringPetToPrimaryDisplay is not a function", () => {
    const fakeElectron = makeFakeElectron();
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({
      bringPetToPrimaryDisplay: undefined,
    });
    attachFakeTray(ctx, fakeElectron);
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildTrayMenu();
    const item = getBringItem(cap);
    assert.strictEqual(item.enabled, false);
  });
});

// ──────────────────────────────────────────────────────────────────
// 4. buildDisplaySubmenu
// ──────────────────────────────────────────────────────────────────
describe("buildDisplaySubmenu", () => {
  const displayA = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const displayB = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1440 },
  };

  // buildDisplaySubmenu is called from buildContextMenu when multiple displays
  // are present and mini mode is off. The submenu is nested inside the
  // "Send to Display" item.
  function getDisplaySubmenu(cap) {
    const sendItem = findByLabel(cap.template, "Send to Display");
    assert.ok(sendItem, "expected a 'Send to Display' menu item");
    assert.ok(Array.isArray(sendItem.submenu), "expected submenu array");
    return sendItem.submenu;
  }

  it("returns disabled single item when only 1 display", () => {
    const fakeElectron = makeFakeElectron({
      screen: {
        getAllDisplays: () => [displayA],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => displayA,
      },
    });
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniMode: () => false });
    // buildContextMenu will NOT push sendToDisplay when displays <= 1,
    // so the submenu approach won't work. Instead, verify the template
    // does NOT contain a "Send to Display" entry.
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildContextMenu();
    const sendItem = findByLabel(cap.template, "Send to Display");
    assert.strictEqual(sendItem, null, "should not have Send to Display with 1 display");
  });

  it("marks primary display with primary label", () => {
    const fakeElectron = makeFakeElectron({
      screen: {
        getAllDisplays: () => [displayA, displayB],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => displayA,
      },
    });
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniMode: () => false });
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildContextMenu();
    const submenu = getDisplaySubmenu(cap);
    // displayA is at (0,0) so it is primary
    assert.ok(
      submenu[0].label.includes("(Primary)"),
      `expected primary label, got: ${submenu[0].label}`
    );
    // displayB is not at (0,0)
    assert.ok(
      !submenu[1].label.includes("(Primary)"),
      `expected non-primary label, got: ${submenu[1].label}`
    );
  });

  it("disables the current display entry", () => {
    const fakeElectron = makeFakeElectron({
      screen: {
        getAllDisplays: () => [displayA, displayB],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => displayA, // pet is on displayA
      },
    });
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniMode: () => false });
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildContextMenu();
    const submenu = getDisplaySubmenu(cap);
    // displayA is current -> disabled
    assert.strictEqual(submenu[0].enabled, false);
  });

  it("enables non-current display entries", () => {
    const fakeElectron = makeFakeElectron({
      screen: {
        getAllDisplays: () => [displayA, displayB],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => displayA, // pet is on displayA
      },
    });
    const cap = captureTemplate(fakeElectron);
    const ctx = makeCtx({ getMiniMode: () => false });
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    m.buildContextMenu();
    const submenu = getDisplaySubmenu(cap);
    // displayB is not current -> enabled
    assert.strictEqual(submenu[1].enabled, true);
  });
});

// ──────────────────────────────────────────────────────────────────
// 5. requestAppQuit
// ──────────────────────────────────────────────────────────────────
describe("requestAppQuit", () => {
  it("sets isQuitting to true and calls app.quit()", () => {
    let quitCalled = false;
    const fakeElectron = makeFakeElectron({
      app: {
        quit: () => { quitCalled = true; },
        setActivationPolicy: () => {},
        dock: { show: () => {}, hide: () => {} },
      },
    });
    const ctx = makeCtx();
    const m = loadMenuWithElectron(fakeElectron)(ctx);
    assert.strictEqual(ctx.isQuitting, false);
    m.requestAppQuit();
    assert.strictEqual(ctx.isQuitting, true);
    assert.strictEqual(quitCalled, true);
  });
});

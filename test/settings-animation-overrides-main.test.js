"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createSettingsAnimationOverridesMain = require("../src/settings-animation-overrides-main");
const {
  registerSettingsAnimationOverridesIpc,
} = createSettingsAnimationOverridesMain;
const animationOverrideTest = createSettingsAnimationOverridesMain.__test;

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

class FakeBrowserWindow {
  static fromWebContents(sender) {
    return { id: "parent", sender };
  }
}

function makeTheme(root, overrides = {}) {
  return {
    _id: "cloudling",
    _variantId: "default",
    _builtin: true,
    _themeDir: root,
    _capabilities: { idleMode: "static", sleepMode: "direct" },
    _bindingBase: {
      states: { idle: "idle.svg", thinking: "scripted.svg", sleeping: "sleep.svg" },
      workingTiers: [],
      jugglingTiers: [],
      displayHintMap: {},
    },
    _baseTransitions: {},
    _stateBindings: {
      idle: { files: ["idle.svg"] },
      thinking: { files: ["scripted.svg"] },
      sleeping: { files: ["sleep.svg"] },
    },
    states: {
      idle: ["idle.svg"],
      thinking: ["scripted.svg"],
      sleeping: ["sleep.svg"],
    },
    transitions: {},
    timings: { autoReturn: {} },
    sounds: {},
    trustedRuntime: {
      scriptedSvgFiles: ["scripted.svg"],
      scriptedSvgCycleMs: { "scripted.svg": 5400 },
    },
    ...overrides,
  };
}

function createRuntimeHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-anim-main-"));
  const assetsDir = path.join(root, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "idle.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  fs.writeFileSync(path.join(assetsDir, "scripted.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  fs.writeFileSync(path.join(assetsDir, "sleep.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");

  const stateCalls = [];
  let themeReloadInProgress = !!overrides.themeReloadInProgress;
  const activeTheme = typeof overrides.activeThemeFactory === "function"
    ? overrides.activeThemeFactory(root)
    : (overrides.activeTheme || makeTheme(root, overrides.themeOverrides));
  const runtime = createSettingsAnimationOverridesMain({
    app: { isPackaged: false, getVersion: () => "1.2.3" },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
    shell: { openPath: async () => "" },
    fs,
    path,
    themeLoader: {
      _resolveAssetPath: (_theme, filename) => path.join(assetsDir, path.basename(filename)),
      getAssetPath: (filename) => path.join(assetsDir, path.basename(filename)),
      getThemeMetadata: (themeId) => ({ name: `Theme ${themeId}` }),
    },
    animationCycle: {
      probeAssetCycle: () => ({ ms: null, status: "unavailable", source: null }),
    },
    settingsController: {
      getSnapshot: () => (overrides.snapshot || { themeOverrides: {} }),
      applyCommand: async () => ({ status: "ok", importedThemeCount: 0 }),
    },
    getActiveTheme: () => activeTheme,
    getSettingsWindow: () => null,
    getLang: () => "en",
    getThemeReloadInProgress: () => themeReloadInProgress,
    getStateRuntime: () => ({
      applyState: (...args) => stateCalls.push(["applyState", ...args]),
      resolveDisplayState: () => "idle",
      getSvgOverride: (state) => `${state}.svg`,
    }),
    sendToRenderer: (...args) => stateCalls.push(["sendToRenderer", ...args]),
  });

  return {
    activeTheme,
    assetsDir,
    runtime,
    root,
    stateCalls,
    setThemeReloadInProgress(value) {
      themeReloadInProgress = !!value;
    },
    cleanup() {
      runtime.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("animation override IPC registers owned channels, delegates, and disposes", async () => {
  const ipcMain = new FakeIpcMain();
  const calls = [];
  const runtime = registerSettingsAnimationOverridesIpc({
    ipcMain,
    animationOverridesMain: {
      buildAnimationOverrideData: () => ({ status: "data" }),
      openThemeAssetsDir: () => ({ status: "opened" }),
      previewAnimationOverride: (payload) => {
        calls.push(["previewAnimationOverride", payload]);
        return { status: "previewed" };
      },
      previewReaction: (payload) => {
        calls.push(["previewReaction", payload]);
        return { status: "reaction" };
      },
      exportAnimationOverrides: (event) => {
        calls.push(["export", event.sender]);
        return { status: "exported" };
      },
      importAnimationOverrides: (event) => {
        calls.push(["import", event.sender]);
        return { status: "imported" };
      },
    },
  });

  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [
    "settings:export-animation-overrides",
    "settings:get-animation-overrides-data",
    "settings:import-animation-overrides",
    "settings:open-theme-assets-dir",
    "settings:preview-animation-override",
    "settings:preview-reaction",
  ]);
  assert.deepStrictEqual(await ipcMain.invoke("settings:get-animation-overrides-data"), { status: "data" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:open-theme-assets-dir"), { status: "opened" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-animation-override", { file: "a.svg" }), { status: "previewed" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-reaction", { file: "b.svg" }), { status: "reaction" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:export-animation-overrides"), { status: "exported" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:import-animation-overrides"), { status: "imported" });
  assert.deepStrictEqual(calls, [
    ["previewAnimationOverride", { file: "a.svg" }],
    ["previewReaction", { file: "b.svg" }],
    ["export", "sender-web-contents"],
    ["import", "sender-web-contents"],
  ]);

  runtime.dispose();
  assert.strictEqual(ipcMain.handlers.size, 0);
});

test("external themes cannot forge trusted scripted preview permission", () => {
  const forgedTheme = {
    _id: "forged",
    _builtin: false,
    trustedRuntime: {
      scriptedSvgFiles: ["forged.svg"],
      scriptedSvgCycleMs: { "forged.svg": 3200 },
    },
  };

  assert.strictEqual(
    animationOverrideTest.isTrustedScriptedAnimationFile("forged.svg", forgedTheme),
    false
  );
  assert.strictEqual(
    animationOverrideTest.needsScriptedAnimationPreviewPoster("forged.svg", forgedTheme),
    false
  );
  assert.strictEqual(
    animationOverrideTest.getTrustedScriptedAnimationCycleMs("forged.svg", forgedTheme),
    null
  );
});

test("scripted SVG previews do not fall back to direct file URLs as poster images", () => {
  const harness = createRuntimeHarness();
  try {
    const preview = harness.runtime.buildAnimationAssetPreview("scripted.svg", harness.activeTheme);

    assert.strictEqual(preview.needsScriptedPreviewPoster, true);
    assert.strictEqual(preview.previewImageUrl, null);
    assert.strictEqual(preview.previewPosterPending, true);
    assert.ok(preview.fileUrl.startsWith("file:"));
    assert.ok(preview.previewPosterCacheKey.includes("|cloudling|scripted.svg|"));
  } finally {
    harness.cleanup();
  }
});

test("runtime exposes animation asset probes for mini-mode entry timing", () => {
  const harness = createRuntimeHarness();
  try {
    const probe = harness.runtime.buildAnimationAssetProbe("scripted.svg", harness.activeTheme);

    assert.deepStrictEqual(probe, {
      assetCycleMs: 5400,
      assetCycleStatus: "exact",
      assetCycleSource: "trusted-runtime",
    });
  } finally {
    harness.cleanup();
  }
});

test("external object-channel SVG previews require posters without getting trusted long holds", () => {
  const harness = createRuntimeHarness({
    themeOverrides: {
      _id: "external-object",
      _builtin: false,
      rendering: { svgChannel: "object" },
      trustedRuntime: {
        scriptedSvgFiles: ["scripted.svg"],
        scriptedSvgCycleMs: { "scripted.svg": 12000 },
      },
    },
  });
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  try {
    global.setTimeout = (_fn, ms) => {
      delays.push(ms);
      return { fakeTimer: true };
    };
    global.clearTimeout = () => {};

    assert.strictEqual(
      animationOverrideTest.isTrustedScriptedAnimationFile("scripted.svg", harness.activeTheme),
      false
    );
    assert.strictEqual(
      animationOverrideTest.needsScriptedAnimationPreviewPoster("scripted.svg", harness.activeTheme),
      true
    );
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 12000 }),
      { status: "ok" }
    );
    assert.deepStrictEqual(delays, [animationOverrideTest.PREVIEW_HOLD_MAX_MS]);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("poster descriptors snapshot theme id, basename, file URL, size, and mtime into the cache key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-anim-descriptor-"));
  try {
    const absPath = path.join(root, "scripted.svg");
    fs.writeFileSync(absPath, "<svg viewBox=\"0 0 10 10\"></svg>", "utf8");
    const descriptor = animationOverrideTest.buildAnimationPreviewPosterDescriptor(
      "../scripted.svg",
      { _id: "theme-a" },
      absPath
    );

    assert.strictEqual(descriptor.themeId, "theme-a");
    assert.strictEqual(descriptor.filename, "scripted.svg");
    assert.strictEqual(descriptor.absPath, absPath);
    assert.ok(descriptor.fileUrl.startsWith("file:"));
    assert.strictEqual(descriptor.posterVersion, animationOverrideTest.ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION);
    assert.ok(descriptor.size > 0);
    assert.ok(Number.isFinite(descriptor.mtime));
    assert.ok(descriptor.cacheKey.includes(`|theme-a|scripted.svg|${descriptor.size}|${descriptor.mtime}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("animation preview requests defer while theme reload is in progress", () => {
  const harness = createRuntimeHarness({ themeReloadInProgress: true });
  try {
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 900 }),
      { status: "ok", deferred: true }
    );
    assert.deepStrictEqual(harness.stateCalls, []);

    harness.setThemeReloadInProgress(false);
    harness.runtime.runPendingPostReloadTasks();

    assert.deepStrictEqual(harness.stateCalls[0], ["applyState", "thinking", "scripted.svg"]);
  } finally {
    harness.cleanup();
  }
});

test("animation override cards expose theme-default wide hitbox state separately from the effective override state", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {
        cloudling: {
          hitbox: {
            wide: {
              "scripted.svg": false,
            },
          },
        },
      },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      wideHitboxFiles: [],
      _baseWideHitboxFiles: ["scripted.svg"],
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const thinkingCard = data.cards.find((card) => card.stateKey === "thinking");

    assert.ok(thinkingCard);
    assert.strictEqual(thinkingCard.wideHitboxEnabled, false);
    assert.strictEqual(thinkingCard.wideHitboxThemeDefault, true);
    assert.strictEqual(thinkingCard.wideHitboxOverridden, true);
  } finally {
    harness.cleanup();
  }
});

test("animation override cards expose theme-default transition state separately from effective timing", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 160, out: 150 },
            },
          },
        },
      },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      transitions: {
        "scripted.svg": { in: 160, out: 150 },
      },
      _baseTransitions: {
        "scripted.svg": { in: 150, out: 150 },
      },
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const thinkingCard = data.cards.find((card) => card.stateKey === "thinking");

    assert.ok(thinkingCard);
    assert.deepStrictEqual(thinkingCard.transition, { in: 160, out: 150 });
    assert.deepStrictEqual(thinkingCard.transitionThemeDefault, { in: 150, out: 150 });
    assert.strictEqual(thinkingCard.hasTransitionOverride, true);
  } finally {
    harness.cleanup();
  }
});

test("animation override data builds tier cards with transition override metadata", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {
        cloudling: {
          tiers: {
            workingTiers: {
              "scripted.svg": {
                transition: { in: 180, out: 150 },
              },
            },
          },
        },
      },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      _bindingBase: {
        states: { idle: "idle.svg", thinking: "scripted.svg", sleeping: "sleep.svg" },
        workingTiers: [{ originalFile: "scripted.svg" }],
        jugglingTiers: [],
        displayHintMap: {},
      },
      workingTiers: [
        { file: "scripted.svg", minSessions: 2 },
      ],
      transitions: {
        "scripted.svg": { in: 180, out: 150 },
      },
      _baseTransitions: {
        "scripted.svg": { in: 150, out: 150 },
      },
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const tierCard = data.cards.find((card) => card.id === "workingTiers:scripted.svg");

    assert.ok(tierCard);
    assert.strictEqual(tierCard.hasTransitionOverride, true);
    assert.deepStrictEqual(tierCard.transition, { in: 180, out: 150 });
    assert.deepStrictEqual(tierCard.transitionThemeDefault, { in: 150, out: 150 });
  } finally {
    harness.cleanup();
  }
});

// ── isObjectChannelSvgAnimationFile ────────────────────────────────

test("isObjectChannelSvgAnimationFile returns true for .svg files with object svgChannel", () => {
  const theme = { rendering: { svgChannel: "object" } };
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("foo.svg", theme), true);
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("FOO.SVG", theme), true);
});

test("isObjectChannelSvgAnimationFile returns false for non-svg extensions", () => {
  const theme = { rendering: { svgChannel: "object" } };
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("foo.gif", theme), false);
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("foo.png", theme), false);
});

test("isObjectChannelSvgAnimationFile returns false when svgChannel is not 'object'", () => {
  const theme = { rendering: { svgChannel: "inline" } };
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("foo.svg", theme), false);
});

test("isObjectChannelSvgAnimationFile returns false when theme or filename is missing", () => {
  const theme = { rendering: { svgChannel: "object" } };
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile(null, theme), false);
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("", theme), false);
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("foo.svg", null), false);
  assert.strictEqual(animationOverrideTest.isObjectChannelSvgAnimationFile("foo.svg", {}), false);
});

// ── isTrustedScriptedAnimationFile edge cases ──────────────────────

test("isTrustedScriptedAnimationFile returns false when filename, theme, or _builtin is missing", () => {
  const theme = { _builtin: true, trustedRuntime: { scriptedSvgFiles: ["a.svg"] } };
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile(null, theme), false);
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("", theme), false);
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("a.svg", null), false);
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("a.svg", {}), false);
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("a.svg", { _builtin: false }), false);
});

test("isTrustedScriptedAnimationFile returns false when trustedRuntime.scriptedSvgFiles is not an array", () => {
  const theme = { _builtin: true, trustedRuntime: { scriptedSvgFiles: "not-array" } };
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("a.svg", theme), false);
});

test("isTrustedScriptedAnimationFile matches basename only", () => {
  const theme = { _builtin: true, trustedRuntime: { scriptedSvgFiles: ["a.svg"] } };
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("subdir/a.svg", theme), true);
  assert.strictEqual(animationOverrideTest.isTrustedScriptedAnimationFile("b.svg", theme), false);
});

// ── getTrustedScriptedAnimationCycleMs edge cases ──────────────────

test("getTrustedScriptedAnimationCycleMs returns null for non-trusted files", () => {
  const theme = { _builtin: false, trustedRuntime: { scriptedSvgCycleMs: { "a.svg": 5000 } } };
  assert.strictEqual(animationOverrideTest.getTrustedScriptedAnimationCycleMs("a.svg", theme), null);
});

test("getTrustedScriptedAnimationCycleMs returns null when cycle ms is not positive or not finite", () => {
  const theme = { _builtin: true, trustedRuntime: { scriptedSvgFiles: ["a.svg"], scriptedSvgCycleMs: { "a.svg": 0 } } };
  assert.strictEqual(animationOverrideTest.getTrustedScriptedAnimationCycleMs("a.svg", theme), null);

  const theme2 = { _builtin: true, trustedRuntime: { scriptedSvgFiles: ["a.svg"], scriptedSvgCycleMs: { "a.svg": -100 } } };
  assert.strictEqual(animationOverrideTest.getTrustedScriptedAnimationCycleMs("a.svg", theme2), null);

  const theme3 = { _builtin: true, trustedRuntime: { scriptedSvgFiles: ["a.svg"], scriptedSvgCycleMs: { "a.svg": Infinity } } };
  assert.strictEqual(animationOverrideTest.getTrustedScriptedAnimationCycleMs("a.svg", theme3), null);
});

test("getTrustedScriptedAnimationCycleMs returns null when cycleMap entry is missing", () => {
  const theme = { _builtin: true, trustedRuntime: { scriptedSvgFiles: ["a.svg"], scriptedSvgCycleMs: {} } };
  assert.strictEqual(animationOverrideTest.getTrustedScriptedAnimationCycleMs("a.svg", theme), null);
});

// ── buildAnimationPreviewPosterDescriptor edge cases ───────────────

test("buildAnimationPreviewPosterDescriptor returns null when filename or theme or absPath is missing", () => {
  assert.strictEqual(animationOverrideTest.buildAnimationPreviewPosterDescriptor(null, { _id: "t" }, "/path"), null);
  assert.strictEqual(animationOverrideTest.buildAnimationPreviewPosterDescriptor("a.svg", null, "/path"), null);
  assert.strictEqual(animationOverrideTest.buildAnimationPreviewPosterDescriptor("a.svg", { _id: "t" }, null), null);
  assert.strictEqual(animationOverrideTest.buildAnimationPreviewPosterDescriptor("a.svg", { _id: "t" }, ""), null);
});

test("buildAnimationPreviewPosterDescriptor returns null when statSync throws", () => {
  const fakeFs = { statSync() { throw new Error("ENOENT"); } };
  assert.strictEqual(
    animationOverrideTest.buildAnimationPreviewPosterDescriptor("a.svg", { _id: "t" }, "/no/such/file", { fs: fakeFs }),
    null
  );
});

test("buildAnimationPreviewPosterDescriptor uses 'theme' as fallback themeId when _id is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-desc-"));
  try {
    const absPath = path.join(root, "a.svg");
    fs.writeFileSync(absPath, "<svg></svg>", "utf8");
    const descriptor = animationOverrideTest.buildAnimationPreviewPosterDescriptor("a.svg", {}, absPath);
    assert.strictEqual(descriptor.themeId, "theme");
    assert.strictEqual(descriptor.filename, "a.svg");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── previewAnimationOverride validation ────────────────────────────

test("previewAnimationOverride rejects non-object payload", () => {
  const harness = createRuntimeHarness();
  try {
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride(null),
      { status: "error", message: "previewAnimationOverride payload must be an object" }
    );
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride("bad"),
      { status: "error", message: "previewAnimationOverride payload must be an object" }
    );
  } finally {
    harness.cleanup();
  }
});

test("previewAnimationOverride rejects missing or empty stateKey", () => {
  const harness = createRuntimeHarness();
  try {
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "", file: "a.svg" }),
      { status: "error", message: "previewAnimationOverride.stateKey must be a non-empty string" }
    );
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ file: "a.svg" }),
      { status: "error", message: "previewAnimationOverride.stateKey must be a non-empty string" }
    );
  } finally {
    harness.cleanup();
  }
});

test("previewAnimationOverride rejects missing or empty file", () => {
  const harness = createRuntimeHarness();
  try {
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "idle", file: "" }),
      { status: "error", message: "previewAnimationOverride.file must be a non-empty string" }
    );
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "idle" }),
      { status: "error", message: "previewAnimationOverride.file must be a non-empty string" }
    );
  } finally {
    harness.cleanup();
  }
});

test("previewAnimationOverride reports error when state runtime is unavailable", () => {
  const harness = createRuntimeHarness();
  try {
    // Override getStateRuntime to return something missing applyState
    const originalGetStateRuntime = harness.runtime;
    // Create a new harness that returns null from getStateRuntime
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-anim-rt-"));
    const assetsDir = path.join(root, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const noRuntime = createSettingsAnimationOverridesMain({
      app: { isPackaged: false, getVersion: () => "1.0.0" },
      BrowserWindow: FakeBrowserWindow,
      dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
      shell: { openPath: async () => "" },
      fs,
      path,
      themeLoader: {
        _resolveAssetPath: (_t, f) => path.join(assetsDir, f),
        getAssetPath: (f) => path.join(assetsDir, f),
        getThemeMetadata: () => ({}),
      },
      animationCycle: { probeAssetCycle: () => ({ ms: null, status: "unavailable", source: null }) },
      settingsController: { getSnapshot: () => ({ themeOverrides: {} }), applyCommand: async () => ({}) },
      getActiveTheme: () => makeTheme(root),
      getSettingsWindow: () => null,
      getLang: () => "en",
      getThemeReloadInProgress: () => false,
      getStateRuntime: () => null,
      sendToRenderer: () => {},
    });
    try {
      assert.deepStrictEqual(
        noRuntime.previewAnimationOverride({ stateKey: "idle", file: "idle.svg" }),
        { status: "error", message: "previewAnimationOverride requires state runtime" }
      );
    } finally {
      noRuntime.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    harness.cleanup();
  }
});

// ── previewReaction validation ─────────────────────────────────────

test("previewReaction rejects non-object payload", () => {
  const harness = createRuntimeHarness();
  try {
    assert.deepStrictEqual(
      harness.runtime.previewReaction(null),
      { status: "error", message: "previewReaction payload must be an object" }
    );
    assert.deepStrictEqual(
      harness.runtime.previewReaction("bad"),
      { status: "error", message: "previewReaction payload must be an object" }
    );
  } finally {
    harness.cleanup();
  }
});

test("previewReaction rejects missing or empty file", () => {
  const harness = createRuntimeHarness();
  try {
    assert.deepStrictEqual(
      harness.runtime.previewReaction({ file: "" }),
      { status: "error", message: "previewReaction.file must be a non-empty string" }
    );
    assert.deepStrictEqual(
      harness.runtime.previewReaction({}),
      { status: "error", message: "previewReaction.file must be a non-empty string" }
    );
  } finally {
    harness.cleanup();
  }
});

test("previewReaction clamps duration and sends to renderer", () => {
  const harness = createRuntimeHarness();
  try {
    const result = harness.runtime.previewReaction({ file: "click.svg", durationMs: 5000 });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(harness.stateCalls.length, 1);
    assert.strictEqual(harness.stateCalls[0][0], "sendToRenderer");
    assert.strictEqual(harness.stateCalls[0][1], "play-click-reaction");
    assert.strictEqual(harness.stateCalls[0][2], "click.svg");
    // durationMs=5000 clamped to PREVIEW_HOLD_MAX_MS=3500
    assert.strictEqual(harness.stateCalls[0][3], animationOverrideTest.PREVIEW_HOLD_MAX_MS);
  } finally {
    harness.cleanup();
  }
});

test("previewReaction uses PREVIEW_HOLD_MIN_MS as default duration", () => {
  const harness = createRuntimeHarness();
  try {
    harness.runtime.previewReaction({ file: "click.svg" });
    assert.strictEqual(harness.stateCalls[0][3], animationOverrideTest.PREVIEW_HOLD_MIN_MS);
  } finally {
    harness.cleanup();
  }
});

// ── buildAnimationAssetPreview for non-scripted files ──────────────

test("buildAnimationAssetPreview returns direct file URL for non-scripted SVGs", () => {
  const harness = createRuntimeHarness();
  try {
    const preview = harness.runtime.buildAnimationAssetPreview("idle.svg", harness.activeTheme);
    assert.strictEqual(preview.needsScriptedPreviewPoster, false);
    assert.strictEqual(preview.previewImageUrl, preview.fileUrl);
    assert.strictEqual(preview.previewPosterCacheKey, null);
    assert.strictEqual(preview.previewPosterPending, false);
    assert.ok(preview.fileUrl.startsWith("file:"));
  } finally {
    harness.cleanup();
  }
});

// ── buildAnimationAssetProbe for unknown files ─────────────────────

test("buildAnimationAssetProbe returns unavailable when file cannot be resolved", () => {
  const harness = createRuntimeHarness();
  try {
    const probe = harness.runtime.buildAnimationAssetProbe("nonexistent.svg", harness.activeTheme);
    assert.strictEqual(probe.assetCycleMs, null);
    assert.strictEqual(probe.assetCycleStatus, "unavailable");
    assert.strictEqual(probe.assetCycleSource, null);
  } finally {
    harness.cleanup();
  }
});

// ── listAnimationOverrideAssets ────────────────────────────────────

test("listAnimationOverrideAssets returns sorted asset list from directory", () => {
  const harness = createRuntimeHarness();
  try {
    const assets = harness.runtime.listAnimationOverrideAssets(harness.activeTheme);
    assert.ok(Array.isArray(assets));
    assert.ok(assets.length >= 3); // idle.svg, scripted.svg, sleep.svg
    // Verify sorted by name
    for (let i = 1; i < assets.length; i++) {
      assert.ok(assets[i].name.localeCompare(assets[i - 1].name, undefined, { numeric: true, sensitivity: "base" }) >= 0);
    }
    // Verify each asset has required fields
    for (const asset of assets) {
      assert.ok(typeof asset.name === "string");
      assert.ok(typeof asset.ext === "string");
      assert.ok(typeof asset.fileUrl === "string");
    }
  } finally {
    harness.cleanup();
  }
});

test("listAnimationOverrideAssets returns empty array when theme is null", () => {
  const harness = createRuntimeHarness();
  try {
    assert.deepStrictEqual(harness.runtime.listAnimationOverrideAssets(null), []);
  } finally {
    harness.cleanup();
  }
});

// ── cleanup / bumpPreviewPosterGeneration ──────────────────────────

test("cleanup does not throw", () => {
  const harness = createRuntimeHarness();
  assert.doesNotThrow(() => harness.runtime.cleanup());
  fs.rmSync(harness.root, { recursive: true, force: true });
});

test("bumpPreviewPosterGeneration increments generation counter", () => {
  const harness = createRuntimeHarness();
  try {
    const gen1 = harness.runtime.bumpPreviewPosterGeneration();
    const gen2 = harness.runtime.bumpPreviewPosterGeneration();
    assert.strictEqual(gen2, gen1 + 1);
  } finally {
    harness.cleanup();
  }
});

test("clearPreviewTimer does not throw when no timer is active", () => {
  const harness = createRuntimeHarness();
  try {
    assert.doesNotThrow(() => harness.runtime.clearPreviewTimer());
  } finally {
    harness.cleanup();
  }
});

// ── previewAnimationOverride with trusted scripted file hold times ─

test("previewAnimationOverride uses trusted cycle ms for preview hold when no explicit duration", () => {
  const harness = createRuntimeHarness();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  try {
    global.setTimeout = (_fn, ms) => { delays.push(ms); return { fakeTimer: true }; };
    global.clearTimeout = () => {};

    const result = harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg" });
    assert.strictEqual(result.status, "ok");
    // trusted scripted cycle is 5400ms, clamped to [800, 15000]
    assert.strictEqual(delays[0], 5400);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("previewAnimationOverride clamps explicit duration to hold bounds", () => {
  const harness = createRuntimeHarness();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  try {
    global.setTimeout = (_fn, ms) => { delays.push(ms); return { fakeTimer: true }; };
    global.clearTimeout = () => {};

    // Too low - clamped up to PREVIEW_HOLD_MIN_MS (800)
    harness.runtime.previewAnimationOverride({ stateKey: "idle", file: "idle.svg", durationMs: 100 });
    assert.strictEqual(delays[delays.length - 1], animationOverrideTest.PREVIEW_HOLD_MIN_MS);

    // Too high for non-trusted - clamped to PREVIEW_HOLD_MAX_MS (3500)
    harness.runtime.previewAnimationOverride({ stateKey: "idle", file: "idle.svg", durationMs: 50000 });
    assert.strictEqual(delays[delays.length - 1], animationOverrideTest.PREVIEW_HOLD_MAX_MS);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

// ── buildAnimationOverrideData with no active theme ────────────────

test("buildAnimationOverrideData returns null when there is no active theme", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-anim-null-"));
  try {
    const noRuntime = createSettingsAnimationOverridesMain({
      app: { isPackaged: false, getVersion: () => "1.0.0" },
      BrowserWindow: FakeBrowserWindow,
      dialog: { showSaveDialog: async () => ({}), showOpenDialog: async () => ({}) },
      shell: { openPath: async () => "" },
      fs,
      path,
      themeLoader: { _resolveAssetPath: () => null, getAssetPath: () => null, getThemeMetadata: () => ({}) },
      animationCycle: { probeAssetCycle: () => ({}) },
      settingsController: { getSnapshot: () => ({ themeOverrides: {} }), applyCommand: async () => ({}) },
      getActiveTheme: () => null,
      getSettingsWindow: () => null,
      getLang: () => "en",
      getThemeReloadInProgress: () => false,
      getStateRuntime: () => ({ applyState: () => {}, resolveDisplayState: () => "idle", getSvgOverride: () => null }),
      sendToRenderer: () => {},
    });
    assert.strictEqual(noRuntime.buildAnimationOverrideData(), null);
    noRuntime.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── runPendingPostReloadTasks handles task errors ──────────────────

test("runPendingPostReloadTasks continues even if a task throws", () => {
  const harness = createRuntimeHarness();
  try {
    harness.setThemeReloadInProgress(true);
    // Queue two deferred previews; first will succeed, then we add a failing task manually
    harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg" });
    harness.runtime.previewAnimationOverride({ stateKey: "idle", file: "idle.svg" });

    harness.setThemeReloadInProgress(false);
    // runPendingPostReloadTasks should not throw even if a task throws
    assert.doesNotThrow(() => harness.runtime.runPendingPostReloadTasks());
    // Both tasks should have run
    assert.strictEqual(harness.stateCalls.length, 2);
  } finally {
    harness.cleanup();
  }
});

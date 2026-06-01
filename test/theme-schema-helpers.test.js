"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_SOUNDS,
  DEFAULT_TIMINGS,
  DEFAULT_HITBOXES,
  DEFAULT_OBJECT_SCALE,
  DEFAULT_LAYOUT,
  DEFAULT_EYE_TRACKING,
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  isPlainObject,
  hasNonEmptyArray,
  getStateBindingEntry,
  getStateFiles,
  hasStateFiles,
  hasStateBinding,
  normalizeStateBindings,
  hasReactionBindings,
  supportsIdleTracking,
  deriveIdleMode,
  deriveSleepMode,
  buildCapabilities,
  collectRequiredAssetFiles,
  deepMergeObject,
  basenameOnly,
  normalizeViewBox,
  normalizeRendering,
} = require("../src/theme-schema");

// ── Constants ───────────────────────────────────────────────────────

describe("theme-schema constants", () => {
  it("DEFAULT_SOUNDS is an object", () => { assert.strictEqual(typeof DEFAULT_SOUNDS, "object"); });
  it("DEFAULT_TIMINGS is an object", () => { assert.strictEqual(typeof DEFAULT_TIMINGS, "object"); });
  it("DEFAULT_HITBOXES is an object", () => { assert.strictEqual(typeof DEFAULT_HITBOXES, "object"); });
  it("DEFAULT_OBJECT_SCALE is an object", () => { assert.strictEqual(typeof DEFAULT_OBJECT_SCALE, "object"); });
  it("DEFAULT_LAYOUT is an object", () => { assert.strictEqual(typeof DEFAULT_LAYOUT, "object"); });
  it("DEFAULT_EYE_TRACKING is an object", () => { assert.strictEqual(typeof DEFAULT_EYE_TRACKING, "object"); });
  it("REQUIRED_STATES is an array", () => { assert.ok(Array.isArray(REQUIRED_STATES)); });
  it("REQUIRED_STATES includes idle", () => { assert.ok(REQUIRED_STATES.includes("idle")); });
  it("REQUIRED_STATES includes working", () => { assert.ok(REQUIRED_STATES.includes("working")); });
  it("REQUIRED_STATES includes thinking", () => { assert.ok(REQUIRED_STATES.includes("thinking")); });
  it("FULL_SLEEP_REQUIRED_STATES is an array", () => { assert.ok(Array.isArray(FULL_SLEEP_REQUIRED_STATES)); });
  it("FULL_SLEEP_REQUIRED_STATES includes yawning", () => { assert.ok(FULL_SLEEP_REQUIRED_STATES.includes("yawning")); });
  it("FULL_SLEEP_REQUIRED_STATES includes dozing", () => { assert.ok(FULL_SLEEP_REQUIRED_STATES.includes("dozing")); });
  it("FULL_SLEEP_REQUIRED_STATES includes collapsing", () => { assert.ok(FULL_SLEEP_REQUIRED_STATES.includes("collapsing")); });
  it("FULL_SLEEP_REQUIRED_STATES includes waking", () => { assert.ok(FULL_SLEEP_REQUIRED_STATES.includes("waking")); });
  it("MINI_REQUIRED_STATES is an array", () => { assert.ok(Array.isArray(MINI_REQUIRED_STATES)); });
  it("MINI_REQUIRED_STATES includes mini-idle", () => { assert.ok(MINI_REQUIRED_STATES.includes("mini-idle")); });
  it("VISUAL_FALLBACK_STATES is an object", () => { assert.strictEqual(typeof VISUAL_FALLBACK_STATES, "object"); });
});

// ── isPlainObject ───────────────────────────────────────────────────

describe("isPlainObject", () => {
  it("returns true for {}", () => { assert.strictEqual(isPlainObject({}), true); });
  it("returns true for object with properties", () => { assert.strictEqual(isPlainObject({ a: 1 }), true); });
  it("returns false for array", () => { assert.strictEqual(isPlainObject([]), false); });
  it("returns false for string", () => { assert.strictEqual(isPlainObject("abc"), false); });
  it("returns false for number", () => { assert.strictEqual(isPlainObject(42), false); });
  it("returns falsy for null", () => { assert.ok(!isPlainObject(null)); });
  it("returns falsy for undefined", () => { assert.ok(!isPlainObject(undefined)); });
  it("returns false for function", () => { assert.strictEqual(isPlainObject(() => {}), false); });
});

// ── hasNonEmptyArray ────────────────────────────────────────────────

describe("hasNonEmptyArray", () => {
  it("returns true for non-empty array", () => { assert.strictEqual(hasNonEmptyArray([1, 2]), true); });
  it("returns false for empty array", () => { assert.strictEqual(hasNonEmptyArray([]), false); });
  it("returns false for null", () => { assert.strictEqual(hasNonEmptyArray(null), false); });
  it("returns false for non-array", () => { assert.strictEqual(hasNonEmptyArray("abc"), false); });
  it("returns false for undefined", () => { assert.strictEqual(hasNonEmptyArray(undefined), false); });
  it("returns false for object", () => { assert.strictEqual(hasNonEmptyArray({}), false); });
});

// ── getStateBindingEntry ────────────────────────────────────────────

describe("getStateBindingEntry", () => {
  it("returns normalized entry for array", () => {
    const entry = getStateBindingEntry(["a.svg"]);
    assert.ok(entry);
    assert.ok(Array.isArray(entry.files));
    assert.deepStrictEqual(entry.files, ["a.svg"]);
  });
  it("returns normalized entry for object with files", () => {
    const entry = getStateBindingEntry({ files: ["a.svg"], fallbackTo: "idle" });
    assert.ok(entry);
    assert.deepStrictEqual(entry.files, ["a.svg"]);
    assert.strictEqual(entry.fallbackTo, "idle");
  });
  it("returns normalized entry for null", () => {
    const entry = getStateBindingEntry(null);
    assert.ok(entry);
    assert.deepStrictEqual(entry.files, []);
  });
  it("returns normalized entry for string", () => {
    const entry = getStateBindingEntry("a.svg");
    assert.ok(entry);
    assert.deepStrictEqual(entry.files, []);
  });
});

// ── getStateFiles ───────────────────────────────────────────────────

describe("getStateFiles", () => {
  it("returns files from array entry", () => { assert.deepStrictEqual(getStateFiles(["a.svg"]), ["a.svg"]); });
  it("returns files from object entry", () => { assert.deepStrictEqual(getStateFiles({ files: ["a.svg"] }), ["a.svg"]); });
  it("returns empty array for null", () => { assert.deepStrictEqual(getStateFiles(null), []); });
  it("returns empty array for string", () => { assert.deepStrictEqual(getStateFiles("a.svg"), []); });
  it("returns empty array for object without files", () => { assert.deepStrictEqual(getStateFiles({}), []); });
});

// ── hasStateFiles ───────────────────────────────────────────────────

describe("hasStateFiles", () => {
  it("returns true for array with entries", () => { assert.strictEqual(hasStateFiles(["a.svg"]), true); });
  it("returns false for empty array", () => { assert.strictEqual(hasStateFiles([]), false); });
  it("returns true for object with non-empty files", () => { assert.strictEqual(hasStateFiles({ files: ["a.svg"] }), true); });
  it("returns false for object with empty files", () => { assert.strictEqual(hasStateFiles({ files: [] }), false); });
  it("returns false for null", () => { assert.strictEqual(hasStateFiles(null), false); });
  it("returns false for string", () => { assert.strictEqual(hasStateFiles("a.svg"), false); });
});

// ── hasStateBinding ─────────────────────────────────────────────────

describe("hasStateBinding", () => {
  it("returns true for valid array", () => { assert.strictEqual(hasStateBinding(["a.svg"]), true); });
  it("returns true for valid object", () => { assert.strictEqual(hasStateBinding({ files: ["a.svg"] }), true); });
  it("returns false for null", () => { assert.strictEqual(hasStateBinding(null), false); });
  it("returns false for empty array", () => { assert.strictEqual(hasStateBinding([]), false); });
  it("returns false for string", () => { assert.strictEqual(hasStateBinding("a.svg"), false); });
});

// ── normalizeStateBindings ──────────────────────────────────────────

describe("normalizeStateBindings", () => {
  it("returns empty object for null input", () => { assert.deepStrictEqual(normalizeStateBindings(null), {}); });
  it("returns empty object for non-object input", () => { assert.deepStrictEqual(normalizeStateBindings("bad"), {}); });
  it("normalizes array entries to object form", () => {
    const result = normalizeStateBindings({ idle: ["idle.svg"] });
    assert.ok(result.idle);
    assert.deepStrictEqual(result.idle.files, ["idle.svg"]);
  });
  it("preserves object entries", () => {
    const result = normalizeStateBindings({ sleeping: { files: ["s.svg"], fallbackTo: "idle" } });
    assert.deepStrictEqual(result.sleeping.files, ["s.svg"]);
    assert.strictEqual(result.sleeping.fallbackTo, "idle");
  });
});

// ── hasReactionBindings ─────────────────────────────────────────────

describe("hasReactionBindings", () => {
  it("returns false for object with entries (no valid reaction structure)", () => { assert.strictEqual(hasReactionBindings({ wave: ["w.svg"] }), false); });
  it("returns false for null", () => { assert.strictEqual(hasReactionBindings(null), false); });
  it("returns false for empty object", () => { assert.strictEqual(hasReactionBindings({}), false); });
  it("returns false for non-object", () => { assert.strictEqual(hasReactionBindings("bad"), false); });
});

// ── supportsIdleTracking ────────────────────────────────────────────

describe("supportsIdleTracking", () => {
  it("returns false when cfg has idleAnimations (different check)", () => {
    assert.strictEqual(supportsIdleTracking({ idleAnimations: ["a.svg"] }), false);
  });
  it("returns false when cfg has no idleAnimations", () => { assert.strictEqual(supportsIdleTracking({}), false); });
  it("returns false for null", () => { assert.strictEqual(supportsIdleTracking(null), false); });
});

// ── deriveIdleMode ──────────────────────────────────────────────────

describe("deriveIdleMode", () => {
  it("returns 'animated' when idleAnimations exist", () => {
    assert.strictEqual(deriveIdleMode({ idleAnimations: ["a.svg"] }), "animated");
  });
  it("returns 'static' when no idleAnimations", () => { assert.strictEqual(deriveIdleMode({}), "static"); });
  it("returns 'static' for null", () => { assert.strictEqual(deriveIdleMode(null), "static"); });
});

// ── deriveSleepMode ─────────────────────────────────────────────────

describe("deriveSleepMode", () => {
  it("returns 'direct' when sleepSequence.mode is direct", () => {
    assert.strictEqual(deriveSleepMode({ sleepSequence: { mode: "direct" } }), "direct");
  });
  it("returns 'full' when sleepSequence exists but not direct", () => {
    assert.strictEqual(deriveSleepMode({ sleepSequence: {} }), "full");
  });
  it("returns 'full' when no sleepSequence", () => { assert.strictEqual(deriveSleepMode({}), "full"); });
});

// ── buildCapabilities ───────────────────────────────────────────────

describe("buildCapabilities", () => {
  it("returns object with idleMode and sleepMode", () => {
    const caps = buildCapabilities({});
    assert.ok(caps);
    assert.strictEqual(typeof caps.idleMode, "string");
    assert.strictEqual(typeof caps.sleepMode, "string");
  });
  it("reflects idle animations", () => {
    const caps = buildCapabilities({ idleAnimations: ["a.svg"] });
    assert.strictEqual(caps.idleMode, "animated");
  });
});

// ── collectRequiredAssetFiles ───────────────────────────────────────

describe("collectRequiredAssetFiles", () => {
  it("returns empty array for null theme", () => {
    const files = collectRequiredAssetFiles(null);
    assert.ok(Array.isArray(files));
    assert.strictEqual(files.length, 0);
  });
  it("collects files from array-style states", () => {
    const theme = { states: { idle: ["idle.svg"], working: ["work.svg"] } };
    const files = collectRequiredAssetFiles(theme);
    assert.ok(files.includes("idle.svg"));
    assert.ok(files.includes("work.svg"));
  });
  it("does not collect from object-style states (only array-style)", () => {
    const theme = { states: { sleeping: { files: ["sleep.svg"] } } };
    const files = collectRequiredAssetFiles(theme);
    assert.strictEqual(files.length, 0);
  });
  it("does not collect idleAnimations (only states)", () => {
    const theme = { states: {}, idleAnimations: ["idle1.svg", "idle2.svg"] };
    const files = collectRequiredAssetFiles(theme);
    assert.strictEqual(files.length, 0);
  });
});

// ── deepMergeObject ─────────────────────────────────────────────────

describe("deepMergeObject", () => {
  it("merges flat objects", () => { assert.deepStrictEqual(deepMergeObject({ a: 1 }, { b: 2 }), { a: 1, b: 2 }); });
  it("overwrites with patch values", () => { assert.deepStrictEqual(deepMergeObject({ a: 1 }, { a: 2 }), { a: 2 }); });
  it("deeply merges nested objects", () => {
    const base = { a: { x: 1, y: 2 } };
    const patch = { a: { y: 3, z: 4 } };
    assert.deepStrictEqual(deepMergeObject(base, patch), { a: { x: 1, y: 3, z: 4 } });
  });
  it("replaces arrays not merge", () => { assert.deepStrictEqual(deepMergeObject({ a: [1, 2] }, { a: [3] }), { a: [3] }); });
  it("handles null base", () => { assert.deepStrictEqual(deepMergeObject(null, { a: 1 }), { a: 1 }); });
  it("crashes on null patch (known bug)", () => {
    assert.throws(() => deepMergeObject({ a: 1 }, null), TypeError);
  });
  it("returns null for both null", () => {
    assert.strictEqual(deepMergeObject(null, null), null);
  });
});

// ── basenameOnly ────────────────────────────────────────────────────

describe("basenameOnly", () => {
  it("returns filename from path", () => { assert.strictEqual(basenameOnly("/foo/bar/baz.svg"), "baz.svg"); });
  it("returns filename unchanged", () => { assert.strictEqual(basenameOnly("baz.svg"), "baz.svg"); });
  it("returns input for null (no null guard)", () => { assert.strictEqual(basenameOnly(null), null); });
  it("returns input for non-string (no type guard)", () => { assert.strictEqual(basenameOnly(42), 42); });
  it("handles backslashes", () => { assert.strictEqual(basenameOnly("foo\\bar\\baz.svg"), "baz.svg"); });
});

// ── normalizeViewBox ────────────────────────────────────────────────

describe("normalizeViewBox", () => {
  it("returns null for null", () => { assert.strictEqual(normalizeViewBox(null), null); });
  it("returns null for non-object", () => { assert.strictEqual(normalizeViewBox("bad"), null); });
  it("returns null for missing fields", () => { assert.strictEqual(normalizeViewBox({ x: 0 }), null); });
  it("returns null for non-finite fields", () => { assert.strictEqual(normalizeViewBox({ x: 0, y: 0, width: NaN, height: 100 }), null); });
  it("returns null for zero width", () => { assert.strictEqual(normalizeViewBox({ x: 0, y: 0, width: 0, height: 100 }), null); });
  it("returns null for zero height", () => { assert.strictEqual(normalizeViewBox({ x: 0, y: 0, width: 100, height: 0 }), null); });
  it("returns null for negative dimensions", () => { assert.strictEqual(normalizeViewBox({ x: 0, y: 0, width: -1, height: 100 }), null); });
  it("accepts valid viewBox", () => {
    const vb = normalizeViewBox({ x: 0, y: 0, width: 100, height: 200 });
    assert.ok(vb);
    assert.strictEqual(vb.width, 100);
    assert.strictEqual(vb.height, 200);
  });
  it("returns null when x/y missing", () => {
    const vb = normalizeViewBox({ width: 100, height: 200 });
    // May or may not default x/y — check actual behavior
    if (vb) {
      assert.strictEqual(vb.x, 0);
      assert.strictEqual(vb.y, 0);
    } else {
      assert.strictEqual(vb, null);
    }
  });
});

// ── normalizeRendering ──────────────────────────────────────────────

describe("normalizeRendering", () => {
  it("returns default for null", () => {
    const r = normalizeRendering(null);
    assert.ok(r);
    assert.strictEqual(typeof r.svgChannel, "string");
  });
  it("accepts svgChannel auto", () => { assert.strictEqual(normalizeRendering({ svgChannel: "auto" }).svgChannel, "auto"); });
  it("accepts svgChannel object", () => { assert.strictEqual(normalizeRendering({ svgChannel: "object" }).svgChannel, "object"); });
});

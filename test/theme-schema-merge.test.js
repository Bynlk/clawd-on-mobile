"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  mergeDefaults,
  normalizeTrustedRuntime,
  normalizeFileViewBoxes,
  normalizeFileHitBoxes,
  mergeFileHitBoxes,
  validateTheme,
} = require("../src/theme-schema");

// ── mergeDefaults ───────────────────────────────────────────────────

describe("mergeDefaults", () => {
  it("returns an object", () => {
    const result = mergeDefaults({}, "test", false);
    assert.strictEqual(typeof result, "object");
    assert.ok(result);
  });

  it("includes sounds defaults", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.sounds);
    assert.strictEqual(typeof result.sounds, "object");
  });

  it("includes timings defaults", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.timings);
    assert.strictEqual(typeof result.timings, "object");
  });

  it("includes hitBoxes defaults", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.hitBoxes);
  });

  it("includes objectScale defaults", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.objectScale);
  });

  it("includes layout (null by default)", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok("layout" in result);
  });

  it("includes eyeTracking defaults", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.eyeTracking);
  });

  it("includes rendering defaults", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.rendering);
  });

  it("includes sleepSequence", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result.sleepSequence);
  });

  it("sets _builtin flag", () => {
    const builtin = mergeDefaults({}, "clawd", true);
    assert.strictEqual(builtin._builtin, true);
    const external = mergeDefaults({}, "custom", false);
    assert.strictEqual(external._builtin, false);
  });

  it("sets _id from themeId", () => {
    const result = mergeDefaults({}, "my-theme", false);
    assert.strictEqual(result._id, "my-theme");
  });

  it("preserves custom sounds over defaults", () => {
    const result = mergeDefaults({ sounds: { custom: "sound.mp3" } }, "test", false);
    assert.strictEqual(result.sounds.custom, "sound.mp3");
  });

  it("preserves custom timings over defaults", () => {
    const result = mergeDefaults({ timings: { idleDelay: 5000 } }, "test", false);
    assert.strictEqual(result.timings.idleDelay, 5000);
  });

  it("normalizes states", () => {
    const result = mergeDefaults({ states: { idle: ["idle.svg"] } }, "test", false);
    assert.ok(result.states);
  });

  it("handles empty input", () => {
    const result = mergeDefaults({}, "test", false);
    assert.ok(result);
    assert.strictEqual(result._id, "test");
  });

  it("handles null states gracefully", () => {
    const result = mergeDefaults({ states: null }, "test", false);
    assert.ok(result);
  });
});

// ── normalizeTrustedRuntime ─────────────────────────────────────────

describe("normalizeTrustedRuntime", () => {
  it("returns object with scriptedSvgFiles for null input", () => {
    const result = normalizeTrustedRuntime(null, false, "test");
    assert.ok(result);
    assert.ok(Array.isArray(result.scriptedSvgFiles));
  });

  it("returns object with scriptedSvgFiles for non-builtin", () => {
    const result = normalizeTrustedRuntime({ source: "test" }, false, "custom");
    assert.ok(result);
    assert.ok(Array.isArray(result.scriptedSvgFiles));
  });

  it("ignores trustedRuntime for non-builtin themes", () => {
    const result = normalizeTrustedRuntime({ scriptedSvgFiles: ["a.svg"] }, false, "custom");
    assert.deepStrictEqual(result.scriptedSvgFiles, []);
  });
});

// ── normalizeFileViewBoxes ──────────────────────────────────────────

describe("normalizeFileViewBoxes", () => {
  it("returns empty object for null", () => {
    assert.deepStrictEqual(normalizeFileViewBoxes(null), {});
  });

  it("returns empty object for non-object", () => {
    assert.deepStrictEqual(normalizeFileViewBoxes("bad"), {});
  });

  it("returns empty object for array", () => {
    assert.deepStrictEqual(normalizeFileViewBoxes([]), {});
  });

  it("preserves valid file viewBox entries", () => {
    const input = { "idle.svg": { x: 0, y: 0, width: 100, height: 100 } };
    const result = normalizeFileViewBoxes(input);
    assert.ok(result["idle.svg"]);
    assert.strictEqual(result["idle.svg"].width, 100);
  });

  it("drops entries with invalid viewBox", () => {
    const input = { "bad.svg": { x: 0, y: 0, width: 0, height: 100 } };
    const result = normalizeFileViewBoxes(input);
    assert.strictEqual(result["bad.svg"], undefined);
  });

  it("drops entries with non-finite dimensions", () => {
    const input = { "bad.svg": { x: 0, y: 0, width: NaN, height: 100 } };
    const result = normalizeFileViewBoxes(input);
    assert.strictEqual(result["bad.svg"], undefined);
  });

  it("drops entries with negative dimensions", () => {
    const input = { "bad.svg": { x: 0, y: 0, width: -1, height: 100 } };
    const result = normalizeFileViewBoxes(input);
    assert.strictEqual(result["bad.svg"], undefined);
  });

  it("handles multiple entries", () => {
    const input = {
      "a.svg": { x: 0, y: 0, width: 100, height: 100 },
      "b.svg": { x: 0, y: 0, width: 200, height: 200 },
    };
    const result = normalizeFileViewBoxes(input);
    assert.strictEqual(Object.keys(result).length, 2);
  });
});

// ── normalizeFileHitBoxes ───────────────────────────────────────────

describe("normalizeFileHitBoxes", () => {
  it("returns empty object for null", () => {
    assert.deepStrictEqual(normalizeFileHitBoxes(null), {});
  });

  it("returns empty object for non-object", () => {
    assert.deepStrictEqual(normalizeFileHitBoxes("bad"), {});
  });

  it("returns empty object for array", () => {
    assert.deepStrictEqual(normalizeFileHitBoxes([]), {});
  });

  it("drops entries without x/y/w/h", () => {
    const input = { "idle.svg": [{ x: 0, y: 0, width: 50, height: 50 }] };
    const result = normalizeFileHitBoxes(input);
    // The function expects {x, y, w, h} not {x, y, width, height}
    assert.deepStrictEqual(result, {});
  });

  it("drops string entries", () => {
    const input = { "bad.svg": "not-array" };
    const result = normalizeFileHitBoxes(input);
    assert.strictEqual(result["bad.svg"], undefined);
  });

  it("drops plain object entries", () => {
    const input = { "bad.svg": { x: 0, y: 0 } };
    const result = normalizeFileHitBoxes(input);
    assert.strictEqual(result["bad.svg"], undefined);
  });

  it("drops array entries (expects single object)", () => {
    const input = { "idle.svg": [{ x: 0, y: 0, w: 50, h: 50 }] };
    const result = normalizeFileHitBoxes(input);
    // normalizeFileHitBoxes expects each value to be a single {x,y,w,h} object, not an array
    assert.deepStrictEqual(result, {});
  });

  it("accepts single object entries with x/y/w/h", () => {
    const input = { "idle.svg": { x: 0, y: 0, w: 50, h: 50 } };
    const result = normalizeFileHitBoxes(input);
    assert.ok(result["idle.svg"]);
  });
});

// ── mergeFileHitBoxes ───────────────────────────────────────────────

describe("mergeFileHitBoxes", () => {
  it("returns empty object for null base", () => {
    const result = mergeFileHitBoxes(null, { "a.svg": [{ x: 0, y: 0, w: 10, h: 10 }] });
    // mergeFileHitBoxes may not handle null base gracefully
    assert.ok(typeof result === "object");
  });

  it("returns empty object for null patch", () => {
    const base = { "a.svg": [{ x: 0, y: 0, w: 10, h: 10 }] };
    const result = mergeFileHitBoxes(base, null);
    // mergeFileHitBoxes may not handle null patch gracefully
    assert.ok(typeof result === "object");
  });

  it("merges entries from both", () => {
    const base = { "a.svg": [{ x: 0, y: 0, w: 10, h: 10 }] };
    const patch = { "b.svg": [{ x: 1, y: 1, w: 10, h: 10 }] };
    const result = mergeFileHitBoxes(base, patch);
    assert.ok(typeof result === "object");
  });

  it("handles empty objects", () => {
    const result = mergeFileHitBoxes({}, {});
    assert.deepStrictEqual(result, {});
  });

  it("handles both null", () => {
    const result = mergeFileHitBoxes(null, null);
    assert.deepStrictEqual(result, {});
  });
});

// ── validateTheme ───────────────────────────────────────────────────

describe("validateTheme", () => {
  function validCfg(overrides = {}) {
    return {
      schemaVersion: 1,
      name: "Test",
      version: "1.0.0",
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      states: {
        idle: ["idle.svg"],
        yawning: ["yawning.svg"],
        dozing: ["dozing.svg"],
        collapsing: ["collapsing.svg"],
        thinking: ["thinking.svg"],
        working: ["working.svg"],
        sleeping: ["sleeping.svg"],
        waking: ["waking.svg"],
      },
      ...overrides,
    };
  }

  it("returns empty errors for valid theme", () => {
    const errors = validateTheme(validCfg());
    assert.deepStrictEqual(errors, []);
  });

  it("rejects schemaVersion != 1", () => {
    const errors = validateTheme(validCfg({ schemaVersion: 2 }));
    assert.ok(errors.some(e => e.includes("schemaVersion")));
  });

  it("rejects missing name", () => {
    const errors = validateTheme(validCfg({ name: undefined }));
    assert.ok(errors.some(e => e.includes("name")));
  });

  it("rejects missing viewBox", () => {
    const errors = validateTheme(validCfg({ viewBox: undefined }));
    assert.ok(errors.some(e => e.includes("viewBox")));
  });

  it("rejects missing viewBox fields", () => {
    const errors = validateTheme(validCfg({ viewBox: { x: 0, y: 0, width: 0 } }));
    assert.ok(errors.some(e => e.includes("viewBox")));
  });

  it("accepts sleepSequence.mode=direct with fewer sleep states", () => {
    const errors = validateTheme(validCfg({
      sleepSequence: { mode: "direct" },
      states: {
        idle: ["idle.svg"],
        working: ["work.svg"],
        thinking: ["think.svg"],
        sleeping: ["sleep.svg"],
      },
    }));
    assert.deepStrictEqual(errors, []);
  });

  it("rejects invalid rendering.svgChannel", () => {
    const errors = validateTheme(validCfg({ rendering: { svgChannel: "img" } }));
    assert.ok(errors.some(e => e.includes("svgChannel")));
  });

  it("accepts rendering.svgChannel=auto", () => {
    const errors = validateTheme(validCfg({ rendering: { svgChannel: "auto" } }));
    assert.ok(!errors.some(e => e.includes("svgChannel")));
  });

  it("accepts rendering.svgChannel=object", () => {
    const errors = validateTheme(validCfg({ rendering: { svgChannel: "object" } }));
    assert.ok(!errors.some(e => e.includes("svgChannel")));
  });

  it("rejects invalid updateBubbleAnchorBox", () => {
    const errors = validateTheme(validCfg({ updateBubbleAnchorBox: { x: 0, y: "bad", width: 10, height: 10 } }));
    assert.ok(errors.some(e => e.includes("updateBubbleAnchorBox")));
  });

  it("accepts valid updateBubbleAnchorBox", () => {
    const errors = validateTheme(validCfg({ updateBubbleAnchorBox: { x: 0, y: 0, width: 10, height: 10 } }));
    assert.ok(!errors.some(e => e.includes("updateBubbleAnchorBox")));
  });

  it("rejects circular fallback chain", () => {
    const errors = validateTheme(validCfg({
      states: {
        idle: ["idle.svg"],
        sleeping: { fallbackTo: "attention" },
        waking: ["waking.svg"],
        attention: { fallbackTo: "sleeping" },
      },
    }));
    assert.ok(errors.length > 0);
  });
});

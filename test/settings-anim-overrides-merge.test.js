"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_POSTER_CACHE_MAX,
  isValidAnimationPreviewPosterPayload,
  rememberAnimationPreviewPoster,
  mergePosterCacheIntoAnimationData,
  applyAnimationPosterPayload,
  getAssetPreviewUrl,
  getCardPreviewUrl,
} = require("../src/settings-anim-overrides-merge");

function validPayload(overrides = {}) {
  return {
    themeId: "clawd",
    filename: "idle.svg",
    previewImageUrl: "https://example.com/preview.png",
    previewPosterCacheKey: "cache-key-1",
    ...overrides,
  };
}

// ── isValidAnimationPreviewPosterPayload ────────────────────────────

describe("isValidAnimationPreviewPosterPayload", () => {
  it("accepts valid payload", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(validPayload()), true); });
  it("rejects null", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(null), false); });
  it("rejects non-object", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload("bad"), false); });
  it("rejects array", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload([]), false); });
  it("rejects missing themeId", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(validPayload({ themeId: "" })), false); });
  it("rejects non-string themeId", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(validPayload({ themeId: 42 })), false); });
  it("rejects missing filename", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(validPayload({ filename: "" })), false); });
  it("rejects missing previewImageUrl", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(validPayload({ previewImageUrl: "" })), false); });
  it("rejects missing previewPosterCacheKey", () => { assert.strictEqual(isValidAnimationPreviewPosterPayload(validPayload({ previewPosterCacheKey: "" })), false); });
});

// ── rememberAnimationPreviewPoster ──────────────────────────────────

describe("rememberAnimationPreviewPoster", () => {
  it("stores payload in cache", () => {
    const cache = new Map();
    const result = rememberAnimationPreviewPoster(cache, validPayload());
    assert.strictEqual(result, true);
    assert.strictEqual(cache.size, 1);
  });

  it("returns false for invalid payload", () => {
    const cache = new Map();
    assert.strictEqual(rememberAnimationPreviewPoster(cache, null), false);
    assert.strictEqual(cache.size, 0);
  });

  it("returns false for non-Map cache", () => {
    assert.strictEqual(rememberAnimationPreviewPoster({}, validPayload()), false);
  });

  it("moves existing key to end (LRU)", () => {
    const cache = new Map();
    rememberAnimationPreviewPoster(cache, validPayload({ previewPosterCacheKey: "k1" }));
    rememberAnimationPreviewPoster(cache, validPayload({ previewPosterCacheKey: "k2" }));
    rememberAnimationPreviewPoster(cache, validPayload({ previewPosterCacheKey: "k1" }));
    const keys = [...cache.keys()];
    assert.strictEqual(keys[0], "k2");
    assert.strictEqual(keys[1], "k1");
  });

  it("evicts oldest when over maxEntries", () => {
    const cache = new Map();
    rememberAnimationPreviewPoster(cache, validPayload({ previewPosterCacheKey: "k1" }), 2);
    rememberAnimationPreviewPoster(cache, validPayload({ previewPosterCacheKey: "k2" }), 2);
    rememberAnimationPreviewPoster(cache, validPayload({ previewPosterCacheKey: "k3" }), 2);
    assert.strictEqual(cache.size, 2);
    assert.strictEqual(cache.has("k1"), false);
    assert.strictEqual(cache.has("k3"), true);
  });

  it("stores correct data fields", () => {
    const cache = new Map();
    rememberAnimationPreviewPoster(cache, validPayload());
    const entry = cache.get("cache-key-1");
    assert.strictEqual(entry.themeId, "clawd");
    assert.strictEqual(entry.filename, "idle.svg");
    assert.strictEqual(entry.previewImageUrl, "https://example.com/preview.png");
  });
});

// ── getAssetPreviewUrl ──────────────────────────────────────────────

describe("getAssetPreviewUrl", () => {
  it("returns null for null asset", () => { assert.strictEqual(getAssetPreviewUrl(null), null); });
  it("returns previewImageUrl if present", () => {
    assert.strictEqual(getAssetPreviewUrl({ previewImageUrl: "https://example.com/a.png" }), "https://example.com/a.png");
  });
  it("returns fileUrl when no preview and not needsScriptedPreviewPoster", () => {
    assert.strictEqual(getAssetPreviewUrl({ fileUrl: "file:///a.svg" }), "file:///a.svg");
  });
  it("returns null when needsScriptedPreviewPoster is true", () => {
    assert.strictEqual(getAssetPreviewUrl({ needsScriptedPreviewPoster: true, fileUrl: "file:///a.svg" }), null);
  });
  it("returns null when no URLs at all", () => { assert.strictEqual(getAssetPreviewUrl({}), null); });
});

// ── getCardPreviewUrl ───────────────────────────────────────────────

describe("getCardPreviewUrl", () => {
  it("returns null for null card", () => { assert.strictEqual(getCardPreviewUrl(null), null); });
  it("returns currentFilePreviewUrl if present", () => {
    assert.strictEqual(getCardPreviewUrl({ currentFilePreviewUrl: "https://example.com/p.png" }), "https://example.com/p.png");
  });
  it("returns null when previewPosterPending", () => {
    assert.strictEqual(getCardPreviewUrl({ previewPosterPending: true, currentFileUrl: "file:///a.svg" }), null);
  });
  it("returns null when needsScriptedPreviewPoster", () => {
    assert.strictEqual(getCardPreviewUrl({ needsScriptedPreviewPoster: true }), null);
  });
  it("returns currentFileUrl when no preview and not pending", () => {
    assert.strictEqual(getCardPreviewUrl({ currentFileUrl: "file:///a.svg" }), "file:///a.svg");
  });
  it("returns null when no URLs", () => { assert.strictEqual(getCardPreviewUrl({}), null); });
});

// ── mergePosterCacheIntoAnimationData ───────────────────────────────

describe("mergePosterCacheIntoAnimationData", () => {
  it("returns data unchanged when no themeId", () => {
    const data = { assets: [] };
    assert.deepStrictEqual(mergePosterCacheIntoAnimationData(data, new Map()), data);
  });

  it("returns data unchanged for non-Map cache", () => {
    const data = { theme: { id: "clawd" }, assets: [] };
    assert.deepStrictEqual(mergePosterCacheIntoAnimationData(data, {}), data);
  });

  it("patches assets with cached poster", () => {
    const cache = new Map();
    cache.set("ck1", { themeId: "clawd", filename: "idle.svg", previewImageUrl: "https://example.com/idle.png" });
    const data = { theme: { id: "clawd" }, assets: [{ name: "idle.svg", previewPosterCacheKey: "ck1", previewPosterPending: true }] };
    mergePosterCacheIntoAnimationData(data, cache);
    assert.strictEqual(data.assets[0].previewImageUrl, "https://example.com/idle.png");
    assert.strictEqual(data.assets[0].previewPosterPending, false);
  });

  it("patches section cards with cached poster", () => {
    const cache = new Map();
    cache.set("ck1", { themeId: "clawd", filename: "walk.svg", previewImageUrl: "https://example.com/walk.png" });
    const data = {
      theme: { id: "clawd" },
      sections: [{ cards: [{ currentFile: "walk.svg", currentFilePreviewPosterCacheKey: "ck1", previewPosterPending: true }] }],
    };
    mergePosterCacheIntoAnimationData(data, cache);
    assert.strictEqual(data.sections[0].cards[0].currentFilePreviewUrl, "https://example.com/walk.png");
    assert.strictEqual(data.sections[0].cards[0].previewPosterPending, false);
  });

  it("patches top-level cards array", () => {
    const cache = new Map();
    cache.set("ck1", { themeId: "clawd", filename: "run.svg", previewImageUrl: "https://example.com/run.png" });
    const data = { theme: { id: "clawd" }, cards: [{ currentFile: "run.svg", currentFilePreviewPosterCacheKey: "ck1" }] };
    mergePosterCacheIntoAnimationData(data, cache);
    assert.strictEqual(data.cards[0].currentFilePreviewUrl, "https://example.com/run.png");
  });
});

// ── applyAnimationPosterPayload ─────────────────────────────────────

describe("applyAnimationPosterPayload", () => {
  it("returns invalid for bad payload", () => {
    const runtime = {};
    const result = applyAnimationPosterPayload(runtime, null);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.stored, false);
    assert.strictEqual(result.applied, false);
  });

  it("stores in cache when no animation data", () => {
    const runtime = {};
    const result = applyAnimationPosterPayload(runtime, validPayload());
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.stored, true);
    assert.strictEqual(result.applied, false);
    assert.ok(runtime.animationPreviewPosterCache instanceof Map);
  });

  it("returns applied=false when themeId mismatch", () => {
    const runtime = { animationOverridesData: { theme: { id: "other" } } };
    const result = applyAnimationPosterPayload(runtime, validPayload());
    assert.strictEqual(result.applied, false);
  });

  it("patches matching asset", () => {
    const runtime = {
      animationOverridesData: {
        theme: { id: "clawd" },
        assets: [{ name: "idle.svg", previewPosterCacheKey: "cache-key-1", previewPosterPending: true }],
      },
    };
    const result = applyAnimationPosterPayload(runtime, validPayload());
    assert.strictEqual(result.applied, true);
    assert.strictEqual(runtime.animationOverridesData.assets[0].previewImageUrl, "https://example.com/preview.png");
    assert.strictEqual(runtime.animationOverridesData.assets[0].previewPosterPending, false);
  });

  it("patches matching section card", () => {
    const runtime = {
      animationOverridesData: {
        theme: { id: "clawd" },
        sections: [{ cards: [{ currentFile: "idle.svg", currentFilePreviewPosterCacheKey: "cache-key-1", previewPosterPending: true }] }],
      },
    };
    const result = applyAnimationPosterPayload(runtime, validPayload());
    assert.strictEqual(result.applied, true);
    assert.strictEqual(runtime.animationOverridesData.sections[0].cards[0].currentFilePreviewUrl, "https://example.com/preview.png");
  });

  it("calls warn for invalid payload when provided", () => {
    const warnings = [];
    applyAnimationPosterPayload({}, null, { warn: (msg) => warnings.push(msg) });
    assert.strictEqual(warnings.length, 1);
  });
});

// ── DEFAULT_POSTER_CACHE_MAX ────────────────────────────────────────

describe("DEFAULT_POSTER_CACHE_MAX", () => {
  it("is 192", () => { assert.strictEqual(DEFAULT_POSTER_CACHE_MAX, 192); });
});

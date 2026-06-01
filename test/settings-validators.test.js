"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  requireBoolean,
  requireFiniteNumber,
  requireNonNegativeFiniteNumber,
  requireNumberInRange,
  requireIntegerInRange,
  requireEnum,
  requireString,
  requirePlainObject,
} = require("../src/settings-validators");

// ── Exports surface ─────────────────────────────────────────────────

describe("settings validators exports", () => {
  it("exposes all 8 factory functions", () => {
    assert.strictEqual(typeof requireBoolean, "function");
    assert.strictEqual(typeof requireFiniteNumber, "function");
    assert.strictEqual(typeof requireNonNegativeFiniteNumber, "function");
    assert.strictEqual(typeof requireNumberInRange, "function");
    assert.strictEqual(typeof requireIntegerInRange, "function");
    assert.strictEqual(typeof requireEnum, "function");
    assert.strictEqual(typeof requireString, "function");
    assert.strictEqual(typeof requirePlainObject, "function");
  });
});

// ── requireBoolean ──────────────────────────────────────────────────

describe("requireBoolean", () => {
  const v = requireBoolean("flag");

  it("accepts true", () => { assert.strictEqual(v(true).status, "ok"); });
  it("accepts false", () => { assert.strictEqual(v(false).status, "ok"); });
  it("rejects 0", () => { assert.strictEqual(v(0).status, "error"); });
  it("rejects 1", () => { assert.strictEqual(v(1).status, "error"); });
  it("rejects string 'true'", () => { assert.strictEqual(v("true").status, "error"); });
  it("rejects string 'false'", () => { assert.strictEqual(v("false").status, "error"); });
  it("rejects empty string", () => { assert.strictEqual(v("").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("rejects undefined", () => { assert.strictEqual(v(undefined).status, "error"); });
  it("rejects object", () => { assert.strictEqual(v({}).status, "error"); });
  it("rejects array", () => { assert.strictEqual(v([]).status, "error"); });
  it("error message includes key", () => { assert.ok(v("bad").message.includes("flag")); });
});

// ── requireFiniteNumber ─────────────────────────────────────────────

describe("requireFiniteNumber", () => {
  const v = requireFiniteNumber("count");

  it("accepts 0", () => { assert.strictEqual(v(0).status, "ok"); });
  it("accepts positive integer", () => { assert.strictEqual(v(42).status, "ok"); });
  it("accepts negative", () => { assert.strictEqual(v(-1).status, "ok"); });
  it("accepts float", () => { assert.strictEqual(v(3.14).status, "ok"); });
  it("accepts large number", () => { assert.strictEqual(v(1e15).status, "ok"); });
  it("rejects NaN", () => { assert.strictEqual(v(NaN).status, "error"); });
  it("rejects Infinity", () => { assert.strictEqual(v(Infinity).status, "error"); });
  it("rejects -Infinity", () => { assert.strictEqual(v(-Infinity).status, "error"); });
  it("rejects numeric string", () => { assert.strictEqual(v("42").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("rejects undefined", () => { assert.strictEqual(v(undefined).status, "error"); });
  it("rejects boolean true", () => { assert.strictEqual(v(true).status, "error"); });
  it("rejects boolean false", () => { assert.strictEqual(v(false).status, "error"); });
  it("rejects object", () => { assert.strictEqual(v({}).status, "error"); });
  it("rejects array", () => { assert.strictEqual(v([]).status, "error"); });
});

// ── requireNonNegativeFiniteNumber ──────────────────────────────────

describe("requireNonNegativeFiniteNumber", () => {
  const v = requireNonNegativeFiniteNumber("size");

  it("accepts 0", () => { assert.strictEqual(v(0).status, "ok"); });
  it("accepts positive", () => { assert.strictEqual(v(100).status, "ok"); });
  it("accepts positive float", () => { assert.strictEqual(v(0.5).status, "ok"); });
  it("rejects negative", () => { assert.strictEqual(v(-1).status, "error"); });
  it("rejects -0.001", () => { assert.strictEqual(v(-0.001).status, "error"); });
  it("rejects NaN", () => { assert.strictEqual(v(NaN).status, "error"); });
  it("rejects Infinity", () => { assert.strictEqual(v(Infinity).status, "error"); });
  it("rejects string", () => { assert.strictEqual(v("10").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("error message includes key", () => { assert.ok(v(-1).message.includes("size")); });
});

// ── requireNumberInRange ────────────────────────────────────────────

describe("requireNumberInRange", () => {
  const v = requireNumberInRange("opacity", 0, 1);

  it("accepts min boundary", () => { assert.strictEqual(v(0).status, "ok"); });
  it("accepts max boundary", () => { assert.strictEqual(v(1).status, "ok"); });
  it("accepts mid value", () => { assert.strictEqual(v(0.5).status, "ok"); });
  it("rejects below min", () => { assert.strictEqual(v(-0.01).status, "error"); });
  it("rejects above max", () => { assert.strictEqual(v(1.01).status, "error"); });
  it("rejects NaN", () => { assert.strictEqual(v(NaN).status, "error"); });
  it("rejects Infinity", () => { assert.strictEqual(v(Infinity).status, "error"); });
  it("rejects string", () => { assert.strictEqual(v("0.5").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("works with negative range", () => {
    const v2 = requireNumberInRange("temp", -40, 100);
    assert.strictEqual(v2(-40).status, "ok");
    assert.strictEqual(v2(100).status, "ok");
    assert.strictEqual(v2(-41).status, "error");
    assert.strictEqual(v2(101).status, "error");
  });
});

// ── requireIntegerInRange ───────────────────────────────────────────

describe("requireIntegerInRange", () => {
  const v = requireIntegerInRange("port", 1, 65535);

  it("accepts min boundary", () => { assert.strictEqual(v(1).status, "ok"); });
  it("accepts max boundary", () => { assert.strictEqual(v(65535).status, "ok"); });
  it("accepts mid value", () => { assert.strictEqual(v(8080).status, "ok"); });
  it("rejects below min", () => { assert.strictEqual(v(0).status, "error"); });
  it("rejects above max", () => { assert.strictEqual(v(65536).status, "error"); });
  it("rejects float", () => { assert.strictEqual(v(8080.5).status, "error"); });
  it("rejects NaN", () => { assert.strictEqual(v(NaN).status, "error"); });
  it("rejects Infinity", () => { assert.strictEqual(v(Infinity).status, "error"); });
  it("rejects string", () => { assert.strictEqual(v("8080").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("works with 0-100 range", () => {
    const v2 = requireIntegerInRange("percent", 0, 100);
    assert.strictEqual(v2(0).status, "ok");
    assert.strictEqual(v2(100).status, "ok");
    assert.strictEqual(v2(50).status, "ok");
    assert.strictEqual(v2(-1).status, "error");
    assert.strictEqual(v2(101).status, "error");
  });
});

// ── requireEnum ─────────────────────────────────────────────────────

describe("requireEnum", () => {
  const v = requireEnum("lang", ["en", "zh", "ko", "ja"]);

  it("accepts en", () => { assert.strictEqual(v("en").status, "ok"); });
  it("accepts zh", () => { assert.strictEqual(v("zh").status, "ok"); });
  it("accepts ko", () => { assert.strictEqual(v("ko").status, "ok"); });
  it("accepts ja", () => { assert.strictEqual(v("ja").status, "ok"); });
  it("rejects unknown value", () => { assert.strictEqual(v("fr").status, "error"); });
  it("rejects empty string", () => { assert.strictEqual(v("").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("rejects undefined", () => { assert.strictEqual(v(undefined).status, "error"); });
  it("rejects number", () => { assert.strictEqual(v(0).status, "error"); });
  it("rejects boolean", () => { assert.strictEqual(v(true).status, "error"); });
  it("error message includes key", () => { assert.ok(v("fr").message.includes("lang")); });
  it("works with single-value enum", () => {
    const v2 = requireEnum("mode", ["auto"]);
    assert.strictEqual(v2("auto").status, "ok");
    assert.strictEqual(v2("manual").status, "error");
  });
});

// ── requireString ───────────────────────────────────────────────────

describe("requireString", () => {
  const v = requireString("name");

  it("accepts non-empty string", () => { assert.strictEqual(v("hello").status, "ok"); });
  it("accepts whitespace-only", () => { assert.strictEqual(v("  ").status, "ok"); });
  it("accepts single char", () => { assert.strictEqual(v("x").status, "ok"); });
  it("rejects empty string", () => { assert.strictEqual(v("").status, "error"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("rejects undefined", () => { assert.strictEqual(v(undefined).status, "error"); });
  it("rejects number", () => { assert.strictEqual(v(42).status, "error"); });
  it("rejects boolean", () => { assert.strictEqual(v(true).status, "error"); });
  it("rejects object", () => { assert.strictEqual(v({}).status, "error"); });
  it("rejects array", () => { assert.strictEqual(v([]).status, "error"); });
  it("error message includes key", () => { assert.ok(v("").message.includes("name")); });
});

describe("requireString with allowEmpty", () => {
  const v = requireString("title", { allowEmpty: true });

  it("accepts non-empty string", () => { assert.strictEqual(v("hello").status, "ok"); });
  it("accepts empty string", () => { assert.strictEqual(v("").status, "ok"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("rejects number", () => { assert.strictEqual(v(42).status, "error"); });
  it("rejects undefined", () => { assert.strictEqual(v(undefined).status, "error"); });
});

// ── requirePlainObject ──────────────────────────────────────────────

describe("requirePlainObject", () => {
  const v = requirePlainObject("config");

  it("accepts empty object", () => { assert.strictEqual(v({}).status, "ok"); });
  it("accepts object with properties", () => { assert.strictEqual(v({ a: 1, b: "x" }).status, "ok"); });
  it("rejects null", () => { assert.strictEqual(v(null).status, "error"); });
  it("rejects undefined", () => { assert.strictEqual(v(undefined).status, "error"); });
  it("rejects array", () => { assert.strictEqual(v([]).status, "error"); });
  it("rejects string", () => { assert.strictEqual(v("abc").status, "error"); });
  it("rejects number", () => { assert.strictEqual(v(42).status, "error"); });
  it("rejects boolean", () => { assert.strictEqual(v(true).status, "error"); });
  it("error message includes key", () => { assert.ok(v(null).message.includes("config")); });
  it("accepts nested objects", () => { assert.strictEqual(v({ a: { b: { c: 1 } } }).status, "ok"); });
});

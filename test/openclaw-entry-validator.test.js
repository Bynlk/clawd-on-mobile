"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { validateOpenClawEntry } = require("../src/doctor-detectors/openclaw-entry-validator");

// ── helpers ─────────────────────────────────────────────────────────

function makeFakeFs({ files = {}, directories = new Set(), statThrows = new Set() } = {}) {
  return {
    statSync(entry) {
      if (statThrows.has(entry)) throw new Error("ENOENT");
      if (directories.has(entry)) return { isDirectory: () => true };
      return { isDirectory: () => false };
    },
    existsSync(entry) {
      return files[entry] !== undefined || directories.has(entry);
    },
    readFileSync(entry) {
      if (files[entry] === undefined) throw new Error("ENOENT");
      return files[entry];
    },
  };
}

// ── validateOpenClawEntry ───────────────────────────────────────────

describe("validateOpenClawEntry", () => {
  it("rejects non-string entries with not-absolute", () => {
    assert.deepStrictEqual(validateOpenClawEntry(null), { ok: false, reason: "not-absolute" });
    assert.deepStrictEqual(validateOpenClawEntry(undefined), { ok: false, reason: "not-absolute" });
    assert.deepStrictEqual(validateOpenClawEntry(42), { ok: false, reason: "not-absolute" });
    assert.deepStrictEqual(validateOpenClawEntry(""), { ok: false, reason: "not-absolute" });
    assert.deepStrictEqual(validateOpenClawEntry({}), { ok: false, reason: "not-absolute" });
  });

  it("rejects relative paths with not-absolute", () => {
    assert.deepStrictEqual(validateOpenClawEntry("relative/path"), { ok: false, reason: "not-absolute" });
    assert.deepStrictEqual(validateOpenClawEntry("./some/path"), { ok: false, reason: "not-absolute" });
    assert.deepStrictEqual(validateOpenClawEntry("../parent"), { ok: false, reason: "not-absolute" });
  });

  it("accepts POSIX absolute paths as absolute", () => {
    const fs = makeFakeFs({ statThrows: new Set(["/some/path"]) });
    const result = validateOpenClawEntry("/some/path", { fs });
    // It fails at stat (directory-missing) because stat throws, but it passed the absolute check
    assert.deepStrictEqual(result, { ok: false, reason: "directory-missing" });
  });

  it("accepts Windows absolute paths as absolute", () => {
    const fs = makeFakeFs({ statThrows: new Set(["C:\\some\\path"]) });
    const result = validateOpenClawEntry("C:\\some\\path", { fs });
    assert.deepStrictEqual(result, { ok: false, reason: "directory-missing" });
  });

  it("returns directory-missing when statSync throws", () => {
    const absPath = "/missing/dir";
    const fs = makeFakeFs({ statThrows: new Set([absPath]) });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "directory-missing",
    });
  });

  it("returns not-a-directory when stat returns nullish", () => {
    const absPath = "/nullish/stat";
    const fs = {
      statSync() { return null; },
      existsSync() { return false; },
    };
    // !stat is true so the condition short-circuits to "not-a-directory"
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "not-a-directory",
    });
  });

  it("returns not-a-directory when stat says it is a file", () => {
    const absPath = "/file/not/dir";
    const fs = makeFakeFs({ directories: new Set() });
    // statSync returns isDirectory: () => false by default
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "not-a-directory",
    });
  });

  it("returns not-a-directory when isDirectory is not a function", () => {
    const absPath = "/weird/stat";
    const fs = {
      statSync() { return { /* no isDirectory */ }; },
      existsSync() { return false; },
    };
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "not-a-directory",
    });
  });

  it("returns index-js-missing when index.js is absent", () => {
    const absPath = "/plugin/dir";
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {},
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "index-js-missing",
    });
  });

  it("returns manifest-missing when openclaw.plugin.json is absent", () => {
    const absPath = "/plugin/dir";
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: { [path.join(absPath, "index.js")]: "// noop" },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-missing",
    });
  });

  it("returns manifest-corrupt when manifest JSON is invalid", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: "{{not valid json",
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-corrupt",
    });
  });

  it("returns manifest-corrupt when readFileSync throws for the manifest", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    // existsSync returns true but readFileSync throws
    const fs = {
      statSync(entry) {
        if (entry === absPath) return { isDirectory: () => true };
        return { isDirectory: () => false };
      },
      existsSync(entry) {
        return entry === absPath || entry === path.join(absPath, "index.js") || entry === manifestPath;
      },
      readFileSync(entry) {
        if (entry === manifestPath) throw new Error("read error");
        return "// noop";
      },
    };
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-corrupt",
    });
  });

  it("returns manifest-id-mismatch when id is wrong", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({ id: "wrong-id" }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-id-mismatch",
    });
  });

  it("returns manifest-id-mismatch when manifest is null (parsed from 'null')", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: "null",
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-id-mismatch",
    });
  });

  it("returns manifest-missing-on-startup when activation.onStartup is not true", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({
          id: "clawd-on-mobile",
          activation: { onStartup: false },
        }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-missing-on-startup",
    });
  });

  it("returns manifest-missing-on-startup when activation is missing", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({ id: "clawd-on-mobile" }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-missing-on-startup",
    });
  });

  it("returns manifest-missing-config-schema when configSchema is absent", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({
          id: "clawd-on-mobile",
          activation: { onStartup: true },
        }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-missing-config-schema",
    });
  });

  it("returns manifest-missing-config-schema when configSchema.type is not 'object'", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({
          id: "clawd-on-mobile",
          activation: { onStartup: true },
          configSchema: { type: "string" },
        }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), {
      ok: false,
      reason: "manifest-missing-config-schema",
    });
  });

  it("returns ok: true for a valid plugin directory", () => {
    const absPath = "/plugin/dir";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({
          id: "clawd-on-mobile",
          activation: { onStartup: true },
          configSchema: { type: "object" },
        }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), { ok: true });
  });

  it("accepts Windows-style absolute paths", () => {
    const absPath = "C:\\Users\\test\\.openclaw\\plugins\\clawd";
    const manifestPath = path.join(absPath, "openclaw.plugin.json");
    const fs = makeFakeFs({
      directories: new Set([absPath]),
      files: {
        [path.join(absPath, "index.js")]: "// noop",
        [manifestPath]: JSON.stringify({
          id: "clawd-on-mobile",
          activation: { onStartup: true },
          configSchema: { type: "object" },
        }),
      },
    });
    assert.deepStrictEqual(validateOpenClawEntry(absPath, { fs }), { ok: true });
  });
});

"use strict";

const assert = require("node:assert");
const path = require("node:path");
const test = require("node:test");

const ensure = require("../scripts/ensure-sidecar-binaries");

const {
  runtimePlatformName,
  truthyEnv,
  isExistingFile,
  runtimeExecutableName,
  resolveOverridePath,
  sidecarFetchCommand,
  parseArgs,
  ENSURE_COMMAND,
  SKIP_ENV,
  OVERRIDE_ENV,
  DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS,
} = ensure;

function makeStream() {
  let text = "";
  return {
    write(chunk) {
      text += String(chunk);
    },
    text() {
      return text;
    },
  };
}

test("runtimeSidecarTarget maps supported runtime platforms to pinned sidecar targets", () => {
  assert.equal(ensure.runtimeSidecarTarget({ platform: "win32", arch: "x64" }).dir, "windows-x64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "darwin", arch: "arm64" }).dir, "darwin-arm64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "linux", arch: "x64" }).dir, "linux-x64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "linux", arch: "arm64" }), null);
});

test("ensureCurrentPlatformSidecar skips when the current binary already exists", async () => {
  const calls = [];
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    fs: {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
    },
    fetchSidecarBinaries: () => {
      calls.push("fetch");
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.existing, true);
  assert.equal(result.target, "windows-x64");
  assert.deepEqual(calls, []);
});

test("ensureCurrentPlatformSidecar fetches only the current platform target when missing", async () => {
  const fetchCalls = [];
  const stdout = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    stdout,
    fs: {
      existsSync: () => false,
    },
    fetchSidecarBinaries: async (options) => {
      fetchCalls.push(options);
      return { ok: true, installed: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.fetched, true);
  assert.equal(result.target, "windows-x64");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].target, "windows-x64");
  assert.equal(fetchCalls[0].rootDir, "D:\\repo");
  assert.equal(fetchCalls[0].requestTimeoutMs, ensure.DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS);
  assert.match(stdout.text(), /fetching pinned binary/);
});

test("ensureCurrentPlatformSidecar reports fetch failures without throwing", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "darwin",
    arch: "arm64",
    rootDir: "/repo",
    env: {},
    stdout: makeStream(),
    stderr,
    fs: {
      existsSync: () => false,
    },
    fetchSidecarBinaries: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.command, "npm run fetch:sidecars -- --target darwin-arm64");
  assert.match(stderr.text(), /could not be fetched automatically/);
  assert.match(stderr.text(), /npm run fetch:sidecars -- --target darwin-arm64/);
  assert.match(stderr.text(), /Set CLAWD_SKIP_SIDECAR_FETCH=1 before running npm start/);
});

test("ensureCurrentPlatformSidecar honors skip and valid override env vars", async () => {
  const fetchSidecarBinaries = () => {
    throw new Error("should not fetch");
  };
  assert.deepEqual(await ensure.ensureCurrentPlatformSidecar({
    env: { CLAWD_SKIP_SIDECAR_FETCH: "1" },
    fetchSidecarBinaries,
  }), { ok: true, skipped: true, reason: "env-skip" });
  const overrideDir = path.join("D:\\tools", "sidecar");
  const overrideExe = path.join(overrideDir, "cc-connect-clawd.exe");
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: overrideDir },
    fs: {
      existsSync: (filePath) => filePath === overrideExe,
      statSync: (filePath) => {
        if (filePath === overrideDir) return { isDirectory: () => true, isFile: () => false };
        if (filePath === overrideExe) return { isDirectory: () => false, isFile: () => true };
        throw new Error(`unexpected path: ${filePath}`);
      },
    },
    fetchSidecarBinaries,
  });
  assert.deepEqual(result, { ok: true, skipped: true, reason: "override-path", path: overrideExe });
});

test("ensureCurrentPlatformSidecar reports a missing override path without fetching", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: "/tmp/missing-sidecar" },
    stderr,
    fs: {
      existsSync: () => false,
      statSync: () => {
        throw new Error("missing");
      },
    },
    fetchSidecarBinaries: () => {
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "override-path-missing");
  assert.match(result.path, /missing-sidecar/);
  assert.match(stderr.text(), /CLAWD_CC_CONNECT_CLAWD_PATH is set but no sidecar executable was found/);
  assert.match(stderr.text(), /Clawd will still launch/);
});

test("ensureCurrentPlatformSidecar reports strict override failures accurately", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    strict: true,
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: "/tmp/missing-sidecar" },
    stderr,
    fs: {
      existsSync: () => false,
      statSync: () => {
        throw new Error("missing");
      },
    },
    fetchSidecarBinaries: () => {
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, false);
  assert.match(stderr.text(), /Strict mode will stop launch/);
});

test("resolveOverridePath appends the runtime executable for directory-like values", () => {
  assert.equal(
    ensure.resolveOverridePath("D:\\tools\\sidecar\\", { platform: "win32", fs: { statSync: () => { throw new Error("skip"); } } }),
    path.join("D:\\tools\\sidecar\\", "cc-connect-clawd.exe")
  );
});

test("sidecarFetchCommand gives the manual recovery command", () => {
  assert.equal(
    ensure.sidecarFetchCommand("windows-x64"),
    "npm run fetch:sidecars -- --target windows-x64"
  );
});

test("runtimePlatformName maps known platforms and returns empty for unknown", () => {
  assert.equal(runtimePlatformName("win32"), "windows");
  assert.equal(runtimePlatformName("darwin"), "darwin");
  assert.equal(runtimePlatformName("linux"), "linux");
  assert.equal(runtimePlatformName("freebsd"), "");
  assert.equal(runtimePlatformName(""), "");
  // default uses process.platform
  const expected = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  assert.equal(runtimePlatformName(), expected);
});

test("runtimeExecutableName returns platform-specific executable name", () => {
  assert.equal(runtimeExecutableName("win32"), "cc-connect-clawd.exe");
  assert.equal(runtimeExecutableName("darwin"), "cc-connect-clawd");
  assert.equal(runtimeExecutableName("linux"), "cc-connect-clawd");
});

test("truthyEnv handles various value types", () => {
  assert.equal(truthyEnv("1"), true);
  assert.equal(truthyEnv("true"), true);
  assert.equal(truthyEnv("yes"), true);
  assert.equal(truthyEnv("TRUE"), true);
  assert.equal(truthyEnv("Yes"), true);
  assert.equal(truthyEnv("0"), false);
  assert.equal(truthyEnv("false"), false);
  assert.equal(truthyEnv("no"), false);
  assert.equal(truthyEnv(""), false);
  assert.equal(truthyEnv(null), false);
  assert.equal(truthyEnv(undefined), false);
  assert.equal(truthyEnv("  "), false);
  assert.equal(truthyEnv("  true  "), true);
});

test("isExistingFile handles various filesystem states", () => {
  // Existing file
  assert.equal(
    isExistingFile(
      { existsSync: () => true, statSync: () => ({ isFile: () => true }) },
      "/path/to/file"
    ),
    true
  );

  // Non-existing path
  assert.equal(
    isExistingFile(
      { existsSync: () => false },
      "/path/to/missing"
    ),
    false
  );

  // Directory instead of file
  assert.equal(
    isExistingFile(
      { existsSync: () => true, statSync: () => ({ isFile: () => false }) },
      "/path/to/dir"
    ),
    false
  );

  // statSync throws
  assert.equal(
    isExistingFile(
      { existsSync: () => true, statSync: () => { throw new Error("perm"); } },
      "/path/to/file"
    ),
    false
  );

  // statSync returns null (no stat function)
  assert.equal(
    isExistingFile(
      { existsSync: () => true },
      "/path/to/file"
    ),
    true
  );
});

test("resolveOverridePath returns empty string for empty input", () => {
  assert.equal(resolveOverridePath(""), "");
  assert.equal(resolveOverridePath(null), "");
  assert.equal(resolveOverridePath(undefined), "");
});

test("resolveOverridePath returns path as-is when it is a file", () => {
  const result = resolveOverridePath("/path/to/cc-connect-clawd", {
    platform: "linux",
    fs: {
      statSync: () => ({ isDirectory: () => false, isFile: () => true }),
    },
  });
  assert.equal(result, "/path/to/cc-connect-clawd");
});

test("resolveOverridePath appends executable for directory stat", () => {
  const result = resolveOverridePath("/opt/sidecar", {
    platform: "linux",
    fs: {
      statSync: () => ({ isDirectory: () => true, isFile: () => false }),
    },
  });
  assert.equal(result, path.join("/opt/sidecar", "cc-connect-clawd"));
});

test("resolveOverridePath appends executable when path ends with separator", () => {
  const result = resolveOverridePath("/opt/sidecar/", {
    platform: "darwin",
    fs: {
      statSync: () => { throw new Error("skip"); },
    },
  });
  assert.equal(result, path.join("/opt/sidecar/", "cc-connect-clawd"));
});

test("resolveOverridePath appends .exe on win32 for trailing separator", () => {
  const result = resolveOverridePath("C:\\tools\\", {
    platform: "win32",
    fs: {
      statSync: () => { throw new Error("skip"); },
    },
  });
  assert.equal(result, path.join("C:\\tools\\", "cc-connect-clawd.exe"));
});

test("parseArgs parses valid flags", () => {
  assert.deepEqual(parseArgs([]), { strict: false, dryRun: false });
  assert.deepEqual(parseArgs(["--strict"]), { strict: true, dryRun: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { strict: false, dryRun: true });
  assert.deepEqual(parseArgs(["--strict", "--dry-run"]), { strict: true, dryRun: true });
  assert.deepEqual(parseArgs(["--help"]), { strict: false, dryRun: false, help: true });
  assert.deepEqual(parseArgs(["-h"]), { strict: false, dryRun: false, help: true });
});

test("parseArgs throws on unknown arguments", () => {
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--verbose"]), /Unknown argument/);
});

test("exports expected constants", () => {
  assert.equal(ENSURE_COMMAND, "node scripts/ensure-sidecar-binaries.js");
  assert.equal(SKIP_ENV, "CLAWD_SKIP_SIDECAR_FETCH");
  assert.equal(OVERRIDE_ENV, "CLAWD_CC_CONNECT_CLAWD_PATH");
  assert.equal(DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS, 30000);
});

test("ensureCurrentPlatformSidecar returns unsupported-runtime for unknown platform", async () => {
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "freebsd",
    arch: "x64",
    env: {},
    fs: { existsSync: () => false },
    fetchSidecarBinaries: () => { throw new Error("should not fetch"); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unsupported-runtime");
  assert.equal(result.platform, "freebsd");
  assert.equal(result.arch, "x64");
});

test("ensureCurrentPlatformSidecar returns missing=true in dry-run mode when binary is absent", async () => {
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    dryRun: true,
    fs: { existsSync: () => false },
    fetchSidecarBinaries: () => { throw new Error("should not fetch"); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
  assert.equal(result.target, "windows-x64");
  assert.ok(result.command.includes("windows-x64"));
});

test("ensureCurrentPlatformSidecar passes requestTimeoutMs to fetch", async () => {
  const fetchCalls = [];
  await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    requestTimeoutMs: 5000,
    stdout: makeStream(),
    fs: { existsSync: () => false },
    fetchSidecarBinaries: async (options) => {
      fetchCalls.push(options);
      return { ok: true, installed: [] };
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].requestTimeoutMs, 5000);
});

test("ensureCurrentPlatformSidecar passes fs module to fetch", async () => {
  const fetchCalls = [];
  const fakeFs = { existsSync: () => false };
  await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    stdout: makeStream(),
    fs: fakeFs,
    fetchSidecarBinaries: async (options) => {
      fetchCalls.push(options);
      return { ok: true, installed: [] };
    },
  });

  assert.equal(fetchCalls[0].fs, fakeFs);
});

test("resolveOverridePath handles backslash-separated paths", () => {
  const result = resolveOverridePath("C:\\Users\\tools\\sidecar", {
    platform: "win32",
    fs: {
      statSync: () => ({ isDirectory: () => true }),
    },
  });
  assert.ok(result.includes("cc-connect-clawd.exe"));
});

test("truthyEnv treats whitespace-only strings as falsy", () => {
  assert.equal(truthyEnv("   "), false);
  assert.equal(truthyEnv("\t"), false);
  assert.equal(truthyEnv("\n"), false);
});

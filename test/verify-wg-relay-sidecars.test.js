"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT, "scripts", "build-wg-relay-sidecar.js");
const VERIFY_SCRIPT = path.join(ROOT, "scripts", "verify-wg-relay-sidecars.js");
const TARGET_NAMES = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];

function loadBuildModule() {
  assert.ok(fs.existsSync(BUILD_SCRIPT), "the WireGuard Relay sidecar build script must exist");
  return require(BUILD_SCRIPT);
}

function loadVerifyModule() {
  assert.ok(fs.existsSync(VERIFY_SCRIPT), "the WireGuard Relay sidecar verifier must exist");
  return require(VERIFY_SCRIPT);
}

function makeTempRoot(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-sidecars-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function writeBinary(rootDir, target, contents = "binary", mode = 0o755) {
  const executable = target.startsWith("win32-") ? "clawd-wg-tunnel.exe" : "clawd-wg-tunnel";
  const filePath = path.join(rootDir, "wg-relay-sidecars", target, executable);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

test("build script exposes the six fixed desktop targets", () => {
  const { TARGETS, selectTargets } = loadBuildModule();
  assert.deepEqual(TARGETS.map((target) => target.name), TARGET_NAMES);
  assert.deepEqual(selectTargets("all").map((target) => target.name), TARGET_NAMES);
  assert.deepEqual(
    selectTargets("darwin-arm64,linux-x64,darwin-arm64").map((target) => target.name),
    ["darwin-arm64", "linux-x64"],
  );
  assert.throws(() => selectTargets("freebsd-x64"), /unsupported.*target/i);
});

test("build commands map fixed targets to Go OS/architecture and output names", () => {
  const { TARGETS, createBuildSpec } = loadBuildModule();
  const expected = {
    "win32-x64": ["windows", "amd64", "clawd-wg-tunnel.exe"],
    "win32-arm64": ["windows", "arm64", "clawd-wg-tunnel.exe"],
    "darwin-x64": ["darwin", "amd64", "clawd-wg-tunnel"],
    "darwin-arm64": ["darwin", "arm64", "clawd-wg-tunnel"],
    "linux-x64": ["linux", "amd64", "clawd-wg-tunnel"],
    "linux-arm64": ["linux", "arm64", "clawd-wg-tunnel"],
  };

  for (const target of TARGETS) {
    const spec = createBuildSpec(target, { rootDir: "/repo" });
    assert.equal(spec.command, "go");
    assert.deepEqual(spec.args, ["build", "-trimpath", "-o", spec.outputPath, "."]);
    assert.equal(spec.cwd, path.join("/repo", "sidecars", "wg-relay-tunnel"));
    assert.equal(spec.env.CGO_ENABLED, "0");
    assert.equal(spec.env.GOOS, expected[target.name][0]);
    assert.equal(spec.env.GOARCH, expected[target.name][1]);
    assert.equal(
      spec.outputPath,
      path.join("/repo", "wg-relay-sidecars", target.name, expected[target.name][2]),
    );
  }
});

test("build runner invokes Go once per selected target and rejects failures", () => {
  const { buildSidecars } = loadBuildModule();
  const rootDir = path.join(os.tmpdir(), "wg-relay-build-contract");
  const calls = [];
  const result = buildSidecars({
    rootDir,
    target: "win32-x64,linux-arm64",
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(result.built.map((item) => item.target), ["win32-x64", "linux-arm64"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.GOOS, "windows");
  assert.equal(calls[1].options.env.GOARCH, "arm64");

  assert.throws(() => buildSidecars({
    rootDir,
    target: "darwin-arm64",
    spawnSync() { return { status: 2 }; },
  }), /go build failed.*darwin-arm64/i);
});

test("verifier reports missing and zero-byte binaries", (t) => {
  const { verifyWgRelaySidecars } = loadVerifyModule();
  const rootDir = makeTempRoot(t);
  writeBinary(rootDir, "linux-x64", "", 0o755);

  const result = verifyWgRelaySidecars({ rootDir, target: "linux-x64,linux-arm64" });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.invalid.map((item) => [item.target, item.reason]),
    [["linux-x64", "empty"], ["linux-arm64", "missing"]],
  );
});

test("verifier requires executable mode for Unix targets", (t) => {
  const { verifyWgRelaySidecars } = loadVerifyModule();
  const rootDir = makeTempRoot(t);
  writeBinary(rootDir, "darwin-arm64", "binary", 0o644);
  writeBinary(rootDir, "win32-arm64", "binary", 0o644);

  const result = verifyWgRelaySidecars({ rootDir, target: "darwin-arm64,win32-arm64" });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.invalid.map((item) => [item.target, item.reason]),
    [["darwin-arm64", "not-executable"]],
  );
});

test("verifier accepts non-empty executable binaries for all six targets", (t) => {
  const { verifyWgRelaySidecars } = loadVerifyModule();
  const rootDir = makeTempRoot(t);
  for (const target of TARGET_NAMES) writeBinary(rootDir, target);

  const result = verifyWgRelaySidecars({ rootDir, target: "all" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checked.map((item) => item.target), TARGET_NAMES);
  assert.deepEqual(result.invalid, []);
});

test("electron-builder beforePack hook verifies exactly its current target", (t) => {
  const verifier = loadVerifyModule();
  const rootDir = makeTempRoot(t);
  writeBinary(rootDir, "darwin-arm64");

  assert.equal(typeof verifier, "function", "verifier module must itself be a beforePack hook");
  assert.doesNotThrow(() => verifier({
    arch: 3,
    electronPlatformName: "darwin",
    packager: { projectDir: rootDir },
  }));
  assert.throws(() => verifier({
    arch: 1,
    electronPlatformName: "darwin",
    packager: { projectDir: rootDir },
  }), /darwin-x64.*missing/i);
});

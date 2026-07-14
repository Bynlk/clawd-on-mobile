"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  VERIFY_COMMAND,
  normalizeLifecycleEvent,
  sidecarBinaryPath,
  getRequiredSidecarsForLifecycle,
  verifySidecarBinaries,
} = require("../scripts/verify-sidecar-binaries");

function fakeFs(existingFiles) {
  const existing = new Set(existingFiles);
  return {
    existsSync(filePath) {
      return existing.has(filePath);
    },
    statSync(filePath) {
      if (!existing.has(filePath)) throw new Error("missing");
      return { isFile: () => true };
    },
  };
}

test("normalizeLifecycleEvent maps npm prebuild hooks to build scripts", () => {
  assert.equal(normalizeLifecycleEvent("prebuild:win:x64"), "build:win:x64");
  assert.equal(normalizeLifecycleEvent("build:linux"), "build:linux");
});

test("getRequiredSidecarsForLifecycle maps configured build targets", () => {
  assert.deepEqual(getRequiredSidecarsForLifecycle("prebuild:win:x64"), [
    { platform: "windows", arch: "x64" },
  ]);
  assert.deepEqual(getRequiredSidecarsForLifecycle("prebuild:mac"), [
    { platform: "darwin", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
  ]);
});

test("sidecarBinaryPath uses resolver-compatible binary names", () => {
  assert.equal(
    sidecarBinaryPath("D:\\repo", "windows", "arm64"),
    path.join("D:\\repo", "bin", "cc-connect-clawd", "windows-arm64", "cc-connect-clawd.exe")
  );
  assert.equal(
    sidecarBinaryPath("/repo", "linux", "x64"),
    path.join("/repo", "bin", "cc-connect-clawd", "linux-x64", "cc-connect-clawd")
  );
});

test("verifySidecarBinaries reports missing binaries for the active build", () => {
  const rootDir = "D:\\repo";
  const result = verifySidecarBinaries({
    rootDir,
    lifecycleEvent: "prebuild:win:arm64",
    fs: fakeFs([]),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [
    {
      platform: "windows",
      arch: "arm64",
      path: path.join(rootDir, "bin", "cc-connect-clawd", "windows-arm64", "cc-connect-clawd.exe"),
    },
  ]);
});

test("verifySidecarBinaries passes when all required files exist", () => {
  const rootDir = "D:\\repo";
  const filePath = sidecarBinaryPath(rootDir, "windows", "x64");
  const result = verifySidecarBinaries({
    rootDir,
    lifecycleEvent: "prebuild:win:x64",
    fs: fakeFs([filePath]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("package build scripts use the sidecar verification command", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["verify:sidecars"], VERIFY_COMMAND);
  const relayTargets = {
    prebuild: "win32-x64,win32-arm64",
    "prebuild:win:x64": "win32-x64",
    "prebuild:win:arm64": "win32-arm64",
    "prebuild:win:all": "win32-x64,win32-arm64",
    "prebuild:mac": "darwin-x64,darwin-arm64",
    "prebuild:linux": "linux-x64",
    "prebuild:all": "win32-x64,win32-arm64,darwin-x64,darwin-arm64,linux-x64,linux-arm64",
  };
  for (const [name, targets] of Object.entries(relayTargets)) {
    assert.equal(
      pkg.scripts[name],
      `${VERIFY_COMMAND} && node scripts/verify-wg-relay-sidecars.js --target ${targets}`,
      `${name} should verify both bundled sidecar families before packaging`,
    );
  }
});

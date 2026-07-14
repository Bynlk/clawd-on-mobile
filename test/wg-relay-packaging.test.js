"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function platformSidecarResource(platform) {
  const resources = pkg.build[platform] && pkg.build[platform].extraResources;
  assert.ok(Array.isArray(resources), `build.${platform}.extraResources must be an array`);
  return resources.find((entry) => entry && String(entry.from || "").startsWith("wg-relay-sidecars/"));
}

test("package exposes WireGuard Relay sidecar build and verify commands", () => {
  assert.equal(pkg.scripts["build:wg-relay-sidecar"], "node scripts/build-wg-relay-sidecar.js");
  assert.equal(pkg.scripts["build:wg-relay-sidecars"], "node scripts/build-wg-relay-sidecar.js");
  assert.equal(pkg.scripts["verify:wg-relay-sidecars"], "node scripts/verify-wg-relay-sidecars.js");
  assert.equal(pkg.build.beforePack, "scripts/verify-wg-relay-sidecars.js");
});

test("every npm Electron build preflights the WireGuard Relay target set", () => {
  const expectations = {
    prebuild: "win32-x64,win32-arm64",
    "prebuild:win:x64": "win32-x64",
    "prebuild:win:arm64": "win32-arm64",
    "prebuild:win:all": "win32-x64,win32-arm64",
    "prebuild:mac": "darwin-x64,darwin-arm64",
    "prebuild:linux": "linux-x64",
    "prebuild:all": "win32-x64,win32-arm64,darwin-x64,darwin-arm64,linux-x64,linux-arm64",
  };

  for (const [scriptName, targets] of Object.entries(expectations)) {
    const command = pkg.scripts[scriptName];
    assert.match(command, /node scripts\/verify-sidecar-binaries\.js/);
    assert.match(command, /node scripts\/verify-wg-relay-sidecars\.js/);
    assert.match(command, new RegExp(`--target ${targets.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  }
});

test("electron-builder copies only the current platform and architecture sidecar", () => {
  const expected = {
    win: ["win32", "clawd-wg-tunnel.exe"],
    mac: ["darwin", "clawd-wg-tunnel"],
    linux: ["linux", "clawd-wg-tunnel"],
  };

  for (const [platform, [runtimePlatform, executable]] of Object.entries(expected)) {
    const resource = platformSidecarResource(platform);
    assert.ok(resource, `build.${platform}.extraResources must include the WG Relay sidecar`);
    assert.equal(resource.from, `wg-relay-sidecars/${runtimePlatform}-\${arch}`);
    assert.equal(resource.to, `sidecars/wg-relay-tunnel/${runtimePlatform}-\${arch}`);
    assert.deepEqual(resource.filter, [executable]);
    assert.doesNotMatch(resource.from, /\*\*|\{x64,arm64\}|wg-relay-sidecars$/);
  }

  const common = pkg.build.extraResources || [];
  assert.equal(
    common.some((entry) => entry && String(entry.from || "").startsWith("wg-relay-sidecars")),
    false,
    "the common resource list must not copy every target",
  );
});

test("desktop CI builds and verifies all six Go targets before packaging", () => {
  const workflow = read(".github/workflows/build.yml");
  for (const target of [
    "win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64",
  ]) {
    assert.match(workflow, new RegExp(`- ${target}(?:\\s|$)`), `CI matrix must include ${target}`);
  }
  assert.match(workflow, /node scripts\/build-wg-relay-sidecar\.js --target \$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /node scripts\/verify-wg-relay-sidecars\.js --target \$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /build-windows:[\s\S]*?build-wg-relay-sidecar\.js --target win32-x64,win32-arm64[\s\S]*?verify-wg-relay-sidecars\.js --target win32-x64,win32-arm64[\s\S]*?npx electron-builder --win --publish never/);
  assert.match(workflow, /build-mac:[\s\S]*?build-wg-relay-sidecar\.js --target darwin-x64,darwin-arm64[\s\S]*?verify-wg-relay-sidecars\.js --target darwin-x64,darwin-arm64[\s\S]*?npx electron-builder --mac --publish never/);
  assert.match(workflow, /build-linux:[\s\S]*?build-wg-relay-sidecar\.js --target linux-x64[\s\S]*?verify-wg-relay-sidecars\.js --target linux-x64[\s\S]*?npx electron-builder --linux --publish never/);
});

test("release workflow behavior remains tag-gated with all existing artifacts", () => {
  const workflow = read(".github/workflows/build.yml");
  assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /release:\s*\n\s*if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /needs: \[build-windows, build-mac, build-linux, build-android\]/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
  assert.match(workflow, /draft: true/);
});

test("Android CI gates unit tests, lint, and debug assembly", () => {
  const workflow = read(".github/workflows/android.yml");
  assert.match(workflow, /\.\/gradlew testDebugUnitTest --no-daemon/);
  assert.match(workflow, /\.\/gradlew lintDebug --no-daemon/);
  assert.match(workflow, /\.\/gradlew assembleDebug --no-daemon/);
  assert.doesNotMatch(workflow, /skip_tests/);
});

test("VPS smoke script uses explicit test address variables and never accepts address arguments", () => {
  const scriptPath = path.join(ROOT, "scripts", "smoke-wg-relay-vps.sh");
  assert.ok(fs.existsSync(scriptPath), "VPS smoke script must exist");
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /CLAWD_TEST_VPS_HOST/);
  assert.match(script, /CLAWD_TEST_VPS_USER/);
  assert.match(script, /CLAWD_TEST_VPS_PORT/);
  assert.match(script, /\[ "\$#" -eq 0 \]/);
  assert.doesNotMatch(script, /sshpass|set -x|StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
  assert.match(script, /read -r -s/);
  assert.match(script, /CLAWD_TEST_VPS_PASSWORD/);
  assert.doesNotMatch(script, /ssh[^\n]*(?:PASSWORD|password)/);
});

test("VPS smoke script exercises idempotence, service gates, private Relay, sidecar health, and rotation", () => {
  const script = read("scripts/smoke-wg-relay-vps.sh");
  assert.match(script, /for deployment in 1 2/);
  assert.match(script, /systemctl is-enabled --quiet wg-quick@clawd/);
  assert.match(script, /systemctl is-active --quiet wg-quick@clawd/);
  assert.match(script, /systemctl is-enabled --quiet clawd-relay\.service/);
  assert.match(script, /systemctl is-active --quiet clawd-relay\.service/);
  assert.match(script, /REMOTE_CHECK_COMMAND="\$\(cat <<'REMOTE_CHECKS'/);
  assert.doesNotMatch(script, /run_privileged "bash -s"/);
  assert.match(script, /public Relay TCP exposure/i);
  assert.match(script, /build-wg-relay-sidecar\.js/);
  assert.match(script, /verify-wg-relay-sidecars\.js/);
  assert.match(script, /\/health/);
  assert.match(script, /\/api\/manage\/phone\/rotate/);
  assert.match(script, /old WireGuard key rejection/i);
  assert.match(script, /old Relay token rejection/i);
  assert.match(script, /secrets redacted/i);
  assert.doesNotMatch(script, /CLAWD_TEST_VPS_HOST:-[^}]+/);
  assert.doesNotMatch(script, /CLAWD_TEST_VPS_USER:-[^}]+/);
  assert.doesNotMatch(script, /CLAWD_TEST_VPS_PORT:-[^}]+/);
});

test("desktop and Android READMEs document the one-click first-run flow", () => {
  for (const file of ["README.md", "android/README.md"]) {
    const text = read(file);
    assert.match(text, /VPS 地址/);
    assert.match(text, /SSH 用户名/);
    assert.match(text, /SSH 端口/);
    assert.match(text, /SSH 密码/);
    assert.match(text, /扫码/);
    assert.match(text, /后续.*一键/);
    assert.match(text, /UDP.*51820|51820.*UDP/);
    assert.match(text, /Windows.*x64.*ARM64|Windows.*ARM64.*x64/);
    assert.match(text, /macOS.*x64.*ARM64|macOS.*ARM64.*x64/);
    assert.match(text, /Linux.*x64.*ARM64|Linux.*ARM64.*x64/);
    assert.match(text, /1\s*(?:核|C).*2\s*G/i);
    assert.match(text, /无需.*外部软件/);
  }
});

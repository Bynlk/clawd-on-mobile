"use strict";

const { spawnSync: defaultSpawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SIDECAR_ROOT = "wg-relay-sidecars";
const SOURCE_ROOT = path.join("sidecars", "wg-relay-tunnel");

const TARGETS = Object.freeze([
  Object.freeze({ name: "win32-x64", platform: "win32", arch: "x64", goos: "windows", goarch: "amd64", executable: "clawd-wg-tunnel.exe" }),
  Object.freeze({ name: "win32-arm64", platform: "win32", arch: "arm64", goos: "windows", goarch: "arm64", executable: "clawd-wg-tunnel.exe" }),
  Object.freeze({ name: "darwin-x64", platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64", executable: "clawd-wg-tunnel" }),
  Object.freeze({ name: "darwin-arm64", platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64", executable: "clawd-wg-tunnel" }),
  Object.freeze({ name: "linux-x64", platform: "linux", arch: "x64", goos: "linux", goarch: "amd64", executable: "clawd-wg-tunnel" }),
  Object.freeze({ name: "linux-arm64", platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64", executable: "clawd-wg-tunnel" }),
]);

function selectTargets(rawTarget = "all") {
  const value = String(rawTarget || "all").trim();
  if (!value || value === "all") return TARGETS.slice();

  const byName = new Map(TARGETS.map((target) => [target.name, target]));
  const selected = [];
  const seen = new Set();
  for (const item of value.split(",")) {
    const name = item.trim();
    const target = byName.get(name);
    if (!target) {
      throw new Error(`Unsupported WireGuard Relay sidecar target "${name}". Expected one of: all, ${TARGETS.map((entry) => entry.name).join(", ")}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      selected.push(target);
    }
  }
  return selected;
}

function targetBinaryPath(rootDir, target) {
  return path.join(rootDir, SIDECAR_ROOT, target.name, target.executable);
}

function createBuildSpec(target, options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const outputPath = targetBinaryPath(rootDir, target);
  return {
    command: "go",
    args: ["build", "-trimpath", "-o", outputPath, "."],
    cwd: path.join(rootDir, SOURCE_ROOT),
    outputPath,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: target.goos,
      GOARCH: target.goarch,
    },
  };
}

function buildSidecars(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const selected = selectTargets(options.target || "all");
  const built = [];

  for (const target of selected) {
    const spec = createBuildSpec(target, { rootDir });
    fs.mkdirSync(path.dirname(spec.outputPath), { recursive: true });
    const result = spawnSync(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: options.stdio || "inherit",
    });
    if (result.error) {
      throw new Error(`Go build failed for ${target.name}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Go build failed for ${target.name} with exit code ${result.status == null ? "unknown" : result.status}`);
    }
    if (target.platform !== "win32" && fs.existsSync(spec.outputPath)) {
      fs.chmodSync(spec.outputPath, 0o755);
    }
    built.push({ target: target.name, path: spec.outputPath });
  }

  return { ok: true, built };
}

function parseArgs(argv) {
  const options = { target: "all", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      if (index + 1 >= argv.length) throw new Error("--target requires a value");
      options.target = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage: node scripts/build-wg-relay-sidecar.js [--target all|${TARGETS.map((target) => target.name).join("|")}[,..]]\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = buildSidecars(options);
  for (const item of result.built) console.log(`Built ${item.target}: ${item.path}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  SIDECAR_ROOT,
  SOURCE_ROOT,
  TARGETS,
  selectTargets,
  targetBinaryPath,
  createBuildSpec,
  buildSidecars,
  parseArgs,
};

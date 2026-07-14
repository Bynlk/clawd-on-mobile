"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  TARGETS,
  selectTargets,
  targetBinaryPath,
} = require("./build-wg-relay-sidecar");

const ARCH_NAMES = Object.freeze({
  1: "x64",
  3: "arm64",
  x64: "x64",
  arm64: "arm64",
});

function inspectBinary(fsModule, filePath, target) {
  let stat;
  try {
    stat = fsModule.statSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return "missing";
    return "unreadable";
  }
  if (!stat.isFile()) return "not-file";
  if (stat.size <= 0) return "empty";
  if (target.platform !== "win32" && (stat.mode & 0o111) === 0) return "not-executable";
  return null;
}

function verifyWgRelaySidecars(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const fsModule = options.fs || fs;
  const selected = selectTargets(options.target || "all");
  const checked = [];
  const invalid = [];

  for (const target of selected) {
    const filePath = targetBinaryPath(rootDir, target);
    const reason = inspectBinary(fsModule, filePath, target);
    const item = { target: target.name, path: filePath };
    checked.push(item);
    if (reason) invalid.push({ ...item, reason });
  }

  return { ok: invalid.length === 0, checked, invalid };
}

function formatFailure(result) {
  return result.invalid.map((item) => `${item.target}: ${item.reason} (${item.path})`).join("\n");
}

function targetFromPackContext(context = {}) {
  const platform = context.electronPlatformName;
  const arch = ARCH_NAMES[context.arch];
  if (!["win32", "darwin", "linux"].includes(platform) || !arch) {
    throw new Error(`Unsupported electron-builder target context: ${String(platform)}/${String(context.arch)}`);
  }
  return `${platform}-${arch}`;
}

function electronBuilderBeforePack(context) {
  const rootDir = context && context.packager && context.packager.projectDir;
  if (typeof rootDir !== "string" || !rootDir) {
    throw new Error("electron-builder projectDir is required for WireGuard Relay sidecar verification");
  }
  const target = targetFromPackContext(context);
  const result = verifyWgRelaySidecars({ rootDir, target });
  if (!result.ok) {
    throw new Error(`WireGuard Relay sidecar verification failed:\n${formatFailure(result)}`);
  }
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
  stdout.write(`Usage: node scripts/verify-wg-relay-sidecars.js [--target all|${TARGETS.map((target) => target.name).join("|")}[,..]]\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = verifyWgRelaySidecars(options);
  if (!result.ok) {
    console.error(`WireGuard Relay sidecar verification failed:\n${formatFailure(result)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Verified ${result.checked.length} WireGuard Relay sidecar binary/binaries.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

Object.assign(electronBuilderBeforePack, {
  ARCH_NAMES,
  inspectBinary,
  verifyWgRelaySidecars,
  formatFailure,
  targetFromPackContext,
  parseArgs,
});

module.exports = electronBuilderBeforePack;

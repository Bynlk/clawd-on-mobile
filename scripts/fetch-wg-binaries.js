"use strict";

// ── Fetch the bundled userspace WireGuard binaries (wireguard-go + wg) ──
//
// The desktop in-app tunnel (src/wg-pc-tunnel.js) shells out to a bundled
// `wireguard-go` (creates the userspace TUN) and `wg` (applies the conf via
// `setconf`). electron-builder packs `wg-bin/<platform>/` into the app
// resources (see package.json build.extraResources), and resolveWgGoPath /
// resolveWgToolPath look for them under resources/wg-bin/<platform>/.
//
// wireguard-go / wireguard-tools are MIT/GPL licensed and NOT redistributed in
// this repo -- CI (or a maintainer) runs this script before packaging to drop
// the platform binaries in place. Set the *_URL env vars to trusted release
// artifacts (or a mirror) and this verifies the sha256 before writing.
//
// Usage:
//   WG_GO_LINUX_X64_URL=... WG_GO_LINUX_X64_SHA256=... \
//   WG_TOOL_LINUX_X64_URL=... WG_TOOL_LINUX_X64_SHA256=... \
//   node scripts/fetch-wg-binaries.js linux x64
//
// This is intentionally dependency-free (uses node:https) and idempotent: an
// already-present binary with a matching sha256 is left untouched.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const WG_BIN = path.join(ROOT, "wg-bin");

// platform token as used in wg-bin/<token> (matches process.platform).
const PLATFORMS = {
  linux: { token: "linux", tool: "wg", go: "wireguard-go" },
  darwin: { token: "darwin", tool: "wg", go: "wireguard-go" },
  win32: { token: "win32", tool: null, go: "wireguard.exe" },
};

function envKey(kind, platform, arch) {
  return `WG_${kind}_${platform.toUpperCase()}_${String(arch).toUpperCase()}`;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(download(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fetchOne({ kind, name, platform, arch, destDir }) {
  const urlKey = `${envKey(kind, platform, arch)}_URL`;
  const shaKey = `${envKey(kind, platform, arch)}_SHA256`;
  const url = process.env[urlKey];
  const wantSha = process.env[shaKey];
  const dest = path.join(destDir, name);

  if (!url) {
    console.warn(`[wg] SKIP ${name} (${platform}/${arch}): ${urlKey} not set`);
    return false;
  }
  if (fs.existsSync(dest) && wantSha) {
    const have = sha256(fs.readFileSync(dest));
    if (have === wantSha) {
      console.log(`[wg] OK   ${name} (${platform}/${arch}) already present`);
      return true;
    }
  }
  console.log(`[wg] GET  ${name} <- ${url}`);
  const buf = await download(url);
  if (wantSha) {
    const got = sha256(buf);
    if (got !== wantSha) {
      throw new Error(`[wg] sha256 mismatch for ${name}: got ${got}, want ${wantSha}`);
    }
  } else {
    console.warn(`[wg] WARN ${shaKey} not set -- skipping integrity check for ${name}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  fs.chmodSync(dest, 0o755);
  console.log(`[wg] WROTE ${dest} (${buf.length} bytes, sha256=${sha256(buf)})`);
  return true;
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const spec = PLATFORMS[platform];
  if (!spec) {
    console.error(`[wg] unsupported platform: ${platform}`);
    process.exit(1);
  }
  const destDir = path.join(WG_BIN, spec.token);
  fs.mkdirSync(destDir, { recursive: true });

  let ok = true;
  ok = (await fetchOne({ kind: "GO", name: spec.go, platform, arch, destDir })) && ok;
  if (spec.tool) {
    ok = (await fetchOne({ kind: "TOOL", name: spec.tool, platform, arch, destDir })) && ok;
  }
  if (!ok) {
    console.warn("[wg] one or more binaries were skipped -- the tunnel will fall back to PATH at runtime.");
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

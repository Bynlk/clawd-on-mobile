"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const SIDECAR_ROOT = path.join("bin", "cc-connect-clawd");
const FETCH_COMMAND = "node scripts/fetch-sidecar-binaries.js";
const DEFAULT_RELEASE = Object.freeze({
  owner: "rullerzhou-afk",
  repo: "cc-connect-clawd",
  tag: "clawd-sidecar-v0.1.0",
});

const TARGETS = Object.freeze([
  Object.freeze({ platform: "windows", arch: "x64", dir: "windows-x64", exe: "cc-connect-clawd.exe", archiveExt: ".zip" }),
  Object.freeze({ platform: "windows", arch: "arm64", dir: "windows-arm64", exe: "cc-connect-clawd.exe", archiveExt: ".zip" }),
  Object.freeze({ platform: "darwin", arch: "x64", dir: "darwin-x64", exe: "cc-connect-clawd", archiveExt: ".tar.gz" }),
  Object.freeze({ platform: "darwin", arch: "arm64", dir: "darwin-arm64", exe: "cc-connect-clawd", archiveExt: ".tar.gz" }),
  Object.freeze({ platform: "linux", arch: "x64", dir: "linux-x64", exe: "cc-connect-clawd", archiveExt: ".tar.gz" }),
]);

function archiveName(target) {
  return `cc-connect-clawd-${target.dir}${target.archiveExt}`;
}

function binaryChecksumName(target) {
  return `${target.dir}/${target.exe}`;
}

function releaseAssetUrl(assetName, release = DEFAULT_RELEASE) {
  return `https://github.com/${release.owner}/${release.repo}/releases/download/${release.tag}/${assetName}`;
}

function targetBinaryPath(rootDir, target) {
  return path.join(rootDir, SIDECAR_ROOT, target.dir, target.exe);
}

function selectTargets(raw) {
  const value = String(raw || "all").trim();
  if (!value || value === "all") return TARGETS.map((target) => ({ ...target }));
  const byDir = new Map(TARGETS.map((target) => [target.dir, target]));
  const seen = new Set();
  const selected = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    const target = byDir.get(name);
    if (!target) {
      throw new Error(`Unsupported sidecar target "${name}". Expected one of: all, ${TARGETS.map((t) => t.dir).join(", ")}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push({ ...target });
  }
  return selected;
}

function buildReleaseManifest(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const release = options.release || DEFAULT_RELEASE;
  const targets = selectTargets(options.target || "all").map((target) => {
    const archive = archiveName(target);
    return {
      ...target,
      archive,
      archiveUrl: releaseAssetUrl(archive, release),
      archiveChecksumName: archive,
      binaryChecksumName: binaryChecksumName(target),
      binaryPath: targetBinaryPath(rootDir, target),
    };
  });
  return {
    release,
    checksums: {
      name: "checksums.txt",
      url: releaseAssetUrl("checksums.txt", release),
    },
    targets,
  };
}

function parseChecksums(text) {
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const name = match[2].replace(/\\/g, "/").trim();
    if (!name || name.includes("..") || name.startsWith("/")) {
      throw new Error(`Unsafe checksum path: ${name}`);
    }
    out.set(name, match[1].toLowerCase());
  }
  return out;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function verifyChecksum(buffer, expected, label) {
  if (!expected) throw new Error(`Missing checksum for ${label}`);
  const got = sha256(buffer);
  if (got !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${label}: got ${got}, expected ${expected}`);
  }
}

function extractSidecarBinary(archiveBuffer, target) {
  if (target.archiveExt === ".zip") return extractZipEntry(archiveBuffer, target.exe);
  if (target.archiveExt === ".tar.gz") return extractTarGzEntry(archiveBuffer, target.exe);
  throw new Error(`Unsupported sidecar archive type: ${target.archiveExt}`);
}

function extractZipEntry(buffer, wantedName) {
  const eocdOffset = findZipEocd(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wantedName) {
      return readZipEntryData(buffer, localOffset, method, compressedSize, uncompressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Zip archive is missing ${wantedName}`);
}

function findZipEocd(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Invalid zip archive: missing end of central directory");
}

function readZipEntryData(buffer, localOffset, method, compressedSize, uncompressedSize) {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid zip local file header");
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  let out;
  if (method === 0) {
    out = Buffer.from(compressed);
  } else if (method === 8) {
    out = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported zip compression method: ${method}`);
  }
  if (out.length !== uncompressedSize) {
    throw new Error(`Unexpected zip entry size: got ${out.length}, expected ${uncompressedSize}`);
  }
  return out;
}

function extractTarGzEntry(buffer, wantedName) {
  const tarBuffer = zlib.gunzipSync(buffer);
  for (let offset = 0; offset + 512 <= tarBuffer.length;) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header.subarray(124, 136));
    const dataOffset = offset + 512;
    if (fullName === wantedName) {
      return Buffer.from(tarBuffer.subarray(dataOffset, dataOffset + size));
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  throw new Error(`tar.gz archive is missing ${wantedName}`);
}

function isZeroBlock(buffer) {
  for (const byte of buffer) {
    if (byte !== 0) return false;
  }
  return true;
}

function readTarString(buffer, offset, length) {
  const raw = buffer.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul >= 0 ? nul : raw.length).toString("utf8").trim();
}

function parseTarOctal(buffer) {
  const value = buffer.toString("ascii").replace(/\0/g, "").trim();
  if (!value) return 0;
  const out = Number.parseInt(value, 8);
  if (!Number.isFinite(out)) throw new Error(`Invalid tar size: ${value}`);
  return out;
}

function installBinary(fsModule, filePath, buffer) {
  const dir = path.dirname(filePath);
  fsModule.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const backupPath = `${filePath}.bak-${process.pid}-${Date.now()}`;
  fsModule.writeFileSync(tempPath, buffer, { mode: 0o755 });
  let hasBackup = false;
  try {
    if (fsModule.existsSync(filePath)) {
      fsModule.renameSync(filePath, backupPath);
      hasBackup = true;
    }
    fsModule.renameSync(tempPath, filePath);
    if (hasBackup) {
      fsModule.rmSync(backupPath, { force: true });
      hasBackup = false;
    }
  } catch (err) {
    try {
      fsModule.rmSync(tempPath, { force: true });
    } catch {}
    if (hasBackup) {
      try {
        fsModule.renameSync(backupPath, filePath);
      } catch {}
    }
    throw err;
  }
  if (os.platform() !== "win32" && typeof fsModule.chmodSync === "function") {
    fsModule.chmodSync(filePath, 0o755);
  }
}

async function fetchSidecarBinaries(options = {}) {
  const fsModule = options.fs || fs;
  const download = options.download || downloadBuffer;
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const release = {
    ...DEFAULT_RELEASE,
    ...(options.release || {}),
    tag: options.tag || (options.release && options.release.tag) || DEFAULT_RELEASE.tag,
  };
  const manifest = buildReleaseManifest({ rootDir, release, target: options.target || "all" });
  if (options.dryRun) return { ok: true, manifest, installed: [] };

  const checksumsBuffer = await download(manifest.checksums.url);
  const checksums = parseChecksums(checksumsBuffer.toString("utf8"));
  const installed = [];
  for (const target of manifest.targets) {
    const archiveBuffer = await download(target.archiveUrl);
    verifyChecksum(archiveBuffer, checksums.get(target.archiveChecksumName), target.archiveChecksumName);
    const binaryBuffer = extractSidecarBinary(archiveBuffer, target);
    verifyChecksum(binaryBuffer, checksums.get(target.binaryChecksumName), target.binaryChecksumName);
    installBinary(fsModule, target.binaryPath, binaryBuffer);
    installed.push({ target: target.dir, path: target.binaryPath });
  }
  return { ok: true, manifest, installed };
}

function downloadBuffer(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "clawd-sidecar-fetcher",
        "Accept": "application/octet-stream",
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        downloadBuffer(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`Download failed (${status}) for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error(`Download timed out for ${url}`));
    });
  });
}

function parseArgs(argv) {
  const out = { target: "all", tag: DEFAULT_RELEASE.tag, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--target") {
      out.target = argv[++i];
    } else if (arg === "--tag") {
      out.tag = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage: node scripts/fetch-sidecar-binaries.js [--target all|platform-arch[,..]] [--tag ${DEFAULT_RELEASE.tag}] [--dry-run]\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = await fetchSidecarBinaries(args);
  if (args.dryRun) {
    console.log(JSON.stringify(result.manifest, null, 2));
    return;
  }
  for (const item of result.installed) {
    console.log(`Installed ${item.target}: ${item.path}`);
  }
  console.log(`Fetched ${result.installed.length} cc-connect-clawd sidecar binary/binaries from ${result.manifest.release.tag}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  FETCH_COMMAND,
  DEFAULT_RELEASE,
  TARGETS,
  archiveName,
  binaryChecksumName,
  releaseAssetUrl,
  targetBinaryPath,
  selectTargets,
  buildReleaseManifest,
  parseChecksums,
  sha256,
  verifyChecksum,
  extractZipEntry,
  extractTarGzEntry,
  extractSidecarBinary,
  installBinary,
  fetchSidecarBinaries,
  parseArgs,
};

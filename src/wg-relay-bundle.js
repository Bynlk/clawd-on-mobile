"use strict";

const fs = require("fs");
const path = require("path");

const REQUIRED_FILES = [
  ["relay/install-wg-relay.sh", "install-wg-relay.sh", 0o755],
  ["relay/relay-server.js", "app/relay-server.js", 0o644],
  ["relay/pair-registry.js", "app/pair-registry.js", 0o644],
  ["relay/relay-token-store.js", "app/relay-token-store.js", 0o644],
  ["relay/wg-management.js", "app/wg-management.js", 0o644],
];

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertSafeRemotePath(remotePath) {
  if (typeof remotePath !== "string" || !remotePath || remotePath.includes("\\") || remotePath.includes("\0")) {
    throw new Error(`Unsafe relay bundle path: ${String(remotePath)}`);
  }
  const parts = remotePath.split("/");
  if (path.posix.isAbsolute(remotePath) || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe relay bundle path: ${remotePath}`);
  }
  if (path.posix.normalize(remotePath) !== remotePath) {
    throw new Error(`Unsafe relay bundle path: ${remotePath}`);
  }
}

function assertRegularFile(localPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(localPath);
  } catch (error) {
    throw new Error(`Required relay bundle file is missing: ${label}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Relay bundle rejects symlink: ${label}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Required relay bundle path is not a file: ${label}`);
  }
}

function assertNotSymlink(localPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(localPath);
  } catch {
    throw new Error(`Required relay bundle path is missing: ${label}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Relay bundle rejects symlink: ${label}`);
  }
  return stat;
}

function assertNoSymlinkComponents(root, relativePath) {
  assertNotSymlink(root, "appRoot");
  let current = root;
  let label = "";
  for (const segment of relativePath.split(/[\\/]+/)) {
    current = path.join(current, segment);
    label = label ? path.join(label, segment) : segment;
    assertNotSymlink(current, label);
  }
}

function captureContainedFile(root, relativePath) {
  const localPath = path.join(root, relativePath);
  assertRegularFile(localPath, relativePath);
  assertNoSymlinkComponents(root, relativePath);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(localPath);
  const containedPath = path.relative(realRoot, realFile);
  if (containedPath === ".." || containedPath.startsWith(`..${path.sep}`) || path.isAbsolute(containedPath)) {
    throw new Error(`Relay bundle file escapes appRoot: ${relativePath}`);
  }
  return { localPath, contents: fs.readFileSync(localPath) };
}

function createManifestEntry(captured, remotePath, mode) {
  const snapshot = Buffer.from(captured.contents);
  const entry = { localPath: captured.localPath, remotePath, mode };
  Object.defineProperty(entry, "contents", {
    enumerable: true,
    get() { return Buffer.from(snapshot); },
  });
  return Object.freeze(entry);
}

function walkRuntimeFiles(rootPath, relativePath = "") {
  let entries;
  try {
    entries = fs.readdirSync(path.join(rootPath, relativePath), { withFileTypes: true });
  } catch (error) {
    const label = path.join("node_modules/ws", relativePath);
    throw new Error(`Required relay bundle directory is missing: ${label}`);
  }

  const files = [];
  entries.sort((a, b) => comparePaths(a.name, b.name));
  for (const entry of entries) {
    const childRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
    const childPath = path.join(rootPath, childRelative);
    const label = path.join("node_modules/ws", childRelative);
    const stat = fs.lstatSync(childPath);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      throw new Error(`Relay bundle rejects symlink: ${label}`);
    }
    if (entry.isDirectory() && stat.isDirectory()) {
      files.push(...walkRuntimeFiles(rootPath, childRelative));
    } else if (entry.isFile() && stat.isFile()) {
      files.push(childRelative);
    } else {
      throw new Error(`Relay bundle rejects unsupported runtime path: ${label}`);
    }
  }
  return files;
}

function buildRelayBundleManifest({ appRoot }) {
  if (typeof appRoot !== "string" || !appRoot) {
    throw new Error("buildRelayBundleManifest: appRoot required");
  }
  const root = path.resolve(appRoot);
  const manifest = REQUIRED_FILES.map(([sourcePath, remotePath, mode]) => {
    const captured = captureContainedFile(root, sourcePath);
    return createManifestEntry(captured, remotePath, mode);
  });

  const wsRoot = path.join(root, "node_modules", "ws");
  assertNoSymlinkComponents(root, "node_modules/ws");
  const wsRootStat = fs.lstatSync(wsRoot);
  if (!wsRootStat.isDirectory()) {
    throw new Error("Required relay bundle path is not a directory: node_modules/ws");
  }
  for (const relativePath of walkRuntimeFiles(wsRoot).sort(comparePaths)) {
    const sourcePath = path.join("node_modules", "ws", relativePath);
    const captured = captureContainedFile(root, sourcePath);
    const remotePath = path.posix.join("app/node_modules/ws", relativePath.split(path.sep).join("/"));
    assertSafeRemotePath(remotePath);
    manifest.push(createManifestEntry(captured, remotePath, 0o644));
  }
  return manifest;
}

function callSftp(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function collectRemoteDirectories(remoteRoot, manifest) {
  const directories = new Set([remoteRoot]);
  for (const entry of manifest) {
    let current = path.posix.dirname(path.posix.join(remoteRoot, entry.remotePath));
    while (current !== remoteRoot && current.startsWith(`${remoteRoot}/`)) {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].sort((a, b) => {
    const depthDiff = a.split("/").length - b.split("/").length;
    return depthDiff || comparePaths(a, b);
  });
}

async function uploadRelayBundle({ sftp, manifest, remoteRoot, onProgress }) {
  if (!sftp || typeof sftp.mkdir !== "function" || typeof sftp.writeFile !== "function") {
    throw new Error("uploadRelayBundle: sftp client required");
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("uploadRelayBundle: non-empty manifest required");
  }
  if (typeof remoteRoot !== "string" || !path.posix.isAbsolute(remoteRoot) || path.posix.normalize(remoteRoot) !== remoteRoot) {
    throw new Error("uploadRelayBundle: safe absolute remoteRoot required");
  }

  for (const entry of manifest) {
    assertSafeRemotePath(entry && entry.remotePath);
    if (!entry || !Buffer.isBuffer(entry.contents) || ![0o644, 0o755].includes(entry.mode)) {
      throw new Error("uploadRelayBundle: invalid manifest entry");
    }
  }

  for (const directory of collectRemoteDirectories(remoteRoot, manifest)) {
    await callSftp(sftp, "mkdir", directory, { mode: 0o755 });
  }

  let completed = 0;
  for (const entry of manifest) {
    const remotePath = path.posix.join(remoteRoot, entry.remotePath);
    await callSftp(sftp, "writeFile", remotePath, Buffer.from(entry.contents), { mode: entry.mode });
    completed += 1;
    if (typeof onProgress === "function") {
      onProgress({ stage: "upload", completed, total: manifest.length });
    }
  }
}

module.exports = {
  buildRelayBundleManifest,
  uploadRelayBundle,
};

"use strict";

const nodeFs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
let temporarySequence = 0;

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createFlockLock({
  fs = nodeFs,
  lockPath = "/run/lock/clawd-relay.lock",
  timeoutMs = 5000,
  flockCommand = "flock",
  spawnProcess = spawn,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || typeof flockCommand !== "string" || !flockCommand) {
    throw new Error("invalid lock timing");
  }
  let existed = true;
  try {
    const before = fs.lstatSync(lockPath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("lock path must be a regular file");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    existed = false;
  }
  const flags = nodeFs.constants.O_RDWR | nodeFs.constants.O_CREAT |
    (nodeFs.constants.O_NOFOLLOW || 0);
  let descriptor = null;
  try {
    descriptor = fs.openSync(lockPath, flags, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("lock path must be a regular file");
    if (expectedUid !== null && expectedUid !== undefined && stat.uid !== expectedUid) {
      throw new Error("lock file owner is invalid");
    }
    if (existed && (stat.mode & 0o777) !== 0o600) {
      throw new Error("lock file mode must be 0600");
    }
    if (!existed && typeof fs.fchmodSync === "function") fs.fchmodSync(descriptor, 0o600);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }

  async function acquire({ signal } = {}) {
    if (signal && signal.aborted) throw signal.reason || codedError("lock_aborted");
    const seconds = Math.max(0, timeoutMs / 1000).toFixed(3);
    const child = spawnProcess(flockCommand, [
      "-x", "-w", seconds, lockPath,
      "sh", "-c", 'printf "LOCKED\\n"; cat >/dev/null',
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let acquired = false;
    let settled = false;
    let stdout = "";
    let stderrBytes = 0;
    let resolveClose;
    const closed = new Promise((resolve) => { resolveClose = resolve; });

    return new Promise((resolve, reject) => {
      const onAbort = () => fail(signal.reason || codedError("lock_aborted"));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        try { child.kill("SIGKILL"); } catch {}
        reject(error);
      };
      child.once("error", () => fail(codedError("lock_unavailable")));
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 4096) fail(codedError("lock_failed"));
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (acquired || settled) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > 64) {
          fail(codedError("lock_failed"));
          return;
        }
        if (!stdout.includes("\n")) return;
        if (stdout !== "LOCKED\n") {
          fail(codedError("lock_failed"));
          return;
        }
        acquired = true;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        let released = false;
        resolve(async function release() {
          if (released) return closed;
          released = true;
          try { child.stdin.end(); } catch {}
          return closed;
        });
      });
      child.once("close", (code) => {
        resolveClose();
        if (!acquired) fail(codedError(code === 1 ? "lock_timeout" : "lock_failed"));
      });
    });
  }

  async function runExclusive(operation, { signal } = {}) {
    const release = await acquire({ signal });
    try { return await operation(); } finally { await release(); }
  }

  return Object.freeze({ acquire, runExclusive, lockPath });
}

const createDirectoryLock = createFlockLock;

function normalizeToken(name, value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error(`${name} must be 64 hexadecimal characters`);
  }
  return value;
}

function parseEnvironment(contents) {
  const entries = [];
  const values = Object.create(null);
  for (const line of String(contents).split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) {
      entries.push({ raw: line });
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("relay.env contains an invalid line");
    const [, key, value] = match;
    if (Object.hasOwn(values, key)) throw new Error(`relay.env contains duplicate ${key}`);
    if (/\0|\r|\n/.test(value)) throw new Error(`relay.env contains invalid ${key}`);
    values[key] = value;
    entries.push({ key, value });
  }
  return { entries, values };
}

function renderEnvironment(parsed, relayToken) {
  let replaced = false;
  const lines = parsed.entries.map((entry) => {
    if (entry.key !== "RELAY_TOKEN") return entry.raw === undefined ? `${entry.key}=${entry.value}` : entry.raw;
    replaced = true;
    return `RELAY_TOKEN=${relayToken}`;
  });
  if (!replaced) lines.push(`RELAY_TOKEN=${relayToken}`);
  while (lines.length > 1 && lines.at(-1) === "" && lines.at(-2) === "") lines.pop();
  if (lines.at(-1) !== "") lines.push("");
  return lines.join("\n");
}

function atomicWrite(fs, destination, contents) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}-${temporarySequence++}`
  );
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    if (typeof fs.fchmodSync === "function") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
    renamed = true;
    fs.chmodSync(destination, 0o600);
    if (typeof fs.fsyncSync === "function") {
      let directoryDescriptor = null;
      try {
        directoryDescriptor = fs.openSync(path.dirname(destination), "r");
        fs.fsyncSync(directoryDescriptor);
      } finally {
        if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (renamed) error.commitUncertain = true;
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function assertSecureEnvironmentFile(fs, envPath, expectedUid) {
  const stat = fs.lstatSync(envPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("relay.env must be a regular file");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("relay.env mode must be 0600");
  if (expectedUid !== null && expectedUid !== undefined && stat.uid !== expectedUid) {
    throw new Error("relay.env owner is invalid");
  }
}

function createRelayTokenStore({
  envPath = "/etc/clawd-relay/relay.env",
  fs = nodeFs,
  initialRelayToken,
  initialManagementToken,
  initialEnvironment = {},
  expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
  lock = null,
  lockPath = path.join(path.dirname(envPath), ".clawd-relay.lock"),
} = {}) {
  let contents;
  try {
    assertSecureEnvironmentFile(fs, envPath, expectedUid);
    contents = fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if (!initialRelayToken || !initialManagementToken || (error && error.code !== "ENOENT")) throw error;
    const seed = { ...initialEnvironment, RELAY_TOKEN: initialRelayToken, MANAGEMENT_TOKEN: initialManagementToken };
    contents = Object.entries(seed).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  }

  let parsed = parseEnvironment(contents);
  let relayToken = normalizeToken("RELAY_TOKEN", parsed.values.RELAY_TOKEN || initialRelayToken);
  const managementToken = normalizeToken(
    "MANAGEMENT_TOKEN",
    parsed.values.MANAGEMENT_TOKEN || initialManagementToken
  );
  if (relayToken.toLowerCase() === managementToken.toLowerCase()) {
    throw new Error("Relay and management tokens must be distinct");
  }
  const tokenLock = lock || createFlockLock({ fs, lockPath });

  function reconcileFromDisk() {
    assertSecureEnvironmentFile(fs, envPath, expectedUid);
    const freshContents = fs.readFileSync(envPath, "utf8");
    const fresh = parseEnvironment(freshContents);
    const diskRelayToken = normalizeToken("RELAY_TOKEN", fresh.values.RELAY_TOKEN);
    const diskManagementToken = normalizeToken("MANAGEMENT_TOKEN", fresh.values.MANAGEMENT_TOKEN);
    if (diskManagementToken !== managementToken) throw codedError("management_token_conflict");
    if (diskRelayToken.toLowerCase() === diskManagementToken.toLowerCase()) {
      throw new Error("Relay and management tokens must be distinct");
    }
    parsed = fresh;
    relayToken = diskRelayToken;
    return relayToken;
  }

  async function rotate(nextToken, expectedRelayToken = relayToken, { lockHeld = false } = {}) {
    const normalized = normalizeToken("RELAY_TOKEN", nextToken);
    if (normalized.toLowerCase() === managementToken.toLowerCase()) {
      throw new Error("Relay and management tokens must be distinct");
    }
    const commit = () => {
      assertSecureEnvironmentFile(fs, envPath, expectedUid);
      const fresh = parseEnvironment(fs.readFileSync(envPath, "utf8"));
      const diskRelayToken = normalizeToken("RELAY_TOKEN", fresh.values.RELAY_TOKEN);
      const diskManagementToken = normalizeToken("MANAGEMENT_TOKEN", fresh.values.MANAGEMENT_TOKEN);
      if (diskManagementToken !== managementToken) throw codedError("management_token_conflict");
      if (diskRelayToken !== expectedRelayToken) throw codedError("stale_token_conflict");
      const nextContents = renderEnvironment(fresh, normalized);
      try {
        atomicWrite(fs, envPath, nextContents);
      } catch (error) {
        if (error.commitUncertain) {
          try { reconcileFromDisk(); } catch (reconciliationError) {
            error.reconciliationError = reconciliationError;
          }
        }
        throw error;
      }
      parsed = parseEnvironment(nextContents);
      relayToken = normalized;
      return relayToken;
    };
    return lockHeld ? commit() : tokenLock.runExclusive(commit);
  }

  async function reload({ lockHeld = false } = {}) {
    return lockHeld ? reconcileFromDisk() : tokenLock.runExclusive(reconcileFromDisk);
  }

  return Object.freeze({
    current: () => relayToken,
    managementToken: () => managementToken,
    rotate,
    restore: rotate,
    reload,
    lock: tokenLock,
  });
}

module.exports = {
  createDirectoryLock,
  createFlockLock,
  createRelayTokenStore,
  normalizeToken,
  parseEnvironment,
};

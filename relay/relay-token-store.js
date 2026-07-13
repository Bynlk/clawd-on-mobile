"use strict";

const nodeFs = require("node:fs");
const path = require("node:path");

const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
let temporarySequence = 0;

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createDirectoryLock({
  fs = nodeFs,
  lockPath = "/run/lock/clawd-relay.lock",
  timeoutMs = 5000,
  retryMs = 25,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  ownerId = `${process.pid}-${Math.random().toString(16).slice(2)}`,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new Error("invalid lock timing");
  }
  const ownerPath = path.join(lockPath, "owner");

  async function acquire() {
    const deadline = now() + timeoutMs;
    for (;;) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        try {
          fs.writeFileSync(ownerPath, `${ownerId}\n`, { mode: 0o600, flag: "wx" });
        } catch (error) {
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
          throw error;
        }
        let released = false;
        return async function release() {
          if (released) return;
          released = true;
          let currentOwner;
          try { currentOwner = fs.readFileSync(ownerPath, "utf8").trim(); } catch { return; }
          if (currentOwner !== ownerId) return;
          try { fs.unlinkSync(ownerPath); } catch { return; }
          try { fs.rmdirSync(lockPath); } catch {}
        };
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        if (now() >= deadline) throw codedError("lock_timeout");
        await sleep(Math.min(retryMs, Math.max(0, deadline - now())));
      }
    }
  }

  async function runExclusive(operation) {
    const release = await acquire();
    try { return await operation(); } finally { await release(); }
  }

  return Object.freeze({ acquire, runExclusive, lockPath });
}

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
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    if (typeof fs.fchmodSync === "function") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
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
  const tokenLock = lock || createDirectoryLock({ fs, lockPath });

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
      atomicWrite(fs, envPath, nextContents);
      parsed = parseEnvironment(nextContents);
      relayToken = normalized;
      return relayToken;
    };
    return lockHeld ? commit() : tokenLock.runExclusive(commit);
  }

  return Object.freeze({
    current: () => relayToken,
    managementToken: () => managementToken,
    rotate,
    restore: rotate,
    lock: tokenLock,
  });
}

module.exports = {
  createDirectoryLock,
  createRelayTokenStore,
  normalizeToken,
  parseEnvironment,
};

"use strict";

const crypto = require("node:crypto");
const fsConstants = require("node:fs").constants;
const path = require("node:path");

const STORE_FILE = "wg-relay-secrets.json";
const LOCK_FILE = `${STORE_FILE}.lock`;
const STORE_VERSION = 3;
const MAX_RECOVERY_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 1024;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOCK_NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RETRY_CELL = new Int32Array(new SharedArrayBuffer(4));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createBlobMap(entries = []) {
  const values = Object.create(null);
  for (const [profileId, blob] of entries) values[profileId] = blob;
  return values;
}

function isCanonicalBase64(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function createEmptyStore() {
  return {
    version: STORE_VERSION,
    revision: 0,
    profiles: createBlobMap(),
    recovery: createBlobMap(),
  };
}

function createWgRelaySecretStore(options = {}) {
  const safeStorage = options.safeStorage;
  const userDataPath = options.userDataPath;
  const fileSystem = options.fs || require("node:fs");
  const platform = options.platform || process.platform;
  const lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : 5000;
  const lockRetryMs = Number.isFinite(options.lockRetryMs) ? options.lockRetryMs : 10;
  const staleLockMs = Number.isFinite(options.staleLockMs) ? options.staleLockMs : 0;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (milliseconds) => Atomics.wait(RETRY_CELL, 0, 0, milliseconds);
  const processAlive = typeof options.processAlive === "function"
    ? options.processAlive
    : (pid) => {
      if (pid === process.pid) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !!error && error.code !== "ESRCH";
      }
    };

  if (typeof userDataPath !== "string" || userDataPath.length === 0) {
    throw new TypeError("userDataPath must be a non-empty string");
  }
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0
      || !Number.isFinite(lockRetryMs) || lockRetryMs < 1
      || !Number.isFinite(staleLockMs) || staleLockMs < 0) {
    throw new TypeError("invalid secret store lock timing");
  }

  const filePath = path.join(userDataPath, STORE_FILE);
  const lockPath = path.join(userDataPath, LOCK_FILE);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  const noFollow = fsConstants.O_NOFOLLOW || 0;

  function isAvailable() {
    try {
      if (!safeStorage
          || typeof safeStorage.isEncryptionAvailable !== "function"
          || typeof safeStorage.encryptString !== "function"
          || typeof safeStorage.decryptString !== "function"
          || !safeStorage.isEncryptionAvailable()) {
        return false;
      }
      if (platform === "linux"
          && typeof safeStorage.getSelectedStorageBackend === "function"
          && safeStorage.getSelectedStorageBackend() === "basic_text") {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function assertAvailable() {
    if (!isAvailable()) {
      throw new Error("WireGuard relay secret encryption unavailable");
    }
  }

  function assertProfileId(profileId) {
    if (typeof profileId !== "string" || !PROFILE_ID_RE.test(profileId)) {
      throw new TypeError("profileId must be 1-64 characters [A-Za-z0-9_-]");
    }
  }

  function assertOwned(stat, label) {
    if (expectedUid !== null && stat.uid !== expectedUid) {
      throw new Error(`Unsafe WireGuard relay ${label}`);
    }
  }

  function assertSecureDirectory(stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe WireGuard relay userData directory");
    }
    assertOwned(stat, "userData directory");
    if (platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
      throw new Error("Unsafe WireGuard relay userData directory permissions");
    }
  }

  function assertSecureFile(stat, label) {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe WireGuard relay ${label}`);
    }
    assertOwned(stat, label);
    if (platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw new Error(`Unsafe WireGuard relay ${label} permissions`);
    }
  }

  function ensureUserDataDirectory() {
    try {
      fileSystem.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      const stat = fileSystem.lstatSync(userDataPath);
      assertSecureDirectory(stat);
      return stat;
    } catch (error) {
      if (error && /^Unsafe WireGuard relay/.test(error.message)) throw error;
      throw new Error("Unable to validate WireGuard relay userData directory");
    }
  }

  function lstatSecureFile(targetPath, label, allowMissing = false) {
    let stat;
    try {
      stat = fileSystem.lstatSync(targetPath);
    } catch (error) {
      if (allowMissing && error && error.code === "ENOENT") return null;
      throw new Error(`Unable to inspect WireGuard relay ${label}`);
    }
    assertSecureFile(stat, label);
    return stat;
  }

  function sameFile(left, right) {
    return left && right && left.dev === right.dev && left.ino === right.ino;
  }

  function readSecureFile(targetPath, label, maxBytes = Infinity) {
    ensureUserDataDirectory();
    const before = lstatSecureFile(targetPath, label, true);
    if (!before) return null;
    let fd;
    try {
      fd = fileSystem.openSync(targetPath, fsConstants.O_RDONLY | noFollow);
      const opened = fileSystem.fstatSync(fd);
      assertSecureFile(opened, label);
      if (!sameFile(before, opened) || opened.size > maxBytes) {
        throw new Error(`Unsafe WireGuard relay ${label}`);
      }
      return { serialized: fileSystem.readFileSync(fd, "utf8"), stat: opened };
    } catch (error) {
      if (error && /^Unsafe WireGuard relay/.test(error.message)) throw error;
      const wrapped = new Error(`Unable to read WireGuard relay ${label}`);
      if (error && error.code) wrapped.code = error.code;
      throw wrapped;
    } finally {
      if (fd !== undefined) {
        try { fileSystem.closeSync(fd); } catch (_) { /* best effort */ }
      }
    }
  }

  function serializeSecrets(secrets) {
    if (!isPlainObject(secrets)) {
      throw new TypeError("secrets must be a plain object");
    }
    try {
      const serialized = JSON.stringify(secrets);
      const roundTrip = JSON.parse(serialized);
      if (!isPlainObject(roundTrip)) throw new Error("invalid");
      return serialized;
    } catch (_) {
      throw new TypeError("secrets must be a plain object");
    }
  }

  function serializeRecovery(recovery) {
    if (!isPlainObject(recovery)) {
      throw new TypeError("recovery must be a plain object");
    }
    try {
      const serialized = JSON.stringify(recovery);
      const roundTrip = JSON.parse(serialized);
      if (!isPlainObject(roundTrip)
          || Buffer.byteLength(serialized, "utf8") > MAX_RECOVERY_BYTES) {
        throw new Error("invalid");
      }
      return serialized;
    } catch (_) {
      throw new TypeError("recovery must be a bounded plain object");
    }
  }

  function validateBlobMap(value) {
    if (!isPlainObject(value)) throw new Error("Corrupt secret store");
    const entries = Object.entries(value);
    for (const [profileId] of entries) {
      if (!PROFILE_ID_RE.test(profileId)) throw new Error("Corrupt secret store");
    }
    return createBlobMap(entries);
  }

  function hasExactKeys(value, keys) {
    return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  }

  function parseStore(serialized) {
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (_) {
      throw new Error("Corrupt secret store");
    }
    if (!isPlainObject(parsed) || ![1, 2, STORE_VERSION].includes(parsed.version)) {
      throw new Error("Corrupt secret store");
    }
    if (parsed.version === 1 && !hasExactKeys(parsed, ["version", "profiles"])) {
      throw new Error("Corrupt secret store");
    }
    if (parsed.version === 2 && !hasExactKeys(parsed, ["version", "profiles", "recovery"])) {
      throw new Error("Corrupt secret store");
    }
    if (parsed.version === STORE_VERSION
        && (!hasExactKeys(parsed, ["version", "revision", "profiles", "recovery"])
          || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) {
      throw new Error("Corrupt secret store");
    }
    return {
      version: STORE_VERSION,
      revision: parsed.version === STORE_VERSION ? parsed.revision : 0,
      profiles: validateBlobMap(parsed.profiles),
      recovery: parsed.version === 1 ? createBlobMap() : validateBlobMap(parsed.recovery),
    };
  }

  function loadStore() {
    const result = readSecureFile(filePath, "secret store");
    return result ? parseStore(result.serialized) : createEmptyStore();
  }

  function fsyncParentDirectory() {
    if (platform === "win32" || typeof fileSystem.fsyncSync !== "function") return;
    let directoryFd;
    try {
      directoryFd = fileSystem.openSync(
        userDataPath,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | noFollow,
      );
      assertSecureDirectory(fileSystem.fstatSync(directoryFd));
      fileSystem.fsyncSync(directoryFd);
    } catch (error) {
      if (!error || !["ENOSYS", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    } finally {
      if (directoryFd !== undefined) {
        try { fileSystem.closeSync(directoryFd); } catch (_) { /* best effort */ }
      }
    }
  }

  function cleanupOwnedTemp(tempPath, expectedStat) {
    if (!tempPath || !expectedStat) return;
    try {
      const current = fileSystem.lstatSync(tempPath);
      if (sameFile(current, expectedStat) && current.isFile() && !current.isSymbolicLink()) {
        fileSystem.unlinkSync(tempPath);
      }
    } catch (_) {
      // Only the unique inode created by this call may be removed.
    }
  }

  function persistStore(store) {
    ensureUserDataDirectory();
    const nextStore = {
      version: STORE_VERSION,
      revision: store.revision + 1,
      profiles: store.profiles,
      recovery: store.recovery,
    };
    const serialized = JSON.stringify(nextStore);
    const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(12).toString("base64url")}`;
    let fd;
    let tempStat;
    let renamed = false;
    try {
      fd = fileSystem.openSync(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600,
      );
      fileSystem.fchmodSync(fd, 0o600);
      tempStat = fileSystem.fstatSync(fd);
      assertSecureFile(tempStat, "secret store temporary file");
      fileSystem.writeFileSync(fd, serialized, { encoding: "utf8" });
      if (typeof fileSystem.fsyncSync === "function") fileSystem.fsyncSync(fd);
      fileSystem.closeSync(fd);
      fd = undefined;
      lstatSecureFile(filePath, "secret store", true);
      fileSystem.renameSync(tempPath, filePath);
      renamed = true;
      fsyncParentDirectory();
      return nextStore;
    } catch (_) {
      throw new Error("Unable to persist secret store");
    } finally {
      if (fd !== undefined) {
        try { fileSystem.closeSync(fd); } catch (_) { /* best effort */ }
      }
      if (!renamed) cleanupOwnedTemp(tempPath, tempStat);
    }
  }

  function parseLock(serialized) {
    let record;
    try { record = JSON.parse(serialized); }
    catch (_) {
      const error = new Error("Invalid WireGuard relay secret store lock record");
      error.code = "LOCK_RECORD_INVALID";
      throw error;
    }
    if (!isPlainObject(record)
        || !hasExactKeys(record, ["pid", "createdAt", "nonce"])
        || !Number.isSafeInteger(record.pid) || record.pid <= 0
        || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || typeof record.nonce !== "string" || !LOCK_NONCE_RE.test(record.nonce)) {
      const error = new Error("Invalid WireGuard relay secret store lock record");
      error.code = "LOCK_RECORD_INVALID";
      throw error;
    }
    return record;
  }

  function readLock() {
    const result = readSecureFile(lockPath, "secret store lock", MAX_LOCK_BYTES);
    return result ? { record: parseLock(result.serialized), stat: result.stat } : null;
  }

  function removeLockIfSame(expectedStat) {
    const current = lstatSecureFile(lockPath, "secret store lock", true);
    if (!current || !sameFile(current, expectedStat)) return false;
    fileSystem.unlinkSync(lockPath);
    fsyncParentDirectory();
    return true;
  }

  function acquireLock() {
    ensureUserDataDirectory();
    const deadline = now() + lockTimeoutMs;
    for (;;) {
      const nonce = crypto.randomBytes(18).toString("base64url");
      let fd;
      try {
        fd = fileSystem.openSync(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
          0o600,
        );
        fileSystem.fchmodSync(fd, 0o600);
        const stat = fileSystem.fstatSync(fd);
        assertSecureFile(stat, "secret store lock");
        fileSystem.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: now(), nonce }), "utf8");
        if (typeof fileSystem.fsyncSync === "function") fileSystem.fsyncSync(fd);
        fileSystem.closeSync(fd);
        fd = undefined;
        fsyncParentDirectory();
        return { nonce, stat };
      } catch (error) {
        if (fd !== undefined) {
          try { fileSystem.closeSync(fd); } catch (_) { /* best effort */ }
          try {
            const current = fileSystem.lstatSync(lockPath);
            if (current.isFile() && !current.isSymbolicLink()) fileSystem.unlinkSync(lockPath);
          } catch (_) { /* best effort for our failed create */ }
        }
        if (!error || error.code !== "EEXIST") {
          if (error && /^Unsafe WireGuard relay/.test(error.message)) throw error;
          throw new Error("Unable to acquire WireGuard relay secret store lock");
        }
      }

      let existing;
      try {
        existing = readLock();
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        if (!error || error.code !== "LOCK_RECORD_INVALID") throw error;
        if (now() >= deadline) {
          throw new Error("WireGuard relay secret store lock timeout");
        }
        sleep(Math.min(lockRetryMs, Math.max(1, deadline - now())));
        continue;
      }
      if (!existing) continue;
      const oldEnough = now() - existing.record.createdAt >= staleLockMs;
      let alive = true;
      try { alive = processAlive(existing.record.pid); }
      catch (_) { alive = true; }
      if (oldEnough && !alive) {
        removeLockIfSame(existing.stat);
        continue;
      }
      if (now() >= deadline) {
        throw new Error("WireGuard relay secret store lock timeout");
      }
      sleep(Math.min(lockRetryMs, Math.max(1, deadline - now())));
    }
  }

  function releaseLock(owned) {
    const current = readLock();
    if (!current
        || current.record.nonce !== owned.nonce
        || !sameFile(current.stat, owned.stat)
        || !removeLockIfSame(owned.stat)) {
      throw new Error("Unable to release WireGuard relay secret store lock");
    }
  }

  function withLock(operation) {
    const owned = acquireLock();
    try {
      return operation();
    } finally {
      releaseLock(owned);
    }
  }

  function encryptPayload(serialized, label) {
    try {
      const encrypted = safeStorage.encryptString(serialized);
      if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
        throw new Error("invalid encrypted value");
      }
      return Buffer.from(encrypted).toString("base64");
    } catch (_) {
      throw new Error(`Unable to encrypt WireGuard relay ${label}`);
    }
  }

  function decryptPayload(blob, label, maxBytes = Infinity) {
    try {
      if (!isCanonicalBase64(blob)) throw new Error("invalid encrypted value");
      const plaintext = safeStorage.decryptString(Buffer.from(blob, "base64"));
      if (typeof plaintext !== "string" || Buffer.byteLength(plaintext, "utf8") > maxBytes) {
        throw new Error("invalid decrypted value");
      }
      const value = JSON.parse(plaintext);
      if (!isPlainObject(value)) throw new Error("invalid decrypted value");
      return value;
    } catch (_) {
      throw new Error(`Unable to decrypt WireGuard relay ${label}`);
    }
  }

  function write(profileId, secrets) {
    assertProfileId(profileId);
    assertAvailable();
    const blob = encryptPayload(serializeSecrets(secrets), "secrets");
    withLock(() => {
      const store = loadStore();
      store.profiles[profileId] = blob;
      persistStore(store);
    });
  }

  function writeRecovery(profileId, recovery) {
    assertProfileId(profileId);
    assertAvailable();
    const blob = encryptPayload(serializeRecovery(recovery), "recovery");
    withLock(() => {
      const store = loadStore();
      store.recovery[profileId] = blob;
      persistStore(store);
    });
  }

  function preflight() {
    assertAvailable();
    const probe = '{"version":1,"probe":true}';
    try {
      const encrypted = safeStorage.encryptString(probe);
      if ((!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array))
          || safeStorage.decryptString(Buffer.from(encrypted)) !== probe) {
        throw new Error("invalid safeStorage roundtrip");
      }
    } catch (_) {
      throw new Error("Unable to verify WireGuard relay secret encryption");
    }
    withLock(() => persistStore(loadStore()));
    return true;
  }

  function read(profileId) {
    assertProfileId(profileId);
    assertAvailable();
    const store = loadStore();
    if (!Object.hasOwn(store.profiles, profileId)) return null;
    return decryptPayload(store.profiles[profileId], "secrets");
  }

  function readRecovery(profileId) {
    assertProfileId(profileId);
    assertAvailable();
    const store = loadStore();
    if (!Object.hasOwn(store.recovery, profileId)) return null;
    return decryptPayload(store.recovery[profileId], "recovery", MAX_RECOVERY_BYTES);
  }

  function listRecoveryIds() {
    return Object.keys(loadStore().recovery).sort();
  }

  function remove(profileId) {
    assertProfileId(profileId);
    return withLock(() => {
      const store = loadStore();
      if (!Object.hasOwn(store.profiles, profileId)) return false;
      delete store.profiles[profileId];
      persistStore(store);
      return true;
    });
  }

  function removeRecovery(profileId) {
    assertProfileId(profileId);
    return withLock(() => {
      const store = loadStore();
      if (!Object.hasOwn(store.recovery, profileId)) return false;
      delete store.recovery[profileId];
      persistStore(store);
      return true;
    });
  }

  function clear() {
    withLock(() => {
      ensureUserDataDirectory();
      const target = lstatSecureFile(filePath, "secret store", true);
      if (!target) return;
      try {
        fileSystem.unlinkSync(filePath);
        fsyncParentDirectory();
      } catch (_) {
        throw new Error("Unable to clear secret store");
      }
    });
  }

  return {
    isAvailable,
    preflight,
    write,
    read,
    remove,
    writeRecovery,
    readRecovery,
    removeRecovery,
    listRecoveryIds,
    clear,
  };
}

module.exports = {
  createWgRelaySecretStore,
  MAX_RECOVERY_BYTES,
  STORE_FILE,
};

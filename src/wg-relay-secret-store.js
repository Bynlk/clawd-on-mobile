"use strict";

const path = require("node:path");

const STORE_FILE = "wg-relay-secrets.json";
const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const MAX_RECOVERY_BYTES = 64 * 1024;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
  return { version: STORE_VERSION, profiles: createBlobMap(), recovery: createBlobMap() };
}

function createWgRelaySecretStore(options = {}) {
  const safeStorage = options.safeStorage;
  const userDataPath = options.userDataPath;
  const fileSystem = options.fs || require("node:fs");
  const platform = options.platform || process.platform;

  if (typeof userDataPath !== "string" || userDataPath.length === 0) {
    throw new TypeError("userDataPath must be a non-empty string");
  }

  const filePath = path.join(userDataPath, STORE_FILE);
  const tempPath = `${filePath}.tmp`;

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

  function validateBlobEntries(value) {
    if (!isPlainObject(value)) throw new Error("Corrupt secret store");
    const entries = Object.entries(value);
    for (const [profileId, blob] of entries) {
      if (!PROFILE_ID_RE.test(profileId) || !isCanonicalBase64(blob)) {
        throw new Error("Corrupt secret store");
      }
    }
    return entries;
  }

  function parseStore(serialized) {
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (_) {
      throw new Error("Corrupt secret store");
    }
    if (!isPlainObject(parsed)
        || ![LEGACY_STORE_VERSION, STORE_VERSION].includes(parsed.version)) {
      throw new Error("Corrupt secret store");
    }
    const profiles = validateBlobEntries(parsed.profiles);
    if (parsed.version === LEGACY_STORE_VERSION) {
      return { version: STORE_VERSION, profiles: createBlobMap(profiles), recovery: createBlobMap() };
    }
    const recovery = validateBlobEntries(parsed.recovery);
    return {
      version: STORE_VERSION,
      profiles: createBlobMap(profiles),
      recovery: createBlobMap(recovery),
    };
  }

  function loadStore() {
    if (!fileSystem.existsSync(filePath)) return createEmptyStore();
    let serialized;
    try {
      serialized = fileSystem.readFileSync(filePath, "utf8");
    } catch (_) {
      throw new Error("Unable to read secret store");
    }
    return parseStore(serialized);
  }

  function cleanupTemp() {
    try {
      if (fileSystem.existsSync(tempPath)) fileSystem.unlinkSync(tempPath);
    } catch (_) {
      // Best effort only. Never log paths or secret-store content.
    }
  }

  function fsyncParentDirectory() {
    if (platform === "win32" || typeof fileSystem.fsyncSync !== "function") return;
    let directoryFd;
    try {
      directoryFd = fileSystem.openSync(userDataPath, "r");
      fileSystem.fsyncSync(directoryFd);
      fileSystem.closeSync(directoryFd);
      directoryFd = undefined;
    } catch (error) {
      if (directoryFd !== undefined) {
        try { fileSystem.closeSync(directoryFd); } catch (_) { /* best effort */ }
      }
      if (!error || !["ENOSYS", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    }
  }

  function persistStore(store) {
    const serialized = JSON.stringify(store);
    let fd;
    try {
      fileSystem.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      fd = fileSystem.openSync(tempPath, "w", 0o600);
      fileSystem.writeFileSync(fd, serialized, { encoding: "utf8" });
      fileSystem.chmodSync(tempPath, 0o600);
      if (typeof fileSystem.fsyncSync === "function") {
        try {
          fileSystem.fsyncSync(fd);
        } catch (error) {
          if (!error || !["ENOSYS", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
        }
      }
      fileSystem.closeSync(fd);
      fd = undefined;
      fileSystem.renameSync(tempPath, filePath);
      fsyncParentDirectory();
    } catch (_) {
      if (fd !== undefined) {
        try { fileSystem.closeSync(fd); } catch (_) { /* best effort */ }
      }
      cleanupTemp();
      throw new Error("Unable to persist secret store");
    }
  }

  function write(profileId, secrets) {
    assertProfileId(profileId);
    assertAvailable();
    const serialized = serializeSecrets(secrets);
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(serialized);
      if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
        throw new Error("invalid encrypted value");
      }
    } catch (_) {
      throw new Error("Unable to encrypt WireGuard relay secrets");
    }
    const store = loadStore();
    store.profiles[profileId] = Buffer.from(encrypted).toString("base64");
    persistStore(store);
  }

  function writeRecovery(profileId, recovery) {
    assertProfileId(profileId);
    assertAvailable();
    const serialized = serializeRecovery(recovery);
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(serialized);
      if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
        throw new Error("invalid encrypted value");
      }
    } catch (_) {
      throw new Error("Unable to encrypt WireGuard relay recovery");
    }
    const store = loadStore();
    store.recovery[profileId] = Buffer.from(encrypted).toString("base64");
    persistStore(store);
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
    persistStore(loadStore());
    return true;
  }

  function read(profileId) {
    assertProfileId(profileId);
    assertAvailable();
    const store = loadStore();
    if (!Object.hasOwn(store.profiles, profileId)) return null;
    const blob = store.profiles[profileId];
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(blob, "base64"));
      const secrets = JSON.parse(plaintext);
      if (!isPlainObject(secrets)) throw new Error("invalid secrets");
      return secrets;
    } catch (_) {
      throw new Error("Unable to decrypt WireGuard relay secrets");
    }
  }

  function readRecovery(profileId) {
    assertProfileId(profileId);
    assertAvailable();
    const store = loadStore();
    if (!Object.hasOwn(store.recovery, profileId)) return null;
    const blob = store.recovery[profileId];
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(blob, "base64"));
      if (Buffer.byteLength(plaintext, "utf8") > MAX_RECOVERY_BYTES) throw new Error("invalid recovery");
      const recovery = JSON.parse(plaintext);
      if (!isPlainObject(recovery)) throw new Error("invalid recovery");
      return recovery;
    } catch (_) {
      throw new Error("Unable to decrypt WireGuard relay recovery");
    }
  }

  function listRecoveryIds() {
    return Object.keys(loadStore().recovery).sort();
  }

  function remove(profileId) {
    assertProfileId(profileId);
    const store = loadStore();
    if (!Object.hasOwn(store.profiles, profileId)) return false;
    delete store.profiles[profileId];
    persistStore(store);
    return true;
  }

  function removeRecovery(profileId) {
    assertProfileId(profileId);
    const store = loadStore();
    if (!Object.hasOwn(store.recovery, profileId)) return false;
    delete store.recovery[profileId];
    persistStore(store);
    return true;
  }

  function clear() {
    try {
      if (fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath);
      cleanupTemp();
    } catch (_) {
      throw new Error("Unable to clear secret store");
    }
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

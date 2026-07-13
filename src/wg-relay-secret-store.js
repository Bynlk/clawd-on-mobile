"use strict";

const path = require("node:path");

const STORE_FILE = "wg-relay-secrets.json";
const STORE_VERSION = 1;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createEmptyStore() {
  return { version: STORE_VERSION, profiles: {} };
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

  function parseStore(serialized) {
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (_) {
      throw new Error("Corrupt secret store");
    }
    if (!isPlainObject(parsed)
        || parsed.version !== STORE_VERSION
        || !isPlainObject(parsed.profiles)) {
      throw new Error("Corrupt secret store");
    }
    for (const [profileId, blob] of Object.entries(parsed.profiles)) {
      if (!PROFILE_ID_RE.test(profileId)
          || typeof blob !== "string"
          || blob.length === 0
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
        throw new Error("Corrupt secret store");
      }
    }
    return parsed;
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

  function read(profileId) {
    assertProfileId(profileId);
    assertAvailable();
    const store = loadStore();
    const blob = store.profiles[profileId];
    if (blob === undefined) return null;
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(blob, "base64"));
      const secrets = JSON.parse(plaintext);
      if (!isPlainObject(secrets)) throw new Error("invalid secrets");
      return secrets;
    } catch (_) {
      throw new Error("Unable to decrypt WireGuard relay secrets");
    }
  }

  function remove(profileId) {
    assertProfileId(profileId);
    const store = loadStore();
    if (store.profiles[profileId] === undefined) return false;
    delete store.profiles[profileId];
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

  return { isAvailable, write, read, remove, clear };
}

module.exports = {
  createWgRelaySecretStore,
  STORE_FILE,
};

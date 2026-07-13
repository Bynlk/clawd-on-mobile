"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createWgRelaySecretStore } = require("../src/wg-relay-secret-store");

const FILE_NAME = "wg-relay-secrets.json";

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-secret-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function xor(value) {
  return Buffer.from(value).map((byte) => byte ^ 0xaa);
}

function makeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => xor(plaintext),
    decryptString: (ciphertext) => xor(ciphertext).toString("utf8"),
    getSelectedStorageBackend: () => "keyring",
    ...overrides,
  };
}

test("write/read/remove stores only encrypted profile blobs", (t) => {
  const userDataPath = makeTempDir(t);
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(),
    userDataPath,
    fs,
    platform: "darwin",
  });
  const secrets = {
    pcConfig: "PrivateKey = secret",
    relayToken: "token",
  };

  store.write("wg-1", secrets);

  assert.deepEqual(store.read("wg-1"), secrets);
  const disk = fs.readFileSync(path.join(userDataPath, FILE_NAME), "utf8");
  assert.doesNotMatch(disk, /secret|token|PrivateKey/);

  store.remove("wg-1");
  assert.equal(store.read("wg-1"), null);
});

test("schema-valid Object prototype names can be written, reloaded, and removed", (t) => {
  const userDataPath = makeTempDir(t);
  const options = {
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  };
  const store = createWgRelaySecretStore(options);
  const ids = ["__proto__", "constructor", "toString"];

  for (const profileId of ids) {
    store.write(profileId, { relayToken: `secret-for-${profileId}` });
  }

  const reloaded = createWgRelaySecretStore(options);
  for (const profileId of ids) {
    assert.deepEqual(reloaded.read(profileId), { relayToken: `secret-for-${profileId}` });
    assert.equal(reloaded.remove(profileId), true);
    assert.equal(reloaded.read(profileId), null);
  }
});

test("missing Object prototype name IDs return null and false", (t) => {
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath: makeTempDir(t), fs, platform: "darwin",
  });

  for (const profileId of ["__proto__", "constructor", "toString"]) {
    assert.equal(store.read(profileId), null);
    assert.equal(store.remove(profileId), false);
  }
});

test("writes through a chmodded, fsynced temp file and renames atomically", (t) => {
  const userDataPath = makeTempDir(t);
  const calls = [];
  const trackedFs = {
    ...fs,
    openSync(file, flags, mode) {
      calls.push(["open", file, flags, mode]);
      return fs.openSync(file, flags, mode);
    },
    writeFileSync(file, data, options) {
      calls.push(["write"]);
      return fs.writeFileSync(file, data, options);
    },
    chmodSync(file, mode) {
      calls.push(["chmod", file, mode]);
      return fs.chmodSync(file, mode);
    },
    fsyncSync(fd) {
      calls.push(["fsync"]);
      return fs.fsyncSync(fd);
    },
    closeSync(fd) {
      calls.push(["close"]);
      return fs.closeSync(fd);
    },
    renameSync(from, to) {
      calls.push(["rename", from, to]);
      return fs.renameSync(from, to);
    },
  };
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(),
    userDataPath,
    fs: trackedFs,
    platform: "win32",
  });

  store.write("wg-1", { relayToken: "classified" });

  const target = path.join(userDataPath, FILE_NAME);
  const temp = `${target}.tmp`;
  assert.deepEqual(calls.map(([name]) => name), [
    "open", "write", "chmod", "fsync", "close", "rename",
  ]);
  assert.deepEqual(calls[0].slice(1), [temp, "w", 0o600]);
  assert.deepEqual(calls[2].slice(1), [temp, 0o600]);
  assert.deepEqual(calls[5].slice(1), [temp, target]);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(temp), false);
});

test("clear removes every encrypted profile", (t) => {
  const userDataPath = makeTempDir(t);
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });
  store.write("wg-1", { relayToken: "one" });
  store.write("wg-2", { relayToken: "two" });

  store.clear();

  assert.equal(store.read("wg-1"), null);
  assert.equal(store.read("wg-2"), null);
  assert.equal(fs.existsSync(path.join(userDataPath, FILE_NAME)), false);
});

test("corrupt store JSON fails closed", (t) => {
  const userDataPath = makeTempDir(t);
  fs.writeFileSync(path.join(userDataPath, FILE_NAME), "{not-json", { mode: 0o600 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });

  assert.throws(() => store.read("wg-1"), /corrupt secret store/i);
  assert.throws(() => store.write("wg-1", { relayToken: "new" }), /corrupt secret store/i);
});

test("malformed encrypted profile blob fails as corrupt store data", (t) => {
  const userDataPath = makeTempDir(t);
  fs.writeFileSync(path.join(userDataPath, FILE_NAME), JSON.stringify({
    version: 1,
    profiles: { "wg-1": "a" },
  }), { mode: 0o600 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });

  assert.throws(() => store.read("wg-1"), /corrupt secret store/i);
});

test("safeStorage decryption failures stay generic", (t) => {
  const userDataPath = makeTempDir(t);
  createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  }).write("wg-1", { relayToken: "never-log-this" });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage({
      decryptString() {
        throw new Error("backend-specific decryption details");
      },
    }),
    userDataPath,
    fs,
    platform: "darwin",
  });

  assert.throws(
    () => store.read("wg-1"),
    (error) => error.message === "Unable to decrypt WireGuard relay secrets",
  );
});

test("unavailable safeStorage rejects reads and writes", (t) => {
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage({ isEncryptionAvailable: () => false }),
    userDataPath: makeTempDir(t),
    fs,
    platform: "darwin",
  });

  assert.equal(store.isAvailable(), false);
  assert.throws(() => store.write("wg-1", { relayToken: "secret" }), /encryption unavailable/i);
  assert.throws(() => store.read("wg-1"), /encryption unavailable/i);
});

test("Linux basic_text backend is rejected", (t) => {
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
    userDataPath: makeTempDir(t),
    fs,
    platform: "linux",
  });

  assert.equal(store.isAvailable(), false);
  assert.throws(() => store.write("wg-1", { relayToken: "secret" }), /encryption unavailable/i);
});

test("future secure Linux safeStorage backends remain available", (t) => {
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage({ getSelectedStorageBackend: () => "future_secure_backend" }),
    userDataPath: makeTempDir(t),
    fs,
    platform: "linux",
  });

  assert.equal(store.isAvailable(), true);
});

test("rejects invalid ids and non-object secret payloads", (t) => {
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath: makeTempDir(t), fs, platform: "darwin",
  });

  for (const id of ["", "../escape", "has space", null]) {
    assert.throws(() => store.write(id, { relayToken: "x" }), /profileId/i);
  }
  for (const secrets of [null, [], "secret", Buffer.from("secret")]) {
    assert.throws(() => store.write("wg-1", secrets), /secrets must be a plain object/i);
  }
});

test("encryption failures do not log or expose plaintext secrets", (t) => {
  const plaintextSecret = "DO_NOT_LEAK_RELAY_TOKEN";
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  t.after(() => { console.error = originalError; });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage({
      encryptString(value) {
        throw new Error(`failed to encrypt ${value}`);
      },
    }),
    userDataPath: makeTempDir(t),
    fs,
    platform: "darwin",
  });

  let error;
  try {
    store.write("wg-1", { relayToken: plaintextSecret });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.doesNotMatch(error.message, new RegExp(plaintextSecret));
  assert.equal(messages.length, 0);
});

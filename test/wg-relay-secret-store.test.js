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

test("writes through a chmodded, fsynced temp file and renames atomically", (t) => {
  const userDataPath = makeTempDir(t);
  const calls = [];
  const trackedFs = {
    ...fs,
    chmodSync(file, mode) {
      calls.push(["chmod", file, mode]);
      return fs.chmodSync(file, mode);
    },
    fsyncSync(fd) {
      calls.push(["fsync"]);
      return fs.fsyncSync(fd);
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
  assert.ok(calls.some(([name, file, mode]) => name === "chmod" && file === temp && mode === 0o600));
  assert.ok(calls.some(([name]) => name === "fsync"));
  assert.ok(calls.some(([name, from, to]) => name === "rename" && from === temp && to === target));
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

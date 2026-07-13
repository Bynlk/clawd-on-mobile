"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { createWgRelaySecretStore } = require("../src/wg-relay-secret-store");

const FILE_NAME = "wg-relay-secrets.json";
const LOCK_NAME = `${FILE_NAME}.lock`;
const execFileAsync = promisify(execFile);

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

test("v1 stores remain readable and atomically migrate to v3 on the first recovery write", (t) => {
  const userDataPath = makeTempDir(t);
  const profileSecrets = { relayToken: "legacy-secret" };
  fs.writeFileSync(path.join(userDataPath, FILE_NAME), JSON.stringify({
    version: 1,
    profiles: {
      "wg-1": xor(JSON.stringify(profileSecrets)).toString("base64"),
    },
  }), { mode: 0o600 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });

  assert.deepEqual(store.read("wg-1"), profileSecrets);
  assert.deepEqual(store.listRecoveryIds(), []);
  store.writeRecovery("wg-1", { version: 1, phase: "prepared", operation: "deploy" });

  const disk = JSON.parse(fs.readFileSync(path.join(userDataPath, FILE_NAME), "utf8"));
  assert.equal(disk.version, 3);
  assert.equal(disk.revision, 1);
  assert.deepEqual(Object.keys(disk.profiles), ["wg-1"]);
  assert.deepEqual(Object.keys(disk.recovery), ["wg-1"]);
  assert.deepEqual(store.read("wg-1"), profileSecrets);
});

test("encrypted recovery records survive a new store instance and remove independently", (t) => {
  const userDataPath = makeTempDir(t);
  const options = {
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  };
  const first = createWgRelaySecretStore(options);
  const prepared = { version: 1, phase: "prepared", operation: "rotate" };
  const committed = {
    version: 1,
    phase: "remote_committed",
    operation: "rotate",
    candidate: { phoneConfig: "PrivateKey = RECOVERY_PRIVATE_KEY", relayToken: "RECOVERY_TOKEN" },
  };

  first.write("wg-1", { relayToken: "ACTIVE_TOKEN" });
  first.writeRecovery("wg-1", prepared);
  first.writeRecovery("wg-2", committed);

  const disk = fs.readFileSync(path.join(userDataPath, FILE_NAME), "utf8");
  for (const plaintext of ["ACTIVE_TOKEN", "RECOVERY_PRIVATE_KEY", "RECOVERY_TOKEN", "remote_committed"]) {
    assert.doesNotMatch(disk, new RegExp(plaintext));
  }
  const second = createWgRelaySecretStore(options);
  assert.deepEqual(second.listRecoveryIds(), ["wg-1", "wg-2"]);
  assert.deepEqual(second.readRecovery("wg-1"), prepared);
  assert.deepEqual(second.readRecovery("wg-2"), committed);
  assert.equal(second.removeRecovery("wg-1"), true);
  assert.equal(second.removeRecovery("wg-1"), false);
  assert.equal(second.readRecovery("wg-1"), null);
  assert.deepEqual(second.read("wg-1"), { relayToken: "ACTIVE_TOKEN" });
});

test("one malformed recovery entry blocks only its profile and survives unrelated writes", (t) => {
  const userDataPath = makeTempDir(t);
  const goodRecovery = { version: 1, phase: "prepared", operation: "deploy" };
  fs.writeFileSync(path.join(userDataPath, FILE_NAME), JSON.stringify({
    version: 2,
    profiles: { good: xor(JSON.stringify({ relayToken: "good-token" })).toString("base64") },
    recovery: {
      bad: "a",
      good: xor(JSON.stringify(goodRecovery)).toString("base64"),
    },
  }), { mode: 0o600 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });
  assert.deepEqual(store.listRecoveryIds(), ["bad", "good"]);
  assert.deepEqual(store.read("good"), { relayToken: "good-token" });
  assert.deepEqual(store.readRecovery("good"), goodRecovery);
  assert.throws(() => store.readRecovery("bad"), /decrypt WireGuard relay recovery/i);

  store.write("other", { relayToken: "other-token" });
  const diskAfterWrite = JSON.parse(fs.readFileSync(path.join(userDataPath, FILE_NAME), "utf8"));
  assert.equal(diskAfterWrite.recovery.bad, "a");
  assert.deepEqual(store.read("other"), { relayToken: "other-token" });
});

test("one undecryptable profile blob does not block good profiles", (t) => {
  const userDataPath = makeTempDir(t);
  fs.writeFileSync(path.join(userDataPath, FILE_NAME), JSON.stringify({
    version: 2,
    profiles: {
      bad: Buffer.from("not-an-xor-json").toString("base64"),
      good: xor(JSON.stringify({ relayToken: "good-token" })).toString("base64"),
    },
    recovery: {},
  }), { mode: 0o600 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });

  assert.deepEqual(store.read("good"), { relayToken: "good-token" });
  assert.throws(() => store.read("bad"), /decrypt WireGuard relay secrets/i);
  store.writeRecovery("good", { version: 1, phase: "prepared", operation: "deploy" });
  assert.throws(() => store.read("bad"), /decrypt WireGuard relay secrets/i);
});

test("an invalid decrypted recovery record remains isolated and redacted", (t) => {
  const userDataPath = makeTempDir(t);

  fs.writeFileSync(path.join(userDataPath, FILE_NAME), JSON.stringify({
    version: 2,
    profiles: {},
    recovery: { "wg-1": xor('"RECOVERY_PLAINTEXT"').toString("base64") },
  }), { mode: 0o600 });
  const invalidRecord = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });
  assert.throws(
    () => invalidRecord.readRecovery("wg-1"),
    (error) => error.message === "Unable to decrypt WireGuard relay recovery",
  );
});

test("preflight verifies safeStorage roundtrip and the atomic store path without adding a profile", (t) => {
  const userDataPath = makeTempDir(t);
  const calls = [];
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage({
      encryptString(plaintext) {
        calls.push("encrypt");
        return xor(plaintext);
      },
      decryptString(ciphertext) {
        calls.push("decrypt");
        return xor(ciphertext).toString("utf8");
      },
    }),
    userDataPath,
    fs: {
      ...fs,
      renameSync(from, to) {
        calls.push("rename");
        return fs.renameSync(from, to);
      },
    },
    platform: "darwin",
  });

  assert.equal(store.preflight(), true);
  assert.deepEqual(calls, ["encrypt", "decrypt", "rename"]);
  assert.equal(store.read("wg-1"), null);
  const disk = JSON.parse(fs.readFileSync(path.join(userDataPath, FILE_NAME), "utf8"));
  assert.deepEqual(Object.keys(disk.profiles), []);
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

test("writes through a unique no-follow exclusive temp and verifies its descriptor", (t) => {
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
    fchmodSync(fd, mode) {
      calls.push(["fchmod", mode]);
      return fs.fchmodSync(fd, mode);
    },
    fstatSync(fd) {
      calls.push(["fstat"]);
      return fs.fstatSync(fd);
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
    platform: "darwin",
  });

  store.write("wg-1", { relayToken: "classified" });

  const target = path.join(userDataPath, FILE_NAME);
  const temp = calls.find(([name, file]) => (
    name === "open" && typeof file === "string" && /\.tmp-[A-Za-z0-9_-]+$/.test(file)
  ))[1];
  const tempFlags = calls.find(([name, file]) => name === "open" && file === temp)[2];
  assert.match(path.basename(temp), /^wg-relay-secrets\.json\.tmp-[A-Za-z0-9_-]+$/);
  assert.equal(typeof tempFlags, "number");
  assert.notEqual(tempFlags & fs.constants.O_CREAT, 0);
  assert.notEqual(tempFlags & fs.constants.O_EXCL, 0);
  if (fs.constants.O_NOFOLLOW) assert.notEqual(tempFlags & fs.constants.O_NOFOLLOW, 0);
  assert.equal(calls.some(([name]) => name === "fchmod"), true);
  assert.equal(calls.some(([name]) => name === "fstat"), true);
  assert.deepEqual(calls.find(([name]) => name === "rename").slice(1), [temp, target]);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(temp), false);
});

test("store and lock symlinks fail closed without modifying their targets", (t) => {
  const userDataPath = makeTempDir(t);
  const outside = makeTempDir(t);
  const storeProbe = path.join(outside, "store-probe");
  const lockProbe = path.join(outside, "lock-probe");
  fs.writeFileSync(storeProbe, "STORE_PROBE", { mode: 0o600 });
  fs.symlinkSync(storeProbe, path.join(userDataPath, FILE_NAME));
  let store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
    lockTimeoutMs: 20, lockRetryMs: 1,
  });
  assert.throws(() => store.write("wg-1", { relayToken: "secret" }), /secret store|persist/i);
  assert.equal(fs.readFileSync(storeProbe, "utf8"), "STORE_PROBE");

  fs.unlinkSync(path.join(userDataPath, FILE_NAME));
  fs.writeFileSync(lockProbe, "LOCK_PROBE", { mode: 0o600 });
  fs.symlinkSync(lockProbe, path.join(userDataPath, LOCK_NAME));
  store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
    lockTimeoutMs: 20, lockRetryMs: 1,
  });
  assert.throws(() => store.write("wg-1", { relayToken: "secret" }), /lock|persist/i);
  assert.equal(fs.readFileSync(lockProbe, "utf8"), "LOCK_PROBE");
});

test("an attacker-owned fixed tmp symlink is neither followed nor cleaned", (t) => {
  const userDataPath = makeTempDir(t);
  const outside = makeTempDir(t);
  const probe = path.join(outside, "probe");
  const legacyTemp = path.join(userDataPath, `${FILE_NAME}.tmp`);
  fs.writeFileSync(probe, "TMP_PROBE", { mode: 0o600 });
  fs.symlinkSync(probe, legacyTemp);
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });

  store.write("wg-1", { relayToken: "secret" });

  assert.equal(fs.readFileSync(probe, "utf8"), "TMP_PROBE");
  assert.equal(fs.lstatSync(legacyTemp).isSymbolicLink(), true);
});

test("target and userData permissions or file type fail closed", (t) => {
  const userDataPath = makeTempDir(t);
  const target = path.join(userDataPath, FILE_NAME);
  fs.writeFileSync(target, "{}", { mode: 0o644 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });
  assert.throws(() => store.read("wg-1"), /secret store/i);
  assert.equal(fs.readFileSync(target, "utf8"), "{}");

  fs.unlinkSync(target);
  fs.mkdirSync(target, { mode: 0o700 });
  assert.throws(() => store.write("wg-1", { relayToken: "secret" }), /secret store|persist/i);
  fs.rmSync(target, { recursive: true });
  fs.chmodSync(userDataPath, 0o777);
  assert.throws(() => store.write("wg-1", { relayToken: "secret" }), /userData|secret store|persist/i);
});

test("a live lock times out fail-closed and a dead stale lock is recovered", (t) => {
  const userDataPath = makeTempDir(t);
  const lockPath = path.join(userDataPath, LOCK_NAME);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, createdAt: Date.now(), nonce: "live-lock",
  }), { mode: 0o600 });
  const blocked = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
    lockTimeoutMs: 20, lockRetryMs: 1,
    processAlive: () => true,
  });
  assert.throws(() => blocked.write("wg-1", { relayToken: "secret" }), /lock|persist/i);
  assert.equal(fs.existsSync(path.join(userDataPath, FILE_NAME)), false);

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647, createdAt: 0, nonce: "stale-lock",
  }), { mode: 0o600 });
  const recovered = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
    staleLockMs: 0,
    processAlive: () => false,
  });
  recovered.write("wg-1", { relayToken: "secret" });
  assert.deepEqual(recovered.read("wg-1"), { relayToken: "secret" });
  assert.equal(fs.existsSync(lockPath), false);
});

test("24 independent writers preserve every profile and recovery record", async (t) => {
  const userDataPath = makeTempDir(t);
  const modulePath = path.resolve(__dirname, "../src/wg-relay-secret-store.js");
  const childScript = `
    const { createWgRelaySecretStore } = require(process.argv[1]);
    const root = process.argv[2];
    const id = process.argv[3];
    const xor = (value) => Buffer.from(value).map((byte) => byte ^ 0xaa);
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => xor(value),
      decryptString: (value) => xor(value).toString("utf8"),
      getSelectedStorageBackend: () => "keyring",
    };
    const store = createWgRelaySecretStore({ safeStorage, userDataPath: root, platform: process.platform });
    store.write(id, { relayToken: "token-" + id });
    store.writeRecovery(id, { version: 1, phase: "prepared", operation: "deploy" });
  `;

  await Promise.all(Array.from({ length: 24 }, (_, index) => {
    const id = `wg-${index}`;
    return execFileAsync(process.execPath, ["-e", childScript, modulePath, userDataPath, id], {
      timeout: 10000,
    });
  }));

  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });
  assert.equal(store.listRecoveryIds().length, 24);
  for (let index = 0; index < 24; index += 1) {
    assert.deepEqual(store.read(`wg-${index}`), { relayToken: `token-wg-${index}` });
    assert.equal(store.readRecovery(`wg-${index}`).phase, "prepared");
  }
  const disk = JSON.parse(fs.readFileSync(path.join(userDataPath, FILE_NAME), "utf8"));
  assert.equal(disk.version, 3);
  assert.equal(disk.revision, 48);
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

test("malformed encrypted profile blob fails only that profile", (t) => {
  const userDataPath = makeTempDir(t);
  fs.writeFileSync(path.join(userDataPath, FILE_NAME), JSON.stringify({
    version: 1,
    profiles: { "wg-1": "a" },
  }), { mode: 0o600 });
  const store = createWgRelaySecretStore({
    safeStorage: makeSafeStorage(), userDataPath, fs, platform: "darwin",
  });

  assert.throws(() => store.read("wg-1"), /decrypt WireGuard relay secrets/i);
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

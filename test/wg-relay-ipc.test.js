"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  registerWgRelayIpc,
  requestPhoneRotation,
} = require("../src/wg-relay-ipc");
const { createWgRelayRuntime } = require("../src/wg-relay-runtime");
const { createWgRelaySecretStore } = require("../src/wg-relay-secret-store");

const PROFILE = {
  id: "wg-1",
  label: "My VPS",
  host: "8.8.8.8",
  sshUsername: "deploy",
  sshPort: 2222,
  authMethod: "password",
  wgPort: 51820,
  wgSubnet: "10.8.0.0/24",
  endpoint: "8.8.8.8:51820",
  relayAddr: "ws://10.8.0.1:7891",
};
const FINGERPRINT = `SHA256:${Buffer.alloc(32, 9).toString("base64")}`;
const PC_KEY = Buffer.alloc(32, 1).toString("base64");
const PHONE_KEY = Buffer.alloc(32, 2).toString("base64");
const SERVER_KEY = Buffer.alloc(32, 3).toString("base64");
const RELAY_TOKEN = "11".repeat(32);
const MANAGEMENT_TOKEN = "22".repeat(32);

function config(address, privateKey, endpoint = "8.8.8.8:51820") {
  return [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${address}`,
    "",
    "[Peer]",
    `PublicKey = ${SERVER_KEY}`,
    `Endpoint = ${endpoint}`,
    "AllowedIPs = 10.8.0.0/24",
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function readback(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: "8.8.8.8:51820",
    subnet: "10.8.0.0/24",
    relayUrl: "ws://10.8.0.1:7891",
    pcConfig: config("10.8.0.2/32", PC_KEY),
    phoneConfig: config("10.8.0.3/32", PHONE_KEY),
    relayToken: RELAY_TOKEN,
    managementToken: MANAGEMENT_TOKEN,
    ...overrides,
  };
}

function secretValue(overrides = {}) {
  const value = readback(overrides);
  return {
    pcConfig: value.pcConfig,
    phoneConfig: value.phoneConfig,
    relayToken: value.relayToken,
    managementToken: value.managementToken,
    relayUrl: value.relayUrl,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}

function xor(value) {
  return Buffer.from(value).map((byte) => byte ^ 0xaa);
}

function realSecretStore(userDataPath) {
  return createWgRelaySecretStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext) => xor(plaintext),
      decryptString: (ciphertext) => xor(ciphertext).toString("utf8"),
      getSelectedStorageBackend: () => "keyring",
    },
    userDataPath,
    fs,
    platform: "darwin",
  });
}

function sharedSettings(initialProfiles) {
  let profiles = structuredClone(initialProfiles);
  return {
    getSnapshot: () => ({ wgRelay: { profiles: structuredClone(profiles) } }),
    async applyCommand(action, payload) {
      if (action === "wgRelay.add") profiles.push(structuredClone(payload));
      if (action === "wgRelay.update") {
        const index = profiles.findIndex((profile) => profile.id === payload.id);
        if (index === -1) return { status: "error" };
        profiles[index] = structuredClone(payload);
      }
      if (action === "wgRelay.remove") profiles = profiles.filter((profile) => profile.id !== payload.id);
      return { status: "ok" };
    },
  };
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`missing handler ${channel}`);
      return listener({}, payload);
    },
  };
}

function fakeBrowserWindow() {
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload: structuredClone(payload) }),
    },
  };
  return { BrowserWindow: { getAllWindows: () => [window] }, sent };
}

function fixture(options = {}) {
  const ipcMain = fakeIpcMain();
  const { BrowserWindow, sent } = fakeBrowserWindow();
  const runtime = createWgRelayRuntime();
  let profiles = structuredClone(options.profiles || []);
  const publicWrites = [];
  const defaultSettingsController = {
    getSnapshot: () => ({ wgRelay: { profiles: structuredClone(profiles) } }),
    async applyCommand(action, payload) {
      publicWrites.push({ action, payload: structuredClone(payload) });
      if (options.publicWrite) {
        const result = await options.publicWrite(action, payload, profiles);
        if (result) return result;
      }
      if (action === "wgRelay.add") profiles.push(structuredClone(payload));
      if (action === "wgRelay.update") {
        const index = profiles.findIndex((profile) => profile.id === payload.id);
        if (index === -1) return { status: "error" };
        profiles[index] = structuredClone(payload);
      }
      if (action === "wgRelay.remove") {
        const id = typeof payload === "string" ? payload : payload.id;
        profiles = profiles.filter((profile) => profile.id !== id);
      }
      return { status: "ok" };
    },
  };
  const settingsController = options.settingsController || defaultSettingsController;
  const stored = new Map(Object.entries(options.secrets || {}).map(([id, value]) => [id, structuredClone(value)]));
  const recovery = new Map(Object.entries(options.recovery || {}).map(([id, value]) => [id, structuredClone(value)]));
  const secretCalls = [];
  const fakeSecretStore = {
    isAvailable: () => options.secretAvailable !== false,
    preflight() {
      secretCalls.push(["preflight"]);
      if (options.secretPreflight) return options.secretPreflight(stored);
      if (options.secretAvailable === false) throw new Error("unavailable");
      return true;
    },
    write(id, value) {
      secretCalls.push(["write", id, structuredClone(value)]);
      if (options.secretWrite) return options.secretWrite(id, value, stored);
      stored.set(id, structuredClone(value));
    },
    read(id) {
      secretCalls.push(["read", id]);
      if (options.secretRead) return options.secretRead(id, stored);
      return stored.has(id) ? structuredClone(stored.get(id)) : null;
    },
    remove(id) {
      secretCalls.push(["remove", id]);
      if (options.secretRemove) return options.secretRemove(id, stored);
      return stored.delete(id);
    },
    writeRecovery(id, value) {
      secretCalls.push(["writeRecovery", id, structuredClone(value)]);
      if (options.recoveryWrite) return options.recoveryWrite(id, value, recovery);
      recovery.set(id, structuredClone(value));
    },
    readRecovery(id) {
      secretCalls.push(["readRecovery", id]);
      if (options.recoveryRead) return options.recoveryRead(id, recovery);
      return recovery.has(id) ? structuredClone(recovery.get(id)) : null;
    },
    removeRecovery(id) {
      secretCalls.push(["removeRecovery", id]);
      if (options.recoveryRemove) return options.recoveryRemove(id, recovery);
      return recovery.delete(id);
    },
    listRecoveryIds() {
      secretCalls.push(["listRecoveryIds"]);
      if (options.recoveryList) return options.recoveryList(recovery);
      return Array.from(recovery.keys()).sort();
    },
  };
  const secretStore = options.secretStore || fakeSecretStore;
  const connectionCalls = [];
  const states = new Map(Object.entries(options.states || {}));
  const setState = (id, status) => {
    const state = runtime.setStatus(id, {
      status,
      generation: (states.get(id)?.generation || 0) + 1,
      message: null,
      hint: null,
    });
    states.set(id, state);
    return state;
  };
  const connection = {
    async connect(id) {
      connectionCalls.push(["connect", id]);
      if (options.connect) return options.connect(id, { states, setState });
      return setState(id, "connected");
    },
    async disconnect(id) {
      connectionCalls.push(["disconnect", id]);
      if (options.disconnect) return options.disconnect(id, { states, setState });
      return setState(id, "idle");
    },
    status(id) {
      return states.get(id) || runtime.getProfileStatus(id);
    },
  };
  const qrCalls = [];
  const qrEncoder = async ({ profile, secrets }) => {
    qrCalls.push({ profile: structuredClone(profile), secrets: structuredClone(secrets) });
    if (options.qrEncoder) return options.qrEncoder({ profile, secrets });
    return { version: 1, dataUrl: `data:image/png;base64,${secrets.relayToken.slice(0, 8)}` };
  };
  const dialogCalls = [];
  const dialog = {
    async showMessageBox(messageOptions) {
      dialogCalls.push(structuredClone(messageOptions));
      return { response: options.dialogResponse === undefined ? 1 : options.dialogResponse };
    },
  };
  const logs = [];
  const deployCalls = [];
  const deployFn = options.deployFn || (async (args) => {
    deployCalls.push(args);
    return { ok: true, readback: readback(), acceptedFingerprint: FINGERPRINT };
  });
  const ipc = registerWgRelayIpc({
    ipcMain,
    settingsController,
    wgRelayRuntime: runtime,
    BrowserWindow,
    secretStore,
    connection,
    dialog,
    deployFn,
    qrEncoder,
    rotatePhoneFn: options.rotatePhoneFn,
    getForwardEndpoint: options.getForwardEndpoint || (() => "127.0.0.1:43127"),
    now: options.now || (() => 1_783_900_800_000),
    log: (...parts) => logs.push(parts.join(" ")),
  });
  return {
    connection, connectionCalls, deployCalls, dialogCalls, ipc, ipcMain, logs,
    profiles: () => structuredClone(profiles), publicWrites, qrCalls, recovery, runtime,
    secretCalls, secretStore, sent, states, stored,
  };
}

function assertNoSecrets(value, extra = []) {
  const serialized = JSON.stringify(value);
  for (const secret of [PC_KEY, PHONE_KEY, RELAY_TOKEN, MANAGEMENT_TOKEN, ...extra]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

test("registers the exact Task 6 contract and dispose removes handlers/listeners", async () => {
  const fx = fixture({ profiles: [PROFILE] });
  for (const channel of [
    "wgRelay:deploy", "wgRelay:connect", "wgRelay:disconnect", "wgRelay:rotate-phone",
    "wgRelay:delete-local", "wgRelay:pairing-qr", "wgRelay:status", "wgRelay:list-statuses",
  ]) assert.equal(fx.ipcMain.handlers.has(channel), true, channel);

  fx.runtime.setStatus("wg-1", { status: "connected", generation: 1 });
  assert.equal(fx.sent.length, 1);
  await fx.ipc.dispose();
  assert.equal(fx.ipcMain.handlers.size, 0);
  fx.runtime.setStatus("wg-1", { status: "failed", generation: 2 });
  assert.equal(fx.sent.length, 1);
});

test("deploy sanitizes profile, confirms TOFU, persists/reads secrets before public commit, connects, and returns only public data", async () => {
  const password = "TASK6-SSH-PASSWORD";
  const order = [];
  let fx;
  const request = {
    profile: { ...PROFILE, password: "PROFILE-SECRET", managementToken: MANAGEMENT_TOKEN },
    password,
  };
  fx = fixture({
    secretPreflight() { order.push("secret-preflight"); },
    recoveryWrite(_id, value, journal) {
      order.push(`recovery-${value.phase}`);
      journal.set("wg-1", structuredClone(value));
    },
    recoveryRemove(_id, journal) { order.push("recovery-remove"); return journal.delete("wg-1"); },
    secretWrite(id, value, stored) { order.push("secret-write"); stored.set(id, structuredClone(value)); },
    secretRead(id, stored) { order.push("secret-read"); return structuredClone(stored.get(id)); },
    publicWrite() { order.push("public-write"); },
    connect(id, { setState }) { order.push("connect"); return setState(id, "connected"); },
    qrEncoder({ secrets }) { order.push("qr"); return { version: 1, dataUrl: `data:image/png;base64,${secrets.relayToken.slice(0, 4)}` }; },
    async deployFn(args) {
      order.push("ssh-deploy");
      assert.equal(args.password, password);
      assert.equal(Object.hasOwn(args.profile, "password"), false);
      assert.equal(await args.deps.confirmHostKey({ fingerprint: FINGERPRINT, host: PROFILE.host, port: 2222 }), true);
      args.deps.runtime.emitProgress({
        profileId: PROFILE.id, step: "install", status: "start", message: password,
      });
      return { ok: true, readback: readback(), acceptedFingerprint: FINGERPRINT };
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", request);

  assert.deepEqual(order, [
    "secret-read", "secret-preflight", "recovery-prepared", "ssh-deploy",
    "recovery-remote_committed", "secret-write", "secret-read", "public-write",
    "recovery-remove", "secret-read", "connect", "qr",
  ]);
  assert.equal(fx.dialogCalls.length, 1);
  assert.match(fx.dialogCalls[0].detail, new RegExp(FINGERPRINT.replace("+", "\\+")));
  assert.equal(result.status, "ok");
  assert.equal(result.state.status, "connected");
  assert.equal(result.profile.sshHostFingerprint, FINGERPRINT);
  assert.match(result.qr.dataUrl, /^data:image\/png;base64,/);
  assert.equal(Object.hasOwn(result, "readback"), false);
  assert.equal(Object.hasOwn(request, "password"), false);
  assertNoSecrets({ result, writes: fx.publicWrites, events: fx.sent, logs: fx.logs }, [password, "PROFILE-SECRET"]);
  assert.equal(fx.sent.find((entry) => entry.channel === "wgRelay:progress").payload.message, undefined);
});

test("TOFU rejection and known-key mismatch are stable and never expose an override shortcut", async () => {
  const rejected = fixture({
    dialogResponse: 0,
    profiles: [PROFILE],
    async deployFn(args) {
      const confirmed = await args.deps.confirmHostKey({ fingerprint: FINGERPRINT, host: PROFILE.host, port: 2222 });
      return confirmed
        ? { ok: true, readback: readback(), acceptedFingerprint: FINGERPRINT }
        : { ok: false, step: "host-key", reason: "host_key_unconfirmed", hint: "wgErrHostKeyUnconfirmed" };
    },
  });
  const rejectedResult = await rejected.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });
  assert.deepEqual(rejectedResult, {
    status: "error", errorCode: "deploy_failed", step: "host-key",
    reason: "host_key_unconfirmed", hint: "wgErrHostKeyUnconfirmed",
  });
  assert.equal(rejected.publicWrites.length, 0);

  const mismatch = fixture({
    profiles: [{ ...PROFILE, sshHostFingerprint: FINGERPRINT }],
    deployFn: async () => ({
      ok: false, step: "host-key", reason: "host_key_changed", hint: "wgErrHostKeyChanged",
      message: "changed secret fingerprint",
    }),
  });
  const mismatchResult = await mismatch.ipcMain.invoke("wgRelay:deploy", {
    profile: { ...PROFILE, sshHostFingerprint: FINGERPRINT }, password: "secret",
  });
  assert.equal(mismatchResult.reason, "host_key_changed");
  assert.equal(mismatch.dialogCalls.length, 0);
  assert.equal(Object.hasOwn(mismatchResult, "message"), false);
});

test("deploy failures allowlist structured codes instead of copying secret-like values", async () => {
  const sshPassword = "SSH-PASSWORD-MUST-NOT-LEAK";
  const fx = fixture({
    deployFn: async () => ({
      ok: false,
      remoteCommitted: false,
      step: RELAY_TOKEN,
      reason: sshPassword,
      hint: RELAY_TOKEN,
      message: PC_KEY,
    }),
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: sshPassword });

  assert.deepEqual(result, { status: "error", errorCode: "deploy_failed" });
  assert.equal(fx.recovery.has("wg-1"), false);
  assert.deepEqual(
    fx.secretCalls.filter(([name]) => name === "writeRecovery" || name === "removeRecovery").map(([name]) => name),
    ["writeRecovery", "removeRecovery"],
  );
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs }, [sshPassword]);
});

test("deploy journals a remote-committed raw candidate before rejecting its topology", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const invalidPhoneConfig = config("10.8.0.4/32", Buffer.alloc(32, 4).toString("base64"));
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    async deployFn() {
      return {
        ok: false,
        remoteCommitted: true,
        rawReadback: readback({ phoneConfig: invalidPhoneConfig }),
        acceptedFingerprint: FINGERPRINT,
        step: "validate",
      };
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  const journal = fx.recovery.get("wg-1");
  assert.equal(journal.phase, "remote_committed_invalid_response");
  assert.equal(journal.candidate.readback.phoneConfig, invalidPhoneConfig);
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
});

test("deploy keeps prepared recovery after an ambiguous transport failure", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    async deployFn() {
      return { ok: false, step: "install", message: "connection lost after remote execution" };
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.equal(fx.recovery.get("wg-1").phase, "prepared");
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.deepEqual(fx.connectionCalls, []);
});

test("deploy journals then rejects a success readback with invalid non-pairing secrets", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const invalidReadback = readback({
    pcConfig: "[Interface]\nPrivateKey = invalid",
    managementToken: "not-a-management-token",
  });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    async deployFn() { return { ok: true, readback: invalidReadback }; },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.equal(fx.recovery.get("wg-1").phase, "remote_committed_invalid_response");
  assert.equal(fx.recovery.get("wg-1").candidate.readback.managementToken, "not-a-management-token");
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.publicWrites, []);
  assert.deepEqual(fx.connectionCalls, []);
});

test("restart does not forward an incomplete deploy candidate from the encrypted journal", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    recovery: {
      "wg-1": {
        version: 1,
        phase: "remote_committed",
        operation: "deploy",
        profile: PROFILE,
        candidate: {
          acceptedFingerprint: null,
          readback: readback({ managementToken: "invalid" }),
        },
      },
    },
    connect() { throw new Error("old credentials must remain blocked"); },
  });

  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.connectionCalls, []);
  assert.equal(fx.recovery.get("wg-1").phase, "remote_committed");
});

test("deploy ok without a usable readback keeps a durable invalid-response candidate", async () => {
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue({ relayToken: "33".repeat(32) }) },
    async deployFn() { return { ok: true, acceptedFingerprint: FINGERPRINT }; },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.equal(fx.recovery.get("wg-1").phase, "remote_committed_invalid_response");
  assert.equal(Object.hasOwn(fx.recovery.get("wg-1").candidate, "readback"), false);
});

test("oversized committed deploy candidate disconnects stale credentials and clears old QR", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async deployFn() {
      return { ok: true, readback: { oversized: "x".repeat(49 * 1024) } };
    },
  });
  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(oldQr.status, "ok");

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.equal(fx.recovery.get("wg-1").phase, "prepared");
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
});

test("deploy commitPoint keeps new secrets/public state and clears old QR when QR generation fails", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const oldProfile = {
    ...PROFILE, sshHostFingerprint: FINGERPRINT,
    endpoint: "8.8.8.8:51820", relayAddr: "ws://10.8.0.1:7891",
    lastDeployedAt: 100, deployVersion: 1,
  };
  const fx = fixture({
    profiles: [oldProfile],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 3 } },
    qrEncoder({ secrets }) {
      if (secrets.relayToken === RELAY_TOKEN) throw new Error(`QR failed ${RELAY_TOKEN}`);
      return { version: 1, dataUrl: "data:image/png;base64,OLD" };
    },
  });
  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(oldQr.qr.dataUrl, "data:image/png;base64,OLD");

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "pairing_qr_retry_required");
  assert.deepEqual(fx.stored.get("wg-1"), secretValue());
  assert.notDeepEqual(fx.profiles(), [oldProfile]);
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"], ["connect", "wg-1"]]);
  const cached = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.deepEqual(cached, { status: "error", errorCode: "pairing_qr_failed" });
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs });
});

test("duplicate deploys for one profile coalesce", async () => {
  const gate = deferred();
  let deployCount = 0;
  const coalesced = fixture({
    async deployFn() {
      deployCount += 1;
      await gate.promise;
      return { ok: true, readback: readback(), acceptedFingerprint: FINGERPRINT };
    },
  });
  const firstPayload = { profile: PROFILE, password: "one" };
  const secondPayload = { profile: PROFILE, password: "two" };
  const first = coalesced.ipcMain.invoke("wgRelay:deploy", firstPayload);
  const second = coalesced.ipcMain.invoke("wgRelay:deploy", secondPayload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deployCount, 1);
  gate.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(Object.hasOwn(firstPayload, "password"), false);
  assert.equal(Object.hasOwn(secondPayload, "password"), false);
});

test("queued rotate uses the committed public profile instead of its pre-queue snapshot", async () => {
  const gate = deferred();
  const newEndpoint = "relay.example.com:51820";
  const newProfile = { ...PROFILE, label: "New VPS", host: "relay.example.com" };
  const newReadback = readback({
    endpoint: newEndpoint,
    pcConfig: config("10.8.0.2/32", PC_KEY, newEndpoint),
    phoneConfig: config("10.8.0.3/32", PHONE_KEY, newEndpoint),
  });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue() },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async deployFn() {
      await gate.promise;
      return { ok: true, readback: newReadback, acceptedFingerprint: FINGERPRINT };
    },
    async rotatePhoneFn() {
      return {
        version: 1,
        phoneConfig: config("10.8.0.3/32", Buffer.alloc(32, 4).toString("base64"), newEndpoint),
        relayToken: "44".repeat(32),
      };
    },
  });

  const deploying = fx.ipcMain.invoke("wgRelay:deploy", { profile: newProfile, password: "secret" });
  await new Promise((resolve) => setImmediate(resolve));
  const rotating = fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });
  gate.resolve();

  assert.equal((await deploying).status, "ok");
  assert.equal((await rotating).status, "ok");
  assert.equal(fx.stored.get("wg-1").relayToken, "44".repeat(32));
});

test("deploy commitPoint keeps a failed durable bundle in recovery and retries locally without SSH", async () => {
  let failVerification = true;
  let deployCount = 0;
  const fx = fixture({
    secretRead(id, stored) {
      if (failVerification && stored.has(id)) throw new Error("verification unavailable");
      return stored.has(id) ? structuredClone(stored.get(id)) : null;
    },
    async deployFn() {
      deployCount += 1;
      return { ok: true, readback: readback(), acceptedFingerprint: FINGERPRINT };
    },
  });

  const first = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });
  assert.equal(first.status, "partial_success");
  assert.equal(first.errorCode, "local_storage_retry_required");
  assert.equal(fx.publicWrites.length, 0);
  assert.equal(fx.connectionCalls.length, 0);
  assertNoSecrets(first);

  failVerification = false;
  const retried = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "unused" });
  assert.equal(retried.status, "ok");
  assert.equal(deployCount, 1);
  assert.deepEqual(fx.stored.get("wg-1"), secretValue());
  assert.equal(fx.connection.status("wg-1").status, "connected");
  assertNoSecrets(retried);
});

test("a new IPC instance forwards a durable deploy candidate before any old credential attempt", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-ipc-recovery-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const diskStoreA = realSecretStore(userDataPath);
  diskStoreA.write("wg-1", oldSecrets);
  const failingStoreA = {
    ...diskStoreA,
    write() { throw new Error("simulated post-commit disk failure"); },
  };
  const settingsController = sharedSettings([PROFILE]);
  const instanceA = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: failingStoreA,
  });

  const committed = await instanceA.ipcMain.invoke("wgRelay:deploy", {
    profile: PROFILE,
    password: "secret",
  });
  assert.equal(committed.errorCode, "local_storage_retry_required");
  assert.equal(diskStoreA.readRecovery("wg-1").phase, "remote_committed");

  const diskStoreB = realSecretStore(userDataPath);
  let oldCredentialAttempted = false;
  const instanceB = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: diskStoreB,
    connect(id, { setState }) {
      if (diskStoreB.read(id).relayToken === oldSecrets.relayToken) oldCredentialAttempted = true;
      return setState(id, "connected");
    },
  });

  const connected = await instanceB.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });

  assert.equal(connected.status, "ok");
  assert.equal(oldCredentialAttempted, false);
  assert.equal(diskStoreB.read("wg-1").relayToken, RELAY_TOKEN);
  assert.equal(diskStoreB.readRecovery("wg-1"), null);
});

test("a prepared durable tombstone blocks old credentials after restart", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-ipc-prepared-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const diskStore = realSecretStore(userDataPath);
  diskStore.write("wg-1", secretValue({ relayToken: "33".repeat(32) }));
  diskStore.writeRecovery("wg-1", {
    version: 1,
    phase: "prepared",
    operation: "deploy",
    profile: PROFILE,
  });
  let oldCredentialAttempted = false;
  const instance = fixture({
    profiles: [PROFILE],
    settingsController: sharedSettings([PROFILE]),
    secretStore: realSecretStore(userDataPath),
    connect() { oldCredentialAttempted = true; throw new Error("must not connect"); },
  });

  assert.deepEqual(await instance.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.deepEqual(await instance.ipcMain.invoke("wgRelay:status", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.equal(oldCredentialAttempted, false);
});

test("delete-local in a second IPC instance invalidates another instance's stale recovery cache", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-ipc-delete-race-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = realSecretStore(userDataPath);
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  store.write("wg-1", oldSecrets);
  store.writeRecovery("wg-1", {
    version: 1,
    phase: "remote_committed",
    operation: "deploy",
    profile: PROFILE,
    candidate: { acceptedFingerprint: null, readback: readback() },
  });
  const settingsController = sharedSettings([PROFILE]);
  let staleCredentialAttempted = false;
  const instanceA = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: realSecretStore(userDataPath),
    connect() { staleCredentialAttempted = true; throw new Error("must not connect"); },
  });
  const instanceB = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: realSecretStore(userDataPath),
  });

  assert.equal((await instanceB.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" })).status, "ok");
  assert.deepEqual(await instanceA.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "profile_not_found",
  });
  assert.equal(staleCredentialAttempted, false);
  assert.equal(store.read("wg-1"), null);
  assert.equal(store.readRecovery("wg-1"), null);
  assert.deepEqual(settingsController.getSnapshot().wgRelay.profiles, []);
});

test("connect pairing and status resync a journal created after IPC registration", async () => {
  const fx = fixture({ profiles: [] });
  fx.recovery.set("wg-1", {
    version: 1,
    phase: "prepared",
    operation: "deploy",
    profile: PROFILE,
  });

  for (const channel of ["wgRelay:connect", "wgRelay:pairing-qr", "wgRelay:status"]) {
    assert.deepEqual(await fx.ipcMain.invoke(channel, { profileId: "wg-1" }), {
      status: "error", errorCode: "remote_commit_recovery_required",
    });
  }
  assert.equal(fx.connectionCalls.length, 0);
});

test("one profile recovery read failure does not block an unrelated profile", async () => {
  const goodProfile = {
    ...PROFILE,
    id: "wg-2",
    label: "Good VPS",
    wgSubnet: "10.9.0.0/24",
  };
  const fx = fixture({
    profiles: [PROFILE, goodProfile],
    secrets: { "wg-1": secretValue(), "wg-2": secretValue() },
    recovery: {
      "wg-1": { version: 1, phase: "prepared", operation: "deploy", profile: PROFILE },
    },
    recoveryRead(id, recovery) {
      if (id === "wg-1") throw new Error("corrupt recovery blob");
      return recovery.has(id) ? structuredClone(recovery.get(id)) : null;
    },
  });

  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.equal((await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-2" })).status, "ok");
  assert.deepEqual(fx.connectionCalls, [["connect", "wg-2"]]);
});

test("an invalid committed candidate remains blocked across IPC instances", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-ipc-invalid-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const diskStoreA = realSecretStore(userDataPath);
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  diskStoreA.write("wg-1", oldSecrets);
  const settingsController = sharedSettings([PROFILE]);
  const instanceA = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: diskStoreA,
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async rotatePhoneFn() {
      return {
        version: 1,
        phoneConfig: config("10.8.0.4/32", Buffer.alloc(32, 4).toString("base64")),
        relayToken: "44".repeat(32),
      };
    },
  });
  const invalid = await instanceA.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });
  assert.equal(invalid.status, "partial_success");
  assert.equal(diskStoreA.readRecovery("wg-1").phase, "remote_committed_invalid_response");

  let oldCredentialAttempted = false;
  const instanceB = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: realSecretStore(userDataPath),
    connect() { oldCredentialAttempted = true; throw new Error("must not connect"); },
  });
  assert.deepEqual(await instanceB.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.deepEqual(await instanceB.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.equal(oldCredentialAttempted, false);
  assert.deepEqual(realSecretStore(userDataPath).read("wg-1"), oldSecrets);
});

test("candidate journal failure leaves the prepared tombstone durable across restart", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-ipc-candidate-fail-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const baseStore = realSecretStore(userDataPath);
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  baseStore.write("wg-1", oldSecrets);
  let journalWrites = 0;
  const failingStore = {
    ...baseStore,
    write() { throw new Error("main secret write failed"); },
    writeRecovery(id, record) {
      journalWrites += 1;
      if (journalWrites > 1) throw new Error("candidate journal write failed");
      return baseStore.writeRecovery(id, record);
    },
  };
  const settingsController = sharedSettings([PROFILE]);
  const instanceA = fixture({
    profiles: [PROFILE], settingsController, secretStore: failingStore,
  });

  const result = await instanceA.ipcMain.invoke("wgRelay:deploy", {
    profile: PROFILE, password: "secret",
  });
  assert.equal(result.errorCode, "local_storage_retry_required");
  assert.equal(baseStore.readRecovery("wg-1").phase, "prepared");

  let oldCredentialAttempted = false;
  const instanceB = fixture({
    profiles: [PROFILE],
    settingsController,
    secretStore: realSecretStore(userDataPath),
    connect() { oldCredentialAttempted = true; throw new Error("must not connect"); },
  });
  assert.deepEqual(await instanceB.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.equal(oldCredentialAttempted, false);
});

test("deploy commitPoint never removes new secrets when public persistence reports failure", async () => {
  let failedOnce = false;
  const fx = fixture({
    publicWrite(action, payload, profiles) {
      if (!failedOnce && action === "wgRelay.add") {
        failedOnce = true;
        profiles.push(structuredClone(payload));
        return { status: "error" };
      }
      return null;
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "public_profile_retry_required");
  assert.deepEqual(fx.stored.get("wg-1"), secretValue());
  assert.equal(fx.profiles().length, 1);
  assert.deepEqual(fx.publicWrites.map((entry) => entry.action), ["wgRelay.add"]);
  assertNoSecrets(result);
});

test("deploy preflight failure preserves old state and never calls SSH", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  let deployCount = 0;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    secretPreflight() { throw new Error("disk read only"); },
    async deployFn() { deployCount += 1; return { ok: true, readback: readback() }; },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.deepEqual(result, { status: "error", errorCode: "secret_store_preflight_failed" });
  assert.equal(deployCount, 0);
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.profiles(), [PROFILE]);
  assert.equal(fx.connectionCalls.length, 0);
});

test("deploy commitPoint connection failure keeps new secrets and pairing retries from them", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    connect() { throw Object.assign(new Error(RELAY_TOKEN), { code: "relay_auth_failed" }); },
    qrEncoder({ secrets }) {
      return { version: 1, dataUrl: `data:image/png;base64,${secrets.relayToken.slice(0, 8)}` };
    },
  });
  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "connection_retry_required");
  assert.deepEqual(fx.stored.get("wg-1"), secretValue());
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"], ["connect", "wg-1"]]);
  const newQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.notEqual(newQr.qr.dataUrl, oldQr.qr.dataUrl);
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs });
});

test("deploy commitPoint blocks old local credentials when successful readback has an invalid phone topology", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async deployFn() {
      return {
        ok: true,
        acceptedFingerprint: FINGERPRINT,
        readback: readback({ phoneConfig: config("10.8.0.4/32", PHONE_KEY) }),
      };
    },
  });
  await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs });
});

test("deploy commitPoint blocks old local credentials when readback cannot form a public profile", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async deployFn() {
      return {
        ok: true,
        readback: readback({ endpoint: "not-an-endpoint" }),
        acceptedFingerprint: FINGERPRINT,
      };
    },
  });
  await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
});

test("deploy commitPoint tombstones old credentials when canonical public profile sanitization fails", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async deployFn() {
      return {
        ok: true,
        readback: readback({ endpoint: "relay.example.com:51820\nsecret" }),
        acceptedFingerprint: FINGERPRINT,
      };
    },
  });
  await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
});

test("connect/disconnect/status/list-statuses return only stable redacted Task 5 snapshots", async () => {
  const fx = fixture({ profiles: [PROFILE] });
  const connected = await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });
  assert.equal(connected.status, "ok");
  assert.equal(connected.state.status, "connected");
  const one = await fx.ipcMain.invoke("wgRelay:status", { profileId: "wg-1" });
  const list = await fx.ipcMain.invoke("wgRelay:list-statuses");
  assert.deepEqual(list.statuses, [one.state]);
  assertNoSecrets({ connected, one, list });
  const disconnected = await fx.ipcMain.invoke("wgRelay:disconnect", { profileId: "wg-1" });
  assert.equal(disconnected.state.status, "idle");
});

test("status results and broadcasts validate values and expose only the minimal stable schema", async () => {
  const sshPassword = "SSH-PASSWORD-MUST-NOT-LEAK";
  const fx = fixture({
    profiles: [PROFILE],
    connect: async () => ({
      profileId: RELAY_TOKEN,
      status: PHONE_KEY,
      generation: sshPassword,
      errorCode: PC_KEY,
      hint: RELAY_TOKEN,
      ifName: PHONE_KEY,
      address: sshPassword,
      updatedAt: RELAY_TOKEN,
      message: RELAY_TOKEN,
      token: RELAY_TOKEN,
      managementToken: MANAGEMENT_TOKEN,
      privateKey: PC_KEY,
    }),
  });
  const result = await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });
  for (const secret of [RELAY_TOKEN, PC_KEY, sshPassword]) {
    for (const field of [
      "profileId", "status", "generation", "errorCode",
      "hint", "ifName", "address", "updatedAt",
    ]) {
      fx.runtime.emit("status-changed", {
        profileId: "wg-1", status: "connected", generation: 2, [field]: secret,
      });
    }
    for (const field of ["profileId", "step", "status", "hint", "message"]) {
      fx.runtime.emit("progress", {
        profileId: "wg-1", step: "install", status: "start", [field]: secret,
      });
    }
  }
  assert.deepEqual(result, {
    status: "ok",
    state: {
      profileId: "wg-1", status: "idle", generation: 0, errorCode: "connection_failed",
    },
  });
  for (const entry of fx.sent) {
    const allowed = entry.channel === "wgRelay:progress"
      ? ["profileId", "status", "step"]
      : ["errorCode", "generation", "profileId", "status"];
    assert.deepEqual(
      Object.keys(entry.payload).sort(),
      allowed.filter((key) => Object.hasOwn(entry.payload, key)).sort(),
    );
  }
  assertNoSecrets({ result, events: fx.sent }, [sshPassword]);
});

test("progress boundary preserves every fixed production deploy stage", () => {
  const fx = fixture({ profiles: [PROFILE] });
  const steps = [
    "connect", "host-key", "upload", "install", "install-wg", "gen-keys",
    "write-conf", "start-service", "firewall", "readback", "validate",
  ];

  for (const step of steps) {
    fx.runtime.emitProgress({ profileId: "wg-1", step, status: "start", message: RELAY_TOKEN });
  }

  assert.deepEqual(
    fx.sent.filter((entry) => entry.channel === "wgRelay:progress").map((entry) => entry.payload.step),
    steps,
  );
  assertNoSecrets(fx.sent);
});

test("requestPhoneRotation returns bounded raw JSON so the handler can journal before strict validation", async (t) => {
  const received = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("location", "http://example.com/"); res.end(); return; }
      if (req.url === "/large") { res.setHeader("content-type", "application/json"); res.end("x".repeat(1024)); return; }
      if (req.url === "/invalid") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: 1, phoneConfig: "x", relayToken: RELAY_TOKEN, extra: true })); return; }
      if (req.url === "/stall") { res.setHeader("content-type", "application/json"); res.flushHeaders(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: 1, phoneConfig: config("10.8.0.3/32", PHONE_KEY), relayToken: RELAY_TOKEN }));
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const listen = `127.0.0.1:${server.address().port}`;
  const result = await requestPhoneRotation({ listen, managementToken: MANAGEMENT_TOKEN, timeoutMs: 100 });
  assert.equal(result.version, 1);
  assert.deepEqual(received[0], {
    method: "POST",
    url: "/api/manage/phone/rotate",
    body: '{"version":1}',
    headers: {
      host: listen,
      accept: "application/json",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      "content-type": "application/json",
      "content-length": "13",
      connection: "close",
    },
  });
  await assert.rejects(
    requestPhoneRotation({ listen, managementToken: MANAGEMENT_TOKEN, path: "/redirect", timeoutMs: 100 }),
    (error) => error.code === "management_redirect_rejected",
  );
  await assert.rejects(
    requestPhoneRotation({ listen, managementToken: MANAGEMENT_TOKEN, path: "/large", maxBytes: 64, timeoutMs: 100 }),
    (error) => error.code === "management_response_too_large",
  );
  assert.deepEqual(
    await requestPhoneRotation({ listen, managementToken: MANAGEMENT_TOKEN, path: "/invalid", timeoutMs: 100 }),
    { version: 1, phoneConfig: "x", relayToken: RELAY_TOKEN, extra: true },
  );
  await assert.rejects(
    requestPhoneRotation({ listen, managementToken: MANAGEMENT_TOKEN, path: "/stall", timeoutMs: 10 }),
    (error) => error.code === "management_timeout" && error.remoteCommitted === true,
  );
  await assert.rejects(
    requestPhoneRotation({ listen: "203.0.113.10:80", managementToken: MANAGEMENT_TOKEN }),
    (error) => error.code === "management_non_loopback",
  );
});

test("rotate-phone reconnects with verified new secrets and replaces QR only after success", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const newPhoneConfig = config("10.8.0.3/32", Buffer.alloc(32, 4).toString("base64"));
  const newToken = "44".repeat(32);
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    rotatePhoneFn: async (args) => {
      assert.equal(args.listen, "127.0.0.1:43127");
      assert.equal(args.managementToken, MANAGEMENT_TOKEN);
      return { version: 1, phoneConfig: newPhoneConfig, relayToken: newToken };
    },
  });
  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.equal(result.status, "ok");
  assert.notEqual(result.qr.dataUrl, oldQr.qr.dataUrl);
  assert.deepEqual(fx.stored.get("wg-1"), { ...oldSecrets, phoneConfig: newPhoneConfig, relayToken: newToken });
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"], ["connect", "wg-1"]]);
  assertNoSecrets(result, [newToken, newPhoneConfig]);
  const cached = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(cached.qr.dataUrl, result.qr.dataUrl);
});

test("rotate commitPoint connection failure keeps new secrets, clears old QR, and never reconnects old token", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const newToken = "44".repeat(32);
  let connectCount = 0;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    rotatePhoneFn: async () => ({
      version: 1,
      phoneConfig: config("10.8.0.3/32", Buffer.alloc(32, 4).toString("base64")),
      relayToken: newToken,
    }),
    connect(id, { setState }) {
      connectCount += 1;
      if (connectCount === 1) throw Object.assign(new Error(newToken), { code: "relay_auth_failed" });
      return setState(id, "connected");
    },
  });
  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "connection_retry_required");
  assert.equal(fx.stored.get("wg-1").relayToken, newToken);
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"], ["connect", "wg-1"]]);
  const cached = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.notEqual(cached.qr.dataUrl, oldQr.qr.dataUrl);
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs }, [newToken]);
});

test("rotate retry releases a stale old-token connection before connecting with committed secrets", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const newToken = "44".repeat(32);
  let disconnectCount = 0;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    rotatePhoneFn: async () => ({
      version: 1,
      phoneConfig: config("10.8.0.3/32", Buffer.alloc(32, 4).toString("base64")),
      relayToken: newToken,
    }),
    disconnect(id, { setState }) {
      disconnectCount += 1;
      if (disconnectCount === 1) throw new Error("old connection still active");
      return setState(id, "idle");
    },
  });

  const rotated = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });
  const retried = await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });

  assert.equal(rotated.status, "partial_success");
  assert.equal(rotated.errorCode, "connection_retry_required");
  assert.equal(retried.status, "ok");
  assert.deepEqual(fx.connectionCalls, [
    ["disconnect", "wg-1"], ["disconnect", "wg-1"], ["connect", "wg-1"],
  ]);
  assert.equal(fx.stored.get("wg-1").relayToken, newToken);
});

test("rotate commitPoint retains new bundle in recovery when durable readback fails", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const newToken = "44".repeat(32);
  let failVerification = true;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    secretRead(id, stored) {
      if (failVerification && stored.get(id)?.relayToken === newToken) throw new Error("verification unavailable");
      return stored.has(id) ? structuredClone(stored.get(id)) : null;
    },
    rotatePhoneFn: async () => ({
      version: 1,
      phoneConfig: config("10.8.0.3/32", Buffer.alloc(32, 4).toString("base64")),
      relayToken: newToken,
    }),
  });

  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "local_storage_retry_required");
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs }, [newToken]);

  failVerification = false;
  const retried = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(retried.status, "ok");
  assert.notEqual(retried.qr.dataUrl, oldQr.qr.dataUrl);
  assert.equal(fx.stored.get("wg-1").relayToken, newToken);
});

test("rotate preflight failure preserves old secret, connection, and QR without management POST", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  let rotateCount = 0;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    secretPreflight() { throw new Error("disk read only"); },
    async rotatePhoneFn() { rotateCount += 1; throw new Error("must not run"); },
  });
  const oldQr = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.deepEqual(result, { status: "error", errorCode: "secret_store_preflight_failed" });
  assert.equal(rotateCount, 0);
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.equal(fx.connectionCalls.length, 0);
  const cached = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(cached.qr.dataUrl, oldQr.qr.dataUrl);
});

test("rotate writes prepared before POST and removes it after a proven pre-commit failure", async () => {
  const order = [];
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue() },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    recoveryWrite(_id, value, recovery) {
      order.push(`journal-${value.phase}`);
      recovery.set("wg-1", structuredClone(value));
    },
    recoveryRemove(_id, recovery) {
      order.push("journal-remove");
      return recovery.delete("wg-1");
    },
    async rotatePhoneFn() {
      order.push("management-post");
      throw Object.assign(new Error("connection refused"), {
        code: "management_request_failed",
        remoteCommitted: false,
      });
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.deepEqual(result, { status: "error", errorCode: "rotate_failed" });
  assert.deepEqual(order, ["journal-prepared", "management-post", "journal-remove"]);
  assert.equal(fx.recovery.has("wg-1"), false);
});

test("rotate keeps prepared recovery when a sent request has an ambiguous transport failure", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async rotatePhoneFn() {
      throw Object.assign(new Error("response lost"), { code: "management_timeout" });
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.equal(fx.recovery.get("wg-1").phase, "prepared");
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
});

test("rotate commitPoint blocks old local credentials when response phone topology is invalid", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const newToken = "44".repeat(32);
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async rotatePhoneFn() {
      return {
        version: 1,
        phoneConfig: config("10.8.0.4/32", Buffer.alloc(32, 4).toString("base64")),
        relayToken: newToken,
      };
    },
  });
  await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  const durable = fx.recovery.get("wg-1");
  assert.equal(durable.phase, "remote_committed_invalid_response");
  assert.equal(durable.operation, "rotate");
  assert.equal(durable.candidate.phoneConfig, config("10.8.0.4/32", Buffer.alloc(32, 4).toString("base64")));
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs }, [newToken]);
});

test("rotate treats a rejected invalid response after HTTP success as a committed tombstone", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async rotatePhoneFn() {
      const error = new Error("invalid committed response");
      error.code = "management_invalid_response";
      error.remoteCommitted = true;
      throw error;
    },
  });
  await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });

  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.equal(result.status, "partial_success");
  assert.equal(result.errorCode, "remote_commit_recovery_required");
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
});

test("dispose rejects a late pairing QR and does not let it repopulate the cache", async () => {
  const gate = deferred();
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue() },
    async qrEncoder() {
      await gate.promise;
      return { version: 1, dataUrl: "data:image/png;base64,LATE" };
    },
  });
  const pairing = fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  await new Promise((resolve) => setImmediate(resolve));

  const disposing = fx.ipc.dispose();
  gate.resolve();

  assert.deepEqual(await pairing, { status: "error", errorCode: "pairing_qr_failed" });
  await disposing;
  assert.equal(fx.ipcMain.handlers.size, 0);
});

test("dispose makes one final recovery flush before releasing IPC state", async () => {
  let failPersist = true;
  const fx = fixture({
    secretWrite(id, value, stored) {
      if (failPersist) throw new Error("disk unavailable");
      stored.set(id, structuredClone(value));
    },
  });
  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });
  assert.equal(result.errorCode, "local_storage_retry_required");
  assert.equal(fx.stored.has("wg-1"), false);

  failPersist = false;
  await fx.ipc.dispose();

  assert.deepEqual(fx.stored.get("wg-1"), secretValue());
  assert.equal(fx.ipcMain.handlers.size, 0);
});

test("dispose succeeds with a durable prepared tombstone because quit flush is supplementary", async () => {
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue({ relayToken: "33".repeat(32) }) },
    recovery: {
      "wg-1": { version: 1, phase: "prepared", operation: "deploy", profile: PROFILE },
    },
    connect() { throw new Error("old credentials must not be used"); },
  });

  await fx.ipc.dispose();

  assert.equal(fx.ipcMain.handlers.size, 0);
  assert.equal(fx.recovery.get("wg-1").phase, "prepared");
  assert.deepEqual(fx.connectionCalls, []);
});

test("delete-local disconnects first, removes local layers idempotently, and reports partial failures stably", async () => {
  const fx = fixture({ profiles: [PROFILE], secrets: { "wg-1": secretValue() } });
  await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  const deleted = await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  assert.deepEqual(deleted, { status: "ok", removed: { publicProfile: true, secrets: true } });
  assert.deepEqual(fx.connectionCalls, [["disconnect", "wg-1"]]);
  assert.equal(fx.stored.has("wg-1"), false);
  assert.deepEqual(fx.profiles(), []);
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:status", { profileId: "wg-1" }), {
    status: "error", errorCode: "profile_not_found",
  });
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" }), {
    status: "ok", removed: { publicProfile: false, secrets: false },
  });

  const partial = fixture({
    profiles: [PROFILE], secrets: { "wg-1": secretValue() },
    recovery: { "wg-1": { version: 1, phase: "prepared", operation: "deploy", profile: PROFILE } },
    secretRemove: () => { throw new Error(RELAY_TOKEN); },
  });
  const partialResult = await partial.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  assert.deepEqual(partialResult, {
    status: "partial", removed: { publicProfile: true, secrets: false }, errors: ["secret_remove_failed"],
  });
  assert.equal(partial.recovery.get("wg-1").phase, "delete_pending");
  assertNoSecrets({ partialResult, logs: partial.logs, events: partial.sent });
});

test("delete-local aborts without any destructive side effect when delete_pending cannot persist", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    recoveryWrite() { throw new Error("disk unavailable"); },
  });
  const runtimeBefore = fx.runtime.getProfileStatus("wg-1");

  const result = await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });

  assert.deepEqual(result, { status: "error", errorCode: "delete_prepare_failed" });
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.profiles(), [PROFILE]);
  assert.deepEqual(fx.connectionCalls, []);
  assert.deepEqual(fx.publicWrites, []);
  assert.deepEqual(fx.runtime.getProfileStatus("wg-1"), runtimeBefore);
});

test("delete_pending survives final journal removal failure and a new instance finishes without resurrection", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-ipc-delete-pending-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const baseStore = realSecretStore(userDataPath);
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  baseStore.write("wg-1", oldSecrets);
  baseStore.writeRecovery("wg-1", {
    version: 1,
    phase: "remote_committed",
    operation: "deploy",
    profile: PROFILE,
    candidate: { acceptedFingerprint: null, readback: readback() },
  });
  const settingsController = sharedSettings([PROFILE]);
  const failingFinalRemoveStore = {
    ...baseStore,
    removeRecovery() { throw new Error("final journal removal failed"); },
  };
  const instanceA = fixture({
    profiles: [PROFILE], settingsController, secretStore: failingFinalRemoveStore,
  });

  const deleted = await instanceA.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });

  assert.equal(deleted.status, "partial");
  assert.deepEqual(deleted.errors, ["recovery_remove_failed"]);
  const survived = baseStore.readRecovery("wg-1");
  assert.equal(survived.phase, "delete_pending");
  assert.deepEqual(Object.keys(survived).sort(), ["operation", "phase", "version"]);
  assert.equal(baseStore.read("wg-1"), null);
  assert.deepEqual(settingsController.getSnapshot().wgRelay.profiles, []);

  const instanceB = fixture({
    profiles: [], settingsController, secretStore: realSecretStore(userDataPath),
    connect() { throw new Error("deleted profile must not reconnect"); },
  });
  for (let attempt = 0; attempt < 20 && baseStore.readRecovery("wg-1"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(baseStore.readRecovery("wg-1"), null);
  assert.equal(baseStore.read("wg-1"), null);
  assert.deepEqual(settingsController.getSnapshot().wgRelay.profiles, []);
  assert.deepEqual(await instanceB.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "profile_not_found",
  });
  assert.equal(instanceB.connectionCalls.some(([operation]) => operation === "connect"), false);
});

test("repeated delete-local remains idempotent through a retained delete_pending journal", async () => {
  let failSecretRemove = true;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue() },
    secretRemove(id, stored) {
      if (failSecretRemove) throw new Error("temporary delete failure");
      return stored.delete(id);
    },
  });

  const first = await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  assert.equal(first.status, "partial");
  assert.equal(fx.recovery.get("wg-1").phase, "delete_pending");
  failSecretRemove = false;
  const second = await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  const third = await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });

  assert.deepEqual(second, { status: "ok", removed: { publicProfile: false, secrets: true } });
  assert.deepEqual(third, { status: "ok", removed: { publicProfile: false, secrets: false } });
  assert.equal(fx.stored.has("wg-1"), false);
  assert.equal(fx.recovery.has("wg-1"), false);
  assert.deepEqual(fx.profiles(), []);
});

test("delete_pending is durable before disconnect and wins queued connect plus quit", async () => {
  const gate = deferred();
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue() },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    async disconnect(id, { setState }) {
      await gate.promise;
      return setState(id, "idle");
    },
  });

  const deleting = fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.recovery.get("wg-1").phase, "delete_pending");
  assert.deepEqual(Object.keys(fx.recovery.get("wg-1")).sort(), ["operation", "phase", "version"]);
  const connecting = fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });
  const disposing = fx.ipc.dispose();
  gate.resolve();

  assert.equal((await deleting).status, "ok");
  assert.equal((await connecting).status, "error");
  await disposing;
  assert.equal(fx.connectionCalls.some(([operation]) => operation === "connect"), false);
  assert.equal(fx.recovery.has("wg-1"), false);
  assert.equal(fx.ipcMain.handlers.size, 0);
});

test("delete-local clears runtime and suppresses statuses even when public profile removal fails", async () => {
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue() },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    publicWrite(action) {
      if (action === "wgRelay.remove") return { status: "error" };
      return null;
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  const statuses = await fx.ipcMain.invoke("wgRelay:list-statuses");

  assert.deepEqual(result, {
    status: "partial",
    removed: { publicProfile: false, secrets: true },
    errors: ["public_profile_remove_failed"],
  });
  assert.deepEqual(fx.profiles(), [PROFILE]);
  assert.deepEqual(statuses.statuses, []);
  assert.deepEqual(fx.runtime.getProfileStatus("wg-1"), {
    profileId: "wg-1", status: "idle", generation: 0,
  });
  fx.runtime.setStatus("wg-1", { status: "failed", generation: 3 });
  assert.deepEqual(await fx.ipcMain.invoke("wgRelay:list-statuses"), { status: "ok", statuses: [] });
  assert.deepEqual(fx.runtime.listStatuses(), []);
});

test("operations queued behind partial delete recheck the tombstone and never reuse old secrets", async () => {
  const gate = deferred();
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": secretValue({ relayToken: "33".repeat(32) }) },
    async disconnect(id, { setState }) {
      await gate.promise;
      return setState(id, "idle");
    },
    secretRemove() { throw new Error("disk unavailable"); },
  });

  const deleting = fx.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  await new Promise((resolve) => setImmediate(resolve));
  const pairing = fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  const connecting = fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });
  gate.resolve();

  assert.equal((await deleting).status, "partial");
  assert.deepEqual(await pairing, { status: "error", errorCode: "profile_not_found" });
  assert.deepEqual(await connecting, { status: "error", errorCode: "profile_not_found" });
  assert.equal(fx.connectionCalls.length, 3);
  assert.equal(fx.connectionCalls.every(([operation, id]) => (
    operation === "disconnect" && id === "wg-1"
  )), true);
});

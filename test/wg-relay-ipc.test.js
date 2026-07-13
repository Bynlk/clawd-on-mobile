"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { test } = require("node:test");

const {
  registerWgRelayIpc,
  requestPhoneRotation,
} = require("../src/wg-relay-ipc");
const { createWgRelayRuntime } = require("../src/wg-relay-runtime");

const PROFILE = {
  id: "wg-1",
  label: "My VPS",
  host: "203.0.113.10",
  sshUsername: "deploy",
  sshPort: 2222,
  authMethod: "password",
  wgPort: 51820,
  wgSubnet: "10.8.0.0/24",
};
const FINGERPRINT = `SHA256:${Buffer.alloc(32, 9).toString("base64")}`;
const PC_KEY = Buffer.alloc(32, 1).toString("base64");
const PHONE_KEY = Buffer.alloc(32, 2).toString("base64");
const SERVER_KEY = Buffer.alloc(32, 3).toString("base64");
const RELAY_TOKEN = "11".repeat(32);
const MANAGEMENT_TOKEN = "22".repeat(32);

function config(address, privateKey) {
  return [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${address}`,
    "",
    "[Peer]",
    `PublicKey = ${SERVER_KEY}`,
    "Endpoint = 203.0.113.10:51820",
    "AllowedIPs = 10.8.0.0/24",
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function readback(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: "203.0.113.10:51820",
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
  const settingsController = {
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
  const stored = new Map(Object.entries(options.secrets || {}).map(([id, value]) => [id, structuredClone(value)]));
  const secretCalls = [];
  const secretStore = {
    isAvailable: () => options.secretAvailable !== false,
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
  };
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
    profiles: () => structuredClone(profiles), publicWrites, qrCalls, runtime,
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
  const fx = fixture();
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

  assert.deepEqual(order, ["secret-read", "ssh-deploy", "secret-write", "secret-read", "public-write", "connect", "qr"]);
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

test("deploy rolls local secret/public/connection/QR state back when QR generation fails", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const oldProfile = {
    ...PROFILE, sshHostFingerprint: FINGERPRINT,
    endpoint: "203.0.113.10:51820", relayAddr: "ws://10.8.0.1:7891",
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

  assert.deepEqual(result, { status: "error", errorCode: "deploy_failed" });
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.deepEqual(fx.profiles(), [oldProfile]);
  assert.deepEqual(fx.connectionCalls, [
    ["disconnect", "wg-1"], ["connect", "wg-1"],
    ["disconnect", "wg-1"], ["connect", "wg-1"],
  ]);
  const cached = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(cached.qr.dataUrl, "data:image/png;base64,OLD");
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs });
});

test("secret verification failure leaves no public profile and duplicate deploys coalesce", async () => {
  let badReads = 0;
  const bad = fixture({ secretRead: () => (++badReads === 1 ? null : { corrupt: true }) });
  const badResult = await bad.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });
  assert.deepEqual(badResult, { status: "error", errorCode: "deploy_failed" });
  assert.equal(bad.publicWrites.length, 0);
  assert.equal(bad.stored.has("wg-1"), false);

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

test("deploy restores existing secrets when write succeeds but verification read throws", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  let reads = 0;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    secretRead(id, stored) {
      reads += 1;
      if (reads === 2) throw new Error("verification unavailable");
      return stored.has(id) ? structuredClone(stored.get(id)) : null;
    },
  });

  const result = await fx.ipcMain.invoke("wgRelay:deploy", { profile: PROFILE, password: "secret" });

  assert.deepEqual(result, { status: "error", errorCode: "deploy_failed" });
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.equal(fx.publicWrites.length, 0);
});

test("deploy rolls public state back when the controller mutates then reports persistence failure", async () => {
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

  assert.deepEqual(result, { status: "error", errorCode: "deploy_failed" });
  assert.deepEqual(fx.profiles(), []);
  assert.equal(fx.stored.has("wg-1"), false);
  assert.deepEqual(fx.publicWrites.map((entry) => entry.action), ["wgRelay.add", "wgRelay.remove"]);
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

test("status results and broadcasts drop unexpected secret-like fields and messages", async () => {
  const fx = fixture({
    profiles: [PROFILE],
    connect: async () => ({
      profileId: "wg-1",
      status: "connected",
      generation: 1,
      message: RELAY_TOKEN,
      token: RELAY_TOKEN,
      managementToken: MANAGEMENT_TOKEN,
      privateKey: PC_KEY,
    }),
  });
  const result = await fx.ipcMain.invoke("wgRelay:connect", { profileId: "wg-1" });
  fx.runtime.emit("status-changed", {
    profileId: "wg-1", status: "connected", generation: 2,
    message: RELAY_TOKEN, relayToken: RELAY_TOKEN,
  });
  assert.deepEqual(result, {
    status: "ok",
    state: { profileId: "wg-1", status: "connected", generation: 1 },
  });
  assertNoSecrets({ result, events: fx.sent });
});

test("requestPhoneRotation sends a bounded loopback-only bearer request and validates strict response schema", async (t) => {
  const received = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("location", "http://example.com/"); res.end(); return; }
      if (req.url === "/large") { res.setHeader("content-type", "application/json"); res.end("x".repeat(1024)); return; }
      if (req.url === "/invalid") { res.end(JSON.stringify({ version: 1, phoneConfig: "x", relayToken: RELAY_TOKEN, extra: true })); return; }
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
  await assert.rejects(
    requestPhoneRotation({ listen, managementToken: MANAGEMENT_TOKEN, path: "/invalid", timeoutMs: 100 }),
    (error) => error.code === "management_invalid_response",
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

test("rotate-phone failure restores old local secrets/connection/QR and never replaces cache", async () => {
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

  assert.deepEqual(result, { status: "error", errorCode: "rotate_failed" });
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assert.equal(fx.connection.status("wg-1").status, "connected");
  const cached = await fx.ipcMain.invoke("wgRelay:pairing-qr", { profileId: "wg-1" });
  assert.equal(cached.qr.dataUrl, oldQr.qr.dataUrl);
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs }, [newToken]);
});

test("rotate-phone restores old secrets when the new secret readback throws", async () => {
  const oldSecrets = secretValue({ relayToken: "33".repeat(32) });
  const newToken = "44".repeat(32);
  let reads = 0;
  const fx = fixture({
    profiles: [PROFILE],
    secrets: { "wg-1": oldSecrets },
    states: { "wg-1": { profileId: "wg-1", status: "connected", generation: 1 } },
    secretRead(id, stored) {
      reads += 1;
      if (reads === 2) throw new Error("verification unavailable");
      return stored.has(id) ? structuredClone(stored.get(id)) : null;
    },
    rotatePhoneFn: async () => ({
      version: 1,
      phoneConfig: config("10.8.0.3/32", Buffer.alloc(32, 4).toString("base64")),
      relayToken: newToken,
    }),
  });

  const result = await fx.ipcMain.invoke("wgRelay:rotate-phone", { profileId: "wg-1" });

  assert.deepEqual(result, { status: "error", errorCode: "rotate_failed" });
  assert.deepEqual(fx.stored.get("wg-1"), oldSecrets);
  assertNoSecrets({ result, events: fx.sent, logs: fx.logs }, [newToken]);
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
    secretRemove: () => { throw new Error(RELAY_TOKEN); },
  });
  const partialResult = await partial.ipcMain.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  assert.deepEqual(partialResult, {
    status: "partial", removed: { publicProfile: true, secrets: false }, errors: ["secret_remove_failed"],
  });
  assertNoSecrets({ partialResult, logs: partial.logs, events: partial.sent });
});

test("delete-local keeps statuses visible when the public profile removal fails", async () => {
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
  assert.equal(statuses.statuses.length, 1);
  assert.equal(statuses.statuses[0].profileId, "wg-1");
  assert.equal(statuses.statuses[0].status, "idle");
  assert.equal(statuses.statuses[0].generation, 2);
});

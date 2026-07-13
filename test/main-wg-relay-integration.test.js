"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const WebSocket = require("ws");

const {
  createWgRelayMainIntegration,
  createWgRelayQuitBarrier,
} = require("../src/wg-relay-ipc");
const { MobileWSServer } = require("../src/mobile-ws-server");

const PC_CONFIG = [
  "[Interface]", `PrivateKey = ${Buffer.alloc(32, 1).toString("base64")}`,
  "Address = 10.8.0.2/32", "[Peer]",
  `PublicKey = ${Buffer.alloc(32, 2).toString("base64")}`,
  "Endpoint = 203.0.113.10:51820", "AllowedIPs = 10.8.0.0/24",
  "PersistentKeepalive = 25", "",
].join("\n");

function safeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8"),
    ...overrides,
  };
}

function ipcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: (channel, payload) => handlers.get(channel)({}, payload),
  };
}

function settingsController() {
  const profile = {
    id: "wg-1", label: "VPS", host: "203.0.113.10", sshUsername: "root",
    sshPort: 22, authMethod: "password", wgPort: 51820, wgSubnet: "10.8.0.0/24",
  };
  return {
    getSnapshot: () => ({ wgRelay: { profiles: [profile] } }),
    applyCommand: async () => ({ status: "ok" }),
  };
}

class FakeSidecar extends EventEmitter {
  constructor(options, events) {
    super();
    this.options = options;
    this.events = events;
  }
  async start() { this.events.push("sidecar-start"); return { listen: "127.0.0.1:43127", generation: 1 }; }
  async stop() { this.events.push("sidecar-stop"); }
  async dispose() { this.events.push("sidecar-dispose"); this.removeAllListeners(); }
}

class FakeBridge extends EventEmitter {
  constructor(events) { super(); this.events = events; }
  configure() { this.events.push("bridge-configure"); }
  start() { this.events.push("bridge-start"); }
  async waitUntilConnected() { this.events.push("bridge-connected"); }
  async stop() { this.events.push("bridge-stop"); }
  clearConfig() {}
  async dispose() { this.events.push("bridge-dispose"); this.removeAllListeners(); }
}

function makeIntegration(t, overrides = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wg-main-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const events = [];
  const sidecarOptions = [];
  const ipc = ipcMain();
  const integration = createWgRelayMainIntegration({
    ipcMain: ipc,
    BrowserWindow: { getAllWindows: () => [] },
    settingsController: settingsController(),
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    safeStorage: safeStorage(),
    userDataPath,
    resourcesPath: "/Applications/Clawd.app/Contents/Resources",
    appRoot: "/workspace/clawd",
    isPackaged: true,
    platform: "darwin",
    arch: "arm64",
    sidecarFactory(options) {
      sidecarOptions.push(options);
      return new FakeSidecar(options, events);
    },
    bridgeFactory: () => new FakeBridge(events),
    healthProbe: async () => ({ version: 1, status: "ok", uptimeSeconds: 0 }),
    qrEncoder: async () => ({ version: 1, dataUrl: "data:image/png;base64,QR" }),
    ...overrides,
  });
  return { events, integration, ipc, sidecarOptions, userDataPath };
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (!server.listening) return;
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function attachWebSocketServer(t, server, onUpgrade) {
  const wss = new WebSocket.Server({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (onUpgrade && !onUpgrade(request, socket)) return;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return wss;
}

test("main integration creates secure storage and the packaged sidecar lazily with exact platform paths", async (t) => {
  const fx = makeIntegration(t);
  assert.equal(fx.integration.available, true);
  assert.equal(fx.sidecarOptions.length, 0, "startup must not auto-connect");
  fx.integration.secretStore.write("wg-1", {
    pcConfig: PC_CONFIG,
    relayUrl: "ws://10.8.0.1:7891",
    relayToken: "11".repeat(32),
    managementToken: "22".repeat(32),
    phoneConfig: "encrypted-only",
  });

  const state = await fx.integration.connection.connect("wg-1");
  assert.equal(state.status, "connected");
  assert.equal(fx.integration.getForwardEndpoint("wg-1"), "127.0.0.1:43127");
  assert.deepEqual(fx.sidecarOptions[0], {
    appRoot: "/workspace/clawd",
    resourcesPath: "/Applications/Clawd.app/Contents/Resources",
    isPackaged: true,
    platform: "darwin",
    arch: "arm64",
  });
  await fx.integration.dispose();
  assert.equal(fx.integration.getForwardEndpoint("wg-1"), null);
  assert.equal(fx.ipc.handlers.size, 0);
});

test("main startup recognizes a durable prepared journal without auto-connecting old credentials", async (t) => {
  let recovery = {
    version: 1,
    phase: "prepared",
    operation: "deploy",
    profile: settingsController().getSnapshot().wgRelay.profiles[0],
  };
  let connectCalls = 0;
  const secretStore = {
    isAvailable: () => true,
    preflight: () => true,
    write() {},
    read: () => ({ pcConfig: PC_CONFIG, relayToken: "OLD_TOKEN" }),
    remove: () => true,
    writeRecovery(_id, value) { recovery = structuredClone(value); },
    readRecovery: () => recovery && structuredClone(recovery),
    removeRecovery() { const existed = Boolean(recovery); recovery = null; return existed; },
    listRecoveryIds: () => recovery ? ["wg-1"] : [],
  };
  const fx = makeIntegration(t, {
    secretStoreFactory: () => secretStore,
    connectionFactory({ runtime }) {
      return {
        async connect(id) { connectCalls += 1; return runtime.setStatus(id, { status: "connected", generation: 1 }); },
        async disconnect(id) { return runtime.setStatus(id, { status: "idle", generation: 2 }); },
        status: (id) => runtime.getProfileStatus(id),
        async dispose() {},
      };
    },
  });

  assert.equal(connectCalls, 0);
  assert.deepEqual(await fx.ipc.invoke("wgRelay:connect", { profileId: "wg-1" }), {
    status: "error", errorCode: "remote_commit_recovery_required",
  });
  assert.equal(connectCalls, 0);
  await fx.ipc.invoke("wgRelay:delete-local", { profileId: "wg-1" });
  await fx.integration.dispose();
});

test("main integration uses real RelayBridge with current Mobile token and actual dynamic port", async (t) => {
  const relayToken = "11".repeat(32);
  const staleMobileToken = "MOBILE-TOKEN-STALE";
  const currentMobileToken = "MOBILE-TOKEN-CURRENT";
  const relayAuthorizations = [];
  const relayHttp = http.createServer();
  attachWebSocketServer(t, relayHttp, (request, socket) => {
    relayAuthorizations.push(request.headers.authorization || "");
    if (request.headers.authorization !== `Bearer ${relayToken}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return false;
    }
    return true;
  });
  const relayPort = await listen(t, relayHttp);

  let currentPort = null;
  let currentToken = staleMobileToken;
  const logs = [];
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wg-real-bridge-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const integration = createWgRelayMainIntegration({
    ipcMain: ipcMain(),
    BrowserWindow: { getAllWindows: () => [] },
    settingsController: settingsController(),
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    safeStorage: safeStorage(),
    userDataPath,
    resourcesPath: "/Applications/Clawd.app/Contents/Resources",
    appRoot: "/workspace/clawd",
    isPackaged: true,
    platform: "darwin",
    arch: "arm64",
    sidecarFactory(options) {
      const sidecar = new FakeSidecar(options, []);
      sidecar.start = async () => ({ listen: `127.0.0.1:${relayPort}`, generation: 1 });
      return sidecar;
    },
    healthProbe: async () => ({ version: 1, status: "ok", uptimeSeconds: 0 }),
    bridgeTimeoutMs: 500,
    mobileIntegration: {
      getMobileToken: () => currentToken,
      getMobileServerPort: () => currentPort,
    },
    log: (...parts) => logs.push(parts.join(" ")),
  });

  const mobileHttp = http.createServer();
  const mobileWss = attachWebSocketServer(t, mobileHttp);
  const mobileServer = new MobileWSServer(mobileHttp, {
    token: currentMobileToken,
    maxClients: 4,
    heartbeatIntervalMs: 60_000,
  });
  mobileServer.attachWSS(mobileWss);
  currentPort = await listen(t, mobileHttp);
  currentToken = currentMobileToken;

  integration.secretStore.write("wg-1", {
    pcConfig: PC_CONFIG,
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    relayToken,
    managementToken: "22".repeat(32),
    phoneConfig: "encrypted-only",
  });

  const state = await integration.connection.connect("wg-1");

  assert.equal(state.status, "connected");
  assert.equal(mobileServer.getClientCount(), 1);
  assert.deepEqual(relayAuthorizations, [`Bearer ${relayToken}`]);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${relayToken}|${staleMobileToken}|${currentMobileToken}`));
  await integration.dispose();
});

test("safeStorage unavailable and Linux basic_text fail closed while IPC remains available", async (t) => {
  for (const entry of [
    { platform: "darwin", safeStorage: safeStorage({ isEncryptionAvailable: () => false }) },
    { platform: "linux", safeStorage: safeStorage({ getSelectedStorageBackend: () => "basic_text" }) },
  ]) {
    const fx = makeIntegration(t, entry);
    assert.equal(fx.integration.available, false);
    assert.equal(fx.integration.errorCode, "secure_storage_unavailable");
    const result = await fx.ipc.invoke("wgRelay:deploy", {
      profile: settingsController().getSnapshot().wgRelay.profiles[0],
      password: "must-not-run-ssh",
    });
    assert.deepEqual(result, { status: "error", errorCode: "secure_storage_unavailable" });
    await fx.integration.dispose();
  }
});

test("main integration snapshots safeStorage availability exactly once", async (t) => {
  let availabilityChecks = 0;
  const fx = makeIntegration(t, {
    safeStorage: safeStorage({
      isEncryptionAvailable() {
        availabilityChecks += 1;
        return availabilityChecks === 1;
      },
    }),
  });

  assert.equal(availabilityChecks, 1);
  assert.equal(fx.integration.available, true);
  assert.equal(Object.hasOwn(fx.integration, "errorCode"), false);
  await fx.integration.dispose();
});

test("quit barrier prevents exit until one asynchronous WG Relay disposal completes", async () => {
  let releaseDispose;
  const disposeGate = new Promise((resolve) => { releaseDispose = resolve; });
  const scheduled = [];
  let disposeCalls = 0;
  let quitCalls = 0;
  const barrier = createWgRelayQuitBarrier({
    async dispose() { disposeCalls += 1; await disposeGate; },
    quit() { quitCalls += 1; },
    schedule(callback) { scheduled.push(callback); },
  });
  const firstEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  const duplicateEvent = { prevented: false, preventDefault() { this.prevented = true; } };

  assert.equal(barrier.beforeQuit(firstEvent), true);
  assert.equal(barrier.beforeQuit(duplicateEvent), true);
  assert.equal(firstEvent.prevented, true);
  assert.equal(duplicateEvent.prevented, true);
  assert.equal(disposeCalls, 1);
  assert.equal(quitCalls, 0);

  releaseDispose();
  await barrier.wait();
  assert.equal(scheduled.length, 1);
  assert.equal(quitCalls, 0);
  scheduled[0]();
  assert.equal(quitCalls, 1);

  const resumedEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(barrier.beforeQuit(resumedEvent), false);
  assert.equal(resumedEvent.prevented, false);
  assert.equal(disposeCalls, 1);
});

test("quit barrier keeps the process alive after recovery persistence failure and allows retry", async () => {
  let disposeCalls = 0;
  let quitCalls = 0;
  const barrier = createWgRelayQuitBarrier({
    dispose() {
      disposeCalls += 1;
      if (disposeCalls === 1) throw Object.assign(new Error("recovery pending"), {
        code: "recovery_persistence_required",
      });
      return Promise.resolve();
    },
    quit() { quitCalls += 1; },
    schedule(callback) { callback(); },
  });
  const firstEvent = { prevented: false, preventDefault() { this.prevented = true; } };

  assert.equal(barrier.beforeQuit(firstEvent), true);
  await assert.rejects(barrier.wait(), (error) => error.code === "recovery_persistence_required");
  assert.equal(firstEvent.prevented, true);
  assert.equal(quitCalls, 0);

  const retryEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(barrier.beforeQuit(retryEvent), true);
  await barrier.wait();
  assert.equal(disposeCalls, 2);
  assert.equal(quitCalls, 1);
});

test("integration disposal is idempotent and suppresses late sidecar endpoint publication", async (t) => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const fx = makeIntegration(t, {
    sidecarFactory(options) {
      const sidecar = new FakeSidecar(options, fx ? fx.events : []);
      sidecar.start = async () => {
        await startGate;
        return { listen: "127.0.0.1:49999", generation: 1 };
      };
      return sidecar;
    },
  });
  fx.integration.secretStore.write("wg-1", {
    pcConfig: PC_CONFIG,
    relayUrl: "ws://10.8.0.1:7891",
    relayToken: "11".repeat(32),
    managementToken: "22".repeat(32),
  });
  const connecting = fx.integration.connection.connect("wg-1");
  const firstDispose = fx.integration.dispose();
  const secondDispose = fx.integration.dispose();
  assert.equal(firstDispose, secondDispose);
  releaseStart();
  await assert.rejects(connecting);
  await firstDispose;
  assert.equal(fx.integration.getForwardEndpoint("wg-1"), null);
});

test("dispose starts connection cancellation immediately while an IPC deploy is still pending", async (t) => {
  let releaseDeploy;
  const deployGate = new Promise((resolve) => { releaseDeploy = resolve; });
  let connectionDisposed = false;
  const fx = makeIntegration(t, {
    connectionFactory({ runtime }) {
      return {
        connect: async (id) => runtime.setStatus(id, { status: "connected", generation: 1 }),
        disconnect: async (id) => runtime.setStatus(id, { status: "idle", generation: 2 }),
        status: (id) => runtime.getProfileStatus(id),
        async dispose() { connectionDisposed = true; },
      };
    },
    deployFn: async () => {
      await deployGate;
      return { ok: false, reason: "cancelled", remoteCommitted: false };
    },
  });
  const deploying = fx.ipc.invoke("wgRelay:deploy", {
    profile: settingsController().getSnapshot().wgRelay.profiles[0],
    password: "short-lived",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const disposing = fx.integration.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectionDisposed, true);
  releaseDeploy();
  await deploying;
  await disposing;
});

test("main.js wires WG Relay only inside app readiness and gates quit on disposal", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const ready = source.indexOf("app.whenReady().then(() => {");
  const create = source.indexOf("createWgRelayMainIntegration({");
  assert.ok(ready >= 0 && create > ready);
  for (const fragment of [
    "safeStorage,", 'userDataPath: app.getPath("userData")', "resourcesPath: process.resourcesPath",
    "isPackaged: app.isPackaged", "platform: process.platform", "arch: process.arch",
    "settingsController: _settingsController", "BrowserWindow", "ipcMain", "dialog", "mobileIntegration",
  ]) assert.ok(source.includes(fragment), fragment);
  assert.match(source, /app\.on\("before-quit"[\s\S]*disposeWgRelayIntegration\(\)/);
  assert.match(source, /app\.on\("before-quit"[\s\S]*_wgRelayQuitBarrier\.beforeQuit\(event\)/);
  assert.match(source, /app\.on\("will-quit"[\s\S]*disposeWgRelayIntegration\(\)/);
  assert.doesNotMatch(source.slice(0, ready), /createWgRelayMainIntegration\(\{/);
});

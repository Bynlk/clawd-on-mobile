"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RelayBridge } = require("../src/relay-bridge-integration");

test("production server injects a Mobile token provider instead of a startup snapshot", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  assert.match(source, /initRelayBridge\(ctx\.relayPrefs,\s*\{[\s\S]*?getLocalToken:\s*\(\)\s*=>\s*getMobileToken\(\)/);
  assert.doesNotMatch(source, /initRelayBridge\(ctx\.relayPrefs,\s*\{[\s\S]*?localToken:\s*getMobileToken\(\)/);
});

test("production server wires RelayBridge to the live SettingsController", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  assert.match(mainSource, /relayPrefs:\s*_settingsController/);
  assert.match(serverSource, /initRelayBridge\(ctx\.relayPrefs,\s*\{/);
  assert.doesNotMatch(serverSource, /const prefsModule = require\("\.\/prefs"\)/);
});

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.closed = [];
    FakeWebSocket.connections.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  close(code, reason) {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }

  terminate() {
    this.closed.push(["terminate"]);
    this.readyState = 3;
  }
}
FakeWebSocket.connections = [];

function fixture(overrides = {}) {
  FakeWebSocket.connections = [];
  const logs = [];
  const bridge = new RelayBridge({
    WebSocketImpl: FakeWebSocket,
    localToken: "local secret",
    getLocalPort: () => 23335,
    log: (...parts) => logs.push(parts.join(" ")),
    ...overrides,
  });
  return { bridge, logs };
}

function fakePrefs(initial) {
  const values = { ...initial };
  const listeners = new Map();
  return {
    get(name) { return values[name]; },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    emit(name, value) {
      values[name] = value;
      const listener = listeners.get(name);
      if (listener) listener(value);
    },
    listeners,
  };
}

test("configure/start/wait connect Relay then the authenticated local mobile endpoint", async () => {
  const { bridge } = fixture();
  assert.strictEqual(bridge.configure({ url: "ws://127.0.0.1:43127", token: "relay secret" }), bridge);
  assert.strictEqual(bridge.start(), bridge);
  assert.strictEqual(bridge.start(), bridge);
  assert.equal(FakeWebSocket.connections.length, 1);
  const waiting = bridge.waitUntilConnected(50);

  const relay = FakeWebSocket.connections[0];
  assert.equal(relay.url, "ws://127.0.0.1:43127/mobile/ws?role=pc");
  assert.deepEqual(relay.options.headers, { Authorization: "Bearer relay secret" });
  relay.open();
  assert.equal(bridge.status, "connecting");

  const local = FakeWebSocket.connections[1];
  assert.equal(local.url, "ws://127.0.0.1:23335/mobile/ws?role=pc");
  assert.deepEqual(local.options.headers, { Authorization: "Bearer local secret" });
  local.open();

  await waiting;
  assert.equal(bridge.status, "connected");
  await bridge.stop();
});

test("local connection reads the current Mobile token and port when the socket is created", async () => {
  let token = "token-before-start";
  let port = 23334;
  const { bridge, logs } = fixture({
    localToken: "stale-constructor-token",
    getLocalToken: () => token,
    getLocalPort: () => port,
  });
  bridge.configure({ url: "ws://127.0.0.1:43127", token: "relay-secret" }).start();
  token = "token-at-connect";
  port = 24444;

  FakeWebSocket.connections[0].open();

  const local = FakeWebSocket.connections[1];
  assert.equal(local.url, "ws://127.0.0.1:24444/mobile/ws?role=pc");
  assert.deepEqual(local.options.headers, { Authorization: "Bearer token-at-connect" });
  assert.doesNotMatch(JSON.stringify(logs), /token-before-start|token-at-connect|stale-constructor-token/);
  await bridge.stop();
});

test("configure is idempotent, validates input, and never writes prefs", async () => {
  const { bridge } = fixture();
  const config = { url: "ws://127.0.0.1:40001", token: "token-a" };
  bridge.configure(config);
  bridge.configure({ ...config });
  assert.throws(() => bridge.configure({ url: "https://relay.example", token: "x" }), /url/i);
  assert.throws(() => bridge.configure({ url: config.url, token: "" }), /token/i);
  bridge.start();
  assert.throws(() => bridge.configure({ url: "ws://127.0.0.1:40002", token: "token-b" }), /running/i);
  await bridge.stop();
  bridge.configure({ url: "ws://127.0.0.1:40002", token: "token-b" });
});

test("waitUntilConnected reports authentication, connection, and timeout failures", async (t) => {
  await t.test("auth", async () => {
    const { bridge } = fixture();
    bridge.configure({ url: "ws://127.0.0.1:40001", token: "secret" }).start();
    const waiting = bridge.waitUntilConnected(50);
    FakeWebSocket.connections[0].emit("unexpected-response", {}, { statusCode: 401 });
    await assert.rejects(waiting, (error) => error.code === "relay_auth_failed");
    await bridge.stop();
  });
  await t.test("close before ready", async () => {
    const { bridge } = fixture();
    bridge.configure({ url: "ws://127.0.0.1:40001", token: "secret" }).start();
    const waiting = bridge.waitUntilConnected(50);
    FakeWebSocket.connections[0].emit("close", 1006, "secret must not escape");
    await assert.rejects(waiting, (error) => error.code === "relay_connect_failed");
    await bridge.stop();
  });
  await t.test("timeout", async () => {
    const { bridge } = fixture();
    bridge.configure({ url: "ws://127.0.0.1:40001", token: "secret" }).start();
    await assert.rejects(bridge.waitUntilConnected(2), (error) => error.code === "relay_connect_timeout");
    await bridge.stop();
  });
});

test("stop is idempotent and stale sockets cannot reconnect or mutate a new generation", async () => {
  const { bridge } = fixture();
  bridge.configure({ url: "ws://127.0.0.1:40001", token: "first" }).start();
  const oldRelay = FakeWebSocket.connections[0];
  const firstStop = bridge.stop();
  assert.strictEqual(firstStop, bridge.stop());
  await firstStop;

  bridge.configure({ url: "ws://127.0.0.1:40002", token: "second" }).start();
  const currentRelay = FakeWebSocket.connections[1];
  oldRelay.open();
  oldRelay.emit("close", 1006, "late");
  assert.equal(FakeWebSocket.connections.length, 2);
  assert.equal(bridge.status, "connecting");

  currentRelay.open();
  FakeWebSocket.connections[2].open();
  await bridge.waitUntilConnected(50);
  assert.equal(bridge.status, "connected");
  await bridge.stop();
});

test("same-generation Relay reopens reuse one healthy local socket and stop closes it", async () => {
  const { bridge } = fixture();
  bridge.configure({ url: "ws://127.0.0.1:40001", token: "secret" }).start();
  const firstRelay = FakeWebSocket.connections[0];
  firstRelay.open();
  const local = FakeWebSocket.connections[1];
  local.open();

  firstRelay.emit("close", 1006, "relay restart");
  bridge.connectToRelay(bridge._generation);
  const secondRelay = FakeWebSocket.connections[2];
  secondRelay.open();
  secondRelay.emit("close", 1006, "relay restart again");
  bridge.connectToRelay(bridge._generation);
  const thirdRelay = FakeWebSocket.connections.at(-1);
  thirdRelay.open();

  const localConnections = FakeWebSocket.connections.filter((socket) => socket.url.includes("127.0.0.1:23335"));
  assert.deepEqual(localConnections, [local]);
  await bridge.stop();
  assert.equal(local.closed.length, 1);
});

test("Relay reopen also reuses a still-connecting local socket", async () => {
  const { bridge } = fixture();
  bridge.configure({ url: "ws://127.0.0.1:40001", token: "secret" }).start();
  const firstRelay = FakeWebSocket.connections[0];
  firstRelay.open();
  const connectingLocal = FakeWebSocket.connections[1];

  firstRelay.emit("close", 1006, "relay restart");
  bridge.connectToRelay(bridge._generation);
  FakeWebSocket.connections[2].open();

  const localConnections = FakeWebSocket.connections.filter((socket) => socket.url.includes("127.0.0.1:23335"));
  assert.deepEqual(localConnections, [connectingLocal]);
  assert.deepEqual(connectingLocal.closed, []);
  await bridge.stop();
});

test("replacing an unhealthy local socket closes it and cancels its reconnect timer", async () => {
  const { bridge } = fixture();
  bridge.configure({ url: "ws://127.0.0.1:40001", token: "secret" }).start();
  const firstRelay = FakeWebSocket.connections[0];
  firstRelay.open();
  const oldLocal = FakeWebSocket.connections[1];
  oldLocal.readyState = 3;
  bridge.scheduleLocalReconnect(bridge._generation);

  firstRelay.emit("close", 1006, "relay restart");
  bridge.connectToRelay(bridge._generation);
  FakeWebSocket.connections[2].open();

  assert.equal(oldLocal.closed.length, 1);
  assert.equal(bridge.localReconnectTimer, null);
  await bridge.stop();
  const localConnections = FakeWebSocket.connections.filter((socket) => socket.url.includes("127.0.0.1:23335"));
  assert.equal(oldLocal.closed.length, 2);
  assert.ok(localConnections.every((socket) => socket.closed.length >= 1));
});

test("Relay token never appears in bridge logs or public failures", async () => {
  const secret = "RELAY-TOKEN-NEVER-LOG";
  const { bridge, logs } = fixture();
  const failures = [];
  bridge.on("failure", (failure) => failures.push(failure));
  bridge.configure({ url: "ws://127.0.0.1:40001", token: secret }).start();
  FakeWebSocket.connections[0].emit("error", new Error(secret));
  FakeWebSocket.connections[0].emit("close", 1006, secret);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(JSON.stringify({ logs, failures }), new RegExp(secret));
  await bridge.stop();
});

test("legacy init(prefs) remains supported", async () => {
  const listeners = new Map();
  const prefs = {
    get(name) {
      return { relayEnabled: true, relayUrl: "ws://127.0.0.1:40001", relayToken: "legacy-token" }[name];
    },
    on(name, listener) { listeners.set(name, listener); },
    off(name) { listeners.delete(name); },
  };
  const { bridge } = fixture();
  bridge.init(prefs);
  assert.equal(FakeWebSocket.connections.length, 1);
  listeners.get("relayEnabled")(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.status, "disconnected");
  bridge.destroy();
});

test("init subscribes to the SettingsController get/subscribeKey API", async () => {
  const values = {
    relayEnabled: false,
    relayUrl: "",
    relayToken: "",
  };
  const listeners = new Map();
  const prefs = {
    get(name) { return values[name]; },
    subscribeKey(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  };
  const update = (name, value) => {
    values[name] = value;
    listeners.get(name)(value, { ...values });
  };
  const { bridge } = fixture();

  bridge.init(prefs);
  assert.deepEqual([...listeners.keys()].sort(), ["relayEnabled", "relayToken", "relayUrl"]);
  update("relayUrl", "ws://127.0.0.1:40001");
  update("relayToken", "controller-token");
  update("relayEnabled", true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.connections.length, 1);
  assert.deepEqual(FakeWebSocket.connections[0].options.headers, {
    Authorization: "Bearer controller-token",
  });
  await bridge.dispose();
  assert.equal(listeners.size, 0);
});

test("legacy init starts when enabled config becomes complete after initialization", async () => {
  const prefs = fakePrefs({ relayEnabled: true, relayUrl: "", relayToken: "" });
  const { bridge } = fixture();
  bridge.init(prefs);
  assert.equal(FakeWebSocket.connections.length, 0);

  prefs.emit("relayUrl", "ws://127.0.0.1:40001");
  prefs.emit("relayToken", "late-token");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.connections.length, 1);
  assert.equal(bridge.running, true);
  bridge.destroy();
});

test("legacy disable wins an in-flight config restart and cannot resurrect the bridge", async () => {
  const prefs = fakePrefs({
    relayEnabled: true,
    relayUrl: "ws://127.0.0.1:40001",
    relayToken: "first-token",
  });
  const { bridge } = fixture();
  bridge.init(prefs);
  assert.equal(FakeWebSocket.connections.length, 1);

  prefs.emit("relayToken", "second-token");
  prefs.emit("relayEnabled", false);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.running, false);
  assert.equal(FakeWebSocket.connections.length, 1);
  bridge.destroy();
});

test("legacy config change performs one stop then starts the latest complete config", async () => {
  const prefs = fakePrefs({
    relayEnabled: true,
    relayUrl: "ws://127.0.0.1:40001",
    relayToken: "first-token",
  });
  const { bridge } = fixture();
  bridge.init(prefs);
  const oldRelay = FakeWebSocket.connections[0];

  prefs.emit("relayUrl", "ws://127.0.0.1:40002");
  prefs.emit("relayToken", "latest-token");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.connections.length, 2);
  assert.equal(oldRelay.closed.length, 1);
  assert.equal(FakeWebSocket.connections[1].url, "ws://127.0.0.1:40002/mobile/ws?role=pc");
  assert.deepEqual(FakeWebSocket.connections[1].options.headers, {
    Authorization: "Bearer latest-token",
  });
  bridge.destroy();
});

test("clearConfig and dispose scrub credentials, sockets, timers, prefs, and listeners", async () => {
  const prefs = fakePrefs({
    relayEnabled: true,
    relayUrl: "ws://127.0.0.1:40001",
    relayToken: "secret-to-clear",
  });
  const { bridge } = fixture();
  bridge.on("failure", () => {});
  bridge.init(prefs);
  FakeWebSocket.connections[0].open();
  bridge.scheduleLocalReconnect(bridge._generation);

  await bridge.stop();
  const stoppedGeneration = bridge._generation;
  assert.strictEqual(bridge.clearConfig(), bridge);
  await bridge.dispose();

  assert.equal(bridge.config, null);
  assert.equal(bridge.relayWs, null);
  assert.equal(bridge.localWs, null);
  assert.equal(bridge.relayReconnectTimer, null);
  assert.equal(bridge.localReconnectTimer, null);
  assert.equal(prefs.listeners.size, 0);
  assert.equal(bridge.listenerCount("failure"), 0);
  assert.equal(bridge._generation, stoppedGeneration);
});

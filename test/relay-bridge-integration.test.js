"use strict";

const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RelayBridge } = require("../src/relay-bridge-integration");

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

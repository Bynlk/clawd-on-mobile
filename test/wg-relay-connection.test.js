"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { test } = require("node:test");

const { createWgRelayRuntime } = require("../src/wg-relay-runtime");
const {
  createWgRelayConnection,
  probeRelayHealth,
} = require("../src/wg-relay-connection");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}

const PC_CONFIG = [
  "[Interface]",
  "PrivateKey = PRIVATE-SECRET",
  "Address = 10.8.0.2/32",
  "[Peer]",
  "PublicKey = PUBLIC-SECRET",
  "Endpoint = relay.example.com:51820",
  "AllowedIPs = 10.8.0.0/24",
  "PersistentKeepalive = 25",
  "",
].join("\n");

function secrets(overrides = {}) {
  return {
    pcConfig: PC_CONFIG,
    relayUrl: "ws://10.8.0.1:7891",
    relayToken: "RELAY-TOKEN-SECRET",
    managementToken: "MANAGEMENT-SECRET",
    ...overrides,
  };
}

class FakeSidecar extends EventEmitter {
  constructor(profileId, events, startResult) {
    super();
    this.profileId = profileId;
    this.events = events;
    this.startResult = startResult;
    this.config = null;
  }

  start(config) {
    this.config = config;
    this.events.push(`${this.profileId}:sidecar-start`);
    return this.startResult || Promise.resolve({ listen: "127.0.0.1:43127", generation: 1 });
  }

  async stop() {
    this.events.push(`${this.profileId}:sidecar-stop`);
  }

  async dispose() {
    this.events.push(`${this.profileId}:sidecar-dispose`);
    this.removeAllListeners();
  }
}

class FakeBridge extends EventEmitter {
  constructor(profileId, events, waitResult) {
    super();
    this.profileId = profileId;
    this.events = events;
    this.waitResult = waitResult;
    this.config = null;
  }

  configure(config) {
    this.config = config;
    this.events.push(`${this.profileId}:bridge-configure`);
    return this;
  }

  start() {
    this.events.push(`${this.profileId}:bridge-start`);
    return this;
  }

  waitUntilConnected() {
    this.events.push(`${this.profileId}:bridge-wait`);
    return this.waitResult || Promise.resolve();
  }

  async stop() {
    this.events.push(`${this.profileId}:bridge-stop`);
  }

  destroy() {
    this.removeAllListeners();
  }
}

function fixture(overrides = {}) {
  const events = [];
  const logs = [];
  const runtime = createWgRelayRuntime();
  const sidecars = new Map();
  const bridges = new Map();
  const secretStore = overrides.secretStore || {
    read(profileId) {
      events.push(`${profileId}:secret-read`);
      return secrets();
    },
  };
  const connection = createWgRelayConnection({
    runtime,
    secretStore,
    sidecarFactory(profileId) {
      const sidecar = overrides.sidecarFactory
        ? overrides.sidecarFactory(profileId, events)
        : new FakeSidecar(profileId, events);
      sidecars.set(profileId, sidecar);
      return sidecar;
    },
    bridgeFactory(profileId) {
      const bridge = overrides.bridgeFactory
        ? overrides.bridgeFactory(profileId, events)
        : new FakeBridge(profileId, events);
      bridges.set(profileId, bridge);
      return bridge;
    },
    async healthProbe(options) {
      events.push(`${options.profileId}:health`);
      if (overrides.healthProbe) return overrides.healthProbe(options);
      return { version: 1, status: "ok", uptimeSeconds: 1 };
    },
    healthTimeoutMs: 25,
    bridgeTimeoutMs: 25,
    log: (...parts) => logs.push(parts.join(" ")),
  });
  return { bridges, connection, events, logs, runtime, sidecars };
}

test("connect follows secret → sidecar → health → bridge configure/start/wait", async () => {
  const fx = fixture();
  const states = [];
  fx.runtime.on("status-changed", (state) => states.push(state.status));
  const result = await fx.connection.connect("alpha");

  assert.equal(result.status, "connected");
  assert.deepEqual(fx.events, [
    "alpha:secret-read",
    "alpha:sidecar-start",
    "alpha:health",
    "alpha:bridge-configure",
    "alpha:bridge-start",
    "alpha:bridge-wait",
  ]);
  assert.deepEqual(states, [
    "starting_tunnel", "verifying_relay", "connecting_relay", "connected",
  ]);
  assert.deepEqual(fx.sidecars.get("alpha").config, {
    PrivateKey: "PRIVATE-SECRET",
    Address: "10.8.0.2/32",
    ServerPublicKey: "PUBLIC-SECRET",
    Endpoint: "relay.example.com:51820",
    AllowedIP: "10.8.0.0/24",
    ForwardAddress: "10.8.0.1:7891",
    KeepaliveSeconds: 25,
  });
  assert.deepEqual(fx.bridges.get("alpha").config, {
    url: "ws://127.0.0.1:43127",
    token: "RELAY-TOKEN-SECRET",
  });
  assert.equal(fx.connection.status("alpha").generation, 1);
  assert.equal(Object.hasOwn(fx.connection.status("alpha"), "attempt"), false);
});

test("sidecar failure while health is pending aborts and rejects without starting bridge", async () => {
  const healthGate = deferred();
  let healthSignal = null;
  const fx = fixture({
    healthProbe: ({ signal }) => {
      healthSignal = signal;
      return healthGate.promise;
    },
  });
  const connecting = fx.connection.connect("alpha");
  const rejected = assert.rejects(connecting, (error) => error.code === "device_stopped");
  while (!fx.events.includes("alpha:health")) await new Promise((resolve) => setImmediate(resolve));
  fx.sidecars.get("alpha").emit("failure", { errorCode: "device_stopped", generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  healthGate.resolve({ version: 1, status: "ok", uptimeSeconds: 1 });

  await rejected;
  assert.equal(healthSignal && healthSignal.aborted, true);
  assert.equal(fx.events.includes("alpha:bridge-configure"), false);
  assert.equal(fx.events.filter((event) => event === "alpha:bridge-stop").length, 1);
  assert.equal(fx.events.filter((event) => event === "alpha:sidecar-stop").length, 1);
  assert.equal(fx.connection.status("alpha").status, "failed");
  assert.equal(fx.connection.status("alpha").errorCode, "device_stopped");
});

test("sidecar failure while bridge wait is pending rejects and ignores late bridge success", async () => {
  const bridgeGate = deferred();
  const fx = fixture({
    bridgeFactory: (id, events) => new FakeBridge(id, events, bridgeGate.promise),
  });
  const connecting = fx.connection.connect("alpha");
  const rejected = assert.rejects(connecting, (error) => error.code === "listener_failed");
  while (!fx.events.includes("alpha:bridge-wait")) await new Promise((resolve) => setImmediate(resolve));
  fx.sidecars.get("alpha").emit("failure", { errorCode: "listener_failed", generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  bridgeGate.resolve();

  await rejected;
  assert.equal(fx.events.filter((event) => event === "alpha:bridge-stop").length, 1);
  assert.equal(fx.events.filter((event) => event === "alpha:sidecar-stop").length, 1);
  assert.equal(fx.connection.status("alpha").status, "failed");
});

test("sidecar failure racing disconnect rolls back once and disconnect wins public state", async () => {
  const healthGate = deferred();
  const fx = fixture({ healthProbe: () => healthGate.promise });
  const connecting = fx.connection.connect("alpha");
  while (!fx.events.includes("alpha:health")) await new Promise((resolve) => setImmediate(resolve));
  fx.sidecars.get("alpha").emit("failure", { errorCode: "device_stopped", generation: 1 });
  const disconnecting = fx.connection.disconnect("alpha");
  healthGate.resolve({ version: 1, status: "ok", uptimeSeconds: 1 });

  await assert.rejects(connecting, (error) => error.code === "device_stopped");
  await disconnecting;
  assert.equal(fx.events.filter((event) => event === "alpha:bridge-stop").length, 1);
  assert.equal(fx.events.filter((event) => event === "alpha:sidecar-stop").length, 1);
  assert.equal(fx.connection.status("alpha").status, "idle");
});

test("sidecar failure racing dispose rolls back once and never reconnects", async () => {
  const bridgeGate = deferred();
  const fx = fixture({ bridgeFactory: (id, events) => new FakeBridge(id, events, bridgeGate.promise) });
  const connecting = fx.connection.connect("alpha");
  while (!fx.events.includes("alpha:bridge-wait")) await new Promise((resolve) => setImmediate(resolve));
  fx.sidecars.get("alpha").emit("failure", { errorCode: "listener_failed", generation: 1 });
  const disposing = fx.connection.dispose();
  bridgeGate.resolve();

  await assert.rejects(connecting, (error) => error.code === "listener_failed");
  await disposing;
  assert.equal(fx.events.filter((event) => event === "alpha:bridge-stop").length, 1);
  assert.equal(fx.events.filter((event) => event === "alpha:sidecar-stop").length, 1);
  assert.equal(fx.events.includes("alpha:bridge-start"), true);
  assert.equal(fx.connection.status("alpha").status, "idle");
});

test("failure paths rollback bridge before sidecar and expose only stable codes", async (t) => {
  await t.test("sidecar", async () => {
    const error = Object.assign(new Error("PRIVATE-SECRET"), { code: "sidecar_spawn_failed" });
    const fx = fixture({ sidecarFactory: (id, events) => new FakeSidecar(id, events, Promise.reject(error)) });
    await assert.rejects(fx.connection.connect("alpha"), (failure) => (
      failure.code === "sidecar_spawn_failed" && failure.message === "sidecar_spawn_failed"
    ));
    assert.deepEqual(fx.events.slice(-2), ["alpha:bridge-stop", "alpha:sidecar-stop"]);
    assert.equal(fx.connection.status("alpha").errorCode, "sidecar_spawn_failed");
  });

  for (const code of ["health_timeout", "health_http_status", "health_invalid_response"]) {
    await t.test(code, async () => {
      const fx = fixture({ healthProbe: async () => { throw Object.assign(new Error("secret"), { code }); } });
      await assert.rejects(fx.connection.connect("alpha"), (failure) => failure.code === code);
      assert.deepEqual(fx.events.slice(-2), ["alpha:bridge-stop", "alpha:sidecar-stop"]);
    });
  }

  await t.test("relay auth", async () => {
    const error = Object.assign(new Error("RELAY-TOKEN-SECRET"), { code: "relay_auth_failed" });
    const fx = fixture({ bridgeFactory: (id, events) => new FakeBridge(id, events, Promise.reject(error)) });
    await assert.rejects(fx.connection.connect("alpha"), (failure) => failure.code === "relay_auth_failed");
    assert.deepEqual(fx.events.slice(-2), ["alpha:bridge-stop", "alpha:sidecar-stop"]);
  });
});

test("connection preserves every known Go sidecar code and rejects unknown code-shaped data", async (t) => {
  const goCodes = [
    "invalid_config", "invalid_json", "trailing_data", "stdin_failed",
    "invalid_private_key", "invalid_server_public_key", "invalid_allowed_ip",
    "invalid_address", "invalid_endpoint", "invalid_forward_address", "invalid_keepalive",
    "device_create_failed", "device_config_failed", "device_start_failed",
    "endpoint_resolution_failed", "endpoint_resolution_canceled", "endpoint_resolution_timeout",
    "listen_failed", "listener_failed", "device_stopped", "listener_stopped",
  ];
  for (const code of goCodes) {
    await t.test(code, async () => {
      const error = Object.assign(new Error("redacted"), { code });
      const fx = fixture({ sidecarFactory: (id, events) => new FakeSidecar(id, events, Promise.reject(error)) });
      await assert.rejects(fx.connection.connect("alpha"), (failure) => failure.code === code);
    });
  }

  for (const malicious of [
    "valid_but_unknown_code",
    "a".repeat(64),
    "secret_token_must_not_escape",
  ]) {
    await t.test(`unknown:${malicious.length}`, async () => {
      const error = Object.assign(new Error(`message:${malicious}`), { code: malicious });
      const fx = fixture({ sidecarFactory: (id, events) => new FakeSidecar(id, events, Promise.reject(error)) });
      await assert.rejects(fx.connection.connect("alpha"), (failure) => (
        failure.code === "connection_failed" && !failure.message.includes(malicious)
      ));
      const publicData = JSON.stringify({ status: fx.connection.status("alpha"), logs: fx.logs });
      assert.doesNotMatch(publicData, new RegExp(malicious));
    });
  }
});

test("probeRelayHealth maps loopback forward endpoints to /health and validates responses", async (t) => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: 1, status: "ok", uptimeSeconds: 2 }));
      return;
    }
    if (req.url === "/status") { res.statusCode = 503; res.end("no"); return; }
    if (req.url === "/schema") { res.end(JSON.stringify({ status: "ok", token: "secret" })); return; }
    if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("location", "http://example.com/health"); res.end(); return; }
    if (req.url === "/large") { res.end("x".repeat(200)); return; }
    if (req.url === "/slow") { return; }
    res.statusCode = 404; res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;

  const healthy = await probeRelayHealth({ listen: `127.0.0.1:${port}`, timeoutMs: 50 });
  assert.equal(healthy.status, "ok");
  await assert.rejects(
    probeRelayHealth({ listen: `127.0.0.1:${port}`, path: "/status", timeoutMs: 50 }),
    (error) => error.code === "health_http_status",
  );
  await assert.rejects(
    probeRelayHealth({ listen: `127.0.0.1:${port}`, path: "/schema", timeoutMs: 50 }),
    (error) => error.code === "health_invalid_response",
  );
  await assert.rejects(
    probeRelayHealth({ listen: `127.0.0.1:${port}`, path: "/redirect", timeoutMs: 50 }),
    (error) => error.code === "health_redirect_rejected",
  );
  await assert.rejects(
    probeRelayHealth({ listen: `127.0.0.1:${port}`, path: "/large", timeoutMs: 50, maxBytes: 64 }),
    (error) => error.code === "health_response_too_large",
  );
  await assert.rejects(
    probeRelayHealth({ listen: `127.0.0.1:${port}`, path: "/slow", timeoutMs: 5 }),
    (error) => error.code === "health_timeout",
  );
  await assert.rejects(
    probeRelayHealth({ listen: "192.0.2.1:80", timeoutMs: 5 }),
    (error) => error.code === "health_non_loopback",
  );
  await assert.rejects(
    probeRelayHealth({ listen: "127.0.0.1:99999", timeoutMs: 5 }),
    (error) => error.code === "health_non_loopback",
  );
});

test("duplicate connect calls coalesce without duplicate work", async () => {
  const gate = deferred();
  const fx = fixture({ sidecarFactory: (id, events) => new FakeSidecar(id, events, gate.promise) });
  const first = fx.connection.connect("alpha");
  const duplicate = fx.connection.connect("alpha");
  assert.strictEqual(first, duplicate);
  gate.resolve({ listen: "127.0.0.1:43127", generation: 1 });
  await first;
  assert.equal(fx.events.filter((event) => event === "alpha:sidecar-start").length, 1);
});

test("disconnect wins a connect race and stale completion cannot restart the bridge", async () => {
  const gate = deferred();
  const fx = fixture({ sidecarFactory: (id, events) => new FakeSidecar(id, events, gate.promise) });
  const connecting = fx.connection.connect("alpha");
  const disconnected = await fx.connection.disconnect("alpha");
  assert.equal(disconnected.status, "idle");
  gate.resolve({ listen: "127.0.0.1:43127", generation: 1 });
  await assert.rejects(connecting, (error) => error.code === "connection_cancelled");
  assert.equal(fx.events.includes("alpha:health"), false);
  assert.equal(fx.events.includes("alpha:bridge-start"), false);
  assert.deepEqual(fx.events.slice(-2), ["alpha:bridge-stop", "alpha:sidecar-stop"]);
});

test("a newer connect attempt is immune to late events from the old attempt", async () => {
  const firstGate = deferred();
  let count = 0;
  const fx = fixture({
    sidecarFactory(id, events) {
      count++;
      return new FakeSidecar(id, events, count === 1 ? firstGate.promise : null);
    },
  });
  const first = fx.connection.connect("alpha");
  const oldSidecar = fx.sidecars.get("alpha");
  await fx.connection.disconnect("alpha");
  const second = fx.connection.connect("alpha");
  firstGate.resolve({ listen: "127.0.0.1:40001", generation: 1 });
  await assert.rejects(first, (error) => error.code === "connection_cancelled");
  await second;
  oldSidecar.emit("failure", { errorCode: "late_failure", generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.connection.status("alpha").status, "connected");
  assert.equal(fx.connection.status("alpha").generation, 3);
});

test("unexpected active sidecar exit fails the profile and stops bridge before sidecar", async () => {
  const fx = fixture();
  await fx.connection.connect("alpha");
  fx.sidecars.get("alpha").emit("failure", {
    errorCode: "sidecar_unexpected_exit", generation: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.connection.status("alpha").status, "failed");
  assert.equal(fx.connection.status("alpha").errorCode, "sidecar_unexpected_exit");
  assert.deepEqual(fx.events.slice(-2), ["alpha:bridge-stop", "alpha:sidecar-stop"]);
});

test("profiles are isolated and createWgRelayConnection never auto-starts", async () => {
  const fx = fixture();
  assert.deepEqual(fx.events, []);
  assert.equal(fx.connection.status("alpha").status, "idle");
  const alpha = fx.connection.connect("alpha");
  const beta = fx.connection.connect("beta");
  await Promise.all([alpha, beta]);
  await fx.connection.disconnect("alpha");
  assert.equal(fx.connection.status("alpha").status, "idle");
  assert.equal(fx.connection.status("beta").status, "connected");
  assert.equal(fx.connection.status("alpha").generation, 2);
  assert.equal(fx.connection.status("beta").generation, 1);
});

test("secrets never enter public status, errors, or logs", async () => {
  const fx = fixture({
    healthProbe: async () => {
      throw Object.assign(new Error("PRIVATE-SECRET RELAY-TOKEN-SECRET"), { code: "health_invalid_response" });
    },
  });
  let caught;
  try { await fx.connection.connect("alpha"); } catch (error) { caught = error; }
  const publicData = JSON.stringify({
    status: fx.connection.status("alpha"),
    error: { code: caught.code, message: caught.message },
    logs: fx.logs,
  });
  assert.doesNotMatch(publicData, /PRIVATE-SECRET|PUBLIC-SECRET|RELAY-TOKEN-SECRET|MANAGEMENT-SECRET/);
});

test("dispose disconnects every profile in bridge → sidecar order", async () => {
  const fx = fixture();
  await Promise.all([fx.connection.connect("alpha"), fx.connection.connect("beta")]);
  fx.events.length = 0;
  await fx.connection.dispose();
  assert.deepEqual(fx.events, [
    "alpha:bridge-stop", "alpha:sidecar-stop",
    "beta:bridge-stop", "beta:sidecar-stop",
    "alpha:sidecar-dispose", "beta:sidecar-dispose",
  ]);
  await assert.rejects(fx.connection.connect("alpha"), (error) => error.code === "connection_disposed");
});

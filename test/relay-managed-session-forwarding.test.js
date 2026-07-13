"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { RelayPairRegistry } = require("../relay/pair-registry");
const { MobileWSServer } = require("../src/mobile-ws-server");
const { ManagedSessionMobileBridge } = require("../src/managed-session-mobile-bridge");
const { initMobileServer } = require("../src/mobile-server-integration");

function socket(name) {
  return {
    name,
    OPEN: 1,
    readyState: 1,
    sent: [],
    closed: false,
    send(data) { this.sent.push(data); },
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3;
    },
  };
}

describe("RelayPairRegistry", () => {
  it("forwards frames between exactly one PC and one phone", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phone = socket("phone");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phone);

    pairs.forward("token", "pc", "from-pc");
    assert.deepEqual(phone.sent, ["from-pc"]);
    pairs.forward("token", "phone", "from-phone", phone);
    const inbound = JSON.parse(pc.sent[0]);
    assert.equal(inbound.payload, "from-phone");
  });

  it("wraps phone frames with source identity and routes targeted PC replies", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phone = socket("phone");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phone);

    pairs.forward("token", "phone", "from-phone", phone);
    const inbound = JSON.parse(pc.sent.at(-1));
    assert.equal(inbound.type, "relay_forward");
    assert.equal(inbound.payload, "from-phone");
    assert.ok(inbound.sourceClientId);

    pairs.forward("token", "pc", JSON.stringify({
      type: "relay_forward",
      targetClientId: inbound.sourceClientId,
      payload: "only-phone",
    }), pc);
    assert.deepEqual(phone.sent, ["only-phone"]);
  });

  it("replaces the prior phone and keeps only the replacement", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const first = socket("first");
    const replacement = socket("replacement");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", first);
    pairs.add("token", "phone", replacement);

    pairs.forward("token", "pc", "next");
    assert.equal(first.closed, true);
    assert.deepEqual(first.sent, []);
    assert.deepEqual(replacement.sent, ["next"]);
    assert.equal(pairs.get("token").phone, replacement);
    assert.deepEqual(pairs.countConnections(), { pc: 1, phone: 1 });
  });

  it("replaces only the single PC and never retains message payloads", () => {
    const pairs = new RelayPairRegistry();
    const first = socket("first");
    const second = socket("second");
    pairs.add("token", "pc", first);
    pairs.add("token", "pc", second);
    pairs.forward("token", "pc", "secret-payload");

    assert.equal(first.closed, true);
    assert.equal(pairs.get("token").pc, second);
    assert.equal(Object.prototype.hasOwnProperty.call(pairs.get("token"), "messages"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pairs.get("token"), "history"), false);
  });
});

class TopologySocket extends EventEmitter {
  constructor(sendImpl = null) {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.sendImpl = sendImpl;
  }
  send(data) {
    if (this.sendImpl) this.sendImpl(data);
    else this.sent.push(String(data));
  }
  close() { this.readyState = 3; this.emit("close", 1000, "closed"); }
  terminate() { this.close(); }
}

class TopologyRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = [{ id: "s1", agentId: "codex", cwd: "/repo", status: "running" }];
  }
  capabilities() { return { agents: [{ id: "codex" }] }; }
  listSessions() { return this.sessions; }
  historyAfter() { return { records: [], oldestSequence: 0, latestSequence: 0, resetRequired: false, hasMore: false }; }
  write(sessionId, data) { return { sessionId, sequence: 2, kind: "user_input", text: data }; }
  resize() {}
  interrupt() {}
  create() { return this.sessions[0]; }
}

function setupRelayTopology() {
  const pairs = new RelayPairRegistry();
  const mobile = new MobileWSServer({ on() {} }, { token: "local-token", maxClients: 10 });
  const runtime = new TopologyRuntime();
  const bridge = new ManagedSessionMobileBridge({ mobileServer: mobile, runtime, now: () => 1000 });
  bridge.attach();

  let relayPc;
  const desktopTransport = new TopologySocket((data) =>
    pairs.forward("token", "pc", data, relayPc)
  );
  relayPc = new TopologySocket((data) => desktopTransport.emit("message", data));
  pairs.add("token", "pc", relayPc);
  mobile._handleConnection(desktopTransport, {
    url: "/mobile/ws?token=local-token&role=pc",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  });
  const phone = new TopologySocket();
  pairs.add("token", "phone", phone);
  phone.sent.length = 0;

  const sendFromPhone = (phone, payload) => {
    pairs.forward("token", "phone", JSON.stringify(payload), phone);
  };
  const disconnectPhone = (phone) => {
    const sourceClientId = pairs.clientIdFor(phone);
    pairs.remove("token", "phone", phone);
    phone.readyState = 3;
    relayPc.send(JSON.stringify({ type: "relay_client_disconnected", sourceClientId }));
  };
  return {
    pairs, mobile, runtime, bridge, relayPc, desktopTransport,
    phone, sendFromPhone, disconnectPhone,
  };
}

describe("managed console over a real Relay topology", () => {
  it("routes managed-session deltas to the single Relay phone", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { runtime, phone, sendFromPhone } = topology;

    sendFromPhone(phone, { type: "managed_content_sync_set", enabled: true, deviceId: "phone" });
    phone.sent.length = 0;

    runtime.emit("delta", { sessionId: "s1", sequence: 1, kind: "terminal_delta", text: "private" });

    assert.ok(phone.sent.some((raw) => JSON.parse(raw).type === "managed_session_delta"));
  });

  it("releases the single phone's lease when it disables sync and lets it reacquire", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { phone, sendFromPhone } = topology;
    sendFromPhone(phone, { type: "managed_content_sync_set", enabled: true, deviceId: "phone" });
    sendFromPhone(phone, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone" });
    sendFromPhone(phone, { type: "managed_content_sync_set", enabled: false, deviceId: "phone" });
    sendFromPhone(phone, { type: "managed_content_sync_set", enabled: true, deviceId: "phone" });
    phone.sent.length = 0;

    sendFromPhone(phone, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone" });

    const result = phone.sent.map((raw) => JSON.parse(raw)).find((message) =>
      message.type === "managed_session_input_lease_changed" && message.granted === true
    );
    assert.equal(result.owner, "phone");
    assert.equal(result.granted, true);
  });

  it("releases the disconnected phone subscription and lease for its replacement", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { runtime, phone, pairs, sendFromPhone, disconnectPhone } = topology;
    sendFromPhone(phone, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-old" });
    sendFromPhone(phone, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-old" });

    disconnectPhone(phone);
    const replacement = new TopologySocket();
    pairs.add("token", "phone", replacement);
    sendFromPhone(replacement, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-new" });
    replacement.sent.length = 0;
    sendFromPhone(replacement, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-new" });
    runtime.emit("delta", { sessionId: "s1", sequence: 3, kind: "terminal_delta", text: "still-live" });

    const messages = replacement.sent.map((raw) => JSON.parse(raw));
    assert.ok(messages.some((message) =>
      message.type === "managed_session_input_lease_changed" && message.granted === true
    ));
    assert.ok(messages.some((message) => message.type === "managed_session_delta"));
  });

  it("rate limits the logical phone without disconnecting the Relay transport", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { runtime, phone, sendFromPhone, desktopTransport } = topology;
    sendFromPhone(phone, { type: "managed_content_sync_set", enabled: true, deviceId: "phone" });
    phone.sent.length = 0;

    for (let index = 0; index < 65; index++) {
      sendFromPhone(phone, { type: "managed_sessions_request", deviceId: "phone" });
    }
    runtime.emit("delta", { sessionId: "s1", sequence: 4, kind: "terminal_delta", text: "still-connected" });

    assert.equal(desktopTransport.readyState, 1);
    assert.ok(phone.sent.some((raw) => {
      const message = JSON.parse(raw);
      return message.type === "managed_session_error" && message.code === "rate_limit_exceeded";
    }));
  });

  it("routes approval_result back to the single logical Relay phone", (t) => {
    const pairs = new RelayPairRegistry();
    const integration = initMobileServer({ getDataDir: () => "/tmp" }, {
      createHttpServer: () => ({ listen() {}, on() {} }),
    });
    integration.startMobileServer({}, { skipHttpServer: true });
    const mobile = integration.getMobileWS();
    let relayPc;
    const desktopTransport = new TopologySocket((data) => pairs.forward("token", "pc", data, relayPc));
    relayPc = new TopologySocket((data) => desktopTransport.emit("message", data));
    pairs.add("token", "pc", relayPc);
    mobile._handleConnection(desktopTransport, {
      url: `/mobile/ws?token=${integration.getMobileToken()}&role=pc`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    const phone = new TopologySocket();
    pairs.add("token", "phone", phone);
    phone.sent.length = 0;
    t.after(() => { integration.stopMobileServer(); mobile.close(); });

    pairs.forward("token", "phone", JSON.stringify({
      type: "permission_response",
      id: "unknown-approval",
      decision: "allow",
    }), phone);

    assert.ok(phone.sent.some((raw) => JSON.parse(raw).type === "approval_result"));
  });
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function openSocket(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(0), timeoutMs);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

it("production relay forwards more than 120 paired data frames without silent loss", async (t) => {
  const port = await reservePort();
  const token = "33".repeat(32);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "relay", "relay-server.js")], {
    env: { ...process.env, PORT: String(port), BIND_ADDR: "127.0.0.1", RELAY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => terminateChild(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay start timeout")), 5000);
    child.stdout.on("data", (data) => {
      if (String(data).includes("中继服务器启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`relay exited early: ${code}`)));
  });

  const pc = await openSocket(`ws://127.0.0.1:${port}/mobile/ws?role=pc`, token);
  const phone = await openSocket(`ws://127.0.0.1:${port}/mobile/ws?role=phone`, token);
  t.after(async () => {
    const closes = [waitForClose(pc, 250), waitForClose(phone, 250)];
    pc.close();
    phone.close();
    await Promise.all(closes);
  });
  const received = [];
  pc.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "relay_forward") received.push(message.payload);
  });
  for (let index = 0; index < 130; index++) phone.send(`frame-${index}`);

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      if (received.length === 130) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`received ${received.length}/130 frames`));
      setTimeout(poll, 10);
    };
    poll();
  });
  assert.deepEqual(received, Array.from({ length: 130 }, (_, index) => `frame-${index}`));
});

it("production relay retains handshake abuse limits across disconnects", async (t) => {
  const port = await reservePort();
  const token = "44".repeat(32);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "relay", "relay-server.js")], {
    env: { ...process.env, PORT: String(port), BIND_ADDR: "127.0.0.1", RELAY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => terminateChild(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay start timeout")), 5000);
    child.stdout.on("data", (data) => {
      if (String(data).includes("中继服务器启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  let finalCode = null;
  for (let index = 0; index < 121; index++) {
    const ws = await openSocket(`ws://127.0.0.1:${port}/mobile/ws?role=phone`, token);
    const closed = waitForClose(ws);
    if (index < 120) ws.close();
    finalCode = await closed;
  }
  assert.equal(finalCode, 4008);
});

it("production Relay uses the single-phone registry and managed-session envelope", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "relay/relay-server.js"), "utf8");
  assert.match(source, /RelayPairRegistry/);
  assert.match(source, /pairs\.forward\([^,]+, role, data, ws\)/);
  assert.match(source, /relay_client_disconnected/);
  assert.doesNotMatch(source, /pair\.phones\b/);
});

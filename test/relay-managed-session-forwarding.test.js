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
    close() { this.closed = true; this.readyState = 3; },
  };
}

describe("RelayPairRegistry", () => {
  it("forwards PC frames to every phone and each phone frame to the PC", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phoneA = socket("phone-a");
    const phoneB = socket("phone-b");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phoneA);
    pairs.add("token", "phone", phoneB);

    pairs.forward("token", "pc", "from-pc");
    assert.deepEqual(phoneA.sent, ["from-pc"]);
    assert.deepEqual(phoneB.sent, ["from-pc"]);
    pairs.forward("token", "phone", "from-phone");
    assert.deepEqual(pc.sent, ["from-phone"]);
  });

  it("wraps phone frames with source identity and routes targeted PC replies to one phone", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phoneA = socket("phone-a");
    const phoneB = socket("phone-b");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phoneA);
    pairs.add("token", "phone", phoneB);

    pairs.forward("token", "phone", "from-a", phoneA);
    const inbound = JSON.parse(pc.sent.at(-1));
    assert.equal(inbound.type, "relay_forward");
    assert.equal(inbound.payload, "from-a");
    assert.ok(inbound.sourceClientId);

    pairs.forward("token", "pc", JSON.stringify({
      type: "relay_forward",
      targetClientId: inbound.sourceClientId,
      payload: "only-a",
    }), pc);
    assert.deepEqual(phoneA.sent, ["only-a"]);
    assert.deepEqual(phoneB.sent, []);
  });

  it("disconnects one phone without replacing or closing the other", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phoneA = socket("phone-a");
    const phoneB = socket("phone-b");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phoneA);
    pairs.add("token", "phone", phoneB);
    pairs.remove("token", "phone", phoneA);

    pairs.forward("token", "pc", "next");
    assert.deepEqual(phoneA.sent, []);
    assert.deepEqual(phoneB.sent, ["next"]);
    assert.equal(phoneB.closed, false);
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
  const phoneA = new TopologySocket();
  const phoneB = new TopologySocket();
  pairs.add("token", "phone", phoneA);
  pairs.add("token", "phone", phoneB);
  phoneA.sent.length = 0;
  phoneB.sent.length = 0;

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
    phoneA, phoneB, sendFromPhone, disconnectPhone,
  };
}

describe("managed console over a real Relay topology", () => {
  it("keeps A enabled when B disables sync and routes deltas only to A", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { runtime, phoneA, phoneB, sendFromPhone } = topology;

    sendFromPhone(phoneA, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-a" });
    sendFromPhone(phoneB, { type: "managed_content_sync_set", enabled: false, deviceId: "phone-b" });
    phoneA.sent.length = 0;
    phoneB.sent.length = 0;

    runtime.emit("delta", { sessionId: "s1", sequence: 1, kind: "terminal_delta", text: "private" });

    assert.ok(phoneA.sent.some((raw) => JSON.parse(raw).type === "managed_session_delta"));
    assert.equal(phoneB.sent.some((raw) => JSON.parse(raw).type === "managed_session_delta"), false);
  });

  it("does not let B disabling sync release A's input lease", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { phoneA, phoneB, sendFromPhone } = topology;
    sendFromPhone(phoneA, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-a" });
    sendFromPhone(phoneA, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-a" });
    sendFromPhone(phoneB, { type: "managed_content_sync_set", enabled: false, deviceId: "phone-b" });
    sendFromPhone(phoneB, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-b" });
    phoneB.sent.length = 0;

    sendFromPhone(phoneB, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-b" });

    const result = phoneB.sent.map((raw) => JSON.parse(raw)).find((message) =>
      message.type === "managed_session_input_lease_changed" && message.granted === false
    );
    assert.equal(result.owner, "phone-a");
  });

  it("releases only the disconnected logical phone subscription and lease", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { runtime, phoneA, phoneB, sendFromPhone, disconnectPhone } = topology;
    sendFromPhone(phoneA, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-a" });
    sendFromPhone(phoneB, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-b" });
    sendFromPhone(phoneA, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-a" });

    disconnectPhone(phoneA);
    phoneB.sent.length = 0;
    sendFromPhone(phoneB, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-b" });
    runtime.emit("delta", { sessionId: "s1", sequence: 3, kind: "terminal_delta", text: "still-live" });

    const messages = phoneB.sent.map((raw) => JSON.parse(raw));
    assert.ok(messages.some((message) =>
      message.type === "managed_session_input_lease_changed" && message.granted === true
    ));
    assert.ok(messages.some((message) => message.type === "managed_session_delta"));
  });

  it("rate limits one logical phone without disconnecting the shared Relay transport", (t) => {
    const topology = setupRelayTopology();
    t.after(() => { topology.bridge.dispose(); topology.mobile.close(); });
    const { runtime, phoneA, phoneB, sendFromPhone, desktopTransport } = topology;
    sendFromPhone(phoneA, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-a" });
    sendFromPhone(phoneB, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-b" });
    phoneA.sent.length = 0;
    phoneB.sent.length = 0;

    for (let index = 0; index < 65; index++) {
      sendFromPhone(phoneB, { type: "managed_sessions_request", deviceId: "phone-b" });
    }
    runtime.emit("delta", { sessionId: "s1", sequence: 4, kind: "terminal_delta", text: "for-a" });

    assert.equal(desktopTransport.readyState, 1);
    assert.ok(phoneA.sent.some((raw) => JSON.parse(raw).type === "managed_session_delta"));
    assert.ok(phoneB.sent.some((raw) => {
      const message = JSON.parse(raw);
      return message.type === "managed_session_error" && message.code === "rate_limit_exceeded";
    }));
  });

  it("routes approval_result back to only the logical Relay phone", (t) => {
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
    const phoneA = new TopologySocket();
    const phoneB = new TopologySocket();
    pairs.add("token", "phone", phoneA);
    pairs.add("token", "phone", phoneB);
    phoneA.sent.length = 0;
    phoneB.sent.length = 0;
    t.after(() => { integration.stopMobileServer(); mobile.close(); });

    pairs.forward("token", "phone", JSON.stringify({
      type: "permission_response",
      id: "unknown-approval",
      decision: "allow",
    }), phoneA);

    assert.ok(phoneA.sent.some((raw) => JSON.parse(raw).type === "approval_result"));
    assert.equal(phoneB.sent.some((raw) => JSON.parse(raw).type === "approval_result"), false);
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

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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
  const child = spawn(process.execPath, [path.join(__dirname, "..", "relay", "relay-server.js")], {
    env: { ...process.env, PORT: String(port), BIND_ADDR: "127.0.0.1", TOKEN: "rate-test" },
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

  const pc = await openSocket(`ws://127.0.0.1:${port}/mobile/ws?role=pc`);
  const phone = await openSocket(`ws://127.0.0.1:${port}/mobile/ws?role=phone`);
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
  const child = spawn(process.execPath, [path.join(__dirname, "..", "relay", "relay-server.js")], {
    env: { ...process.env, PORT: String(port), BIND_ADDR: "127.0.0.1", TOKEN: "handshake-test" },
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
    const ws = await openSocket(`ws://127.0.0.1:${port}/mobile/ws?role=phone`);
    const closed = waitForClose(ws);
    if (index < 120) ws.close();
    finalCode = await closed;
  }
  assert.equal(finalCode, 4008);
});

it("both relay entry points use the multi-phone registry", () => {
  for (const relative of ["relay/relay-server.js", "relay-server.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(source, /RelayPairRegistry/);
    assert.match(source, /pairs\.forward\(token, role, data, ws\)/);
    assert.match(source, /relay_client_disconnected/);
    assert.doesNotMatch(source, /pair\.phone\b/);
  }
});

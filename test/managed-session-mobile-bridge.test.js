"use strict";

const { EventEmitter } = require("events");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ManagedSessionMobileBridge } = require("../src/managed-session-mobile-bridge");

class FakeMobileServer extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Set();
    this.sent = [];
    this.broadcasts = [];
  }
  onClientMessage(handler) { this.handlers.add(handler); }
  offClientMessage(handler) { this.handlers.delete(handler); }
  getClientId(ws) { return ws.id; }
  send(ws, payload) { this.sent.push({ ws, payload }); return true; }
  broadcast(payload) { this.broadcasts.push(payload); }
  receive(ws, payload) { for (const handler of this.handlers) handler(ws, payload); }
}

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = [{ id: "s1", agentId: "codex", cwd: "/repo", status: "running" }];
    this.writes = [];
    this.interrupts = [];
    this.resizes = [];
  }
  capabilities() { return { agents: [{ id: "codex", name: "Codex" }], directories: ["/repo"] }; }
  listSessions() { return this.sessions; }
  create(request) { const session = { id: "s2", ...request, status: "running" }; this.sessions.push(session); return session; }
  historyAfter(sessionId, sequence) {
    return {
      sessionId,
      records: [
        { sessionId, sequence: sequence + 1, kind: "terminal_delta", text: "a".repeat(30000) },
        { sessionId, sequence: sequence + 2, kind: "terminal_delta", text: "b".repeat(30000) },
      ],
      resetRequired: false,
      latestSequence: sequence + 2,
      oldestSequence: 1,
      hasMore: false,
    };
  }
  write(sessionId, data, options) { this.writes.push({ sessionId, data, options }); }
  interrupt(sessionId) { this.interrupts.push(sessionId); }
  resize(sessionId, cols, rows) { this.resizes.push({ sessionId, cols, rows }); }
}

function setup(options = {}) {
  const mobile = new FakeMobileServer();
  const runtime = new FakeRuntime();
  const bridge = new ManagedSessionMobileBridge({
    mobileServer: mobile,
    runtime,
    maxFrameBytes: options.maxFrameBytes || 48 * 1024,
    now: options.now || (() => 1000),
  });
  bridge.attach();
  return { mobile, runtime, bridge, one: { id: "transport-1" }, two: { id: "transport-2" } };
}

function payloadsFor(mobile, ws) {
  return mobile.sent.filter((entry) => entry.ws === ws).map((entry) => entry.payload);
}

describe("ManagedSessionMobileBridge", () => {
  it("defaults content sync off and sends an explicit error", () => {
    const { mobile, one } = setup();
    mobile.receive(one, { type: "managed_sessions_request", requestId: "r1" });
    assert.equal(payloadsFor(mobile, one)[0].type, "managed_session_error");
    assert.equal(payloadsFor(mobile, one)[0].code, "content_sync_disabled");
  });

  it("enables sync and sends state, capabilities, and sessions", () => {
    const { mobile, one } = setup();
    mobile.receive(one, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-a" });
    assert.deepEqual(payloadsFor(mobile, one).map((item) => item.type), [
      "managed_content_sync_state",
      "managed_capabilities",
      "managed_sessions_snapshot",
    ]);
  });

  it("creates sessions and broadcasts runtime deltas only while enabled", () => {
    const { mobile, runtime, one } = setup();
    runtime.emit("delta", { sessionId: "s1", sequence: 1, kind: "terminal_delta", text: "hidden" });
    assert.equal(mobile.broadcasts.length, 0);
    mobile.receive(one, { type: "managed_content_sync_set", enabled: true });
    mobile.receive(one, { type: "managed_session_create", requestId: "new", agentId: "codex", cwd: "/repo" });
    assert.equal(payloadsFor(mobile, one).at(-1).type, "managed_session_created");
    runtime.emit("delta", { sessionId: "s1", sequence: 2, kind: "terminal_delta", text: "shown" });
    assert.equal(mobile.broadcasts.at(-1).type, "managed_session_delta");
  });

  it("chunks history below the configured frame limit", () => {
    const { mobile, one } = setup({ maxFrameBytes: 48 * 1024 });
    mobile.receive(one, { type: "managed_content_sync_set", enabled: true });
    mobile.sent.length = 0;
    mobile.receive(one, { type: "managed_session_history_request", sessionId: "s1", afterSequence: 0 });
    const chunks = payloadsFor(mobile, one);
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) < 48 * 1024));
    assert.deepEqual(chunks.flatMap((chunk) => chunk.records.map((record) => record.sequence)), [1, 2]);
  });

  it("enforces one input lease across devices", () => {
    const { mobile, runtime, one, two } = setup();
    mobile.receive(one, { type: "managed_content_sync_set", enabled: true });
    mobile.receive(one, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-a" });
    mobile.receive(two, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-b" });
    assert.equal(payloadsFor(mobile, two).at(-1).granted, false);

    mobile.receive(two, { type: "managed_session_input", sessionId: "s1", deviceId: "phone-b", data: "bad" });
    assert.equal(payloadsFor(mobile, two).at(-1).code, "input_lease_required");
    mobile.receive(one, { type: "managed_session_input", sessionId: "s1", deviceId: "phone-a", data: "hello" });
    assert.equal(runtime.writes[0].data, "hello");
  });

  it("releases leases when the owning transport disconnects", () => {
    const { mobile, one, two } = setup();
    mobile.receive(one, { type: "managed_content_sync_set", enabled: true });
    mobile.receive(one, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-a" });
    mobile.emit("client-disconnected", { clientId: "transport-1" });
    mobile.receive(two, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-b" });
    assert.equal(payloadsFor(mobile, two).at(-1).granted, true);
  });

  it("forwards resize, interrupt, and acknowledgements for the lease owner", () => {
    const { mobile, runtime, one } = setup();
    mobile.receive(one, { type: "managed_content_sync_set", enabled: true, deviceId: "phone-a" });
    mobile.receive(one, { type: "managed_session_input_lease_acquire", sessionId: "s1", deviceId: "phone-a" });
    mobile.receive(one, { type: "managed_session_resize", sessionId: "s1", deviceId: "phone-a", cols: 120, rows: 40 });
    mobile.receive(one, { type: "managed_session_interrupt", sessionId: "s1", deviceId: "phone-a" });
    mobile.receive(one, { type: "managed_session_ack", sessionId: "s1", deviceId: "phone-a", sequence: 9 });
    assert.deepEqual(runtime.resizes, [{ sessionId: "s1", cols: 120, rows: 40 }]);
    assert.deepEqual(runtime.interrupts, ["s1"]);
  });
});

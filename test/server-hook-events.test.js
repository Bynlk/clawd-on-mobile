"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  HOOK_EVENT_RING_SIZE_PER_AGENT,
  createSingleRequestHookEventRecorder,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
} = require("../src/server-hook-events");

// ── recordHookEventInBuffer ─────────────────────────────────────────

describe("recordHookEventInBuffer", () => {
  it("records a valid event into the buffer", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, { agent_id: "claude-code", event: "PreToolUse" }, "state", "accepted", { now: () => 1000 });
    assert.ok(event);
    assert.strictEqual(event.agentId, "claude-code");
    assert.strictEqual(event.eventType, "PreToolUse");
    assert.strictEqual(event.route, "state");
    assert.strictEqual(event.outcome, "accepted");
    assert.strictEqual(event.timestamp, 1000);
    assert.strictEqual(buffer.get("claude-code").length, 1);
  });

  it("defaults agentId to claude-code when missing", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, {}, "state", "accepted", { now: () => 1000 });
    assert.strictEqual(event.agentId, "claude-code");
  });

  it("defaults agentId when agent_id is empty string", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, { agent_id: "" }, "state", "accepted", { now: () => 1000 });
    assert.strictEqual(event.agentId, "claude-code");
  });

  it("uses custom agent_id", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, { agent_id: "codex" }, "state", "accepted", { now: () => 1000 });
    assert.strictEqual(event.agentId, "codex");
  });

  it("returns eventType from data.event for state route", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, { event: "Stop" }, "state", "accepted", { now: () => 1000 });
    assert.strictEqual(event.eventType, "Stop");
  });

  it("returns PermissionRequest for permission route", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, { event: "PreToolUse" }, "permission", "accepted", { now: () => 1000 });
    assert.strictEqual(event.eventType, "PermissionRequest");
  });

  it("returns null eventType when data.event is missing on state route", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, {}, "state", "accepted", { now: () => 1000 });
    assert.strictEqual(event.eventType, null);
  });

  it("returns null for invalid route", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, {}, "invalid", "accepted");
    assert.strictEqual(event, null);
  });

  it("returns null for invalid outcome", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, {}, "state", "invalid");
    assert.strictEqual(event, null);
  });

  it("returns null for null buffer", () => {
    const event = recordHookEventInBuffer(null, {}, "state", "accepted");
    assert.strictEqual(event, null);
  });

  it("uses Date.now when no now function provided", () => {
    const buffer = new Map();
    const before = Date.now();
    const event = recordHookEventInBuffer(buffer, {}, "state", "accepted");
    const after = Date.now();
    assert.ok(event.timestamp >= before && event.timestamp <= after);
  });

  it("respects custom ringSize", () => {
    const buffer = new Map();
    for (let i = 0; i < 5; i++) {
      recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => i, ringSize: 3 });
    }
    const events = buffer.get("a");
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].timestamp, 2);
    assert.strictEqual(events[2].timestamp, 4);
  });

  it("uses default ring size of 50", () => {
    assert.strictEqual(HOOK_EVENT_RING_SIZE_PER_AGENT, 50);
    const buffer = new Map();
    for (let i = 0; i < 55; i++) {
      recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => i });
    }
    assert.strictEqual(buffer.get("a").length, 50);
  });

  it("separates events by agentId", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "claude-code" }, "state", "accepted", { now: () => 1 });
    recordHookEventInBuffer(buffer, { agent_id: "codex" }, "state", "accepted", { now: () => 2 });
    assert.strictEqual(buffer.get("claude-code").length, 1);
    assert.strictEqual(buffer.get("codex").length, 1);
  });

  it("returns the same reference as the buffer entry", () => {
    const buffer = new Map();
    const event = recordHookEventInBuffer(buffer, {}, "state", "accepted", { now: () => 1000 });
    assert.strictEqual(event, buffer.get("claude-code")[0]);
  });
});

// ── getRecentHookEventsFromBuffer ───────────────────────────────────

describe("getRecentHookEventsFromBuffer", () => {
  it("returns empty array for null buffer", () => {
    assert.deepStrictEqual(getRecentHookEventsFromBuffer(null), []);
  });

  it("returns all events when no options", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 1 });
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 2 });
    const events = getRecentHookEventsFromBuffer(buffer);
    assert.strictEqual(events.length, 2);
  });

  it("filters by since timestamp", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 100 });
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 200 });
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 300 });
    const events = getRecentHookEventsFromBuffer(buffer, { since: 200 });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].timestamp, 200);
  });

  it("filters by agentId", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "claude-code" }, "state", "accepted", { now: () => 1 });
    recordHookEventInBuffer(buffer, { agent_id: "codex" }, "state", "accepted", { now: () => 2 });
    const events = getRecentHookEventsFromBuffer(buffer, { agentId: "codex" });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].agentId, "codex");
  });

  it("sorts events by timestamp ascending", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 3 });
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 1 });
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 2 });
    const events = getRecentHookEventsFromBuffer(buffer);
    assert.strictEqual(events[0].timestamp, 1);
    assert.strictEqual(events[1].timestamp, 2);
    assert.strictEqual(events[2].timestamp, 3);
  });

  it("returns copies, not references", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 1 });
    const events = getRecentHookEventsFromBuffer(buffer);
    events[0].agentId = "mutated";
    assert.strictEqual(buffer.get("a")[0].agentId, "a");
  });

  it("merges events from all agents when no agentId filter", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, { agent_id: "a" }, "state", "accepted", { now: () => 1 });
    recordHookEventInBuffer(buffer, { agent_id: "b" }, "state", "accepted", { now: () => 2 });
    recordHookEventInBuffer(buffer, { agent_id: "c" }, "state", "accepted", { now: () => 3 });
    const events = getRecentHookEventsFromBuffer(buffer);
    assert.strictEqual(events.length, 3);
  });
});

// ── createSingleRequestHookEventRecorder ────────────────────────────

describe("createSingleRequestHookEventRecorder", () => {
  it("records accepted via .accepted()", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((data, route, outcome) => {
      calls.push({ data, route, outcome });
      return { recorded: true };
    }, { event: "PreToolUse" }, "state");
    const result = recorder.accepted();
    assert.deepStrictEqual(calls, [{ data: { event: "PreToolUse" }, route: "state", outcome: "accepted" }]);
    assert.deepStrictEqual(result, { recorded: true });
  });

  it("records droppedByDisabled", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push({ r, o }); }, {}, "state");
    recorder.droppedByDisabled();
    assert.deepStrictEqual(calls, [{ r: "state", o: "dropped-by-disabled" }]);
  });

  it("records droppedByDnd", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push({ r, o }); }, {}, "state");
    recorder.droppedByDnd();
    assert.deepStrictEqual(calls, [{ r: "state", o: "dropped-by-dnd" }]);
  });

  it("acceptedUnlessDnd records accepted when not DnD", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(o); }, {}, "state");
    recorder.acceptedUnlessDnd(false);
    assert.deepStrictEqual(calls, ["accepted"]);
  });

  it("acceptedUnlessDnd records dropped-by-dnd when DnD", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(o); }, {}, "state");
    recorder.acceptedUnlessDnd(true);
    assert.deepStrictEqual(calls, ["dropped-by-dnd"]);
  });

  it("only records once (single-flight)", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(o); }, {}, "state");
    recorder.accepted();
    recorder.accepted();
    recorder.droppedByDnd();
    assert.strictEqual(calls.length, 1);
  });

  it("returns null on second call", () => {
    const recorder = createSingleRequestHookEventRecorder(() => ({ ok: true }), {}, "state");
    recorder.accepted();
    const second = recorder.accepted();
    assert.strictEqual(second, null);
  });

  it("does not consume slot for invalid route", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(o); }, {}, "state");
    const result = recorder.record("invalid", "accepted");
    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 0);
    // Should still be able to record valid call
    recorder.accepted();
    assert.strictEqual(calls.length, 1);
  });

  it("does not consume slot for invalid outcome", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(o); }, {}, "state");
    recorder.record("state", "invalid");
    assert.strictEqual(calls.length, 0);
    recorder.accepted();
    assert.strictEqual(calls.length, 1);
  });

  it("uses defaultRoute when no route specified", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(r); }, {}, "permission");
    recorder.accepted();
    assert.deepStrictEqual(calls, ["permission"]);
  });

  it("overrides defaultRoute with explicit route", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder((d, r, o) => { calls.push(r); }, {}, "state");
    recorder.accepted("permission");
    assert.deepStrictEqual(calls, ["permission"]);
  });

  it("returns null when recordFn is not a function", () => {
    const recorder = createSingleRequestHookEventRecorder(null, {}, "state");
    const result = recorder.accepted();
    assert.strictEqual(result, null);
  });
});

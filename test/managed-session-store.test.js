"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ManagedSessionStore } = require("../src/managed-session-store");

function createStore(options = {}) {
  return new ManagedSessionStore({
    maxRecords: options.maxRecords || 3,
    maxBytes: options.maxBytes || 4096,
    now: options.now || (() => 42),
  });
}

describe("ManagedSessionStore", () => {
  it("assigns monotonic sequences and returns ordered history", () => {
    const store = createStore();
    store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });

    assert.equal(store.append("s1", { kind: "assistant_text", text: "one" }).sequence, 1);
    assert.equal(store.append("s1", { kind: "tool_result", text: "two" }).sequence, 2);

    const history = store.historyAfter("s1", 0);
    assert.deepEqual(history.records.map((record) => record.sequence), [1, 2]);
    assert.equal(history.resetRequired, false);
    assert.equal(history.hasMore, false);
    assert.equal(history.latestSequence, 2);
  });

  it("evicts oldest records and reports a reset for stale cursors", () => {
    const store = createStore({ maxRecords: 2 });
    store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });
    store.append("s1", { kind: "terminal_delta", text: "one" });
    store.append("s1", { kind: "terminal_delta", text: "two" });
    store.append("s1", { kind: "terminal_delta", text: "three" });

    const history = store.historyAfter("s1", 1);
    assert.equal(history.resetRequired, true);
    assert.deepEqual(history.records.map((record) => record.sequence), [2, 3]);
    assert.equal(history.oldestSequence, 2);
  });

  it("bounds history by encoded bytes while retaining the newest record", () => {
    const store = createStore({ maxRecords: 20, maxBytes: 220 });
    store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });
    store.append("s1", { kind: "terminal_delta", text: "a".repeat(100) });
    store.append("s1", { kind: "terminal_delta", text: "b".repeat(100) });

    const history = store.historyAfter("s1", 0);
    assert.equal(history.records.length, 1);
    assert.equal(history.resetRequired, true);
    assert.equal(history.oldestSequence, 2);
    assert.match(history.records[0].text, /^b+$/);
  });

  it("paginates without losing cursor metadata", () => {
    const store = createStore({ maxRecords: 10 });
    store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });
    for (const text of ["one", "two", "three"]) {
      store.append("s1", { kind: "assistant_text", text });
    }

    const first = store.historyAfter("s1", 0, 2);
    assert.deepEqual(first.records.map((record) => record.sequence), [1, 2]);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextSequence, 2);
    const second = store.historyAfter("s1", first.nextSequence, 2);
    assert.deepEqual(second.records.map((record) => record.sequence), [3]);
  });

  it("updates metadata, lists sessions, and clears process-lifetime state", () => {
    const store = createStore();
    store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });
    store.updateSession("s1", { status: "exited", exitCode: 0 });

    const sessions = store.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "exited");
    assert.equal(sessions[0].createdAt, 42);
    assert.equal(sessions[0].latestSequence, 0);

    store.clear();
    assert.deepEqual(store.listSessions(), []);
  });

  it("rejects duplicate and unknown sessions", () => {
    const store = createStore();
    store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" });
    assert.throws(
      () => store.createSession({ id: "s1", agentId: "codex", cwd: "/repo" }),
      /session_exists/,
    );
    assert.throws(
      () => store.append("missing", { kind: "terminal_delta", text: "x" }),
      /session_not_found/,
    );
  });
});

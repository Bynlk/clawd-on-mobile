"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeEvents } = require("../../src/extensions/runtime-events");

describe("RuntimeEvents", () => {
  it("delivers an immutable snapshot to subscribers", () => {
    const events = new RuntimeEvents();
    let received = null;
    events.on("session-updated", (payload) => {
      received = payload;
    });

    const original = { sessionId: "s-1", nested: { state: "working" } };
    events.emit("session-updated", original);
    original.nested.state = "idle";

    assert.deepEqual(received, {
      sessionId: "s-1",
      nested: { state: "working" },
    });
    assert.ok(Object.isFrozen(received));
    assert.ok(Object.isFrozen(received.nested));
  });

  it("removes every subscriber when disposed", () => {
    const events = new RuntimeEvents();
    let calls = 0;
    events.on("permission-added", () => { calls += 1; });

    events.dispose();
    events.emit("permission-added", { id: "p-1" });

    assert.equal(calls, 0);
  });
});

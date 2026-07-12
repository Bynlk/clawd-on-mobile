"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeEvents } = require("../../../src/extensions/runtime-events");
const { activateMobileExtension } = require("../../../src/extensions/mobile");

describe("activateMobileExtension", () => {
  it("forwards runtime events to the mobile integration without cloning permission entries", () => {
    const runtimeEvents = new RuntimeEvents();
    const received = [];
    const mobileIntegration = {
      setupPermissionHooks(ctx) {
        ctx.onPermissionAdded = (entry, id) => received.push(["added", entry, id]);
        ctx.onPermissionRemoved = (entry) => received.push(["removed", entry]);
      },
      setupStateChangeHooks(ctx) {
        ctx.onMobileStateChange = (sessionId, type, data) => received.push(["state", sessionId, type, data]);
        ctx.onMobileToolOutput = (sessionId, data) => received.push(["output", sessionId, data]);
        ctx.onMobileSessionSnapshot = (snapshot) => received.push(["snapshot", snapshot]);
        ctx.onMobileSessionRemoved = (sessionId) => received.push(["removed-session", sessionId]);
      },
    };
    const dispose = activateMobileExtension({ runtimeEvents, mobileIntegration });
    const entry = { toolName: "Bash" };

    runtimeEvents.emitReference("permission-added", { entry, id: "p-1" });
    runtimeEvents.emit("session-updated", { sessionId: "s-1", data: { state: "working" } });
    dispose();
    runtimeEvents.emitReference("permission-removed", { entry });

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], ["added", entry, "p-1"]);
    assert.strictEqual(received[0][1], entry);
    assert.equal(entry._mobileApprovalId, "p-1");
    assert.deepEqual(received[1], ["state", "s-1", "state", { state: "working" }]);
  });
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createWgRelayRuntime } = require("../src/wg-relay-runtime");

test("getProfileStatus defaults to idle", () => {
  const rt = createWgRelayRuntime();
  assert.deepEqual(rt.getProfileStatus("wg-1"), { profileId: "wg-1", status: "idle" });
});

test("setStatus merges, stamps profileId + updatedAt, and emits", () => {
  const rt = createWgRelayRuntime();
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.setStatus("wg-1", { status: "deploying" });
  rt.setStatus("wg-1", { message: "hi" });
  const cur = rt.getProfileStatus("wg-1");
  assert.equal(cur.status, "deploying"); // merged, not clobbered
  assert.equal(cur.message, "hi");
  assert.equal(cur.profileId, "wg-1");
  assert.ok(Number.isFinite(cur.updatedAt));
  assert.equal(events.length, 2);
});

test("listStatuses returns all tracked profiles", () => {
  const rt = createWgRelayRuntime();
  rt.setStatus("a", { status: "connected" });
  rt.setStatus("b", { status: "failed" });
  assert.equal(rt.listStatuses().length, 2);
});

test("emitProgress emits the progress event verbatim", () => {
  const rt = createWgRelayRuntime();
  let got = null;
  rt.on("progress", (p) => { got = p; });
  rt.emitProgress({ profileId: "wg-1", step: "readback", status: "ok" });
  assert.equal(got.step, "readback");
});

test("pcConf cache is memory-only and clearable (SEC-3)", () => {
  const rt = createWgRelayRuntime();
  rt.rememberPcConf("wg-1", "[Interface]\n...");
  assert.equal(rt.getPcConf("wg-1"), "[Interface]\n...");
  rt.forgetPcConf("wg-1");
  assert.equal(rt.getPcConf("wg-1"), null);
});

test("rememberPcConf ignores empty values", () => {
  const rt = createWgRelayRuntime();
  rt.rememberPcConf("wg-1", "");
  assert.equal(rt.getPcConf("wg-1"), null);
});

test("cleanup drops all secrets, statuses, and listeners", () => {
  const rt = createWgRelayRuntime();
  let fired = 0;
  rt.on("status-changed", () => fired++);
  rt.setStatus("wg-1", { status: "connected" });
  rt.rememberPcConf("wg-1", "conf");
  rt.cleanup();
  assert.equal(rt.getPcConf("wg-1"), null);
  assert.equal(rt.listStatuses().length, 0);
  rt.setStatus("wg-1", { status: "connected" }); // listener removed → no fire
  assert.equal(fired, 1);
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createWgRelayRuntime } = require("../src/wg-relay-runtime");

test("getProfileStatus defaults to idle", () => {
  const rt = createWgRelayRuntime();
  assert.deepEqual(rt.getProfileStatus("wg-1"), { profileId: "wg-1", status: "idle", generation: 0 });
});

test("setStatus merges, stamps profileId + updatedAt, and emits", () => {
  const rt = createWgRelayRuntime();
  const events = [];
  rt.on("status-changed", (s) => events.push(s));
  rt.setStatus("wg-1", { status: "starting_tunnel", generation: 1 });
  rt.setStatus("wg-1", { message: "hi" });
  const cur = rt.getProfileStatus("wg-1");
  assert.equal(cur.status, "starting_tunnel"); // merged, not clobbered
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

test("removeStatus clears one profile status and pcConfig without disturbing peers", () => {
  const rt = createWgRelayRuntime();
  rt.setStatus("wg-1", { status: "connected", generation: 1 });
  rt.setStatus("wg-2", { status: "connected", generation: 1 });
  rt.rememberPcConf("wg-1", "secret-one");
  rt.rememberPcConf("wg-2", "secret-two");

  assert.equal(rt.removeStatus("wg-1"), true);

  assert.deepEqual(rt.getProfileStatus("wg-1"), { profileId: "wg-1", status: "idle", generation: 0 });
  assert.equal(rt.getPcConf("wg-1"), null);
  assert.equal(rt.getProfileStatus("wg-2").status, "connected");
  assert.equal(rt.getPcConf("wg-2"), "secret-two");
  assert.equal(rt.removeStatus("wg-1"), false);
});

test("one-click connection states expose only generation and the fixed state set", () => {
  const rt = createWgRelayRuntime();
  const states = [
    "idle", "starting_tunnel", "verifying_relay", "connecting_relay",
    "connected", "disconnecting", "failed",
  ];
  let generation = 0;
  for (const status of states) {
    const current = rt.setStatus("wg-1", { status, generation, attempt: 999 });
    assert.equal(current.status, status);
    assert.equal(current.generation, generation);
    assert.equal(Object.hasOwn(current, "attempt"), false);
    generation++;
  }
});

test("unknown states and invalid or stale generations cannot overwrite public state", () => {
  const rt = createWgRelayRuntime();
  const events = [];
  rt.on("status-changed", (state) => events.push(state));
  rt.setStatus("wg-1", { status: "connected", generation: 4 });
  for (const patch of [
    { status: "deploying", generation: 5 },
    { status: "failed", generation: 3, errorCode: "connection_failed" },
    { status: "failed", generation: -1 },
    { status: "failed", generation: 1.5 },
    { status: "failed", generation: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.strictEqual(rt.setStatus("wg-1", patch), rt.getProfileStatus("wg-1"));
  }
  assert.equal(rt.getProfileStatus("wg-1").status, "connected");
  assert.equal(rt.getProfileStatus("wg-1").generation, 4);
  assert.equal(events.length, 1);
});

test("public runtime state keeps only stable error codes and excludes secrets", () => {
  const rt = createWgRelayRuntime();
  const state = rt.setStatus("wg-1", {
    status: "failed",
    generation: 1,
    errorCode: "secret_token_must_not_escape",
    token: "TOKEN-SECRET",
    privateKey: "PRIVATE-SECRET",
  });
  assert.equal(state.errorCode, "connection_failed");
  assert.equal(Object.hasOwn(state, "token"), false);
  assert.equal(Object.hasOwn(state, "privateKey"), false);
  assert.doesNotMatch(JSON.stringify(state), /SECRET/);
});

test("runtime accepts the complete known Task 4 and Task 5 error-code allowlist", () => {
  const rt = createWgRelayRuntime();
  const codes = [
    "sidecar_failed", "sidecar_protocol_error", "sidecar_output_limit", "sidecar_disposed",
    "sidecar_invalid_config", "sidecar_spawn_failed", "sidecar_startup_timeout",
    "sidecar_unexpected_exit", "sidecar_start_cancelled", "duplicate_ready",
    "invalid_config", "invalid_json", "trailing_data", "stdin_failed", "invalid_private_key",
    "invalid_server_public_key", "invalid_allowed_ip", "invalid_address", "invalid_endpoint",
    "invalid_forward_address", "invalid_keepalive", "device_create_failed", "device_config_failed",
    "device_start_failed", "endpoint_resolution_failed", "endpoint_resolution_canceled",
    "endpoint_resolution_timeout", "listen_failed", "listener_failed", "device_stopped",
    "listener_stopped", "secret_invalid", "health_non_loopback", "health_timeout",
    "health_redirect_rejected", "health_http_status", "health_response_too_large",
    "health_invalid_response", "health_request_failed", "connection_cancelled",
    "connection_disposed", "connection_failed", "relay_auth_failed", "relay_connect_failed",
    "relay_connect_timeout", "relay_not_running", "local_connect_failed",
  ];
  let generation = 1;
  for (const errorCode of codes) {
    const state = rt.setStatus("wg-1", { status: "failed", generation, errorCode });
    assert.equal(state.errorCode, errorCode);
    generation++;
  }
});

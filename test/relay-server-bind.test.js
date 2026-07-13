"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "..", "relay", "relay-server.js");
const SOURCE = fs.readFileSync(SERVER_PATH, "utf8");

test("relay-server CLI defaults BIND_ADDR to the WireGuard server address", () => {
  assert.match(SOURCE, /process\.env\.BIND_ADDR\s*\|\|\s*["']10\.8\.0\.1["']/);
});

test("relay-server exports a factory and keeps CLI startup behind require.main", () => {
  assert.match(SOURCE, /function createRelayServer|const createRelayServer/);
  assert.match(SOURCE, /if \(require\.main === module\)/);
  assert.match(SOURCE, /module\.exports\s*=\s*\{[^}]*createRelayServer/s);
});

test("relay-server CLI wires the persistent token store and WireGuard management", () => {
  assert.match(SOURCE, /createRelayTokenStore/);
  assert.match(SOURCE, /createWgManagement/);
  assert.match(SOURCE, /RELAY_ENV_PATH/);
  assert.doesNotMatch(SOURCE, /const tokenStore = \{ current: \(\) => process\.env\.RELAY_TOKEN/);
});

test("factory listens on the injected address and exposes the bound address", async (t) => {
  assert.match(SOURCE, /createRelayServer/);
  const { createRelayServer } = require(SERVER_PATH);
  const relay = createRelayServer({
    bindAddr: "127.0.0.1",
    port: 0,
    tokenStore: { current: () => "55".repeat(32) },
    management: null,
    log() {},
  });
  await relay.listen();
  t.after(() => relay.close());

  assert.equal(relay.address().address, "127.0.0.1");
  assert.ok(relay.address().port > 0);
});

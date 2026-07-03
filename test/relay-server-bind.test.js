"use strict";

// Static-source assertions for the relay-server BIND_ADDR change (TDD §3.7).
// We do NOT start the server (network-listening is disallowed in CI/sandbox);
// instead we assert the source wires BIND_ADDR with a back-compatible default
// and passes it to server.listen — the whole scope of the P1 change.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "relay", "relay-server.js"),
  "utf8"
);

test("relay-server declares BIND_ADDR with 0.0.0.0 default (back-compat)", () => {
  assert.match(SRC, /const BIND_ADDR = process\.env\.BIND_ADDR \|\| "0\.0\.0\.0"/);
});

test("relay-server passes BIND_ADDR as the listen host argument", () => {
  assert.match(SRC, /server\.listen\(PORT,\s*BIND_ADDR,/);
});

test("relay-server does not hard-bind to a non-default host (SEC-4: default preserved)", () => {
  // Ensure we didn't accidentally leave the old no-host listen form.
  assert.ok(!/server\.listen\(PORT,\s*\(\)\s*=>/.test(SRC));
});

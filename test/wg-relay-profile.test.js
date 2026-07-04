"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getDefaults,
  normalizeWgRelay,
  validateProfile,
  sanitizeProfile,
  isValidWgPort,
  isValidSubnet,
  isValidAuthMethod,
  WG_DEFAULT_SUBNET,
  WG_DEFAULT_PORT,
} = require("../src/wg-relay-profile");

function keyProfile(over = {}) {
  return {
    id: "wg-1",
    label: "My VPS",
    host: "root@1.2.3.4",
    port: 22,
    authMethod: "key",
    identityFile: "/home/u/.ssh/id_ed25519",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
    ...over,
  };
}

// ── isValidWgPort ──
test("isValidWgPort range", () => {
  assert.equal(isValidWgPort(51820), true);
  assert.equal(isValidWgPort(1), true);
  assert.equal(isValidWgPort(65535), true);
  assert.equal(isValidWgPort(0), false);
  assert.equal(isValidWgPort(65536), false);
  assert.equal(isValidWgPort("51820"), false);
  assert.equal(isValidWgPort(51820.5), false);
});

// ── isValidSubnet ──
test("isValidSubnet accepts private /24", () => {
  for (const s of ["10.8.0.0/24", "10.0.0.0/24", "172.16.5.0/24", "172.31.9.0/24", "192.168.1.0/24"]) {
    assert.equal(isValidSubnet(s), true, s);
  }
});

test("isValidSubnet rejects public / wrong mask / malformed", () => {
  for (const s of [
    "8.8.8.0/24",       // public
    "172.15.0.0/24",    // outside 16-31
    "172.32.0.0/24",    // outside 16-31
    "192.169.1.0/24",   // not 192.168
    "10.8.0.0/16",      // wrong mask
    "10.8.0.1/24",      // not .0
    "10.8.0.0",         // no mask
    "10.999.0.0/24",    // octet out of range
    "not-a-subnet",
    "",
    null,
  ]) {
    assert.equal(isValidSubnet(s), false, JSON.stringify(s));
  }
});

// ── isValidAuthMethod ──
test("isValidAuthMethod", () => {
  assert.equal(isValidAuthMethod("key"), true);
  assert.equal(isValidAuthMethod("password"), true);
  assert.equal(isValidAuthMethod("otp"), false);
  assert.equal(isValidAuthMethod(""), false);
});

// ── validateProfile ──
test("validateProfile accepts a well-formed key profile", () => {
  assert.equal(validateProfile(keyProfile()).status, "ok");
});

test("validateProfile accepts password profile without identityFile", () => {
  const p = keyProfile({ authMethod: "password", identityFile: undefined });
  assert.equal(validateProfile(p).status, "ok");
});

test("validateProfile requires identityFile for key auth", () => {
  const p = keyProfile({ identityFile: undefined });
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects bad id / label / host", () => {
  assert.equal(validateProfile(keyProfile({ id: "bad id!" })).status, "error");
  assert.equal(validateProfile(keyProfile({ label: "" })).status, "error");
  assert.equal(validateProfile(keyProfile({ host: "-oProxyCommand=evil" })).status, "error");
  assert.equal(validateProfile(keyProfile({ host: "a@b@c" })).status, "error");
});

test("validateProfile rejects ssh-option-injection host (SEC-5)", () => {
  assert.equal(validateProfile(keyProfile({ host: "-oProxyCommand=touch /tmp/pwn" })).status, "error");
});

test("validateProfile rejects bad wgPort / subnet", () => {
  assert.equal(validateProfile(keyProfile({ wgPort: 0 })).status, "error");
  assert.equal(validateProfile(keyProfile({ wgSubnet: "8.8.8.0/24" })).status, "error");
});

test("validateProfile rejects control chars in readback fields", () => {
  assert.equal(validateProfile(keyProfile({ endpoint: "1.2.3.4:51820\n" })).status, "error");
});

// ── sanitizeProfile ──
test("sanitizeProfile strips password & phonePrivKey (SEC-1/3)", () => {
  const p = sanitizeProfile(keyProfile({ password: "s3cret", phonePrivKey: "PRIV=" }));
  assert.ok(p);
  assert.equal(p.password, undefined);
  assert.equal(p.phonePrivKey, undefined);
});

test("sanitizeProfile fills defaults for wgPort/wgSubnet", () => {
  const p = sanitizeProfile({
    id: "wg-x", label: "x", host: "h", authMethod: "password",
  });
  assert.ok(p);
  assert.equal(p.wgPort, WG_DEFAULT_PORT);
  assert.equal(p.wgSubnet, WG_DEFAULT_SUBNET);
});

test("sanitizeProfile returns null for invalid", () => {
  assert.equal(sanitizeProfile({ id: "bad!", label: "x", host: "h", authMethod: "key" }), null);
  assert.equal(sanitizeProfile(null), null);
});

test("sanitizeProfile keeps public readback fields", () => {
  const p = sanitizeProfile(keyProfile({
    serverPubKey: "abc=", endpoint: "1.2.3.4:51820", pcAddress: "10.8.0.2", relayAddr: "ws://10.8.0.1:7891",
  }));
  assert.equal(p.serverPubKey, "abc=");
  assert.equal(p.relayAddr, "ws://10.8.0.1:7891");
});

// ── normalizeWgRelay ──
test("normalizeWgRelay drops invalid, dedups id and subnet (EX-14)", () => {
  const out = normalizeWgRelay({
    profiles: [
      keyProfile({ id: "a", wgSubnet: "10.8.0.0/24" }),
      keyProfile({ id: "a", wgSubnet: "10.9.0.0/24" }), // dup id -> dropped
      keyProfile({ id: "b", wgSubnet: "10.8.0.0/24" }), // dup subnet -> dropped
      keyProfile({ id: "c", wgSubnet: "10.10.0.0/24" }),
      { id: "bad!", label: "x", host: "h", authMethod: "key" }, // invalid -> dropped
    ],
  });
  assert.deepEqual(out.profiles.map((p) => p.id), ["a", "c"]);
});

test("normalizeWgRelay returns defaults for garbage", () => {
  assert.deepEqual(normalizeWgRelay(null, getDefaults()), { profiles: [] });
  assert.deepEqual(normalizeWgRelay("x", getDefaults()), { profiles: [] });
});

test("getDefaults shape", () => {
  assert.deepEqual(getDefaults(), { profiles: [] });
});

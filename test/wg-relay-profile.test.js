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
    host: "1.2.3.4",
    sshUsername: "root",
    sshPort: 22,
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

test("validateProfile only accepts SHA256 base64 SSH host fingerprints", () => {
  assert.equal(validateProfile(keyProfile({
    sshHostFingerprint: "SHA256:AbCdEf0123456789+/AbCdEf0123456789+/AbCdEf0",
  })).status, "ok");

  for (const sshHostFingerprint of [
    "MD5:aa:bb:cc",
    "SHA256:",
    "SHA256:abc",
    "SHA256:not base64",
    "SHA256:abc$def",
    "SHA256:abc=def",
  ]) {
    assert.equal(
      validateProfile(keyProfile({ sshHostFingerprint })).status,
      "error",
      sshHostFingerprint,
    );
  }
});

// ── sanitizeProfile ──
test("sanitizeProfile strips unknown and private fields (SEC-1/3)", () => {
  const p = sanitizeProfile(keyProfile({
    password: "s3cret",
    pcConfig: "PC-PRIVATE",
    phoneConfig: "PHONE-PRIVATE",
    relayToken: "RELAY-SECRET",
    managementToken: "MANAGEMENT-SECRET",
    phonePrivKey: "PRIV=",
    unknown: "drop-me",
  }));
  assert.ok(p);
  for (const field of [
    "password",
    "pcConfig",
    "phoneConfig",
    "relayToken",
    "managementToken",
    "phonePrivKey",
    "unknown",
  ]) {
    assert.equal(p[field], undefined, field);
  }
});

test("sanitizeProfile defaults new profiles to password auth", () => {
  const p = sanitizeProfile({
    id: "wg-x", label: "x", host: "h",
  });
  assert.ok(p);
  assert.equal(p.authMethod, "password");
  assert.equal(p.sshPort, 22);
  assert.equal(p.wgPort, WG_DEFAULT_PORT);
  assert.equal(p.wgSubnet, WG_DEFAULT_SUBNET);
});

test("sanitizeProfile returns null for invalid", () => {
  assert.equal(sanitizeProfile({ id: "bad!", label: "x", host: "h", authMethod: "key" }), null);
  assert.equal(sanitizeProfile(null), null);
});

test("sanitizeProfile migrates legacy user@host and port fields", () => {
  const migrated = sanitizeProfile({
    id: "wg-1",
    label: "VPS",
    host: "root@203.0.113.10",
    port: 22,
    authMethod: "password",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
  });
  assert.ok(migrated);
  assert.equal(migrated.host, "203.0.113.10");
  assert.equal(migrated.sshUsername, "root");
  assert.equal(migrated.sshPort, 22);
  assert.equal(migrated.port, undefined);
});

test("sanitizeProfile round-trips explicit canonical public fields", () => {
  const p = sanitizeProfile(keyProfile({
    authMethod: "password",
    identityFile: undefined,
    sshUsername: "deploy",
    sshPort: 2222,
    sshHostFingerprint: "SHA256:AbCdEf0123456789+/AbCdEf0123456789+/AbCdEf0",
    endpoint: "1.2.3.4:51820",
    relayAddr: "ws://10.8.0.1:7891",
    lastDeployedAt: 1700000000000,
    deployVersion: 1,
  }));
  assert.deepEqual(p, {
    id: "wg-1",
    label: "My VPS",
    host: "1.2.3.4",
    sshUsername: "deploy",
    sshPort: 2222,
    authMethod: "password",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
    sshHostFingerprint: "SHA256:AbCdEf0123456789+/AbCdEf0123456789+/AbCdEf0",
    endpoint: "1.2.3.4:51820",
    relayAddr: "ws://10.8.0.1:7891",
    lastDeployedAt: 1700000000000,
    deployVersion: 1,
  });
});

test("sanitizeProfile preserves valid legacy key-auth profiles", () => {
  const p = sanitizeProfile({
    id: "wg-key",
    label: "Legacy key VPS",
    host: "ubuntu@example.com",
    port: 2200,
    authMethod: "key",
    identityFile: "/home/u/.ssh/id_ed25519",
    wgPort: 51820,
    wgSubnet: "10.9.0.0/24",
  });
  assert.ok(p);
  assert.equal(p.authMethod, "key");
  assert.equal(p.identityFile, "/home/u/.ssh/id_ed25519");
  assert.equal(p.host, "example.com");
  assert.equal(p.sshUsername, "ubuntu");
  assert.equal(p.sshPort, 2200);
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

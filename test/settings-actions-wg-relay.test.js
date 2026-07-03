"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  wgRelayAddProfile,
  wgRelayUpdateProfile,
  wgRelayRemoveProfile,
  wgRelayApplyReadback,
  READBACK_PERSIST_FIELDS,
} = require("../src/settings-actions-wg-relay");

function keyPayload(over = {}) {
  return {
    id: "wg-1",
    label: "VPS",
    host: "root@1.2.3.4",
    port: 22,
    authMethod: "key",
    identityFile: "/home/u/.ssh/id_ed25519",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
    ...over,
  };
}

function depsWith(profiles) {
  return { snapshot: { wgRelay: { profiles } } };
}

// ── add ──
test("add: valid profile commits", () => {
  const r = wgRelayAddProfile(keyPayload(), depsWith([]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles.length, 1);
  assert.equal(r.commit.wgRelay.profiles[0].id, "wg-1");
});

test("add: strips password (SEC-1)", () => {
  const r = wgRelayAddProfile(keyPayload({ password: "s3cret", phonePrivKey: "PRIV=" }), depsWith([]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles[0].password, undefined);
  assert.equal(r.commit.wgRelay.profiles[0].phonePrivKey, undefined);
});

test("add: rejects invalid profile", () => {
  const r = wgRelayAddProfile(keyPayload({ id: "bad id!" }), depsWith([]));
  assert.equal(r.status, "error");
});

test("add: rejects duplicate id", () => {
  const r = wgRelayAddProfile(keyPayload(), depsWith([keyPayload()]));
  assert.equal(r.status, "error");
  assert.match(r.message, /already exists/);
});

test("add: rejects duplicate subnet (EX-14)", () => {
  const existing = keyPayload({ id: "other", wgSubnet: "10.8.0.0/24" });
  const r = wgRelayAddProfile(keyPayload({ id: "wg-2", wgSubnet: "10.8.0.0/24" }), depsWith([existing]));
  assert.equal(r.status, "error");
  assert.match(r.message, /subnet/);
});

// ── update ──
test("update: modifies existing, preserves createdAt", () => {
  const existing = { ...keyPayload(), createdAt: 111 };
  const r = wgRelayUpdateProfile(keyPayload({ label: "renamed" }), depsWith([existing]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles[0].label, "renamed");
  assert.equal(r.commit.wgRelay.profiles[0].createdAt, 111);
});

test("update: preserves readback fields when not supplied", () => {
  const existing = { ...keyPayload(), serverPubKey: "abc=", endpoint: "1.2.3.4:51820", lastDeployedAt: 999 };
  const r = wgRelayUpdateProfile(keyPayload({ label: "x" }), depsWith([existing]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles[0].serverPubKey, "abc=");
  assert.equal(r.commit.wgRelay.profiles[0].lastDeployedAt, 999);
});

test("update: not found → error", () => {
  const r = wgRelayUpdateProfile(keyPayload({ id: "ghost" }), depsWith([]));
  assert.equal(r.status, "error");
  assert.match(r.message, /not found/);
});

test("update: rejects subnet collision with another profile", () => {
  const a = keyPayload({ id: "a", wgSubnet: "10.8.0.0/24" });
  const b = keyPayload({ id: "b", wgSubnet: "10.9.0.0/24" });
  const r = wgRelayUpdateProfile(keyPayload({ id: "b", wgSubnet: "10.8.0.0/24" }), depsWith([a, b]));
  assert.equal(r.status, "error");
});

test("update: same profile can keep its own subnet", () => {
  const a = keyPayload({ id: "a", wgSubnet: "10.8.0.0/24" });
  const r = wgRelayUpdateProfile(keyPayload({ id: "a", wgSubnet: "10.8.0.0/24", label: "new" }), depsWith([a]));
  assert.equal(r.status, "ok");
});

// ── remove ──
test("remove: deletes by id", () => {
  const r = wgRelayRemoveProfile("wg-1", depsWith([keyPayload()]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles.length, 0);
});

test("remove: missing id is noop", () => {
  const r = wgRelayRemoveProfile("ghost", depsWith([keyPayload()]));
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
});

// ── applyReadback ──
test("applyReadback: writes ONLY public fields, never conf/private key (SEC-1/3)", () => {
  const r = wgRelayApplyReadback("wg-1", {
    serverPubKey: "SRV=",
    endpoint: "1.2.3.4:51820",
    pcAddress: "10.8.0.2/32",
    relayAddr: "ws://10.8.0.1:7891",
    pcConf: "[Interface]\nPrivateKey = LEAK\n",
    phoneConf: "[Interface]\nPrivateKey = PHONELEAK\n",
    phonePrivKey: "PHONELEAK",
    deployedAt: 1700000000000,
  }, depsWith([keyPayload()]));
  assert.equal(r.status, "ok");
  const p = r.commit.wgRelay.profiles[0];
  assert.equal(p.serverPubKey, "SRV=");
  assert.equal(p.endpoint, "1.2.3.4:51820");
  assert.equal(p.lastDeployedAt, 1700000000000);
  // Never persisted:
  assert.equal(p.pcConf, undefined);
  assert.equal(p.phoneConf, undefined);
  assert.equal(p.phonePrivKey, undefined);
  // Verify serialized form has no private key leak.
  assert.ok(!JSON.stringify(p).includes("LEAK"));
});

test("applyReadback: whitelist excludes conf blobs", () => {
  assert.deepEqual(READBACK_PERSIST_FIELDS, ["serverPubKey", "endpoint", "pcAddress", "relayAddr"]);
});

test("applyReadback: deleted profile → noop", () => {
  const r = wgRelayApplyReadback("ghost", { serverPubKey: "x" }, depsWith([]));
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
});

test("applyReadback: rejects control chars in readback", () => {
  const r = wgRelayApplyReadback("wg-1", { endpoint: "1.2.3.4:51820\n" }, depsWith([keyPayload()]));
  assert.equal(r.status, "error");
});

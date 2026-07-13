"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  wgRelayAddProfile,
  wgRelayUpdateProfile,
  wgRelayRemoveProfile,
  wgRelayApplyReadback,
  wgRelayCommitDeploy,
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

const CANONICAL_FIELDS = new Set([
  "id", "label", "host", "sshUsername", "sshPort", "authMethod",
  "identityFile", // valid legacy key-auth compatibility only
  "wgPort", "wgSubnet", "sshHostFingerprint", "endpoint", "relayAddr",
  "lastDeployedAt", "deployVersion",
]);

const FORBIDDEN_FIELDS = [
  "createdAt", "serverPubKey", "pcAddress", "password", "pcConfig",
  "phoneConfig", "relayToken", "managementToken", "unknown",
];

function dirtyProfile(over = {}) {
  return keyPayload({
    createdAt: 111,
    serverPubKey: "SERVER-PUBLIC-KEY",
    pcAddress: "10.8.0.2/32",
    password: "password-secret",
    pcConfig: "pc-config-secret",
    phoneConfig: "phone-config-secret",
    relayToken: "relay-token-secret",
    managementToken: "management-token-secret",
    unknown: "unknown-value",
    endpoint: "1.2.3.4:51820",
    relayAddr: "ws://10.8.0.1:7891",
    lastDeployedAt: 999,
    deployVersion: 1,
    ...over,
  });
}

function assertCanonicalProfile(profile) {
  for (const key of Object.keys(profile)) {
    assert.equal(CANONICAL_FIELDS.has(key), true, `noncanonical field survived: ${key}`);
  }
  for (const key of FORBIDDEN_FIELDS) {
    assert.equal(profile[key], undefined, `forbidden field survived: ${key}`);
  }
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

test("add: sanitizes dirty profiles already present in the snapshot", () => {
  const existing = dirtyProfile({ id: "existing", wgSubnet: "10.9.0.0/24" });
  const r = wgRelayAddProfile(keyPayload({ id: "new" }), depsWith([existing]));
  assert.equal(r.status, "ok");
  for (const profile of r.commit.wgRelay.profiles) assertCanonicalProfile(profile);
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
test("update: modifies existing without preserving noncanonical createdAt", () => {
  const existing = { ...keyPayload(), createdAt: 111 };
  const r = wgRelayUpdateProfile(keyPayload({ label: "renamed" }), depsWith([existing]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles[0].label, "renamed");
  assert.equal(r.commit.wgRelay.profiles[0].createdAt, undefined);
});

test("update: preserves only canonical deployment metadata when not supplied", () => {
  const existing = dirtyProfile();
  const r = wgRelayUpdateProfile(keyPayload({ label: "x" }), depsWith([existing]));
  assert.equal(r.status, "ok");
  const profile = r.commit.wgRelay.profiles[0];
  assert.equal(profile.serverPubKey, undefined);
  assert.equal(profile.pcAddress, undefined);
  assert.equal(profile.endpoint, "1.2.3.4:51820");
  assert.equal(profile.relayAddr, "ws://10.8.0.1:7891");
  assert.equal(profile.lastDeployedAt, 999);
  assert.equal(profile.deployVersion, 1);
  assertCanonicalProfile(profile);
});

test("update: explicit empty SSH fingerprint clears the saved fingerprint", () => {
  const existing = keyPayload({
    sshHostFingerprint: "SHA256:AbCdEf0123456789+/AbCdEf0123456789+/AbCdEf0",
  });
  const r = wgRelayUpdateProfile(
    keyPayload({ sshHostFingerprint: "" }),
    depsWith([existing]),
  );
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles[0].sshHostFingerprint, undefined);
});

test("update: sanitizes dirty sibling profiles before committing", () => {
  const target = dirtyProfile({ id: "target", wgSubnet: "10.9.0.0/24" });
  const sibling = dirtyProfile({ id: "sibling", wgSubnet: "10.10.0.0/24" });
  const r = wgRelayUpdateProfile(
    keyPayload({ id: "target", label: "updated", wgSubnet: "10.9.0.0/24" }),
    depsWith([target, sibling]),
  );
  assert.equal(r.status, "ok");
  for (const profile of r.commit.wgRelay.profiles) assertCanonicalProfile(profile);
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

test("remove: sanitizes dirty profiles that remain in the committed snapshot", () => {
  const removed = dirtyProfile({ id: "removed", wgSubnet: "10.9.0.0/24" });
  const remaining = dirtyProfile({ id: "remaining", wgSubnet: "10.10.0.0/24" });
  const r = wgRelayRemoveProfile("removed", depsWith([removed, remaining]));
  assert.equal(r.status, "ok");
  assert.equal(r.commit.wgRelay.profiles.length, 1);
  assertCanonicalProfile(r.commit.wgRelay.profiles[0]);
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
    schemaVersion: 1,
  }, depsWith([keyPayload()]));
  assert.equal(r.status, "ok");
  const p = r.commit.wgRelay.profiles[0];
  assert.equal(p.serverPubKey, undefined);
  assert.equal(p.pcAddress, undefined);
  assert.equal(p.endpoint, "1.2.3.4:51820");
  assert.equal(p.lastDeployedAt, 1700000000000);
  assert.equal(p.deployVersion, 1);
  // Never persisted:
  assert.equal(p.pcConf, undefined);
  assert.equal(p.phoneConf, undefined);
  assert.equal(p.phonePrivKey, undefined);
  assertCanonicalProfile(p);
  // Verify serialized form has no private key leak.
  assert.ok(!JSON.stringify(p).includes("LEAK"));
});

test("applyReadback: whitelist excludes conf blobs", () => {
  assert.deepEqual(READBACK_PERSIST_FIELDS, ["endpoint", "relayAddr"]);
});

test("applyReadback: sanitizes dirty target and sibling profiles", () => {
  const target = dirtyProfile({ id: "target", wgSubnet: "10.9.0.0/24" });
  const sibling = dirtyProfile({ id: "sibling", wgSubnet: "10.10.0.0/24" });
  const r = wgRelayApplyReadback("target", {
    endpoint: "203.0.113.10:51820",
    relayAddr: "ws://10.9.0.1:7891",
    serverPubKey: "DO-NOT-PERSIST",
    pcAddress: "10.9.0.2/32",
    password: "DO-NOT-PERSIST",
    pcConfig: "DO-NOT-PERSIST",
    phoneConfig: "DO-NOT-PERSIST",
    relayToken: "DO-NOT-PERSIST",
    managementToken: "DO-NOT-PERSIST",
    unknown: "DO-NOT-PERSIST",
    deployedAt: 1700000000000,
    deployVersion: 2,
  }, depsWith([target, sibling]));
  assert.equal(r.status, "ok");
  for (const profile of r.commit.wgRelay.profiles) assertCanonicalProfile(profile);
  assert.equal(r.commit.wgRelay.profiles[0].deployVersion, 2);
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

test("commitDeploy atomically preserves cosmetic edits and patches deployment metadata", () => {
  const baseProfile = keyPayload({ label: "Original" });
  const currentProfile = keyPayload({ label: "Edited while deploying" });
  const deployedProfile = keyPayload({
    label: "Original",
    sshHostFingerprint: `SHA256:${Buffer.alloc(32, 9).toString("base64")}`,
    endpoint: "1.2.3.4:51820",
    relayAddr: "ws://10.8.0.1:7891",
    lastDeployedAt: 123,
    deployVersion: 1,
  });

  const result = wgRelayCommitDeploy({
    baseProfile, deployedProfile, allowCreate: false,
  }, depsWith([currentProfile]));

  assert.equal(result.status, "ok");
  assert.equal(result.profile.label, "Edited while deploying");
  assert.equal(result.profile.endpoint, "1.2.3.4:51820");
  assert.deepEqual(result.commit.wgRelay.profiles, [result.profile]);
});

test("commitDeploy atomically rejects topology changes and deleted profiles", () => {
  const baseProfile = keyPayload();
  const deployedProfile = keyPayload({
    endpoint: "1.2.3.4:51820", relayAddr: "ws://10.8.0.1:7891",
    lastDeployedAt: 123, deployVersion: 1,
  });
  const changed = wgRelayCommitDeploy({
    baseProfile, deployedProfile, allowCreate: false,
  }, depsWith([{ ...baseProfile, host: "8.8.8.8" }]));
  const deleted = wgRelayCommitDeploy({
    baseProfile, deployedProfile, allowCreate: false,
  }, depsWith([]));

  assert.deepEqual(changed, { status: "error", errorCode: "profile_conflict_recovery_required" });
  assert.deepEqual(deleted, { status: "error", errorCode: "profile_conflict_recovery_required" });
});

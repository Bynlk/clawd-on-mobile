"use strict";

const { isDeepStrictEqual } = require("node:util");

// ── WireGuard relay profile IPC actions ──
//
// Standalone, pure-additive module (does NOT touch settings-actions.js). Each
// command validates via wg-relay-profile then returns `{ status, commit }` so
// the controller atomically writes the `wgRelay` prefs field — same snapshot →
// validate → commit contract the remoteSsh actions use.
//
// SECURITY:
//   SEC-1  password is NEVER part of a profile → sanitizeProfile strips it, and
//          wgRelayApplyReadback only ever writes public/readback fields.
//   SEC-3  configs and tokens are NEVER persisted → applyReadback whitelists
//          the fields it copies; pcConfig/phoneConfig/relayToken/
//          managementToken are deliberately absent from that whitelist.

const {
  normalizeWgRelay,
  sanitizeProfile,
  validateProfile,
  isValidReadbackStr,
} = require("./wg-relay-profile");

function _snapshot(deps) {
  const snap = (deps && deps.snapshot) || {};
  const cur = snap.wgRelay && typeof snap.wgRelay === "object" ? snap.wgRelay : {};
  // Every command that produces a commit starts from a canonical snapshot.
  // This prevents old or externally-mutated settings from carrying secrets or
  // unknown fields forward when an unrelated profile changes.
  return normalizeWgRelay(cur, { profiles: [] });
}

// Reject a subnet already claimed by a DIFFERENT profile (D-SUBNET / EX-14).
function subnetTaken(profiles, subnet, exceptId) {
  return profiles.some((p) => p.wgSubnet === subnet && p.id !== exceptId);
}

const DEPLOY_TOPOLOGY_FIELDS = [
  "host", "sshUsername", "sshPort", "authMethod", "identityFile", "wgPort", "wgSubnet",
];
const DEPLOY_METADATA_FIELDS = [
  "sshHostFingerprint", "endpoint", "relayAddr", "lastDeployedAt", "deployVersion",
];

function sameDeployTopology(left, right) {
  return DEPLOY_TOPOLOGY_FIELDS.every((field) => isDeepStrictEqual(left[field], right[field]));
}

function wgRelayAddProfile(payload, deps) {
  const profile = sanitizeProfile(payload);
  if (!profile) {
    const detail = validateProfile(payload || {});
    return {
      status: "error",
      message: detail.status === "error" ? detail.message : "wgRelay.add: invalid profile",
    };
  }
  const next = _snapshot(deps);
  if (next.profiles.some((p) => p.id === profile.id)) {
    return { status: "error", message: `wgRelay.add: profile id "${profile.id}" already exists` };
  }
  if (subnetTaken(next.profiles, profile.wgSubnet)) {
    return { status: "error", message: `wgRelay.add: subnet ${profile.wgSubnet} already in use (EX-14)` };
  }
  next.profiles.push(profile);
  return { status: "ok", commit: { wgRelay: next } };
}

function wgRelayUpdateProfile(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "wgRelay.update: payload must be an object" };
  }
  const profile = sanitizeProfile(payload);
  if (!profile) {
    const detail = validateProfile(payload || {});
    return {
      status: "error",
      message: detail.status === "error" ? detail.message : "wgRelay.update: invalid profile",
    };
  }
  const next = _snapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) {
    return { status: "error", message: `wgRelay.update: profile id "${profile.id}" not found` };
  }
  if (subnetTaken(next.profiles, profile.wgSubnet, profile.id)) {
    return { status: "error", message: `wgRelay.update: subnet ${profile.wgSubnet} already in use (EX-14)` };
  }
  const prev = next.profiles[idx];
  // Preserve only canonical public deployment metadata across cosmetic edits.
  for (const f of [
    "sshHostFingerprint",
    "endpoint",
    "relayAddr",
    "lastDeployedAt",
    "deployVersion",
  ]) {
    if (!Object.hasOwn(payload, f) && prev[f] !== undefined) profile[f] = prev[f];
  }
  next.profiles[idx] = profile;
  return { status: "ok", commit: { wgRelay: next } };
}

function wgRelayRemoveProfile(payload, deps) {
  const id = typeof payload === "string"
    ? payload
    : (payload && typeof payload === "object" ? payload.id : null);
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "wgRelay.remove: id must be a non-empty string" };
  }
  const next = _snapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    return { status: "ok", noop: true };
  }
  next.profiles.splice(idx, 1);
  return { status: "ok", commit: { wgRelay: next } };
}

function wgRelayCommitDeploy(payload, deps) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { status: "error", errorCode: "profile_conflict_recovery_required" };
  }
  const baseProfile = sanitizeProfile(payload.baseProfile);
  const deployedProfile = sanitizeProfile(payload.deployedProfile);
  if (!baseProfile || !deployedProfile || baseProfile.id !== deployedProfile.id
      || typeof payload.allowCreate !== "boolean") {
    return { status: "error", errorCode: "profile_conflict_recovery_required" };
  }
  const next = _snapshot(deps);
  const index = next.profiles.findIndex((profile) => profile.id === baseProfile.id);
  if (index === -1) {
    if (!payload.allowCreate || subnetTaken(next.profiles, deployedProfile.wgSubnet)) {
      return { status: "error", errorCode: "profile_conflict_recovery_required" };
    }
    next.profiles.push(deployedProfile);
    return { status: "ok", profile: deployedProfile, commit: { wgRelay: next } };
  }
  const current = next.profiles[index];
  if (!sameDeployTopology(baseProfile, current)) {
    return { status: "error", errorCode: "profile_conflict_recovery_required" };
  }
  const candidate = { ...current };
  for (const field of DEPLOY_METADATA_FIELDS) {
    if (Object.hasOwn(deployedProfile, field)) candidate[field] = deployedProfile[field];
    else delete candidate[field];
  }
  const merged = sanitizeProfile(candidate);
  if (!merged) return { status: "error", errorCode: "profile_conflict_recovery_required" };
  next.profiles[index] = merged;
  return { status: "ok", profile: merged, commit: { wgRelay: next } };
}

// Stamp deploy readback onto a profile WITHOUT rewriting the whole profile
// (deploy can take 30+s; user may have edited meanwhile — lost-update race).
// CRITICAL SEC-1/SEC-3: only PUBLIC fields are written. pcConfig/phoneConfig,
// relayToken, managementToken and private keys are intentionally NOT persisted.
const READBACK_PERSIST_FIELDS = ["endpoint", "relayAddr"];

function wgRelayApplyReadback(profileId, readback, deps) {
  if (typeof profileId !== "string" || !profileId) {
    return { status: "error", message: "wgRelay.applyReadback: profileId must be a non-empty string" };
  }
  if (!readback || typeof readback !== "object") {
    return { status: "error", message: "wgRelay.applyReadback: readback must be an object" };
  }
  const next = _snapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === profileId);
  if (idx === -1) {
    return { status: "ok", noop: true, reason: "profile_deleted" };
  }
  const updated = { ...next.profiles[idx] };
  for (const f of READBACK_PERSIST_FIELDS) {
    const v = readback[f];
    if (typeof v === "string" && v.length > 0) {
      if (!isValidReadbackStr(v)) {
        return { status: "error", message: `wgRelay.applyReadback: ${f} contains invalid characters` };
      }
      updated[f] = v;
    }
  }
  updated.lastDeployedAt = Number.isFinite(readback.deployedAt) && readback.deployedAt > 0
    ? readback.deployedAt
    : Date.now();
  const deployVersion = readback.deployVersion === undefined
    ? readback.schemaVersion
    : readback.deployVersion;
  if (Number.isInteger(deployVersion) && deployVersion > 0) {
    updated.deployVersion = deployVersion;
  }
  const canonicalUpdated = sanitizeProfile(updated);
  if (!canonicalUpdated) {
    return { status: "error", message: "wgRelay.applyReadback: resulting profile is invalid" };
  }
  const newProfiles = next.profiles.slice();
  newProfiles[idx] = canonicalUpdated;
  return { status: "ok", commit: { wgRelay: { profiles: newProfiles } } };
}

wgRelayAddProfile.lockKey = "wgRelay";
wgRelayUpdateProfile.lockKey = "wgRelay";
wgRelayRemoveProfile.lockKey = "wgRelay";
wgRelayApplyReadback.lockKey = "wgRelay";
wgRelayCommitDeploy.lockKey = "wgRelay";

module.exports = {
  wgRelayAddProfile,
  wgRelayUpdateProfile,
  wgRelayRemoveProfile,
  wgRelayApplyReadback,
  wgRelayCommitDeploy,
  READBACK_PERSIST_FIELDS,
};

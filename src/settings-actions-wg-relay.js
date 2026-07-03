"use strict";

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
//   SEC-3  phone private key is NEVER persisted → applyReadback whitelists the
//          fields it copies; pcConf/phoneConf/phonePrivKey are deliberately
//          absent from that whitelist (they're transient, returned to the UI
//          for tunnel bring-up + QR only).

const {
  sanitizeProfile,
  validateProfile,
  isValidReadbackStr,
} = require("./wg-relay-profile");

function _snapshot(deps) {
  const snap = (deps && deps.snapshot) || {};
  const cur = snap.wgRelay && typeof snap.wgRelay === "object" ? snap.wgRelay : {};
  const profiles = Array.isArray(cur.profiles) ? cur.profiles.slice() : [];
  return { profiles };
}

// Reject a subnet already claimed by a DIFFERENT profile (D-SUBNET / EX-14).
function subnetTaken(profiles, subnet, exceptId) {
  return profiles.some((p) => p.wgSubnet === subnet && p.id !== exceptId);
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
  // Preserve createdAt / readback metadata across cosmetic edits unless the
  // caller explicitly supplies new values.
  if (Number.isFinite(prev.createdAt) && !Number.isFinite(payload.createdAt)) {
    profile.createdAt = prev.createdAt;
  }
  for (const f of ["serverPubKey", "endpoint", "pcAddress", "relayAddr", "lastDeployedAt"]) {
    if (profile[f] === undefined && prev[f] !== undefined) profile[f] = prev[f];
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

// Stamp deploy readback onto a profile WITHOUT rewriting the whole profile
// (deploy can take 30+s; user may have edited meanwhile — lost-update race).
// CRITICAL SEC-1/SEC-3: only PUBLIC fields are written. pcConf/phoneConf and
// any private key are intentionally NOT persisted — they are returned to the
// renderer transiently for tunnel bring-up (wg-pc-tunnel) and QR only.
const READBACK_PERSIST_FIELDS = ["serverPubKey", "endpoint", "pcAddress", "relayAddr"];

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
  const newProfiles = next.profiles.slice();
  newProfiles[idx] = updated;
  return { status: "ok", commit: { wgRelay: { profiles: newProfiles } } };
}

wgRelayAddProfile.lockKey = "wgRelay";
wgRelayUpdateProfile.lockKey = "wgRelay";
wgRelayRemoveProfile.lockKey = "wgRelay";
wgRelayApplyReadback.lockKey = "wgRelay";

module.exports = {
  wgRelayAddProfile,
  wgRelayUpdateProfile,
  wgRelayRemoveProfile,
  wgRelayApplyReadback,
  READBACK_PERSIST_FIELDS,
};

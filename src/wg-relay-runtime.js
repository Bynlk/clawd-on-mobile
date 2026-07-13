"use strict";

// ── WireGuard relay runtime (state + event bus) ──
//
// Lightweight EventEmitter that owns the *live* runtime state for each relay
// profile — the deploy/tunnel lifecycle that must NOT live in prefs. It mirrors
// the role remote-ssh-runtime plays for SSH tunnels, but far simpler: there is
// no long-lived child process to babysit here (the PC tunnel is a userspace
// interface managed by wg-pc-tunnel), so this module is purely a state machine
// + transient secret cache + event emitter.
//
// Events (consumed by wg-relay-ipc → broadcast to renderers):
//   "status-changed"  { profileId, status, message?, ... }
//   "progress"        { profileId, step, status, message?, hint? }
//
// Public one-click status values:
//   idle | starting_tunnel | verifying_relay | connecting_relay |
//   connected | disconnecting | failed
//
// SECURITY (SEC-3): the deploy readback carries the pc/phone confs (which hold
// private keys). We cache ONLY the pcConf here, in memory, so tunnelUp can
// bring the interface up without re-deploying. It is never written to disk and
// is dropped on cleanup(). The phone conf / QR is handled transiently in the
// renderer and never reaches this module.

const { EventEmitter } = require("events");
const { normalizeConnectionErrorCode } = require("./wg-relay-error-codes");

const PUBLIC_STATUS_FIELDS = new Set([
  "status", "message", "hint", "ifName", "address", "errorCode", "generation",
]);
const PUBLIC_STATUSES = new Set([
  "idle",
  "starting_tunnel",
  "verifying_relay",
  "connecting_relay",
  "connected",
  "disconnecting",
  "failed",
]);

function createWgRelayRuntime(options = {}) {
  const emitter = new EventEmitter();
  const log = options.log || (() => {});

  // profileId → { profileId, status, message?, ifName?, address?, updatedAt }
  const statuses = new Map();
  // profileId → pcConf (MEMORY ONLY, SEC-3). Populated after a successful
  // deploy; consumed by tunnelUp; cleared on tunnelDown/cleanup.
  const pcConfs = new Map();

  function getProfileStatus(profileId) {
    return statuses.get(profileId) || { profileId, status: "idle", generation: 0 };
  }

  function listStatuses() {
    return Array.from(statuses.values());
  }

  // Merge-and-emit a status snapshot. Always stamps profileId + updatedAt so
  // the renderer's runtimeStatuses Map keys line up.
  function setStatus(profileId, patch) {
    const prev = statuses.get(profileId) || { profileId, status: "idle", generation: 0 };
    const candidate = patch && typeof patch === "object" ? patch : {};
    if ((Object.hasOwn(candidate, "status") && !PUBLIC_STATUSES.has(candidate.status))
        || (Object.hasOwn(candidate, "generation")
          && (!Number.isSafeInteger(candidate.generation) || candidate.generation < 0))
        || (Object.hasOwn(candidate, "generation") && candidate.generation < prev.generation)) {
      return prev;
    }
    const clean = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (PUBLIC_STATUS_FIELDS.has(key)) clean[key] = value;
    }
    if (Object.hasOwn(clean, "errorCode")
        && clean.errorCode !== null) {
      clean.errorCode = normalizeConnectionErrorCode(clean.errorCode);
    }
    const next = { ...prev, ...clean, profileId, updatedAt: Date.now() };
    statuses.set(profileId, next);
    emitter.emit("status-changed", next);
    return next;
  }

  function emitProgress(payload) {
    emitter.emit("progress", payload);
  }

  // Cache the pc conf for a later tunnelUp (SEC-3: memory only).
  function rememberPcConf(profileId, pcConf) {
    if (typeof pcConf === "string" && pcConf.length > 0) {
      pcConfs.set(profileId, pcConf);
    }
  }

  function getPcConf(profileId) {
    return pcConfs.get(profileId) || null;
  }

  function forgetPcConf(profileId) {
    pcConfs.delete(profileId);
  }

  function removeStatus(profileId) {
    const removed = statuses.delete(profileId) || pcConfs.has(profileId);
    pcConfs.delete(profileId);
    return removed;
  }

  // Drop all in-memory secrets + state. Called on app quit.
  function cleanup() {
    pcConfs.clear();
    statuses.clear();
    emitter.removeAllListeners();
    log("wg-relay runtime cleaned up");
  }

  return {
    on: (...a) => emitter.on(...a),
    off: (...a) => emitter.off(...a),
    once: (...a) => emitter.once(...a),
    emit: (...a) => emitter.emit(...a),
    getProfileStatus,
    listStatuses,
    setStatus,
    emitProgress,
    rememberPcConf,
    getPcConf,
    forgetPcConf,
    removeStatus,
    cleanup,
  };
}

module.exports = { createWgRelayRuntime };

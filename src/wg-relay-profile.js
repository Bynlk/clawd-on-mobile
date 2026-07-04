"use strict";

// ── WireGuard relay profile schema + validation ──
//
// Pure schema helpers for `prefs.wgRelay.profiles[]`. Mirrors the design of
// remote-ssh-profile.js so writers (settings-actions-wg-relay) and readers
// (prefs normalize) share one rule set. Per TDD §3.1.
//
// Reuses remote-ssh-profile.js validators to avoid rule drift (SEC-5):
//   isValidHost / isValidPort / isValidIdentityFile / isValidId / isValidLabel
//
// Additional wg-specific rules:
//   authMethod  — "key" | "password". password is never persisted (SEC-1);
//                 only the method is stored so the UI knows which form to show.
//   wgPort      — [1,65535].
//   wgSubnet    — private /24 only: 10.x / 172.16-31.x / 192.168.x.
//   readback fields (serverPubKey/endpoint/pcAddress/relayAddr) — public,
//                 persistable; validated leniently (no control chars).

const {
  isValidHost,
  isValidPort,
  isValidIdentityFile,
  isValidId,
  isValidLabel,
} = require("./remote-ssh-profile");

const WG_DEFAULT_SUBNET = "10.8.0.0/24";
const WG_DEFAULT_PORT = 51820;
const WG_DEFAULT_RELAY_PORT = 7891;

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

// Private /24 subnets only. Third octet unrestricted; must end in .0/24.
//   10.a.b.0/24        a,b in 0-255
//   172.(16-31).b.0/24
//   192.168.b.0/24
const SUBNET_10_RE = /^10\.(\d{1,3})\.(\d{1,3})\.0\/24$/;
const SUBNET_172_RE = /^172\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.0\/24$/;
const SUBNET_192_RE = /^192\.168\.(\d{1,3})\.0\/24$/;

function octetsOk(str) {
  return str.split(/[./]/).every((p) => {
    if (!/^\d+$/.test(p)) return true; // the /24 part etc.
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

function isValidWgPort(n) {
  return isValidPort(n);
}

function isValidSubnet(s) {
  if (typeof s !== "string") return false;
  if (!(SUBNET_10_RE.test(s) || SUBNET_172_RE.test(s) || SUBNET_192_RE.test(s))) {
    return false;
  }
  return octetsOk(s);
}

function isValidAuthMethod(v) {
  return v === "key" || v === "password";
}

// Public readback string: non-empty, bounded, no control chars.
function isValidReadbackStr(v, max = 512) {
  return typeof v === "string"
    && v.length > 0
    && v.length <= max
    && !CONTROL_CHARS_RE.test(v);
}

// Validate a wgRelay profile candidate. Returns { status:"ok" } |
// { status:"error", message }.
function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { status: "error", message: "profile must be an object" };
  }
  if (!isValidId(profile.id)) {
    return { status: "error", message: "profile.id must be 1-64 chars [a-zA-Z0-9_-]" };
  }
  if (!isValidLabel(profile.label)) {
    return { status: "error", message: "profile.label must be 1-100 chars and contain no control characters" };
  }
  if (!isValidHost(profile.host)) {
    return {
      status: "error",
      message: "profile.host must be a hostname or user@hostname (ASCII alnum, . _ -; no leading -; at most one @)",
    };
  }
  if (profile.port !== undefined && profile.port !== null) {
    if (!isValidPort(profile.port)) {
      return { status: "error", message: "profile.port must be an integer in [1, 65535]" };
    }
  }
  if (!isValidAuthMethod(profile.authMethod)) {
    return { status: "error", message: 'profile.authMethod must be "key" or "password"' };
  }
  // identityFile required & validated only for key auth.
  if (profile.authMethod === "key") {
    if (!isValidIdentityFile(profile.identityFile)) {
      return {
        status: "error",
        message: "profile.identityFile must be an absolute path with no control chars and not starting with '-' (required for key auth)",
      };
    }
  }
  if (!isValidWgPort(profile.wgPort)) {
    return { status: "error", message: "profile.wgPort must be an integer in [1, 65535]" };
  }
  if (!isValidSubnet(profile.wgSubnet)) {
    return { status: "error", message: "profile.wgSubnet must be a private /24 subnet (10.x/172.16-31.x/192.168.x)" };
  }
  // Optional readback fields (present after a successful deploy).
  for (const f of ["serverPubKey", "endpoint", "pcAddress", "relayAddr"]) {
    if (profile[f] !== undefined && profile[f] !== null && profile[f] !== "") {
      if (!isValidReadbackStr(profile[f])) {
        return { status: "error", message: `profile.${f} contains invalid characters` };
      }
    }
  }
  if (profile.lastDeployedAt !== undefined && profile.lastDeployedAt !== null) {
    if (!Number.isFinite(profile.lastDeployedAt) || profile.lastDeployedAt <= 0) {
      return { status: "error", message: "profile.lastDeployedAt must be a positive finite number" };
    }
  }
  return { status: "ok" };
}

// Coerce arbitrary input into a sanitized profile, dropping unknown fields.
// SECURITY: never carries password or phone private key (SEC-1/SEC-3) — those
// fields are stripped even if present in raw input.
function sanitizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const authMethod = raw.authMethod === "password" ? "password" : "key";
  const out = {
    id: typeof raw.id === "string" ? raw.id : "",
    label: typeof raw.label === "string" ? raw.label : "",
    host: typeof raw.host === "string" ? raw.host.trim() : "",
    port: Number.isInteger(raw.port) ? raw.port : undefined,
    authMethod,
    identityFile: typeof raw.identityFile === "string" && raw.identityFile.length > 0
      ? raw.identityFile
      : undefined,
    wgPort: Number.isInteger(raw.wgPort) ? raw.wgPort : WG_DEFAULT_PORT,
    wgSubnet: typeof raw.wgSubnet === "string" && raw.wgSubnet.length > 0
      ? raw.wgSubnet
      : WG_DEFAULT_SUBNET,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
  // Optional persistable readback fields.
  for (const f of ["serverPubKey", "endpoint", "pcAddress", "relayAddr"]) {
    if (typeof raw[f] === "string" && raw[f].length > 0) out[f] = raw[f];
  }
  if (Number.isFinite(raw.lastDeployedAt) && raw.lastDeployedAt > 0) {
    out.lastDeployedAt = raw.lastDeployedAt;
  }
  // password / phonePrivKey MUST NOT be persisted — explicitly never copied.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  const v = validateProfile(out);
  if (v.status !== "ok") return null;
  return out;
}

function normalizeWgRelay(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults || { profiles: [] };
  }
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  const seen = new Set();
  const usedSubnets = new Set();
  const clean = [];
  for (const raw of profiles) {
    const p = sanitizeProfile(raw);
    if (!p) continue;
    if (seen.has(p.id)) continue;              // id unique (EX-14)
    if (usedSubnets.has(p.wgSubnet)) continue; // subnets must not overlap (EX-14)
    seen.add(p.id);
    usedSubnets.add(p.wgSubnet);
    clean.push(p);
  }
  return { profiles: clean };
}

function getDefaults() {
  return { profiles: [] };
}

module.exports = {
  getDefaults,
  normalizeWgRelay,
  validateProfile,
  sanitizeProfile,
  isValidWgPort,
  isValidSubnet,
  isValidAuthMethod,
  isValidReadbackStr,
  WG_DEFAULT_SUBNET,
  WG_DEFAULT_PORT,
  WG_DEFAULT_RELAY_PORT,
};

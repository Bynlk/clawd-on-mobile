"use strict";

// ── WireGuard relay deploy orchestration ──
//
// Relay deployment supports the legacy key-auth transport and the password
// bundle transport. Both paths parse the same strict schemaVersion=1 readback:
//
//   authMethod=key      → system ssh via buildSshArgs + spawnAndWait (stdin)
//   authMethod=password → one ssh2 connection for TOFU + SFTP + install exec
//
// Progress events reuse the remote-ssh shape:
//   { profileId, step, status:"start"|"ok"|"fail", message?, hint? }
//
// Key auth retains the original `bash -s` compatibility path. Password auth
// uploads the complete manifest and executes its installer by remote path.

const fs = require("fs");
const net = require("net");
const path = require("path");

const STEPS = [
  "connect", "host-key", "upload", "install", "validate",
  "detect", "install-wg", "gen-keys", "write-conf", "start-service", "firewall", "readback",
];

// Map script exit codes → EX table (TDD §3.4).
const EXIT_CODE_MAP = {
  10: { step: "detect", hint: "wgErrNoPkgManager", message: "Package manager not supported (need apt/dnf/yum). Install wireguard-tools manually and retry. (EX-1)" },
  11: { step: "detect", hint: "wgErrKernel", message: "Kernel does not support WireGuard. Upgrade the kernel or use a userspace implementation. (EX-2)" },
  12: { step: "firewall", hint: "wgErrPortInUse", message: "The WireGuard UDP port is already in use on the server. (EX-6)" },
  13: { step: "connect", hint: "wgErrNoSudo", message: "No root or passwordless sudo on the server. (EX-5)" },
  14: { step: "firewall", hint: "wgErrFirewall", message: "Failed to configure the firewall to allow the WireGuard port. (EX-6)" },
};

const TRANSPORT_ERROR_MAP = {
  HOST_KEY_CHANGED: {
    step: "host-key",
    reason: "host_key_changed",
    hint: "wgErrHostKeyChanged",
    message: "Saved SSH host key changed; remove the saved fingerprint before retrying.",
  },
  HOST_KEY_UNCONFIRMED: {
    step: "host-key",
    reason: "host_key_unconfirmed",
    hint: "wgErrHostKeyUnconfirmed",
    message: "SSH host key was not confirmed.",
  },
  HOST_KEY_CONFIRMATION_FAILED: {
    step: "host-key",
    reason: "host_key_confirmation_failed",
    hint: "wgErrHostKeyConfirmationFailed",
    message: "SSH host key confirmation failed.",
  },
  OUTPUT_LIMIT: {
    step: "install",
    reason: "output_limit",
    hint: "wgErrOutputLimit",
    message: "Remote installer output exceeded the safe limit.",
  },
};

const JSON_RE = /<<<CLAWD_JSON>>>([\s\S]*?)<<<END_CLAWD_JSON>>>/;

function resolveScriptPath(deps = {}) {
  if (deps.scriptPath) return deps.scriptPath;
  // src/wg-relay-deploy.js → ../relay/install-wg-relay.sh
  return path.join(__dirname, "..", "relay", "install-wg-relay.sh");
}

// Build the `export VAR=val` preamble. All values come from a schema-validated
// profile so they are safe; we still keep them numeric/whitelisted.
function buildEnvPreamble(profile, runtime) {
  const wgPort = Number(profile.wgPort) || 51820;
  const subnet = String(profile.wgSubnet || "10.8.0.0/24");
  const relayPort = Number((runtime && runtime.relayPort) || 7891);
  const forcePhone = runtime && runtime.forcePhoneKey ? 1 : 0;
  return [
    `export WG_PORT=${wgPort}`,
    `export WG_SUBNET='${subnet}'`,
    `export RELAY_PORT=${relayPort}`,
    `export FORCE_PHONE_KEY=${forcePhone}`,
    "",
  ].join("\n");
}

function buildInstallEnv(profile, runtime) {
  return {
    WG_PORT: String(Number(profile.wgPort) || 51820),
    WG_SUBNET: String(profile.wgSubnet || "10.8.0.0/24"),
    RELAY_PORT: String(Number((runtime && runtime.relayPort) || 7891)),
    FORCE_PHONE_KEY: runtime && runtime.forcePhoneKey ? "1" : "0",
  };
}

// Assemble the full remote payload: preamble + script, executed by `bash -s`.
function buildRemoteScript(profile, runtime, deps) {
  const scriptPath = resolveScriptPath(deps);
  const body = deps.scriptBody != null
    ? deps.scriptBody
    : fs.readFileSync(scriptPath, "utf8");
  return buildEnvPreamble(profile, runtime) + body;
}

function parseIpv4(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split(".").map(Number);
}

function parsePrivate24(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/24$/.exec(value || "");
  if (!match) return null;
  const octets = parseIpv4(match[1]);
  if (!octets || octets[3] !== 0) return null;
  const isPrivate = octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
  return isPrivate ? octets : null;
}

function isValidHostname(host) {
  if (typeof host !== "string" || host.length > 253 || !host) return false;
  if (/^[0-9.]+$/.test(host)) return false;
  return host.split(".").every((label) => (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  ));
}

function parseEndpoint(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let host;
  let portText;
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(value);
  if (ipv6) {
    host = ipv6[1];
    portText = ipv6[2];
    if (net.isIP(host) !== 6) return null;
  } else {
    const match = /^([^:]+):(\d+)$/.exec(value);
    if (!match) return null;
    host = match[1];
    portText = match[2];
    if (net.isIP(host) !== 4 && !isValidHostname(host)) return null;
  }
  const port = Number(portText);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
}

function ipv4ToInt(host) {
  const octets = parseIpv4(host);
  if (!octets) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(value, base, prefix) {
  const shift = 32 - prefix;
  return (value >>> shift) === (ipv4ToInt(base) >>> shift);
}

function ipv6ToBigInt(host) {
  if (net.isIP(host) !== 6) return null;
  let normalized = host.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value, base, prefix) {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (ipv6ToBigInt(base) >> shift);
}

function isGloballyRoutableIp(host) {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const value = ipv4ToInt(host);
    const blocked = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  }
  if (ipVersion === 6) {
    const value = ipv6ToBigInt(host);
    if (!ipv6InCidr(value, "2000::", 3)) return false;
    return ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([base, prefix]) => ipv6InCidr(value, base, prefix));
  }
  return false;
}

function isPublicEndpointHost(host) {
  if (net.isIP(host)) return isGloballyRoutableIp(host);
  const normalized = String(host || "").toLowerCase();
  return isValidHostname(host) && normalized !== "localhost" && !normalized.endsWith(".local");
}

function isExpectedRelayUrl(value, subnetOctets, relayPort) {
  const expectedHost = `${subnetOctets[0]}.${subnetOctets[1]}.${subnetOctets[2]}.1`;
  return value === `ws://${expectedHost}:${relayPort}`;
}

function isWireGuardKey(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value || "")) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

function parseCompleteWgConfig(value, { subnet, subnetOctets, endpoint, clientHost }) {
  if (typeof value !== "string" || value.length < 1 || value.length > 16384 || value.includes("\0")) return null;
  const sections = { Interface: Object.create(null), Peer: Object.create(null) };
  const sectionCounts = { Interface: 0, Peer: 0 };
  const allowedKeys = {
    Interface: new Set(["PrivateKey", "Address"]),
    Peer: new Set(["PublicKey", "Endpoint", "AllowedIPs", "PersistentKeepalive"]),
  };
  let section = null;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = /^\[([^\]]+)]$/.exec(line);
    if (heading) {
      if (!Object.hasOwn(sections, heading[1])) return null;
      section = heading[1];
      sectionCounts[section] += 1;
      if (sectionCounts[section] > 1) return null;
      continue;
    }
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!section || !assignment) return null;
    const key = assignment[1].trim();
    if (!allowedKeys[section].has(key) || Object.hasOwn(sections[section], key)) return null;
    sections[section][key] = assignment[2].trim();
  }

  if (sectionCounts.Interface !== 1 || sectionCounts.Peer !== 1) return null;
  if (Object.keys(sections.Interface).length !== allowedKeys.Interface.size) return null;
  if (Object.keys(sections.Peer).length !== allowedKeys.Peer.size) return null;
  if (!isWireGuardKey(sections.Interface.PrivateKey)) return null;
  if (!isWireGuardKey(sections.Peer.PublicKey)) return null;
  if (sections.Peer.Endpoint !== endpoint) return null;
  if (sections.Peer.AllowedIPs !== subnet) return null;
  if (sections.Peer.PersistentKeepalive !== "25") return null;
  const expectedAddress = `${subnetOctets[0]}.${subnetOctets[1]}.${subnetOctets[2]}.${clientHost}/32`;
  if (sections.Interface.Address !== expectedAddress) return null;
  return {
    privateKey: sections.Interface.PrivateKey,
    serverPublicKey: sections.Peer.PublicKey,
  };
}

function invalidReadback(field) {
  return { ok: false, message: `Invalid readback: ${field} (EX-12)` };
}

function parseReadback(stdout, context = {}) {
  const m = JSON_RE.exec(stdout || "");
  if (!m) return { ok: false, message: "No CLAWD_JSON marker found in output (EX-12)" };
  let obj;
  try {
    obj = JSON.parse(m[1].trim());
  } catch {
    return { ok: false, message: "Malformed readback JSON (EX-12)" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return invalidReadback("payload");
  const requiredFields = [
    "schemaVersion", "endpoint", "subnet", "relayUrl", "pcConfig",
    "phoneConfig", "relayToken", "managementToken",
  ];
  if (Object.keys(obj).length !== requiredFields.length || requiredFields.some((field) => !Object.hasOwn(obj, field))) {
    return invalidReadback("fields");
  }
  if (obj.schemaVersion !== 1) return invalidReadback("schemaVersion");
  const profile = context.profile || {};
  const runtime = context.runtime || {};
  const expectedSubnet = String(profile.wgSubnet || "10.8.0.0/24");
  if (obj.subnet !== expectedSubnet) return invalidReadback("subnet");
  const subnetOctets = parsePrivate24(expectedSubnet);
  if (!subnetOctets) return invalidReadback("subnet");
  const endpoint = parseEndpoint(obj.endpoint);
  const expectedWgPort = Number(profile.wgPort) || 51820;
  if (!endpoint || endpoint.port !== expectedWgPort) return invalidReadback("endpoint");
  const requestedHost = profile.host ? normalizeSshTarget(profile).host : null;
  if (requestedHost && net.isIP(requestedHost)) {
    if (!isGloballyRoutableIp(requestedHost)
      || !isGloballyRoutableIp(endpoint.host)
      || endpoint.host !== requestedHost) return invalidReadback("endpoint");
  } else if (!isPublicEndpointHost(endpoint.host)) {
    return invalidReadback("endpoint");
  }
  const expectedRelayPort = Number(runtime.relayPort) || 7891;
  if (!isExpectedRelayUrl(obj.relayUrl, subnetOctets, expectedRelayPort)) {
    return invalidReadback("relayUrl");
  }
  const configContext = { subnet: expectedSubnet, subnetOctets, endpoint: obj.endpoint };
  const pcConfig = parseCompleteWgConfig(obj.pcConfig, { ...configContext, clientHost: 2 });
  if (!pcConfig) return invalidReadback("pcConfig");
  const phoneConfig = parseCompleteWgConfig(obj.phoneConfig, { ...configContext, clientHost: 3 });
  if (!phoneConfig
    || phoneConfig.serverPublicKey !== pcConfig.serverPublicKey
    || phoneConfig.privateKey === pcConfig.privateKey) {
    return invalidReadback("phoneConfig");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(obj.relayToken || "")) return invalidReadback("relayToken");
  if (!/^[0-9a-fA-F]{64}$/.test(obj.managementToken || "")) return invalidReadback("managementToken");
  if (obj.relayToken.toLowerCase() === obj.managementToken.toLowerCase()) {
    return invalidReadback("managementToken");
  }
  return { ok: true, readback: { ...obj } };
}

// Emit the standard progress-step sequence based on remote log lines. The
// script prints `[wg-relay] step: <name>` to stderr; we map those to progress
// "start" events, and mark the previous step "ok". Any step never reached is
// left implicit. This keeps UI progress faithful without a second round-trip.
function makeStepTracker(progress) {
  // Map raw script step names → public STEPS.
  const toPublic = {
    detect: "detect",
    install: "install-wg",
    "gen-keys": "gen-keys",
    "write-conf": "write-conf",
    "start-service": "start-service",
    relay: "start-service",
    firewall: "firewall",
    readback: "readback",
  };
  let last = null;
  return {
    onLine(line) {
      const m = /\[wg-relay\]\s+step:\s+(\S+)/.exec(line || "");
      if (!m) return;
      const raw = m[1];
      const pub = toPublic[raw];
      if (!pub) return;
      if (last && last !== pub) progress(last, "ok");
      if (last !== pub) progress(pub, "start");
      last = pub;
    },
    finishOk() {
      if (last) progress(last, "ok");
    },
  };
}

async function runKeyPath({ profile, script, onProgress, deps }) {
  const childProcess = require("child_process");
  const spawn = deps.spawn || childProcess.spawn;
  const { buildSshArgs } = deps.runtimeModule || require("./remote-ssh-runtime");
  const { spawnAndWait } = deps.deployModule || require("./remote-ssh-deploy");
  const target = normalizeSshTarget(profile);
  const sshProfile = {
    ...profile,
    host: `${target.username}@${target.host}`,
    port: target.port,
  };
  const args = buildSshArgs(sshProfile).concat(["bash -s"]);
  // spawnAndWait accumulates stdout/stderr; stream lines for progress too.
  const r = await spawnAndWait(spawn, "ssh", args, {
    stdin: script,
    timeoutMs: deps.timeoutMs || 180000,
    runtime: deps.runtime,
  });
  // Feed combined output through the line tracker post-hoc.
  if (onProgress) {
    for (const line of `${r.stderr}\n${r.stdout}`.split(/\r?\n/)) onProgress(line);
  }
  return { code: r.code, stdout: r.stdout || "", stderr: r.stderr || "" };
}

async function runPasswordPath({ profile, password, runtime, onProgress, deps }) {
  const { deployBundle } = deps.ssh2Module || require("./wg-ssh2-exec");
  const bundleModule = deps.bundleModule || require("./wg-relay-bundle");
  const target = normalizeSshTarget(profile);
  const manifest = bundleModule.buildRelayBundleManifest({
    appRoot: deps.appRoot || path.join(__dirname, ".."),
  });
  const r = await deployBundle({
    host: target.host,
    port: target.port,
    username: target.username,
    password,
    expectedFingerprint: profile.sshHostFingerprint || undefined,
    confirmHostKey: deps.confirmHostKey || deps.hostKeyVerifier,
    manifest,
    installEnv: buildInstallEnv(profile, runtime),
    onProgress,
    timeoutMs: deps.timeoutMs || 180000,
    deps: deps.ssh2Deps || {},
  });
  return {
    code: r.code,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    acceptedFingerprint: r.acceptedFingerprint || null,
  };
}

function splitHost(host) {
  const s = String(host || "");
  const at = s.indexOf("@");
  if (at >= 0) return [s.slice(0, at), s.slice(at + 1)];
  return ["root", s];
}

function normalizeSshTarget(profile) {
  const source = profile || {};
  const [legacyUsername, host] = splitHost(source.host);
  return {
    host,
    username: source.sshUsername || legacyUsername,
    port: source.sshPort || source.port || 22,
  };
}

async function deployInternal({ profile, password, runtime = {}, deps = {} }) {
  if (!profile || !profile.id) throw new Error("deploy: profile.id required");
  const emitter = deps.runtime && typeof deps.runtime.emit === "function" ? deps.runtime : runtime.emitter;
  function progress(step, status, message, hint) {
    if (emitter && typeof emitter.emit === "function") {
      emitter.emit("progress", {
        profileId: profile.id,
        step,
        status,
        message: message || null,
        hint: hint || null,
      });
    }
  }

  const passwordAuth = profile.authMethod === "password";
  let script = null;
  if (!passwordAuth) {
    progress("connect", "start");
    try {
      script = buildRemoteScript(profile, runtime, deps);
    } catch (e) {
      progress("connect", "fail", `Cannot read install script: ${e.message}`);
      return { ok: false, step: "connect", message: `Cannot read install script: ${e.message}` };
    }
  }

  const tracker = makeStepTracker(progress);
  const onProgress = (line) => tracker.onLine(line);

  let result;
  try {
    if (passwordAuth) {
      result = await runPasswordPath({
        profile,
        password,
        runtime,
        onProgress: (event) => {
          if (!event || !["connect", "host-key", "upload", "install"].includes(event.stage)) return;
          if (!["start", "ok", "fail"].includes(event.status)) return;
          progress(event.stage, event.status);
        },
        deps,
      });
    } else {
      progress("connect", "ok");
      result = await runKeyPath({ profile, script, onProgress, deps });
    }
  } catch (e) {
    // ssh2 auth / connection errors surface here.
    const msg = (e && e.message) || String(e);
    const transportError = e && TRANSPORT_ERROR_MAP[e.code];
    if (transportError) {
      progress(transportError.step, "fail", transportError.message, transportError.hint);
      return { ok: false, ...transportError };
    }
    if (/password/i.test(msg) && /disabled|denied|not allowed/i.test(msg)) {
      progress("connect", "fail", "The server has disabled password login. Use an SSH key instead. (EX-3)", "wgErrPasswordDisabled");
      return { ok: false, step: "connect", reason: "password_disabled", hint: "wgErrPasswordDisabled", message: "Password login disabled on server (EX-3)" };
    }
    if (/host key/i.test(msg) || /rejected/i.test(msg)) {
      progress("connect", "fail", "Host key verification failed or was rejected.", "wgErrHostKey");
      return { ok: false, step: "connect", reason: "host_key", hint: "wgErrHostKey", message: "SSH host key verification failed" };
    }
    if (/required relay bundle|relay bundle directory is missing/i.test(msg)) {
      progress("upload", "fail", msg);
      return { ok: false, step: "upload", message: msg };
    }
    progress("connect", "fail", "SSH deployment failed");
    return { ok: false, step: "connect", message: "SSH deployment failed" };
  }

  // Non-zero exit → map to EX table.
  if (result.code !== 0) {
    const mapped = EXIT_CODE_MAP[result.code];
    if (mapped) {
      progress(mapped.step, "fail", mapped.message, mapped.hint);
      return { ok: false, step: mapped.step, hint: mapped.hint, message: mapped.message };
    }
    const message = `Remote installer exited with code ${result.code}`;
    progress("install", "fail", message);
    return { ok: false, step: "install", message };
  }

  // Exit 0 → parse readback (tolerate noisy stdout, EX-12).
  progress("validate", "start");
  const parsed = parseReadback(result.stdout, { profile, runtime });
  if (!parsed.ok) {
    progress("validate", "fail", parsed.message);
    return { ok: false, step: "validate", message: parsed.message };
  }
  if (!passwordAuth) tracker.finishOk();
  progress("validate", "ok");
  return {
    ok: true,
    readback: parsed.readback,
    ...(result.acceptedFingerprint ? { acceptedFingerprint: result.acceptedFingerprint } : {}),
  };
}

async function deploy({ profile, password, runtime = {}, deps = {} }) {
  let passwordRef = password;
  password = undefined;
  try {
    return await deployInternal({ profile, password: passwordRef, runtime, deps });
  } finally {
    passwordRef = undefined;
  }
}

module.exports = {
  deploy,
  STEPS,
  EXIT_CODE_MAP,
  parseReadback,
  buildRemoteScript,
  buildEnvPreamble,
  buildInstallEnv,
  makeStepTracker,
  splitHost,
};

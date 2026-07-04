"use strict";

// ── WireGuard relay deploy orchestration ──
//
// Single-connection deploy (D-CONN): assemble one idempotent shell script and
// feed it over stdin in ONE ssh invocation. Two transport paths produce the
// SAME script and parse the SAME JSON (TDD §3.3) so logic never forks:
//
//   authMethod=key      → system ssh via buildSshArgs + spawnAndWait (stdin)
//   authMethod=password → wg-ssh2-exec.execScript (ssh2, lazy-loaded)
//
// Progress events reuse the remote-ssh shape:
//   { profileId, step, status:"start"|"ok"|"fail", message?, hint? }
//
// The remote script itself is relay/install-wg-relay.sh. We read it from disk
// and stream it to the remote's `bash -s` over stdin, passing tunables via a
// leading `export` preamble (values are schema-validated; SEC-5).

const fs = require("fs");
const path = require("path");

const STEPS = ["connect", "detect", "install-wg", "gen-keys", "write-conf", "start-service", "firewall", "readback"];

// Map script exit codes → EX table (TDD §3.4).
const EXIT_CODE_MAP = {
  10: { step: "detect", hint: "wgErrNoPkgManager", message: "Package manager not supported (need apt/dnf/yum). Install wireguard-tools manually and retry. (EX-1)" },
  11: { step: "detect", hint: "wgErrKernel", message: "Kernel does not support WireGuard. Upgrade the kernel or use a userspace implementation. (EX-2)" },
  12: { step: "firewall", hint: "wgErrPortInUse", message: "The WireGuard UDP port is already in use on the server. (EX-6)" },
  13: { step: "connect", hint: "wgErrNoSudo", message: "No root or passwordless sudo on the server. (EX-5)" },
  14: { step: "firewall", hint: "wgErrFirewall", message: "Failed to configure the firewall to allow the WireGuard port. (EX-6)" },
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

// Assemble the full remote payload: preamble + script, executed by `bash -s`.
function buildRemoteScript(profile, runtime, deps) {
  const scriptPath = resolveScriptPath(deps);
  const body = deps.scriptBody != null
    ? deps.scriptBody
    : fs.readFileSync(scriptPath, "utf8");
  return buildEnvPreamble(profile, runtime) + body;
}

function parseReadback(stdout) {
  const m = JSON_RE.exec(stdout || "");
  if (!m) return { ok: false, message: "No CLAWD_JSON marker found in output (EX-12)" };
  let obj;
  try {
    obj = JSON.parse(m[1].trim());
  } catch (e) {
    return { ok: false, message: `Malformed readback JSON: ${e.message} (EX-12)` };
  }
  // Decode the base64-wrapped conf blobs (EX-11/EX-12).
  const out = {
    serverPubKey: obj.serverPubKey || "",
    endpoint: obj.endpoint || "",
    relayAddr: obj.relayAddr || "",
    pcAddress: obj.pcAddress || "",
  };
  try {
    if (obj.pcConfB64) out.pcConf = Buffer.from(obj.pcConfB64, "base64").toString("utf8");
    if (obj.phoneConfB64) out.phoneConf = Buffer.from(obj.phoneConfB64, "base64").toString("utf8");
  } catch (e) {
    return { ok: false, message: `Failed to decode conf blobs: ${e.message} (EX-12)` };
  }
  if (!out.serverPubKey || !out.endpoint || !out.pcConf || !out.phoneConf) {
    return { ok: false, message: "Readback JSON missing required fields (EX-12)" };
  }
  return { ok: true, readback: out };
}

// Emit the standard progress-step sequence based on remote log lines. The
// script prints `[wg-relay] step: <name>` to stderr; we map those to progress
// "start" events, and mark the previous step "ok". Any step never reached is
// left implicit. This keeps UI progress faithful without a second round-trip.
function makeStepTracker(progress) {
  const order = ["detect", "install", "gen-keys", "write-conf", "start-service", "relay", "firewall", "readback"];
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
  const args = buildSshArgs(profile).concat(["bash -s"]);
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

async function runPasswordPath({ profile, password, script, onProgress, hostKeyVerifier, deps }) {
  const { execScript } = deps.ssh2Module || require("./wg-ssh2-exec");
  const [username, hostOnly] = splitHost(profile.host);
  const r = await execScript({
    host: hostOnly,
    port: profile.port || 22,
    username,
    password,
    hostKeyVerifier,
    script,
    onProgress,
    timeoutMs: deps.timeoutMs || 180000,
  });
  return { code: r.code, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function splitHost(host) {
  const s = String(host || "");
  const at = s.indexOf("@");
  if (at >= 0) return [s.slice(0, at), s.slice(at + 1)];
  return ["root", s];
}

async function deploy({ profile, password, runtime = {}, deps = {} }) {
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

  progress("connect", "start");

  let script;
  try {
    script = buildRemoteScript(profile, runtime, deps);
  } catch (e) {
    progress("connect", "fail", `Cannot read install script: ${e.message}`);
    return { ok: false, step: "connect", message: `Cannot read install script: ${e.message}` };
  }

  const tracker = makeStepTracker(progress);
  const onProgress = (line) => tracker.onLine(line);

  let result;
  try {
    if (profile.authMethod === "password") {
      progress("connect", "ok");
      result = await runPasswordPath({
        profile, password, script, onProgress,
        hostKeyVerifier: deps.hostKeyVerifier,
        deps,
      });
    } else {
      progress("connect", "ok");
      result = await runKeyPath({ profile, script, onProgress, deps });
    }
  } catch (e) {
    // ssh2 auth / connection errors surface here.
    const msg = (e && e.message) || String(e);
    if (/password/i.test(msg) && /disabled|denied|not allowed/i.test(msg)) {
      progress("connect", "fail", "The server has disabled password login. Use an SSH key instead. (EX-3)", "wgErrPasswordDisabled");
      return { ok: false, step: "connect", reason: "password_disabled", hint: "wgErrPasswordDisabled", message: "Password login disabled on server (EX-3)" };
    }
    if (/host key/i.test(msg) || /rejected/i.test(msg)) {
      progress("connect", "fail", "Host key verification failed or was rejected.", "wgErrHostKey");
      return { ok: false, step: "connect", reason: "host_key", hint: "wgErrHostKey", message: msg };
    }
    progress("connect", "fail", msg);
    return { ok: false, step: "connect", message: msg };
  }

  // Non-zero exit → map to EX table.
  if (result.code !== 0) {
    const mapped = EXIT_CODE_MAP[result.code];
    if (mapped) {
      progress(mapped.step, "fail", mapped.message, mapped.hint);
      return { ok: false, step: mapped.step, hint: mapped.hint, message: mapped.message };
    }
    const tail = summarize(result.stderr) || `remote exited with code ${result.code}`;
    progress("readback", "fail", tail);
    return { ok: false, step: "readback", message: tail };
  }

  // Exit 0 → parse readback (tolerate noisy stdout, EX-12).
  const parsed = parseReadback(result.stdout);
  if (!parsed.ok) {
    progress("readback", "fail", parsed.message);
    return { ok: false, step: "readback", message: parsed.message };
  }
  tracker.finishOk();
  return { ok: true, readback: parsed.readback };
}

function summarize(text) {
  const t = (text || "").toString().trim();
  if (!t) return null;
  return t.length > 200 ? t.slice(0, 200) + "..." : t;
}

module.exports = {
  deploy,
  STEPS,
  EXIT_CODE_MAP,
  parseReadback,
  buildRemoteScript,
  buildEnvPreamble,
  makeStepTracker,
  splitHost,
};

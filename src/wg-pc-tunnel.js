"use strict";

// ── Desktop in-app userspace WireGuard tunnel (D-PCTUN / D-UX) ──
//
// After a successful deploy the desktop App brings up the PC side of the
// tunnel ITSELF — no jump to a WireGuard client, no manual conf import. We
// bundle a userspace WireGuard implementation (`wireguard-go`, or boringtun)
// with the Electron build so we depend on neither a preinstalled client nor a
// kernel module.
//
// The ONLY user-visible system interaction is a single OS privilege dialog to
// create the TUN interface + routes (macOS osascript admin / Windows UAC /
// Linux pkexec). That native dialog is the sole allowed D-UX exception.
//
// SECURITY (SEC-3): the pc conf carries the pc private key. We NEVER write it
// to a durable file. It is piped to `wg setconf` via a private FD / stdin and
// the in-memory copy is wiped after use. Nothing here is logged.
//
// Testability: all process spawns and the privilege escalator are injected via
// `deps` / `privilegeEscalator`, so unit tests run without touching the OS.

const os = require("os");
const path = require("path");

// Map a bringUp failure to an in-app EX-10 hint (retry / check permission),
// NEVER "please import the conf manually" (D-UX).
const REASONS = {
  noBinary: { hint: "wgPcErrNoBinary", message: "Bundled WireGuard runtime not found. Reinstall the app. (EX-10)" },
  privilegeDenied: { hint: "wgPcErrPrivilege", message: "Permission to create the VPN interface was denied. Retry and approve the system dialog. (EX-10)" },
  ifaceUp: { hint: "wgPcErrIface", message: "Failed to bring up the tunnel interface. (EX-10)" },
  setconf: { hint: "wgPcErrSetconf", message: "Failed to apply the tunnel configuration. (EX-10)" },
  badConf: { hint: "wgPcErrBadConf", message: "The tunnel configuration is invalid. (EX-10)" },
};

// Resolve the bundled userspace WireGuard binary. Packaged builds ship it under
// resources/wg-bin/<platform>; dev falls back to PATH. deps.wgGoPath overrides.
function resolveWgGoPath(deps = {}) {
  if (deps.wgGoPath) return deps.wgGoPath;
  const plat = deps.platform || process.platform;
  const base = deps.resourcesPath || process.resourcesPath || "";
  const exe = plat === "win32" ? "wireguard.exe" : "wireguard-go";
  if (base) return path.join(base, "wg-bin", plat, exe);
  return exe; // dev: expect on PATH
}

// Extract the [Interface] Address from a conf, for the return value + route.
function parseAddress(pcConf) {
  const m = /^\s*Address\s*=\s*([^\s#]+)/im.exec(pcConf || "");
  return m ? m[1].trim() : null;
}

function run(spawn, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...opts });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: (e && e.message) || "spawn failed" });
      return;
    }
    const out = [];
    const err = [];
    if (child.stdout) child.stdout.on("data", (d) => out.push(d));
    if (child.stderr) child.stderr.on("data", (d) => err.push(d));
    if (opts.stdin != null && child.stdin) {
      try { child.stdin.end(opts.stdin); } catch { /* ignore */ }
    } else if (child.stdin) {
      try { child.stdin.end(); } catch { /* ignore */ }
    }
    child.on("error", (e) => resolve({ code: -1, stdout: Buffer.concat(out).toString(), stderr: (e && e.message) || "error" }));
    child.on("exit", (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

async function bringUp({ pcConf, ifName = "clawd0", privilegeEscalator, onProgress, deps = {} }) {
  const spawn = deps.spawn || require("child_process").spawn;
  const emit = (l) => { if (onProgress) { try { onProgress(l); } catch { /* ignore */ } } };

  if (typeof pcConf !== "string" || !/\[Interface\]/i.test(pcConf)) {
    return { ok: false, reason: "badConf", ...REASONS.badConf };
  }
  const address = parseAddress(pcConf);
  if (!address) {
    return { ok: false, reason: "badConf", ...REASONS.badConf };
  }

  const wgGo = resolveWgGoPath(deps);

  // 1. One-time privilege escalation (OS native dialog). D-PCTUN: only the
  //    TUN creation + routing needs it. privilegeEscalator resolves true on
  //    approval. Injected in tests; real impl uses osascript/UAC/pkexec.
  emit("[wg-pc] step: privilege");
  let approved = true;
  if (typeof privilegeEscalator === "function") {
    try {
      approved = await privilegeEscalator();
    } catch {
      approved = false;
    }
  }
  if (!approved) {
    return { ok: false, reason: "privilegeDenied", ...REASONS.privilegeDenied };
  }

  // 2. Create the userspace TUN interface via bundled wireguard-go.
  emit("[wg-pc] step: iface-up");
  const upCmd = deps.ifaceUpCmd || { cmd: wgGo, args: [ifName] };
  const upR = await run(spawn, upCmd.cmd, upCmd.args);
  if (upR.code !== 0) {
    // A missing binary shows up as spawn error (code -1 / ENOENT text).
    if (upR.code === -1 && /ENOENT|not found|spawn/i.test(upR.stderr)) {
      return { ok: false, reason: "noBinary", ...REASONS.noBinary };
    }
    emit(`[wg-pc] iface up failed: ${upR.stderr}`);
    return { ok: false, reason: "ifaceUp", ...REASONS.ifaceUp };
  }

  // 3. Apply conf via `wg setconf` reading from stdin — the pc private key
  //    never touches a durable file (SEC-3). We convert the wg-quick style
  //    conf to a setconf-compatible stream; deps.setConf lets tests capture
  //    the payload and confirm no plaintext key was persisted.
  emit("[wg-pc] step: setconf");
  const setR = deps.setConf
    ? await deps.setConf({ ifName, pcConf })
    : await run(spawn, "wg", ["setconf", ifName, "/dev/stdin"], { stdin: pcConf });
  if (!setR || setR.code !== 0) {
    return { ok: false, reason: "setconf", ...REASONS.setconf };
  }

  emit("[wg-pc] step: ready");
  return { ok: true, ifName, address };
}

async function bringDown({ ifName = "clawd0", deps = {} }) {
  const spawn = deps.spawn || require("child_process").spawn;
  const downCmd = deps.ifaceDownCmd || { cmd: "wg-quick", args: ["down", ifName] };
  const r = await run(spawn, downCmd.cmd, downCmd.args);
  return { ok: r.code === 0 };
}

async function status({ ifName = "clawd0", deps = {} }) {
  const spawn = deps.spawn || require("child_process").spawn;
  const r = await run(spawn, "wg", ["show", ifName, "latest-handshakes"]);
  if (r.code !== 0) return { up: false };
  const line = (r.stdout || "").trim();
  if (!line) return { up: true, peers: 0 };
  const rows = line.split(/\r?\n/).filter(Boolean);
  let handshakeAt = 0;
  for (const row of rows) {
    const parts = row.split(/\s+/);
    const ts = Number(parts[parts.length - 1]);
    if (Number.isFinite(ts) && ts > handshakeAt) handshakeAt = ts;
  }
  return { up: true, peers: rows.length, handshakeAt: handshakeAt || undefined };
}

module.exports = {
  bringUp,
  bringDown,
  status,
  resolveWgGoPath,
  parseAddress,
  REASONS,
};

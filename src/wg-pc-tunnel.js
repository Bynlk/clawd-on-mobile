"use strict";

// ── Desktop in-app userspace WireGuard tunnel (D-PCTUN / D-UX) ──
//
// After a successful deploy the desktop App brings up the PC side of the
// tunnel ITSELF — no jump to a WireGuard client, no manual conf import. We
// bundle a userspace WireGuard implementation (`wireguard-go`) with the
// Electron build so we depend on neither a preinstalled client nor a kernel
// module.
//
// The ONLY user-visible system interaction is a SINGLE OS privilege dialog to
// create the TUN interface + assign the address + add the route (Linux pkexec
// / macOS osascript admin / Windows UAC). That native dialog is the sole
// allowed D-UX exception — so every privileged step is batched into ONE
// escalated shell invocation, never one dialog per command.
//
// SECURITY (SEC-3): the pc conf carries the pc private key. We NEVER write it
// to a durable file. It is piped to `wg setconf` via the escalated process'
// stdin and the in-memory copy is dropped after use. Nothing here is logged.
//
// Testability: the process spawn and the privilege escalator (the thing that
// actually runs the privileged batch) are injected via `deps` /
// `privilegeEscalator`, so unit tests run without touching the OS.

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

// The privileged batch. Runs as root via the escalator in ONE shot. Reads the
// (stripped, setconf-compatible) conf from stdin so the private key never
// touches a durable file (SEC-3). Distinct exit codes let bringUp classify the
// failure without parsing stderr.
//
//   91 bundled runtime missing / not executable   -> noBinary
//   92 wireguard-go could not create the interface -> ifaceUp
//   93 wg setconf failed                           -> setconf
//   94 ip address add failed                       -> ifaceUp
//   95 ip link set up failed                       -> ifaceUp
//
// A pkexec denial (dialog dismissed / not authorized) surfaces as pkexec's own
// 126/127 before the script runs -> privilegeDenied.
const LINUX_UP_SCRIPT = [
  "set -u",
  // pkexec resets the environment to a safe default whose PATH may omit
  // /usr/sbin & /sbin where `ip` / `wg` usually live -- put them back first.
  'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"',
  'WG_GO="$1"; IF="$2"; ADDR="$3"; SUBNET="$4"; WG_TOOL="$5"',
  '[ -x "$WG_GO" ] || exit 91',
  '"$WG_GO" "$IF" || exit 92',
  '"$WG_TOOL" setconf "$IF" /dev/stdin || exit 93',
  'ip address add "$ADDR" dev "$IF" || exit 94',
  'ip link set up dev "$IF" || exit 95',
  'if [ -n "$SUBNET" ]; then ip route add "$SUBNET" dev "$IF" 2>/dev/null || true; fi',
  "exit 0",
].join("\n");

// Tear down the userspace interface. Deleting the link stops wireguard-go and
// drops the address + routes with it — consistent with how we brought it up
// (NOT wg-quick, which assumes the kernel module + an on-disk conf).
const LINUX_DOWN_SCRIPT = [
  "set -u",
  'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"',
  'IF="$1"',
  'ip link del dev "$IF" 2>/dev/null || true',
  "exit 0",
].join("\n");

const UP_CODE_TO_REASON = {
  91: "noBinary",
  92: "ifaceUp",
  93: "setconf",
  94: "ifaceUp",
  95: "ifaceUp",
  126: "privilegeDenied",
  127: "privilegeDenied",
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

// Resolve the bundled `wg` (wireguard-tools) binary used for `setconf`. Same
// layout as wireguard-go; dev falls back to `wg` on PATH. deps.wgToolPath
// overrides. (Not needed on win32 where wireguard.exe is self-contained.)
function resolveWgToolPath(deps = {}) {
  if (deps.wgToolPath) return deps.wgToolPath;
  const plat = deps.platform || process.platform;
  const base = deps.resourcesPath || process.resourcesPath || "";
  if (base) return path.join(base, "wg-bin", plat, "wg");
  return "wg"; // dev: expect on PATH
}

// Extract the [Interface] Address from a conf, for the return value + address
// assignment.
function parseAddress(pcConf) {
  const m = /^\s*Address\s*=\s*([^\s#]+)/im.exec(pcConf || "");
  return m ? m[1].trim() : null;
}

// Extract the subnet to route through the tunnel from the [Peer] AllowedIPs.
// (In our topology the peer's AllowedIPs IS the relay subnet, e.g. 10.8.0.0/24.)
function parseAllowedSubnet(pcConf) {
  const m = /^\s*AllowedIPs\s*=\s*([^\s,#]+)/im.exec(pcConf || "");
  return m ? m[1].trim() : null;
}

// Strip a wg-quick-style conf down to what `wg setconf` accepts. wg setconf
// only understands PrivateKey / ListenPort / FwMark in [Interface] and the full
// [Peer] block; Address / DNS / MTU / Table etc. are wg-quick-only and make it
// error out (we handle Address + routes ourselves via `ip`). The private key
// stays in this in-memory string only, piped over stdin (SEC-3).
const IFACE_SETCONF_KEYS = new Set(["privatekey", "listenport", "fwmark"]);
function toSetconf(pcConf) {
  const lines = String(pcConf || "").split(/\r?\n/);
  const out = [];
  let inInterface = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[Interface\]$/i.test(line)) { inInterface = true; out.push("[Interface]"); continue; }
    if (/^\[Peer\]$/i.test(line)) { inInterface = false; out.push("[Peer]"); continue; }
    if (/^\[/.test(line)) { inInterface = false; out.push(line); continue; }
    if (!line || line.startsWith("#")) { out.push(raw); continue; }
    if (inInterface) {
      const key = (line.split("=")[0] || "").trim().toLowerCase();
      if (!IFACE_SETCONF_KEYS.has(key)) continue; // drop Address/DNS/MTU/...
    }
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
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

// Default (unprivileged) runner used in dev / already-elevated environments and
// in unit tests. Same shape as the escalator: takes { argv, stdin } and runs
// argv[0] with the rest as args. A real privilegeEscalator wraps argv with
// pkexec / osascript / UAC so the whole batch runs under ONE native dialog.
function directRunner(spawn) {
  return async ({ argv, stdin }) => {
    const [cmd, ...args] = argv;
    const r = await run(spawn, cmd, args, { stdin });
    return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

async function bringUp({ pcConf, ifName = "clawd0", subnet, privilegeEscalator, onProgress, deps = {} }) {
  const spawn = deps.spawn || require("child_process").spawn;
  const emit = (l) => { if (onProgress) { try { onProgress(l); } catch { /* ignore */ } } };

  if (typeof pcConf !== "string" || !/\[Interface\]/i.test(pcConf)) {
    return { ok: false, reason: "badConf", ...REASONS.badConf };
  }
  const address = parseAddress(pcConf);
  if (!address) {
    return { ok: false, reason: "badConf", ...REASONS.badConf };
  }
  const sub = subnet || parseAllowedSubnet(pcConf) || "";
  const wgGo = resolveWgGoPath(deps);
  const wgTool = resolveWgToolPath(deps);
  const setconfConf = toSetconf(pcConf);

  // Build the single privileged batch. All args are NON-secret; the conf (with
  // the private key) travels only on stdin (SEC-3).
  const script = deps.upScript || LINUX_UP_SCRIPT;
  const argv = ["/bin/sh", "-c", script, "clawd-wg-up", wgGo, ifName, address, sub, wgTool];

  // One-time privilege escalation -> runs the whole batch (D-UX: one dialog).
  emit("[wg-pc] step: privilege");
  const runner = (typeof privilegeEscalator === "function")
    ? privilegeEscalator
    : directRunner(spawn);

  emit("[wg-pc] step: iface-up");
  let res;
  try {
    res = await runner({ argv, stdin: setconfConf, onProgress });
  } catch {
    return { ok: false, reason: "privilegeDenied", ...REASONS.privilegeDenied };
  }
  if (res && res.denied) {
    return { ok: false, reason: "privilegeDenied", ...REASONS.privilegeDenied };
  }
  const code = res ? res.code : -1;
  if (code !== 0) {
    // spawn-level ENOENT (escalator or /bin/sh missing) -> treat as noBinary.
    if (code === -1 && res && /ENOENT|not found|spawn/i.test(res.stderr || "")) {
      return { ok: false, reason: "noBinary", ...REASONS.noBinary };
    }
    const reason = UP_CODE_TO_REASON[code] || "ifaceUp";
    emit(`[wg-pc] bring-up failed (code ${code})`);
    return { ok: false, reason, ...REASONS[reason] };
  }

  emit("[wg-pc] step: ready");
  return { ok: true, ifName, address, subnet: sub || undefined };
}

async function bringDown({ ifName = "clawd0", privilegeEscalator, deps = {} }) {
  const spawn = deps.spawn || require("child_process").spawn;
  const script = deps.downScript || LINUX_DOWN_SCRIPT;
  const argv = ["/bin/sh", "-c", script, "clawd-wg-down", ifName];
  const runner = (typeof privilegeEscalator === "function")
    ? privilegeEscalator
    : directRunner(spawn);
  try {
    const r = await runner({ argv, stdin: null });
    return { ok: !!(r && r.code === 0) };
  } catch {
    return { ok: false };
  }
}

// Live probe — deliberately UNPRIVILEGED so it can poll without popping a
// dialog every time (D-UX). We check the interface exists and is not DOWN via
// `ip link show` (world-readable). Handshake counts need root, so we omit them;
// the runtime already knows "connected" from a successful bringUp.
async function status({ ifName = "clawd0", deps = {} }) {
  const spawn = deps.spawn || require("child_process").spawn;
  const r = await run(spawn, "ip", ["link", "show", ifName]);
  if (r.code !== 0) return { up: false };
  const text = r.stdout || "";
  const up = !/state DOWN/i.test(text);
  return { up, ifName };
}

module.exports = {
  bringUp,
  bringDown,
  status,
  resolveWgGoPath,
  resolveWgToolPath,
  parseAddress,
  parseAllowedSubnet,
  toSetconf,
  directRunner,
  REASONS,
  LINUX_UP_SCRIPT,
  LINUX_DOWN_SCRIPT,
};

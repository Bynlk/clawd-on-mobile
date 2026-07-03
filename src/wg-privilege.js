"use strict";

// ── Cross-platform privilege escalator (D-UX single native dialog) ──
//
// wg-pc-tunnel batches EVERY privileged step into one shell invocation and
// hands it to an escalator with the shape:
//
//     escalator({ argv, stdin, onProgress }) ->
//        { ok, code, stdout, stderr, denied? }
//
//   argv    the command + args to run as root (argv[0] is the program).
//   stdin   optional string piped to the process' stdin — this is how the
//           WireGuard conf (with the pc private key) reaches `wg setconf`
//           without ever touching a durable file (SEC-3).
//   denied  true when the user dismissed / failed the auth dialog, so the
//           caller can show "approve the dialog" rather than a generic error.
//
// The escalator wraps argv so the WHOLE batch runs under a SINGLE OS auth
// prompt (Linux pkexec now; macOS osascript-admin / Windows UAC are stubbed
// for later platforms). Nothing here logs stdin (SEC-7).

const childProcess = require("child_process");

function runCapture(spawn, cmd, args, { stdin } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: (e && e.message) || "spawn failed" });
      return;
    }
    const out = [];
    const err = [];
    if (child.stdout) child.stdout.on("data", (d) => out.push(d));
    if (child.stderr) child.stderr.on("data", (d) => err.push(d));
    if (child.stdin) {
      try { child.stdin.end(stdin != null ? stdin : ""); } catch { /* ignore */ }
    }
    child.on("error", (e) => resolve({ code: -1, stdout: Buffer.concat(out).toString(), stderr: (e && e.message) || "error" }));
    child.on("exit", (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

// pkexec exit codes: 126 = auth dialog dismissed / not authorized, 127 = the
// target program could not be run. Treat both as a user-facing "denied" so the
// tunnel layer prompts to retry + approve rather than surfacing a raw error.
function isPkexecDenial(code) {
  return code === 126 || code === 127;
}

// Linux: prefix argv with `pkexec`. pkexec runs one graphical/polkit auth
// prompt then executes the whole batch as root, forwarding our stdin — exactly
// the single-dialog contract we want (D-UX).
function makeLinuxEscalator(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const pkexecPath = deps.pkexecPath || "pkexec";
  return async ({ argv, stdin } = {}) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      return { ok: false, code: -1, stdout: "", stderr: "empty argv" };
    }
    const r = await runCapture(spawn, pkexecPath, argv, { stdin });
    // pkexec missing entirely (ENOENT) -> can't escalate on this box.
    if (r.code === -1 && /ENOENT|spawn/i.test(r.stderr || "")) {
      return { ok: false, code: -1, denied: true, stdout: r.stdout, stderr: "pkexec not available" };
    }
    return {
      ok: r.code === 0,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      denied: isPkexecDenial(r.code),
    };
  };
}

// macOS / Windows: not implemented yet. Returning a denied escalator keeps the
// tunnel layer honest (it reports "permission denied / retry") instead of
// silently trying to run privileged commands unelevated. Wired platforms come
// in a follow-up (osascript "with administrator privileges" / a UAC helper).
function makeUnsupportedEscalator(platform) {
  return async () => ({
    ok: false,
    code: -1,
    denied: true,
    stdout: "",
    stderr: `privilege escalation not yet supported on ${platform}`,
  });
}

// Pick the escalator for the current platform. Returns null on Linux ONLY when
// pkexec resolution is explicitly disabled — otherwise always returns a
// function so main.js can pass it straight to registerWgRelayIpc.
function createPrivilegeEscalator(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === "linux") return makeLinuxEscalator(deps);
  return makeUnsupportedEscalator(platform);
}

module.exports = {
  createPrivilegeEscalator,
  makeLinuxEscalator,
  makeUnsupportedEscalator,
  isPkexecDenial,
};

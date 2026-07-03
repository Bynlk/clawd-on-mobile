"use strict";

// ── ssh2 password-auth exec channel ──
//
// The system `ssh` client refuses to read a password from anything but a TTY
// (BatchMode=yes; OpenSSH design). For password profiles (D-SSH) we therefore
// use the `ssh2` npm library — lazily loaded so key-auth users never pay for
// it, and so `npm ls`/audit surface only touches installs that use it.
//
// execScript() opens ONE connection, runs `bash -s` with the assembled script
// fed over the exec stream's stdin (mirrors the key path in wg-relay-deploy so
// the two transports never fork logic), streams stderr lines to onProgress,
// and resolves { code, stdout, stderr }.
//
// SECURITY:
//   SEC-6  host key: we NEVER silently accept. `hostKeyVerifier(fingerprint)`
//          is awaited on first connect; if it returns false we abort. Callers
//          implement TOFU (D-HOSTKEY) — show fingerprint, persist on approve.
//   SEC-1  the password is passed straight to ssh2 and never logged, never
//          written to disk, never echoed into stdout/stderr accumulation.
//   SEC-7  we never console.log the script (it contains no secrets, but the
//          readback JSON that comes back on stdout carries the phone priv key,
//          so stdout is returned to the caller only, never logged here).

const crypto = require("crypto");

// Compute the SHA256 fingerprint the way OpenSSH prints it:
//   SHA256:<base64-no-padding>
function sha256Fingerprint(keyBuf) {
  const hash = crypto.createHash("sha256").update(keyBuf).digest("base64");
  return "SHA256:" + hash.replace(/=+$/, "");
}

// Load ssh2 lazily. deps.ssh2 lets tests inject a fake Client.
function loadClient(deps) {
  if (deps && deps.Client) return deps.Client;
  // eslint-disable-next-line global-require
  return require("ssh2").Client;
}

// hostKeyVerifier: async (info) => boolean, where info = { fingerprint, host, port }.
// If omitted, we REJECT unknown host keys (fail-closed, SEC-6). A caller that
// truly wants to skip verification must pass an explicit verifier.
async function execScript({
  host,
  port = 22,
  username = "root",
  password,
  hostKeyVerifier,
  script,
  onProgress,
  timeoutMs = 180000,
  deps = {},
}) {
  if (!host) throw new Error("execScript: host required");
  if (typeof script !== "string" || !script) throw new Error("execScript: script required");

  const Client = loadClient(deps);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let hostKeyOk = null; // null=pending, true/false after verify
    const stdoutChunks = [];
    const stderrChunks = [];
    let stderrLineBuf = "";

    const timer = setTimeout(() => {
      finishReject(new Error(`ssh2 exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
    }
    function finishResolve(payload) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    }
    function finishReject(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    // Feed stderr to onProgress line-by-line (the install script prints
    // `[wg-relay] step: X` to stderr).
    function pumpStderr(text) {
      stderrLineBuf += text;
      let idx;
      while ((idx = stderrLineBuf.indexOf("\n")) >= 0) {
        const line = stderrLineBuf.slice(0, idx);
        stderrLineBuf = stderrLineBuf.slice(idx + 1);
        if (onProgress) { try { onProgress(line); } catch { /* ignore */ } }
      }
    }

    conn.on("ready", () => {
      conn.exec("bash -s", (err, stream) => {
        if (err) { finishReject(err); return; }
        stream.on("close", (code /*, signal */) => {
          if (stderrLineBuf && onProgress) {
            try { onProgress(stderrLineBuf); } catch { /* ignore */ }
          }
          finishResolve({
            code: typeof code === "number" ? code : 0,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          });
        });
        stream.on("data", (d) => { stdoutChunks.push(Buffer.from(d)); });
        stream.stderr.on("data", (d) => {
          const buf = Buffer.from(d);
          stderrChunks.push(buf);
          pumpStderr(buf.toString("utf8"));
        });
        // Feed the script over stdin, then close it so `bash -s` runs & exits.
        stream.end(script);
      });
    });

    conn.on("error", (err) => {
      // ssh2 surfaces auth failures, connection refused, and our own
      // host-key rejection here. Normalize a rejected host key so the caller
      // can special-case it.
      if (hostKeyOk === false) {
        finishReject(new Error("Host key verification rejected by user"));
        return;
      }
      finishReject(err);
    });

    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: Math.min(timeoutMs, 30000),
      // SEC-6: verify the host key ourselves. ssh2 calls this synchronously
      // and expects a boolean; we resolve the (possibly async) verifier first
      // by short-circuiting: if the verifier is async we must decide here, so
      // we require it to be resolvable synchronously OR pre-resolved. To
      // support async TOFU we instead verify eagerly below via a wrapper.
      hostVerifier: (keyBuf, cb) => {
        const fingerprint = sha256Fingerprint(keyBuf);
        const info = { fingerprint, host, port };
        Promise.resolve(
          hostKeyVerifier ? hostKeyVerifier(info) : false
        ).then((ok) => {
          hostKeyOk = !!ok;
          cb(!!ok);
        }).catch(() => {
          hostKeyOk = false;
          cb(false);
        });
      },
    });
  });
}

module.exports = {
  execScript,
  sha256Fingerprint,
};

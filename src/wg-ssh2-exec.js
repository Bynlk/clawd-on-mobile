"use strict";

// ── ssh2 password-auth exec channel ──
//
// The system `ssh` client refuses to read a password from anything but a TTY
// (BatchMode=yes; OpenSSH design). For password profiles (D-SSH) we therefore
// use the `ssh2` npm library — lazily loaded so key-auth users never pay for
// it, and so `npm ls`/audit surface only touches installs that use it.
//
// deployBundle() opens ONE connection for TOFU verification, SFTP upload and
// one installer exec. execScript() remains exported for backward compatibility
// with the original `bash -s` callers.
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

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function transportError(code, reason, message) {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  return error;
}

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

function emitProgress(onProgress, stage, status) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({ stage, status });
  } catch {
    // Progress observers must not affect deployment.
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildInstallCommand({ username, remoteRoot, installEnv }) {
  if (!/^\/tmp\/[A-Za-z0-9._-]+$/.test(remoteRoot)) {
    throw new Error("deployBundle: unsafe remote upload root");
  }
  const assignments = Object.keys(installEnv || {}).sort().map((key) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error("deployBundle: invalid installer environment name");
    }
    return `${key}=${shellQuote(installEnv[key])}`;
  });
  const envPrefix = assignments.length ? `env ${assignments.join(" ")} ` : "";
  const installer = `${envPrefix}bash ${remoteRoot}/install-wg-relay.sh`;
  return username === "root" ? installer : `sudo -S -p '' ${installer}`;
}

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function closeSftp(sftp) {
  if (!sftp) return;
  try {
    if (typeof sftp.end === "function") sftp.end();
    else if (typeof sftp.close === "function") sftp.close();
  } catch {
    // Best-effort cleanup.
  }
}

function abortChannel(stream) {
  if (!stream) return;
  try {
    if (typeof stream.destroy === "function") stream.destroy();
    else if (typeof stream.close === "function") stream.close();
  } catch {
    // Best-effort cleanup.
  }
}

function executeInstaller(conn, {
  command,
  username,
  password,
  isAborted,
  onChannel,
}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (isAborted()) {
        abortChannel(stream);
        reject(transportError("SSH_ABORTED", "aborted", "SSH deployment was aborted"));
        return;
      }
      onChannel(stream);
      const stdoutChunks = [];
      const stderrChunks = [];
      let outputBytes = 0;
      let done = false;

      function finishReject(error) {
        if (done) return;
        done = true;
        onChannel(null);
        abortChannel(stream);
        reject(error);
      }

      function appendOutput(chunks, chunk) {
        if (done) return;
        const buffer = Buffer.from(chunk);
        if (outputBytes + buffer.length > MAX_OUTPUT_BYTES) {
          finishReject(transportError(
            "OUTPUT_LIMIT",
            "output_limit",
            "Remote installer output exceeded the safe limit"
          ));
          return;
        }
        outputBytes += buffer.length;
        chunks.push(buffer);
      }

      stream.on("data", (chunk) => appendOutput(stdoutChunks, chunk));
      stream.stderr.on("data", (chunk) => appendOutput(stderrChunks, chunk));
      stream.on("error", finishReject);
      stream.on("close", (code) => {
        if (done) return;
        done = true;
        onChannel(null);
        resolve({
          code: typeof code === "number" ? code : 0,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });

      if (isAborted()) {
        finishReject(transportError("SSH_ABORTED", "aborted", "SSH deployment was aborted"));
        return;
      }
      if (username !== "root") stream.write(`${password}\n`);
      if (isAborted()) {
        finishReject(transportError("SSH_ABORTED", "aborted", "SSH deployment was aborted"));
        return;
      }
      stream.end();
    });
  });
}

async function deployBundle({
  host,
  port = 22,
  username = "root",
  password,
  expectedFingerprint,
  confirmHostKey,
  manifest,
  installEnv = {},
  onProgress,
  timeoutMs = 180000,
  deps = {},
}) {
  if (!host) throw new Error("deployBundle: host required");
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("deployBundle: manifest required");
  }
  if (username !== "root" && (typeof password !== "string" || /[\r\n]/.test(password))) {
    throw transportError(
      "INVALID_SUDO_PASSWORD",
      "invalid_sudo_password",
      "SSH password cannot contain CR or LF for sudo deployment"
    );
  }
  const Client = loadClient(deps);
  const { uploadRelayBundle } = deps.bundleModule || require("./wg-relay-bundle");
  const remoteRoot = deps.remoteRoot || `/tmp/clawd-relay-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const command = buildInstallCommand({ username, remoteRoot, installEnv });

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let aborted = false;
    let acceptedFingerprint = null;
    let activeSftp = null;
    let activeChannel = null;
    let activeVerifier = null;
    let hostKeyFailure = null;

    const timer = setTimeout(() => {
      finishReject(transportError(
        "SSH_TIMEOUT",
        "timeout",
        `SSH deployment timed out after ${timeoutMs}ms`
      ));
    }, timeoutMs);

    function isAborted() {
      return aborted || settled;
    }
    function cleanup() {
      clearTimeout(timer);
      if (activeVerifier) activeVerifier(false);
      abortChannel(activeChannel);
      activeChannel = null;
      closeSftp(activeSftp);
      activeSftp = null;
      try { conn.end(); } catch { /* ignore cleanup errors */ }
    }
    function finishResolve(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function finishReject(error) {
      if (settled) return;
      settled = true;
      aborted = true;
      cleanup();
      reject(error);
    }

    conn.on("error", (error) => {
      finishReject(hostKeyFailure || error);
    });
    conn.on("close", () => {
      finishReject(hostKeyFailure || transportError(
        "SSH_CONNECTION_CLOSED",
        "connection_closed",
        "SSH connection closed before deployment completed"
      ));
    });

    conn.on("ready", async () => {
      if (isAborted()) return;
      emitProgress(onProgress, "connect", "ok");
      let activeStage = "upload";
      try {
        if (isAborted()) return;
        emitProgress(onProgress, "upload", "start");
        const sftp = await openSftp(conn);
        if (isAborted()) {
          closeSftp(sftp);
          return;
        }
        activeSftp = sftp;
        if (isAborted()) return;
        await uploadRelayBundle({ sftp, manifest, remoteRoot });
        if (isAborted()) return;
        closeSftp(activeSftp);
        activeSftp = null;
        emitProgress(onProgress, "upload", "ok");

        if (isAborted()) return;
        activeStage = "install";
        emitProgress(onProgress, "install", "start");
        if (isAborted()) return;
        const result = await executeInstaller(conn, {
          command,
          username,
          password,
          isAborted,
          onChannel: (stream) => { activeChannel = stream; },
        });
        if (isAborted()) return;
        emitProgress(onProgress, "install", result.code === 0 ? "ok" : "fail");
        finishResolve({ ...result, acceptedFingerprint });
      } catch (error) {
        if (isAborted()) return;
        emitProgress(onProgress, activeStage, "fail");
        finishReject(error);
      }
    });

    emitProgress(onProgress, "connect", "start");
    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: Math.min(timeoutMs, 30000),
      hostVerifier: (keyBuf, callback) => {
        let verifierCalled = false;
        const respond = (accepted) => {
          if (verifierCalled) return;
          verifierCalled = true;
          if (activeVerifier === respond) activeVerifier = null;
          try {
            callback(Boolean(accepted) && !isAborted());
          } catch {
            finishReject(hostKeyFailure || transportError(
              "HOST_KEY_CONFIRMATION_FAILED",
              "host_key_confirmation_failed",
              "SSH host key verification callback failed"
            ));
          }
        };
        activeVerifier = respond;
        const fingerprint = sha256Fingerprint(keyBuf);
        const info = { fingerprint, host, port };
        emitProgress(onProgress, "host-key", "start");

        if (expectedFingerprint) {
          if (fingerprint === expectedFingerprint) {
            acceptedFingerprint = fingerprint;
            emitProgress(onProgress, "host-key", "ok");
            respond(true);
          } else {
            const error = transportError(
              "HOST_KEY_CHANGED",
              "host_key_changed",
              "Saved SSH host key has changed; remove it before confirming a replacement"
            );
            hostKeyFailure = error;
            emitProgress(onProgress, "host-key", "fail");
            respond(false);
            finishReject(error);
          }
          return;
        }

        Promise.resolve()
          .then(() => (typeof confirmHostKey === "function" ? confirmHostKey(info) : false))
          .then((confirmed) => {
            if (isAborted()) {
              respond(false);
              return;
            }
            if (confirmed) {
              acceptedFingerprint = fingerprint;
              emitProgress(onProgress, "host-key", "ok");
              respond(true);
            } else {
              const error = transportError(
                "HOST_KEY_UNCONFIRMED",
                "host_key_unconfirmed",
                "SSH host key was not confirmed"
              );
              hostKeyFailure = error;
              emitProgress(onProgress, "host-key", "fail");
              respond(false);
              finishReject(error);
            }
          })
          .catch(() => {
            if (isAborted()) {
              respond(false);
              return;
            }
            const error = transportError(
              "HOST_KEY_CONFIRMATION_FAILED",
              "host_key_confirmation_failed",
              "SSH host key confirmation failed"
            );
            hostKeyFailure = error;
            emitProgress(onProgress, "host-key", "fail");
            respond(false);
            finishReject(error);
          });
      },
    });
  });
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
  deployBundle,
  execScript,
  sha256Fingerprint,
};

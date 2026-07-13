"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { normalizeSidecarErrorCode } = require("./wg-relay-error-codes");

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);
const DEFAULT_MAX_STATUS_LINE_BYTES = 4096;

function codedError(code) {
  const stable = normalizeSidecarErrorCode(code);
  const error = new Error(stable);
  error.code = stable;
  return error;
}

function assertAbsoluteRoot(root, name) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.resolve(root);
}

function sidecarPathFor(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`Unsupported sidecar target: ${platform}/${arch}`);
  }

  const executable = platform === "win32" ? "clawd-wg-tunnel.exe" : "clawd-wg-tunnel";
  if (options.isPackaged) {
    const root = assertAbsoluteRoot(options.resourcesPath, "resourcesPath");
    return path.join(root, "sidecars", "wg-relay-tunnel", `${platform}-${arch}`, executable);
  }
  const root = assertAbsoluteRoot(options.appRoot, "appRoot");
  return path.join(root, "sidecars", "wg-relay-tunnel", "bin", `${platform}-${arch}`, executable);
}

function propertyNamesInFlatObject(line) {
  const names = [];
  const pattern = /"(?:\\.|[^"\\])*"\s*:/g;
  for (const match of line.matchAll(pattern)) {
    try {
      names.push(JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))));
    } catch (_) {
      throw codedError("sidecar_protocol_error");
    }
  }
  return names;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validLoopbackListen(value) {
  if (typeof value !== "string") return false;
  const match = /^(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(value);
  return Boolean(match) && Number(match[1]) <= 65535;
}

function parseStatusLine(line, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_STATUS_LINE_BYTES;
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > maxBytes) {
    throw codedError("sidecar_output_limit");
  }

  let value;
  try {
    value = JSON.parse(line);
  } catch (_) {
    throw codedError("sidecar_protocol_error");
  }
  if (!isPlainObject(value)) throw codedError("sidecar_protocol_error");

  const rawNames = propertyNamesInFlatObject(line);
  if (rawNames.length !== Object.keys(value).length || new Set(rawNames).size !== rawNames.length) {
    throw codedError("sidecar_protocol_error");
  }

  if (value.type === "ready") {
    if (Object.keys(value).length !== 2 || !validLoopbackListen(value.listen)) {
      throw codedError("sidecar_protocol_error");
    }
    return { type: "ready", listen: value.listen };
  }
  if (value.type === "error") {
    if (Object.keys(value).length !== 3
        || value.status !== "failed"
        || typeof value.errorCode !== "string") {
      throw codedError("sidecar_protocol_error");
    }
    return {
      type: "error",
      status: "failed",
      errorCode: normalizeSidecarErrorCode(value.errorCode),
    };
  }
  throw codedError("sidecar_protocol_error");
}

function minimalEnvironment(platform, source = process.env) {
  if (platform !== "win32") return {};
  const env = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  }
  return env;
}

function defaultKillProcess(child, force) {
  if (!child || typeof child.kill !== "function") return;
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch (_) {
    // The process may already have exited between the state check and kill.
  }
}

class WgRelaySidecar extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn || defaultSpawn;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.appRoot = options.appRoot || path.join(__dirname, "..");
    this.resourcesPath = options.resourcesPath || process.resourcesPath;
    this.isPackaged = Boolean(options.isPackaged);
    this.startupTimeoutMs = options.startupTimeoutMs || 15_000;
    this.stopTimeoutMs = options.stopTimeoutMs || 2_000;
    this.forceKillTimeoutMs = options.forceKillTimeoutMs || 1_000;
    this.maxStdoutBytes = options.maxStdoutBytes || 64 * 1024;
    this.maxStderrBytes = options.maxStderrBytes || 64 * 1024;
    this.maxStatusLineBytes = options.maxStatusLineBytes || DEFAULT_MAX_STATUS_LINE_BYTES;
    this.maxStatusLines = options.maxStatusLines || 32;
    this.maxStderrLines = options.maxStderrLines || 64;
    this.killProcess = options.killProcess || defaultKillProcess;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this._generation = 0;
    this._attempt = null;
    this._startPromise = null;
    this._queuedStartPromise = null;
    this._stopPromise = null;
    this._status = "idle";
    this._disposed = false;
  }

  get status() {
    return this._status;
  }

  start(config) {
    if (this._disposed) return Promise.reject(codedError("sidecar_disposed"));
    if (this._startPromise) return this._startPromise;
    if (this._stopPromise) {
      if (this._queuedStartPromise) return this._queuedStartPromise;
      const queued = this._stopPromise.then(
        () => {
          if (this._queuedStartPromise === queued) this._queuedStartPromise = null;
          return this.start(config);
        },
        (error) => {
          if (this._queuedStartPromise === queued) this._queuedStartPromise = null;
          throw error;
        },
      );
      this._queuedStartPromise = queued;
      return queued;
    }

    const generation = ++this._generation;
    let resolveStart;
    let rejectStart;
    const startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this._startPromise = startPromise;
    this._status = "starting";

    const attempt = {
      generation,
      child: null,
      readySeen: false,
      failed: false,
      expectedStop: false,
      cleaned: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      statusLines: 0,
      stderrLines: 0,
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
      startupTimer: null,
      resolveStart,
      rejectStart,
      startSettled: false,
      exitSettled: false,
      exitPromise: null,
      resolveExit: null,
      listeners: null,
    };
    attempt.exitPromise = new Promise((resolve) => { attempt.resolveExit = resolve; });
    this._attempt = attempt;

    let child;
    try {
      const executable = sidecarPathFor({
        platform: this.platform,
        arch: this.arch,
        isPackaged: this.isPackaged,
        appRoot: this.appRoot,
        resourcesPath: this.resourcesPath,
      });
      child = this.spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: minimalEnvironment(this.platform),
      });
      attempt.child = child;
      this._attach(attempt);

      let serialized;
      try {
        serialized = JSON.stringify(config);
      } catch (_) {
        throw codedError("sidecar_invalid_config");
      }
      if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
        throw codedError("sidecar_invalid_config");
      }
      child.stdin.end(`${serialized}\n`);
      serialized = undefined;
      attempt.startupTimer = this.setTimeout(() => {
        this._fail(attempt, "sidecar_startup_timeout");
      }, this.startupTimeoutMs);
    } catch (error) {
      const code = error && error.code === "sidecar_invalid_config"
        ? error.code
        : "sidecar_spawn_failed";
      queueMicrotask(() => this._fail(attempt, code));
    }

    return startPromise;
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    const attempt = this._attempt;
    if (!attempt) {
      this._status = "idle";
      return Promise.resolve();
    }

    ++this._generation;
    attempt.expectedStop = true;
    this._status = "stopping";
    if (!attempt.startSettled) {
      attempt.startSettled = true;
      attempt.rejectStart(codedError("sidecar_start_cancelled"));
    }
    if (this._attempt === attempt) this._startPromise = null;

    const stopping = this._terminate(attempt).then(() => {
      this._cleanup(attempt);
      this._status = "idle";
    });
    this._stopPromise = stopping.finally(() => {
      if (this._stopPromise === wrapped) this._stopPromise = null;
    });
    const wrapped = this._stopPromise;
    return wrapped;
  }

  dispose() {
    if (this._disposed) return this._stopPromise || Promise.resolve();
    this._disposed = true;
    return this.stop().finally(() => this.removeAllListeners());
  }

  _isCurrent(attempt) {
    return !attempt.cleaned && this._attempt === attempt;
  }

  _attach(attempt) {
    const { child } = attempt;
    const onStdout = (chunk) => this._onStdout(attempt, chunk);
    const onStderr = (chunk) => this._onStderr(attempt, chunk);
    const onError = () => this._fail(attempt, "sidecar_spawn_failed");
    const onExit = () => this._onExit(attempt);
    attempt.listeners = { onStdout, onStderr, onError, onExit };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  }

  _onStdout(attempt, chunk) {
    if (!this._isCurrent(attempt) || attempt.expectedStop) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    attempt.stdoutBytes += data.length;
    if (attempt.stdoutBytes > this.maxStdoutBytes) {
      this._fail(attempt, "sidecar_output_limit");
      return;
    }
    attempt.stdoutBuffer = Buffer.concat([attempt.stdoutBuffer, data]);

    let newline;
    while ((newline = attempt.stdoutBuffer.indexOf(0x0a)) !== -1) {
      const line = attempt.stdoutBuffer.subarray(0, newline);
      attempt.stdoutBuffer = attempt.stdoutBuffer.subarray(newline + 1);
      attempt.statusLines += 1;
      if (attempt.statusLines > this.maxStatusLines || line.length > this.maxStatusLineBytes) {
        this._fail(attempt, "sidecar_output_limit");
        return;
      }
      if (line.length === 0) {
        this._fail(attempt, "sidecar_protocol_error");
        return;
      }
      let status;
      try {
        status = parseStatusLine(line.toString("utf8"), { maxBytes: this.maxStatusLineBytes });
      } catch (error) {
        this._fail(attempt, error.code || "sidecar_protocol_error");
        return;
      }
      this._onStatus(attempt, status);
      if (attempt.failed || attempt.expectedStop) return;
    }
    if (attempt.stdoutBuffer.length > this.maxStatusLineBytes) {
      this._fail(attempt, "sidecar_output_limit");
    }
  }

  _onStderr(attempt, chunk) {
    if (!this._isCurrent(attempt) || attempt.expectedStop) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    attempt.stderrBytes += data.length;
    if (attempt.stderrBytes > this.maxStderrBytes) {
      this._fail(attempt, "sidecar_output_limit");
      return;
    }
    attempt.stderrBuffer = Buffer.concat([attempt.stderrBuffer, data]);
    let newline;
    while ((newline = attempt.stderrBuffer.indexOf(0x0a)) !== -1) {
      attempt.stderrBuffer = attempt.stderrBuffer.subarray(newline + 1);
      attempt.stderrLines += 1;
      if (attempt.stderrLines > this.maxStderrLines) {
        this._fail(attempt, "sidecar_output_limit");
        return;
      }
      this.log("wg-relay sidecar stderr suppressed");
    }
    if (attempt.stderrBuffer.length > this.maxStatusLineBytes) {
      this._fail(attempt, "sidecar_output_limit");
    }
  }

  _onStatus(attempt, status) {
    if (!this._isCurrent(attempt)) return;
    if (status.type === "error") {
      this._fail(attempt, status.errorCode);
      return;
    }
    if (attempt.readySeen) {
      this._fail(attempt, "duplicate_ready");
      return;
    }
    attempt.readySeen = true;
    this.clearTimeout(attempt.startupTimer);
    attempt.startupTimer = null;
    this._status = "ready";
    if (!attempt.startSettled) {
      attempt.startSettled = true;
      attempt.resolveStart({ listen: status.listen, generation: attempt.generation });
    }
  }

  _onExit(attempt) {
    if (!attempt.exitSettled) {
      attempt.exitSettled = true;
      attempt.resolveExit();
    }
    if (!this._isCurrent(attempt)) return;
    if (attempt.expectedStop || attempt.failed) return;
    if (attempt.stdoutBuffer.length > 0) {
      this._fail(attempt, "sidecar_protocol_error", { terminate: false });
      return;
    }
    this._fail(attempt, "sidecar_unexpected_exit", { terminate: false });
  }

  _fail(attempt, code, options = {}) {
    if (!this._isCurrent(attempt) || attempt.expectedStop || attempt.failed) return;
    const stableCode = normalizeSidecarErrorCode(code);
    attempt.failed = true;
    this.clearTimeout(attempt.startupTimer);
    attempt.startupTimer = null;
    this._status = "failed";
    const wasReady = attempt.readySeen;
    if (!attempt.startSettled) {
      attempt.startSettled = true;
      attempt.rejectStart(codedError(stableCode));
    }
    if (wasReady) {
      this.emit("failure", { errorCode: stableCode, generation: attempt.generation });
    }
    if (this._attempt === attempt) this._startPromise = null;
    if (options.terminate === false) {
      this._cleanup(attempt);
    } else {
      attempt.expectedStop = true;
      void this._terminate(attempt).then(() => this._cleanup(attempt));
    }
  }

  async _terminate(attempt) {
    if (!attempt.child || attempt.exitSettled) return;
    this.killProcess(attempt.child, false, this.platform);
    if (await this._waitForExit(attempt, this.stopTimeoutMs)) return;
    this.killProcess(attempt.child, true, this.platform);
    await this._waitForExit(attempt, this.forceKillTimeoutMs);
  }

  _waitForExit(attempt, timeoutMs) {
    if (attempt.exitSettled) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        this.clearTimeout(timer);
        resolve(exited);
      };
      const timer = this.setTimeout(() => finish(false), timeoutMs);
      attempt.exitPromise.then(() => finish(true));
    });
  }

  _cleanup(attempt) {
    if (attempt.cleaned) return;
    attempt.cleaned = true;
    this.clearTimeout(attempt.startupTimer);
    attempt.startupTimer = null;
    const { child, listeners } = attempt;
    if (child && listeners) {
      child.stdout.off("data", listeners.onStdout);
      child.stderr.off("data", listeners.onStderr);
      child.off("error", listeners.onError);
      child.off("exit", listeners.onExit);
    }
    attempt.stdoutBuffer = Buffer.alloc(0);
    attempt.stderrBuffer = Buffer.alloc(0);
    attempt.child = null;
    attempt.listeners = null;
    if (this._attempt === attempt) {
      this._attempt = null;
      this._startPromise = null;
    }
  }
}

module.exports = {
  WgRelaySidecar,
  parseStatusLine,
  sidecarPathFor,
};

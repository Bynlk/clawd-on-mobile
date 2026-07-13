"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const WG_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
let temporarySequence = 0;

class ManagementRequestError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = "ManagementRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function codedError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw signal.reason || codedError("operation_aborted");
}

function normalizeRemoteAddress(address) {
  if (typeof address !== "string") return "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return mapped ? mapped[1] : address;
}

function timingSafeStringEqual(submitted, expected) {
  if (typeof submitted !== "string" || typeof expected !== "string") return false;
  const left = crypto.createHash("sha256").update(submitted, "utf8").digest();
  const right = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function parseBearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : null;
}

function validateWireGuardKey(name, value) {
  if (typeof value !== "string" || !WG_KEY_PATTERN.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function replacePhonePeer(config, oldPublicKey, newPublicKey, phoneIp) {
  const blocks = String(config).trimEnd().split(/\n(?=\[)/);
  let replacements = 0;
  const next = blocks.map((block) => {
    if (!block.startsWith("[Peer]\n")) return block;
    const allowed = [...block.matchAll(/^AllowedIPs\s*=\s*(\S+)\s*$/gm)];
    if (!allowed.some((match) => match[1] === `${phoneIp}/32`)) return block;
    const publicKeys = [...block.matchAll(/^PublicKey\s*=\s*(\S+)\s*$/gm)];
    if (allowed.length !== 1 || publicKeys.length !== 1) {
      throw new Error("phone peer contains duplicate directives");
    }
    if (publicKeys[0][1] !== oldPublicKey) throw new Error("phone peer does not match key file");
    replacements++;
    return block.replace(/^PublicKey\s*=\s*\S+\s*$/m, `PublicKey = ${newPublicKey}`);
  });
  if (replacements !== 1) throw new Error("phone peer must appear exactly once");
  return `${next.join("\n")}\n`;
}

function atomicWriteFile(fs, destination, contents, label) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${label}-${process.pid}-${temporarySequence++}`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    if (typeof fs.fchmodSync === "function") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    if (typeof fs.fsyncSync === "function") {
      let directoryDescriptor = null;
      try {
        directoryDescriptor = fs.openSync(path.dirname(destination), "r");
        fs.fsyncSync(directoryDescriptor);
      } finally {
        if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function defaultCommand(file, args, { input = "", timeoutMs = 5000, signal } = {}) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4096) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4096) child.kill("SIGKILL");
    });
    child.once("error", () => finish(new Error("WireGuard command failed")));
    child.once("close", (code) => {
      if (aborted) finish(signal.reason || codedError("operation_aborted"));
      else if (timedOut) finish(Object.assign(new Error("WireGuard command timed out"), { code: "command_timeout" }));
      else if (code === 0) finish(null, { stdout });
      else finish(new Error("WireGuard command failed"));
    });
    child.stdin.end(input);
  });
}

function createWgManagement({
  fs = nodeFs,
  command = defaultCommand,
  generateKeyPair,
  generateRelayToken = () => crypto.randomBytes(32).toString("hex"),
  tokenStore,
  pairs,
  paths,
  wgInterface,
  pcIp,
  phoneIp,
  subnet,
  endpoint,
  lock = null,
  verifyLivePeer = null,
  commandTimeoutMs = 5000,
  transactionTimeoutMs = 15000,
} = {}) {
  if (!tokenStore || typeof tokenStore.current !== "function" ||
      typeof tokenStore.managementToken !== "function" || typeof tokenStore.rotate !== "function") {
    throw new Error("tokenStore is required");
  }
  if (!pairs || typeof pairs.closeToken !== "function") throw new Error("pairs is required");
  if (!paths || !paths.wgConfigPath || !paths.phonePrivateKeyPath ||
      !paths.phonePublicKeyPath || !paths.serverPublicKeyPath) throw new Error("management paths are required");
  if (![wgInterface, pcIp, phoneIp, subnet, endpoint].every((value) => typeof value === "string" && value)) {
    throw new Error("WireGuard management configuration is required");
  }
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0 ||
      !Number.isFinite(transactionTimeoutMs) || transactionTimeoutMs <= 0) {
    throw new Error("invalid management timeout");
  }
  const transactionLock = lock || tokenStore.lock || Object.freeze({
    async runExclusive(operation) { return operation(); },
  });
  if (typeof transactionLock.runExclusive !== "function") throw new Error("management lock is required");

  function runCommand(file, args, options = {}) {
    throwIfAborted(options.signal);
    return command(file, args, { ...options, timeoutMs: commandTimeoutMs });
  }

  const makeKeyPair = generateKeyPair || (async ({ signal } = {}) => {
    const privateResult = await runCommand("wg", ["genkey"], { signal });
    const privateKey = String(privateResult.stdout || "").trim();
    const publicResult = await runCommand("wg", ["pubkey"], { input: `${privateKey}\n`, signal });
    return { privateKey, publicKey: String(publicResult.stdout || "").trim() };
  });

  function authorize({ remoteAddress, authorization }) {
    if (normalizeRemoteAddress(remoteAddress) !== pcIp) throw new ManagementRequestError(403, "forbidden_source");
    const submitted = parseBearer(authorization);
    if (!timingSafeStringEqual(submitted, tokenStore.managementToken())) {
      throw new ManagementRequestError(401, "authentication_failed");
    }
  }

  function validateBody(body) {
    if (!body || Object.getPrototypeOf(body) !== Object.prototype ||
        Object.keys(body).length !== 1 || body.version !== 1) {
      throw new ManagementRequestError(400, "invalid_request");
    }
  }

  let healthy = true;
  let recovery = null;

  async function defaultVerifyLivePeer(candidate) {
    const result = await runCommand("wg", ["show", wgInterface, "allowed-ips"], {
      signal: candidate.signal,
    });
    const peers = new Map();
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      const match = /^(\S+)\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      if (peers.has(match[1])) return false;
      peers.set(match[1], match[2].split(/\s*,\s*/).filter(Boolean));
    }
    const oldAllowedIps = peers.get(candidate.oldPublicKey) || [];
    return oldAllowedIps.length === 1 && oldAllowedIps[0] === `${phoneIp}/32` &&
      !peers.has(candidate.publicKey);
  }
  const verifyPeer = verifyLivePeer || defaultVerifyLivePeer;

  async function compensate(candidate, attempts) {
    const failures = [];
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(codedError("rollback_timeout"));
    }, transactionTimeoutMs);
    try {
      if (attempts.filesAttempted) {
        for (const [destination, contents] of [
          [paths.wgConfigPath, candidate.oldConfig],
          [paths.phonePrivateKeyPath, candidate.oldPrivateKey],
          [paths.phonePublicKeyPath, candidate.oldPublicKeyFile],
        ]) {
          try {
            atomicWriteFile(fs, destination, contents, "rollback");
            if (fs.readFileSync(destination, "utf8") !== contents) {
              throw new Error("rollback verification mismatch");
            }
          } catch (error) { failures.push(error); }
        }
      }
      if (attempts.liveAttempted) {
        try {
          await runCommand("wg", [
            "set", wgInterface,
            "peer", candidate.publicKey, "remove",
            "peer", candidate.oldPublicKey, "allowed-ips", `${phoneIp}/32`,
          ], { signal: controller.signal });
        } catch (error) { failures.push(error); }
        try {
          throwIfAborted(controller.signal);
          const verified = await verifyPeer({
            ...candidate, wgInterface, phoneIp, signal: controller.signal,
          });
          if (verified !== true) throw new Error("live peer verification mismatch");
        } catch (error) { failures.push(error); }
      }
      if (attempts.tokenAttempted) {
        try {
          const diskToken = typeof tokenStore.reload === "function"
            ? await tokenStore.reload({ lockHeld: true })
            : tokenStore.current();
          if (diskToken === candidate.relayToken) {
            await tokenStore.restore(candidate.oldRelayToken, candidate.relayToken, { lockHeld: true });
          } else if (diskToken !== candidate.oldRelayToken) {
            throw new Error("token rollback CAS mismatch");
          }
        } catch (error) { failures.push(error); }
      }
      if (attempts.tokenAttempted && typeof tokenStore.reload === "function") {
        try { await tokenStore.reload({ lockHeld: true }); } catch (error) { failures.push(error); }
      }
      if (tokenStore.current() !== candidate.oldRelayToken) {
        failures.push(new Error("token rollback mismatch"));
      }
      return failures;
    } finally {
      clearTimeout(timer);
    }
  }

  async function status(context) {
    authorize(context);
    if (!healthy) {
      if (!recovery) throw new ManagementRequestError(503, "rollback_failed");
      await transactionLock.runExclusive(async () => {
        const failures = await compensate(recovery.candidate, recovery.attempts);
        if (failures.length) throw new ManagementRequestError(503, "rollback_failed");
        healthy = true;
        recovery = null;
      });
    }
    return { version: 1, status: "ok" };
  }

  async function executeRotation(context, signal) {
    authorize(context);
    validateBody(context.body);
    if (!healthy) throw new ManagementRequestError(503, "rollback_failed");

    let candidate;
    try {
      throwIfAborted(signal);
      const keyPair = await makeKeyPair({ signal });
      throwIfAborted(signal);
      const privateKey = validateWireGuardKey("phone private key", keyPair.privateKey);
      const publicKey = validateWireGuardKey("phone public key", keyPair.publicKey);
      const relayToken = String(generateRelayToken()).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(relayToken) || relayToken === tokenStore.managementToken().toLowerCase()) {
        throw new Error("generated Relay token is invalid");
      }
      const oldConfig = fs.readFileSync(paths.wgConfigPath, "utf8");
      const oldPrivateKey = fs.readFileSync(paths.phonePrivateKeyPath, "utf8");
      const oldPublicKeyFile = fs.readFileSync(paths.phonePublicKeyPath, "utf8");
      const oldPublicKey = validateWireGuardKey("old phone public key", oldPublicKeyFile.trim());
      const serverPublicKey = validateWireGuardKey(
        "server public key",
        fs.readFileSync(paths.serverPublicKeyPath, "utf8").trim()
      );
      candidate = {
        privateKey,
        publicKey,
        relayToken,
        oldRelayToken: tokenStore.current(),
        oldConfig,
        oldPrivateKey,
        oldPublicKeyFile,
        oldPublicKey,
        serverPublicKey,
        newConfig: replacePhonePeer(oldConfig, oldPublicKey, publicKey, phoneIp),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error("rotation_failed");
    }

    let filesAttempted = false;
    let liveAttempted = false;
    let tokenAttempted = false;
    try {
      throwIfAborted(signal);
      filesAttempted = true;
      atomicWriteFile(fs, paths.wgConfigPath, candidate.newConfig, "tmp");
      throwIfAborted(signal);
      atomicWriteFile(fs, paths.phonePrivateKeyPath, `${candidate.privateKey}\n`, "tmp");
      throwIfAborted(signal);
      atomicWriteFile(fs, paths.phonePublicKeyPath, `${candidate.publicKey}\n`, "tmp");

      throwIfAborted(signal);
      liveAttempted = true;
      await runCommand("wg", [
        "set", wgInterface,
        "peer", candidate.oldPublicKey, "remove",
        "peer", candidate.publicKey, "allowed-ips", `${phoneIp}/32`,
      ], { signal });

      throwIfAborted(signal);
      tokenAttempted = true;
      await tokenStore.rotate(candidate.relayToken, candidate.oldRelayToken, { lockHeld: true });
      throwIfAborted(signal);
      pairs.closeToken(candidate.oldRelayToken, 4003, "token_rotated");
    } catch (cause) {
      const attempts = { filesAttempted, liveAttempted, tokenAttempted };
      const failures = await compensate(candidate, attempts);
      if (failures.length) {
        healthy = false;
        recovery = { candidate, attempts };
        throw new ManagementRequestError(503, "rollback_failed");
      }
      if (signal.aborted) throw signal.reason;
      const error = new Error("rotation_failed");
      error.code = "rotation_failed";
      throw error;
    }

    const phoneConfig = `[Interface]\n` +
      `PrivateKey = ${candidate.privateKey}\n` +
      `Address = ${phoneIp}/32\n\n` +
      `[Peer]\n` +
      `PublicKey = ${candidate.serverPublicKey}\n` +
      `Endpoint = ${endpoint}\n` +
      `AllowedIPs = ${subnet}\n` +
      `PersistentKeepalive = 25`;
    return { version: 1, phoneConfig, relayToken: candidate.relayToken };
  }

  let acceptingRotations = true;
  let activeController = null;
  let activeTimer = null;
  let rotationQueue = Promise.resolve();
  let shutdownPromise = null;

  function rotatePhone(context) {
    if (!acceptingRotations) return Promise.reject(new ManagementRequestError(503, "shutdown_in_progress"));
    const operation = rotationQueue.then(async () => {
      if (!acceptingRotations) throw new ManagementRequestError(503, "shutdown_in_progress");
      const controller = new AbortController();
      activeController = controller;
      const timer = setTimeout(() => {
        controller.abort(new ManagementRequestError(504, "transaction_timeout"));
      }, transactionTimeoutMs);
      activeTimer = timer;
      try {
        return await transactionLock.runExclusive(
          () => executeRotation(context, controller.signal),
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
        if (activeController === controller) activeController = null;
        if (activeTimer === timer) activeTimer = null;
      }
    });
    rotationQueue = operation.catch(() => {});
    return operation;
  }

  function shutdown({ deadlineMs = 2000 } = {}) {
    if (shutdownPromise) return shutdownPromise;
    acceptingRotations = false;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(new ManagementRequestError(503, "shutdown_in_progress"));
    }
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    shutdownPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        healthy = false;
        reject(new ManagementRequestError(503, "shutdown_failed"));
      }, deadlineMs);
      rotationQueue.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
    return shutdownPromise;
  }

  return Object.freeze({
    authorize,
    status,
    rotatePhone,
    shutdown,
    isHealthy: () => healthy,
    transactionTimeoutMs,
  });
}

module.exports = {
  ManagementRequestError,
  createWgManagement,
  defaultCommand,
  normalizeRemoteAddress,
  replacePhonePeer,
};

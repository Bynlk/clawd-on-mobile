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

function defaultCommand(file, args, { input = "", timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      if (timedOut) finish(Object.assign(new Error("WireGuard command timed out"), { code: "command_timeout" }));
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
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) throw new Error("invalid command timeout");
  const transactionLock = lock || tokenStore.lock || Object.freeze({
    async runExclusive(operation) { return operation(); },
  });
  if (typeof transactionLock.runExclusive !== "function") throw new Error("management lock is required");

  function withDeadline(operation, code = "command_timeout") {
    let timer;
    return Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), commandTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function runCommand(file, args, options = {}) {
    return withDeadline(() => command(file, args, { ...options, timeoutMs: commandTimeoutMs }));
  }

  const makeKeyPair = generateKeyPair || (async () => {
    const privateResult = await runCommand("wg", ["genkey"]);
    const privateKey = String(privateResult.stdout || "").trim();
    const publicResult = await runCommand("wg", ["pubkey"], { input: `${privateKey}\n` });
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
    const result = await runCommand("wg", ["show", wgInterface, "peers"]);
    const peers = String(result.stdout || "").trim().split(/\s+/).filter(Boolean);
    return peers.includes(candidate.oldPublicKey) && !peers.includes(candidate.publicKey);
  }
  const verifyPeer = verifyLivePeer || defaultVerifyLivePeer;

  async function compensate(candidate, attempts) {
    const failures = [];
    if (attempts.filesAttempted) {
      for (const [destination, contents] of [
        [paths.wgConfigPath, candidate.oldConfig],
        [paths.phonePrivateKeyPath, candidate.oldPrivateKey],
        [paths.phonePublicKeyPath, candidate.oldPublicKeyFile],
      ]) {
        try {
          atomicWriteFile(fs, destination, contents, "rollback");
          if (fs.readFileSync(destination, "utf8") !== contents) throw new Error("rollback verification mismatch");
        } catch (error) { failures.push(error); }
      }
    }
    if (attempts.liveAttempted) {
      try {
        await runCommand("wg", [
          "set", wgInterface,
          "peer", candidate.publicKey, "remove",
          "peer", candidate.oldPublicKey, "allowed-ips", `${phoneIp}/32`,
        ]);
      } catch (error) { failures.push(error); }
      try {
        const verified = await withDeadline(() => verifyPeer({
          ...candidate, wgInterface, phoneIp,
        }), "verification_timeout");
        if (verified !== true) throw new Error("live peer verification mismatch");
      } catch (error) { failures.push(error); }
    }
    if (attempts.tokenAttempted && tokenStore.current() !== candidate.oldRelayToken) {
      try {
        await tokenStore.restore(candidate.oldRelayToken, candidate.relayToken, { lockHeld: true });
      } catch (error) { failures.push(error); }
    }
    if (tokenStore.current() !== candidate.oldRelayToken) failures.push(new Error("token rollback mismatch"));
    return failures;
  }

  async function status(context) {
    authorize(context);
    if (!healthy) {
      await transactionLock.runExclusive(async () => {
        const failures = await compensate(recovery.candidate, recovery.attempts);
        if (failures.length) throw new ManagementRequestError(503, "rollback_failed");
        healthy = true;
        recovery = null;
      });
    }
    return { version: 1, status: "ok" };
  }

  async function executeRotation(context) {
    authorize(context);
    validateBody(context.body);
    if (!healthy) throw new ManagementRequestError(503, "rollback_failed");

    let candidate;
    try {
      const keyPair = await withDeadline(() => makeKeyPair());
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
    } catch {
      throw new Error("rotation_failed");
    }

    let filesAttempted = false;
    let liveAttempted = false;
    let tokenAttempted = false;
    try {
      filesAttempted = true;
      atomicWriteFile(fs, paths.wgConfigPath, candidate.newConfig, "tmp");
      atomicWriteFile(fs, paths.phonePrivateKeyPath, `${candidate.privateKey}\n`, "tmp");
      atomicWriteFile(fs, paths.phonePublicKeyPath, `${candidate.publicKey}\n`, "tmp");

      liveAttempted = true;
      await runCommand("wg", [
        "set", wgInterface,
        "peer", candidate.oldPublicKey, "remove",
        "peer", candidate.publicKey, "allowed-ips", `${phoneIp}/32`,
      ]);

      tokenAttempted = true;
      await tokenStore.rotate(candidate.relayToken, candidate.oldRelayToken, { lockHeld: true });
      pairs.closeToken(candidate.oldRelayToken, 4003, "token_rotated");
    } catch {
      const attempts = { filesAttempted, liveAttempted, tokenAttempted };
      const failures = await compensate(candidate, attempts);
      if (failures.length) {
        healthy = false;
        recovery = { candidate, attempts };
        throw new ManagementRequestError(503, "rollback_failed");
      }
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

  let rotationQueue = Promise.resolve();
  function rotatePhone(context) {
    const operation = rotationQueue.then(() => transactionLock.runExclusive(() => executeRotation(context)));
    rotationQueue = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({ authorize, status, rotatePhone, isHealthy: () => healthy });
}

module.exports = {
  ManagementRequestError,
  createWgManagement,
  defaultCommand,
  normalizeRemoteAddress,
  replacePhonePeer,
};

#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const {
  INNER_PROTOCOL_MAX,
  RELAY_ENVELOPE_MAX,
  RelayPairRegistry,
} = require("./pair-registry");
const { createFlockLock, createRelayTokenStore } = require("./relay-token-store");
const { createWgManagement } = require("./wg-management");

const MAX_WS_PAYLOAD = RELAY_ENVELOPE_MAX;
const RATE_LIMIT_ATTEMPTS = 120;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PREAUTH_MAX_SOURCES = 4096;
const RATE_LIMIT_MAX_SOURCES = 4096;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const MAX_MANAGEMENT_BODY = 4096;

function defaultLog(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : null;
}

function timingSafeStringEqual(submitted, expected) {
  if (typeof submitted !== "string" || typeof expected !== "string") return false;
  const left = crypto.createHash("sha256").update(submitted, "utf8").digest();
  const right = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function createRelayServer({
  bindAddr,
  port,
  tokenStore,
  management = null,
  log = defaultLog,
  now = Date.now,
  remoteAddressOf = (req) => req.socket.remoteAddress || "",
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  requestDeadlineMs = 5000,
  closeDeadlineMs = 2000,
  rateLimitAttempts = RATE_LIMIT_ATTEMPTS,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  rateLimitMaxSources = RATE_LIMIT_MAX_SOURCES,
  preAuthRateLimitAttempts = RATE_LIMIT_ATTEMPTS,
  preAuthRateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
} = {}) {
  if (typeof bindAddr !== "string" || !bindAddr) throw new Error("bindAddr is required");
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
    throw new Error("valid port is required");
  }
  if (!tokenStore || typeof tokenStore.current !== "function") throw new Error("tokenStore is required");
  if (typeof log !== "function" || typeof now !== "function" || typeof remoteAddressOf !== "function") {
    throw new Error("invalid Relay dependency");
  }
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs > HEARTBEAT_INTERVAL_MS) {
    throw new Error("heartbeatIntervalMs must be between 1 and 30000");
  }
  if (!Number.isFinite(requestDeadlineMs) || requestDeadlineMs <= 0 ||
      !Number.isFinite(closeDeadlineMs) || closeDeadlineMs <= 0) {
    throw new Error("request and close deadlines must be positive");
  }
  if (!Number.isInteger(rateLimitAttempts) || rateLimitAttempts <= 0 ||
      !Number.isFinite(rateLimitWindowMs) || rateLimitWindowMs <= 0 ||
      !Number.isInteger(rateLimitMaxSources) || rateLimitMaxSources <= 0) {
    throw new Error("invalid rate limit");
  }
  if (!Number.isInteger(preAuthRateLimitAttempts) || preAuthRateLimitAttempts <= 0 ||
      !Number.isFinite(preAuthRateLimitWindowMs) || preAuthRateLimitWindowMs <= 0) {
    throw new Error("invalid pre-auth rate limit");
  }

  const pairs = new RelayPairRegistry();
  const startedAt = now();
  const attemptsBySource = new Map();
  const preAuthAttemptsBySource = new Map();
  let heartbeatTimer = null;
  let listening = false;
  let listenPromise = null;
  let closing = null;
  const sockets = new Set();

  function json(res, statusCode, body) {
    if (res.destroyed || res.writableEnded) return;
    const encoded = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(encoded),
      "Cache-Control": "no-store",
    });
    res.end(encoded);
  }

  function handleHttp(req, res) {
    const url = new URL(req.url, "http://relay.internal");
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        version: 1,
        status: "ok",
        uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      });
      return;
    }
    if (management && req.method === "GET" && url.pathname === "/api/manage/status") {
      Promise.resolve().then(() => management.status({
        remoteAddress: remoteAddressOf(req),
        authorization: req.headers.authorization,
      })).then((result) => json(res, 200, result), (error) => {
        json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, {
          error: error.code || "management_failed",
        });
      });
      return;
    }
    if (management && req.method === "POST" && url.pathname === "/api/manage/phone/rotate") {
      const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        json(res, 415, { error: "unsupported_media_type" });
        req.resume();
        return;
      }
      readJsonBody(req).then((body) => management.rotatePhone({
        remoteAddress: remoteAddressOf(req),
        authorization: req.headers.authorization,
        body,
      })).then((result) => json(res, 200, result), (error) => {
        json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, {
          error: error.code || (error.message === "request_too_large" ? "request_too_large" : "management_failed"),
        });
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const declaredLength = Number(req.headers["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_MANAGEMENT_BODY) {
        const error = new Error("request_too_large");
        error.statusCode = 413;
        error.code = "request_too_large";
        req.resume();
        reject(error);
        return;
      }
      let size = 0;
      const chunks = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        req.resume();
        const error = new Error("request_timeout");
        error.statusCode = 408;
        error.code = "request_timeout";
        reject(error);
      }, requestDeadlineMs);
      const cleanup = () => {
        clearTimeout(timer);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onError);
      };
      const onError = (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause instanceof Error ? cause : new Error("request_aborted"));
      };
      const onData = (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_MANAGEMENT_BODY) {
          settled = true;
          cleanup();
          const error = new Error("request_too_large");
          error.statusCode = 413;
          error.code = "request_too_large";
          reject(error);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          const error = new Error("invalid_json");
          error.statusCode = 400;
          error.code = "invalid_json";
          reject(error);
        }
      };
      req.on("data", onData);
      req.on("end", onEnd);
      req.once("error", onError);
      req.once("aborted", onError);
    });
  }

  const server = http.createServer(handleHttp);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_ENVELOPE_MAX });

  function withinConnectionLimit(source) {
    const timestamp = now();
    for (const [key, value] of attemptsBySource) {
      if (timestamp >= value.resetAt) attemptsBySource.delete(key);
    }
    if (!attemptsBySource.has(source) && attemptsBySource.size >= rateLimitMaxSources) {
      attemptsBySource.delete(attemptsBySource.keys().next().value);
    }
    let entry = attemptsBySource.get(source);
    if (!entry || timestamp >= entry.resetAt) {
      entry = { attempts: 0, resetAt: timestamp + rateLimitWindowMs };
      attemptsBySource.set(source, entry);
    }
    entry.attempts++;
    return entry.attempts <= rateLimitAttempts;
  }

  function withinPreAuthLimit(source) {
    const timestamp = now();
    for (const [key, entry] of preAuthAttemptsBySource) {
      if (timestamp >= entry.resetAt) preAuthAttemptsBySource.delete(key);
    }
    if (!preAuthAttemptsBySource.has(source) && preAuthAttemptsBySource.size >= PREAUTH_MAX_SOURCES) {
      const oldest = preAuthAttemptsBySource.keys().next().value;
      preAuthAttemptsBySource.delete(oldest);
    }
    let entry = preAuthAttemptsBySource.get(source);
    if (!entry) {
      entry = { attempts: 0, resetAt: timestamp + preAuthRateLimitWindowMs };
      preAuthAttemptsBySource.set(source, entry);
    }
    entry.attempts++;
    return entry.attempts <= preAuthRateLimitAttempts;
  }

  function rejectUpgrade(socket, statusCode, code) {
    const reason = statusCode === 401 ? "Unauthorized" : statusCode === 429 ? "Too Many Requests" : "Forbidden";
    const body = JSON.stringify({ error: code });
    socket.end(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" + body
    );
  }

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://relay.internal");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/mobile/ws" && url.pathname !== "/ws") {
      rejectUpgrade(socket, 403, "forbidden_path");
      return;
    }
    const role = url.searchParams.get("role") || (url.pathname === "/mobile/ws" ? "phone" : null);
    if (role !== "pc" && role !== "phone") {
      rejectUpgrade(socket, 403, "invalid_role");
      return;
    }
    const submittedToken = bearerToken(req.headers.authorization);
    const currentToken = tokenStore.current();
    const source = remoteAddressOf(req);
    if (!timingSafeStringEqual(submittedToken, currentToken)) {
      if (!withinPreAuthLimit(source)) rejectUpgrade(socket, 429, "rate_limited");
      else rejectUpgrade(socket, 401, "authentication_failed");
      return;
    }
    if (!withinConnectionLimit(source)) {
      rejectUpgrade(socket, 429, "rate_limited");
      return;
    }
    req._relayAuth = { role, token: currentToken, source };
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://relay.internal");
    const role = req._relayAuth && req._relayAuth.role;
    const submittedToken = bearerToken(req.headers.authorization);
    const currentToken = req._relayAuth && req._relayAuth.token;

    if (!timingSafeStringEqual(submittedToken, currentToken)) {
      ws.close(4001, "authentication_failed");
      log("connection_rejected", { reason: "authentication_failed", remoteAddress: remoteAddressOf(req) });
      return;
    }
    if (role !== "pc" && role !== "phone") {
      ws.close(4000, "invalid_role");
      log("connection_rejected", { reason: "invalid_role", remoteAddress: remoteAddressOf(req) });
      return;
    }
    const { pair, replaced } = pairs.add(currentToken, role, ws);
    ws._token = currentToken;
    ws._role = role;
    ws._relayAlive = true;
    ws._relayAwaitingHeartbeat = false;
    ws._relayMissedHeartbeats = 0;
    log(replaced ? "connection_replaced" : "connection_established", {
      role,
      pcConnected: !!pair.pc,
      phoneConnected: !!pair.phone,
      remoteAddress: remoteAddressOf(req),
    });

    for (const peer of pairs.peers(currentToken, role)) {
      peer.send(JSON.stringify({ type: "peer_connected", role }));
    }

    ws.on("message", (data) => {
      if (!pairs.isCurrent(currentToken, role, ws)) return;
      const wireBytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
      const roleLimit = role === "phone" ? INNER_PROTOCOL_MAX : RELAY_ENVELOPE_MAX;
      if (wireBytes > roleLimit) {
        ws.close(1009, "message_too_large");
        return;
      }
      ws._relayAlive = true;
      ws._relayAwaitingHeartbeat = false;
      ws._relayMissedHeartbeats = 0;
      pairs.forward(currentToken, role, data, ws);
    });

    ws.on("close", () => {
      const relayClientId = role === "phone" ? pairs.clientIdFor(ws) : null;
      delete ws._relayAlive;
      delete ws._relayAwaitingHeartbeat;
      delete ws._relayMissedHeartbeats;
      const removal = pairs.remove(currentToken, role, ws);
      if (removal.removedCurrent && (!removal.pair || !removal.pair[role])) {
        for (const peer of pairs.peers(currentToken, role)) {
          if (relayClientId) {
            peer.send(JSON.stringify({ type: "relay_client_disconnected", sourceClientId: relayClientId }));
          }
          peer.send(JSON.stringify({ type: "peer_disconnected", role }));
        }
      }
      log("connection_closed", { role, remoteAddress: remoteAddressOf(req) });
    });

    ws.on("error", (error) => {
      log("connection_error", { role, error: error && error.message ? error.message : "websocket_error" });
    });
  });

  function listen() {
    if (listening) return Promise.resolve(api.address());
    if (listenPromise) return listenPromise;
    listenPromise = Promise.resolve()
      .then(() => management && typeof management.initialize === "function"
        ? management.initialize()
        : undefined)
      .then(() => new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(Number(port), bindAddr, () => {
          server.off("error", onError);
          listening = true;
          heartbeatTimer = setInterval(() => {
            for (const ws of wss.clients) {
              if (ws.readyState !== 1) continue;
              if (ws._relayAwaitingHeartbeat && ws._relayAlive === false) {
                ws._relayMissedHeartbeats = (ws._relayMissedHeartbeats || 0) + 1;
                if (ws._relayMissedHeartbeats >= 2) {
                  delete ws._relayAlive;
                  delete ws._relayAwaitingHeartbeat;
                  delete ws._relayMissedHeartbeats;
                  ws.terminate();
                  continue;
                }
              }
              try {
                ws._relayAlive = false;
                ws._relayAwaitingHeartbeat = true;
                ws.send(JSON.stringify({ type: "ping", timestamp: now() }));
              } catch {}
            }
          }, heartbeatIntervalMs);
          resolve(api.address());
        });
      })).catch((error) => {
        listenPromise = null;
        throw error;
      });
    return listenPromise;
  }

  function closeNetwork() {
    pairs.closeAll(1001, "server_shutdown");
    for (const ws of wss.clients) ws.terminate();
    if (!listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listening = false;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        const error = new Error("shutdown_failed");
        error.code = "shutdown_failed";
        finish(error);
      }, closeDeadlineMs);
      try { wss.close(() => {}); } catch {}
      server.close((error) => finish(error || null));
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    });
  }

  function close() {
    if (closing) return closing;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    closing = (async () => {
      let shutdownError = null;
      if (management && typeof management.shutdown === "function") {
        try {
          await management.shutdown({ deadlineMs: closeDeadlineMs });
        } catch (error) {
          shutdownError = error;
        }
      }
      try {
        await closeNetwork();
      } catch (error) {
        if (!shutdownError) shutdownError = error;
      }
      if (shutdownError) throw shutdownError;
    })();
    return closing;
  }

  const api = {
    listen,
    close,
    address: () => server.address(),
    pairs,
  };
  return api;
}

function createCliRelay(env = process.env) {
  const bindAddr = env.BIND_ADDR || "10.8.0.1";
  const port = Number(env.PORT || 7891);
  const envPath = env.RELAY_ENV_PATH || "/etc/clawd-relay/relay.env";
  let tokenStore;
  let management = null;
  let managementTarget = null;
  let managementLock = null;

  if (nodeFs.existsSync(envPath)) {
    const lockPath = env.RELAY_LOCK_PATH || "/run/lock/clawd-relay.lock";
    const expectedUid = env.CLAWD_INSTALL_TEST_MODE === "1" && typeof process.getuid === "function"
      ? process.getuid()
      : 0;
    managementLock = createFlockLock({ lockPath, expectedUid });
    tokenStore = createRelayTokenStore({ envPath, expectedUid, lock: managementLock });
    management = Object.freeze({
      initialize() { return managementTarget.initialize(); },
      status(context) { return managementTarget.status(context); },
      rotatePhone(context) { return managementTarget.rotatePhone(context); },
      shutdown(options) { return managementTarget.shutdown(options); },
      isHealthy() { return managementTarget.isHealthy(); },
    });
  } else if (env.ALLOW_LEGACY_EPHEMERAL_RELAY === "1" && /^[0-9a-fA-F]{64}$/.test(env.RELAY_TOKEN || "")) {
    tokenStore = Object.freeze({ current() { return env.RELAY_TOKEN; } });
  } else {
    throw new Error("persistent Relay environment is unavailable");
  }

  const relay = createRelayServer({ bindAddr, port, tokenStore, management });
  if (management) {
    const keyDirectory = env.WG_KEY_DIR || "/etc/wireguard/clawd";
    managementTarget = createWgManagement({
      tokenStore,
      pairs: relay.pairs,
      lock: managementLock,
      paths: {
        wgConfigPath: env.WG_CONFIG_PATH || "/etc/wireguard/clawd.conf",
        phonePrivateKeyPath: env.PHONE_PRIVATE_KEY_PATH || `${keyDirectory}/phone.key`,
        phonePublicKeyPath: env.PHONE_PUBLIC_KEY_PATH || `${keyDirectory}/phone.pub`,
        serverPublicKeyPath: env.SERVER_PUBLIC_KEY_PATH || `${keyDirectory}/server.pub`,
        journalPath: env.PHONE_ROTATION_JOURNAL_PATH || "/etc/clawd-relay/phone-rotation.journal",
      },
      wgInterface: env.WG_INTERFACE || "clawd",
      pcIp: env.PC_IP,
      phoneIp: env.PHONE_IP,
      subnet: env.WG_SUBNET,
      endpoint: env.WG_ENDPOINT,
    });
  }
  return relay;
}

function runCli(env = process.env, { processRef = process } = {}) {
  const bindAddr = env.BIND_ADDR || "10.8.0.1";
  const relay = createCliRelay(env);
  const started = relay.listen().then(() => {
    defaultLog("server_started", { bindAddr, port: relay.address().port });
    console.log(`[relay] 中继服务器启动在端口 ${relay.address().port} (ws://)`);
    return relay.address();
  }).catch((error) => {
    defaultLog("server_start_failed", { error: error.message });
    processRef.exitCode = 1;
    throw error;
  });

  const shutdown = (signal) => {
    defaultLog("shutdown_initiated", { signal });
    return relay.close().then(
      () => processRef.exit(0),
      () => processRef.exit(1)
    );
  };
  processRef.once("SIGTERM", () => shutdown("SIGTERM"));
  processRef.once("SIGINT", () => shutdown("SIGINT"));
  return { relay, started, shutdown };
}

module.exports = { createRelayServer, createCliRelay, runCli, bearerToken, timingSafeStringEqual };

if (require.main === module) {
  runCli();
}

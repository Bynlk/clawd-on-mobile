#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { RelayPairRegistry } = require("./pair-registry");
const { createRelayTokenStore } = require("./relay-token-store");
const { createWgManagement } = require("./wg-management");

const MAX_WS_PAYLOAD = 64 * 1024;
const RATE_LIMIT_ATTEMPTS = 120;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
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
} = {}) {
  if (typeof bindAddr !== "string" || !bindAddr) throw new Error("bindAddr is required");
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
    throw new Error("valid port is required");
  }
  if (!tokenStore || typeof tokenStore.current !== "function") throw new Error("tokenStore is required");
  if (typeof log !== "function" || typeof now !== "function" || typeof remoteAddressOf !== "function") {
    throw new Error("invalid Relay dependency");
  }

  const pairs = new RelayPairRegistry();
  const startedAt = now();
  let attempts = 0;
  let attemptsResetAt = startedAt + RATE_LIMIT_WINDOW_MS;
  let heartbeatTimer = null;
  let listening = false;
  let closing = null;

  function json(res, statusCode, body) {
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
      req.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_MANAGEMENT_BODY) {
          settled = true;
          const error = new Error("request_too_large");
          error.statusCode = 413;
          error.code = "request_too_large";
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          const error = new Error("invalid_json");
          error.statusCode = 400;
          error.code = "invalid_json";
          reject(error);
        }
      });
      req.once("error", reject);
    });
  }

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  function withinConnectionLimit() {
    const timestamp = now();
    if (timestamp >= attemptsResetAt) {
      attempts = 0;
      attemptsResetAt = timestamp + RATE_LIMIT_WINDOW_MS;
    }
    attempts++;
    return attempts <= RATE_LIMIT_ATTEMPTS;
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
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://relay.internal");
    const role = url.searchParams.get("role") || (url.pathname === "/mobile/ws" ? "phone" : null);
    const submittedToken = bearerToken(req.headers.authorization);
    const currentToken = tokenStore.current();

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
    if (!withinConnectionLimit()) {
      ws.close(4008, "rate_limited");
      log("connection_rejected", { reason: "rate_limited", role, remoteAddress: remoteAddressOf(req) });
      return;
    }

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const { pair, replaced } = pairs.add(currentToken, role, ws);
    ws._token = currentToken;
    ws._role = role;
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
      ws.isAlive = true;
      if (data.length <= MAX_WS_PAYLOAD) pairs.forward(currentToken, role, data, ws);
    });

    ws.on("close", () => {
      const relayClientId = role === "phone" ? pairs.clientIdFor(ws) : null;
      pairs.remove(currentToken, role, ws);
      for (const peer of pairs.peers(currentToken, role)) {
        if (relayClientId) {
          peer.send(JSON.stringify({ type: "relay_client_disconnected", sourceClientId: relayClientId }));
        }
        peer.send(JSON.stringify({ type: "peer_disconnected", role }));
      }
      log("connection_closed", { role, remoteAddress: remoteAddressOf(req) });
    });

    ws.on("error", (error) => {
      log("connection_error", { role, error: error && error.message ? error.message : "websocket_error" });
    });
  });

  function listen() {
    if (listening) return Promise.resolve(api.address());
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(Number(port), bindAddr, () => {
        server.off("error", onError);
        listening = true;
        heartbeatTimer = setInterval(() => {
          for (const ws of wss.clients) {
            if (ws.isAlive === false) {
              ws.terminate();
              continue;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch {}
          }
        }, HEARTBEAT_INTERVAL_MS);
        resolve(api.address());
      });
    });
  }

  function close() {
    if (closing) return closing;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    pairs.closeAll(1001, "server_shutdown");
    for (const ws of wss.clients) ws.terminate();
    if (!listening) return Promise.resolve();
    closing = new Promise((resolve, reject) => {
      wss.close(() => {
        server.close((error) => {
          listening = false;
          if (error) reject(error);
          else resolve();
        });
      });
    });
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

  if (nodeFs.existsSync(envPath)) {
    tokenStore = createRelayTokenStore({ envPath });
    management = Object.freeze({
      status(context) { return managementTarget.status(context); },
      rotatePhone(context) { return managementTarget.rotatePhone(context); },
    });
  } else if (/^[0-9a-fA-F]{64}$/.test(env.RELAY_TOKEN || "")) {
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
      paths: {
        wgConfigPath: env.WG_CONFIG_PATH || "/etc/wireguard/clawd.conf",
        phonePrivateKeyPath: env.PHONE_PRIVATE_KEY_PATH || `${keyDirectory}/phone.key`,
        phonePublicKeyPath: env.PHONE_PUBLIC_KEY_PATH || `${keyDirectory}/phone.pub`,
        serverPublicKeyPath: env.SERVER_PUBLIC_KEY_PATH || `${keyDirectory}/server.pub`,
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

module.exports = { createRelayServer, createCliRelay, bearerToken, timingSafeStringEqual };

if (require.main === module) {
  const BIND_ADDR = process.env.BIND_ADDR || "10.8.0.1";
  const relay = createCliRelay(process.env);

  relay.listen().then(() => {
    defaultLog("server_started", { bindAddr: BIND_ADDR, port: relay.address().port });
    console.log(`[relay] 中继服务器启动在端口 ${relay.address().port} (ws://)`);
  }).catch((error) => {
    defaultLog("server_start_failed", { error: error.message });
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    defaultLog("shutdown_initiated", { signal });
    relay.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

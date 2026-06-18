#!/usr/bin/env node
// relay/relay-server.js — 生产级 WebSocket 中继服务器
// 用法: node relay-server.js
// 环境变量:
//   PORT (默认 7891)
//   TOKEN — 连接 token（可选，不设则用 URL 参数）
//   ADMIN_TOKEN — REST API 管理 token（可选）
//   TLS_CERT — TLS 证书文件路径（可选）
//   TLS_KEY — TLS 私钥文件路径（可选）

const http = require("http");
const https = require("https");
const fs = require("fs");
const { WebSocketServer } = require("ws");

// --- 配置 ---
const PORT = process.env.PORT || 7891;
const FIXED_TOKEN = process.env.TOKEN || null;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const TLS_CERT = process.env.TLS_CERT || null;
const TLS_KEY = process.env.TLS_KEY || null;

// 限制参数
const MAX_MSG_SIZE = 64 * 1024;           // 64KB 单条消息上限
const RATE_LIMIT_MSGS = 120;               // 每 token 每分钟消息数
const RATE_LIMIT_WINDOW_MS = 60 * 1000;    // 1 分钟窗口
const REST_RATE_LIMIT = 10;                // REST API 每 IP 每分钟认证尝试
const REST_LOCKOUT_THRESHOLD = 5;          // 连续失败锁定阈值
const REST_LOCKOUT_MS = 5 * 60 * 1000;     // 锁定时长 5 分钟
const HEARTBEAT_INTERVAL_MS = 30 * 1000;   // 心跳间隔

// --- 状态 ---
const pairs = new Map();           // token → { pc: WebSocket, phone: WebSocket }
const rateLimits = new Map();      // token → { count, resetTime }
const restAttempts = new Map();    // ip → { fails, lockoutUntil }
let running = true;
let startTime = Date.now();

// --- 日志 ---
function log(event, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...data }));
}

// --- 速率限制 ---
function checkRateLimit(token) {
  const now = Date.now();
  let rl = rateLimits.get(token);
  if (!rl || now > rl.resetTime) {
    rl = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(token, rl);
  }
  rl.count++;
  return rl.count <= RATE_LIMIT_MSGS;
}

function checkRestRateLimit(ip) {
  const now = Date.now();
  let ra = restAttempts.get(ip);
  if (!ra) {
    ra = { fails: 0, lockoutUntil: 0 };
    restAttempts.set(ip, ra);
  }
  if (ra.lockoutUntil > now) return false;
  return true;
}

function recordRestFail(ip) {
  const now = Date.now();
  let ra = restAttempts.get(ip);
  if (!ra) {
    ra = { fails: 0, lockoutUntil: 0 };
    restAttempts.set(ip, ra);
  }
  ra.fails++;
  if (ra.fails >= REST_LOCKOUT_THRESHOLD) {
    ra.lockoutUntil = now + REST_LOCKOUT_MS;
    ra.fails = 0;
  }
}

function recordRestSuccess(ip) {
  const ra = restAttempts.get(ip);
  if (ra) ra.fails = 0;
}

// --- Token 验证 ---
function verifyAdminToken(req) {
  if (!ADMIN_TOKEN) return false; // 未设置 admin token 则拒绝管理接口访问
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7) === ADMIN_TOKEN;
  }
  // 也支持 body 中的 token（需要先读 body）
  return false;
}

function extractToken(url, req) {
  if (FIXED_TOKEN) return FIXED_TOKEN;
  let token = url.searchParams.get("token");
  if (!token) {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  return token;
}

function extractRole(url) {
  let role = url.searchParams.get("role");
  if (!role) {
    if (url.pathname === "/mobile/ws" || url.pathname === "/mobile/stream") {
      role = "phone";
    }
  }
  return role;
}

// --- REST API ---
function handleRestRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const ip = req.socket.remoteAddress || "unknown";

  // 健康检查（无需认证）
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pairs: pairs.size,
    }));
    return;
  }

  // 速率限制检查
  if (!checkRestRateLimit(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "请求过于频繁，请稍后再试" }));
    return;
  }

  // 状态查询
  if (req.method === "GET" && url.pathname === "/api/status") {
    let pcCount = 0, phoneCount = 0;
    for (const [, pair] of pairs) {
      if (pair.pc && pair.pc.readyState === 1) pcCount++;
      if (pair.phone && pair.phone.readyState === 1) phoneCount++;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: running ? "running" : "stopped",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pairs: pairs.size,
      connections: { pc: pcCount, phone: phoneCount },
    }));
    recordRestSuccess(ip);
    return;
  }

  // 停止/启动（需要 admin token）
  if (req.method === "POST" && (url.pathname === "/api/stop" || url.pathname === "/api/start")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (ADMIN_TOKEN && parsed.token !== ADMIN_TOKEN) {
          recordRestFail(ip);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "认证失败" }));
          return;
        }
        if (url.pathname === "/api/stop") {
          running = false;
          // 断开所有客户端
          for (const [token, pair] of pairs) {
            if (pair.pc) pair.pc.close(1001, "服务器暂停");
            if (pair.phone) pair.phone.close(1001, "服务器暂停");
          }
          pairs.clear();
          log("server_stopped", { by: "api" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "stopped" }));
        } else {
          running = true;
          log("server_started", { by: "api" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "running" }));
        }
        recordRestSuccess(ip);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "无效的 JSON body" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "未找到" }));
}

// --- HTTP/HTTPS 服务器 ---
let server;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, handleRestRequest);
  log("tls_enabled", { cert: TLS_CERT });
} else {
  server = http.createServer(handleRestRequest);
  log("tls_disabled", { warning: "生产环境建议启用 TLS" });
}

// --- WebSocket 服务器 ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!running) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  // 仅允许 /mobile/ws 和 /ws 路径升级
  if (url.pathname === "/mobile/ws" || url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  if (!running) {
    ws.close(1001, "服务器暂停");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const ip = req.socket.remoteAddress || "unknown";

  // 心跳标记
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // 提取 token 和 role
  const token = extractToken(url, req);
  const role = extractRole(url);

  if (!token || !["pc", "phone"].includes(role)) {
    ws.close(4000, "需要 token 和 role 参数");
    log("connection_rejected", { reason: "missing_token_or_role", path: url.pathname, ip });
    return;
  }

  // 消息大小限制
  ws._maxPayload = MAX_MSG_SIZE;

  if (!pairs.has(token)) pairs.set(token, {});
  const pair = pairs.get(token);

  // 同一角色重复连接，关闭旧的
  if (pair[role] && pair[role].readyState === pair[role].OPEN) {
    pair[role].close(4001, "被新连接替换");
    log("connection_replaced", { role, token: token.slice(0, 8) });
  }
  pair[role] = ws;
  ws._token = token;
  ws._role = role;

  const peer = role === "pc" ? "phone" : "pc";
  log("connection_established", { role, token: token.slice(0, 8), pc: !!pair.pc, phone: !!pair.phone });

  // 通知对端已连接
  const peerWsOnConnect = pair[peer];
  if (peerWsOnConnect && peerWsOnConnect.readyState === peerWsOnConnect.OPEN) {
    peerWsOnConnect.send(JSON.stringify({ type: "peer_connected", role }));
  }

  // 转发消息
  ws.on("message", (data) => {
    if (!running) return;
    ws.isAlive = true;

    // 消息大小检查
    if (data.length > MAX_MSG_SIZE) {
      log("message_too_large", { size: data.length, max: MAX_MSG_SIZE, role, token: token.slice(0, 8) });
      return;
    }

    // 速率限制
    if (!checkRateLimit(token)) {
      log("rate_limited", { role, token: token.slice(0, 8) });
      return;
    }

    const peerWs = pair[peer];
    if (peerWs && peerWs.readyState === peerWs.OPEN) {
      peerWs.send(data);
    }
  });

  // 断开清理
  ws.on("close", () => {
    delete pair[role];
    log("connection_closed", { role, token: token.slice(0, 8), pc: !!pair.pc, phone: !!pair.phone });

    const peerWsOnClose = pair[peer];
    if (peerWsOnClose && peerWsOnClose.readyState === peerWsOnClose.OPEN) {
      peerWsOnClose.send(JSON.stringify({ type: "peer_disconnected", role }));
    }
    if (!pair.pc && !pair.phone) {
      pairs.delete(token);
      rateLimits.delete(token);
    }
  });

  ws.on("error", (err) => {
    log("connection_error", { role, token: token.slice(0, 8), error: err.message });
  });
});

// --- 心跳检测 ---
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    } catch {}
  });
}, HEARTBEAT_INTERVAL_MS);

// --- 优雅关闭 ---
function gracefulShutdown(signal) {
  log("shutdown_initiated", { signal });
  running = false;
  clearInterval(heartbeatTimer);

  // 通知所有客户端断开
  for (const [token, pair] of pairs) {
    if (pair.pc) pair.pc.close(1001, "服务器关闭");
    if (pair.phone) pair.phone.close(1001, "服务器关闭");
  }
  pairs.clear();

  wss.close(() => {
    server.close(() => {
      log("shutdown_complete");
      process.exit(0);
    });
  });

  // 强制退出超时
  setTimeout(() => {
    log("shutdown_forced");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// --- 启动 ---
server.listen(PORT, () => {
  const protocol = TLS_CERT ? "wss" : "ws";
  log("server_started", {
    port: PORT,
    protocol,
    fixedToken: !!FIXED_TOKEN,
    adminToken: !!ADMIN_TOKEN,
  });
  console.log(`[relay] 中继服务器启动在端口 ${PORT} (${protocol}://)`);
  if (FIXED_TOKEN) console.log(`[relay] 固定 token: ${FIXED_TOKEN.slice(0, 4)}…`);
  if (ADMIN_TOKEN) console.log(`[relay] Admin API 已启用`);
});

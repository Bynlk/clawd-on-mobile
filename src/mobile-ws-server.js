const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");

const DEFAULT_MAX_CLIENTS = 10;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_MESSAGES = 60;
const MAX_HISTORY = 50;
const SESSION_CACHE_MAX_SIZE = 200;
const SESSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PWA_DIR = path.resolve(__dirname, "../pwa");

// Mobile chip/dot field derivation — mirrors state-session-snapshot.js logic
// for snapshot entries that lack a `mobile` sub-object.
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);
const BADGE_DOT_COLORS = {
  running: "#3b82f6",
  interrupted: "#d97706",
  done: "#71717a",
  idle: "#52525b",
};
const ACTIVE_CHIP_MAP = {
  working: { text: "工作中", color: "#3b82f6" },
  thinking: { text: "思考中", color: "#8b5cf6" },
  juggling: { text: "多任务", color: "#f59e0b" },
  notification: { text: "通知", color: "#d97706" },
  attention: { text: "需要关注", color: "#d97706" },
  error: { text: "错误", color: "#ef4444" },
  sweeping: { text: "清理中", color: "#a1a1aa" },
  carrying: { text: "搬运中", color: "#a1a1aa" },
};
const EVENT_CHIP_MAP = {
  Stop: { text: "已完成", color: "#22c55e" },
  StopFailure: { text: "出错", color: "#ef4444" },
  SubagentStart: { text: "子任务", color: "#60a5fa" },
  SubagentStop: { text: "子任务完成", color: "#22c55e" },
  PermissionRequest: { text: "需要权限", color: "#d97706" },
  Elicitation: { text: "等待中", color: "#d97706" },
  Notification: { text: "等待中", color: "#d97706" },
  WorktreeCreate: { text: "工作树", color: "#60a5fa" },
};
const ERROR_EVENTS = new Set(["StopFailure", "PostToolUseFailure", "ApiError"]);

/** Derive mobile chip fields from a snapshot entry (no `mobile` sub-object). */
function buildMobileFields(entry) {
  const state = entry.state || "idle";
  const recentEvents = Array.isArray(entry.recentEvents) ? entry.recentEvents : [];
  const lastEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null;
  const lastEventName = lastEvent && lastEvent.event ? lastEvent.event : null;
  const isOneshot = ONESHOT_STATES.has(state);
  const effectiveState = isOneshot ? "idle" : state;

  let chip = null;
  if (effectiveState === "idle") {
    if (ERROR_EVENTS.has(lastEventName)) chip = { text: "出错", color: "#ef4444" };
    else if (isOneshot) chip = (lastEventName && EVENT_CHIP_MAP[lastEventName]) || ACTIVE_CHIP_MAP[state] || null;
  } else {
    chip = (lastEventName && EVENT_CHIP_MAP[lastEventName]) || ACTIVE_CHIP_MAP[effectiveState] || null;
  }

  return {
    chipText: chip ? chip.text : null,
    chipColor: chip ? chip.color : null,
    dotColor: BADGE_DOT_COLORS[entry.badge] || BADGE_DOT_COLORS.idle,
    isVisible: !entry.headless && state !== "sleeping" && !entry.hiddenFromHud,
  };
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

class MobileWSServer extends EventEmitter {
  constructor(httpServer, options) {
    super();
    this.token = options.token;
    this.maxClients = options.maxClients || DEFAULT_MAX_CLIENTS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;

    // NOTE: WebSocket.Server is now created externally in startMobileServer()
    // and registered via attachWSS(). No internal WS server is created here.
    this.wss = null;
    this.clients = new Set();
    this.sessionCache = new Map();
    this.clientMeta = new Map();
    this._heartbeatTimer = null;
    this._messageHandlers = new Set();
    this.connectionHistory = [];
    this.externalClients = new Map();
  }

  /** Attach an externally-created WebSocket.Server. */
  attachWSS(wss) {
    this.wss = wss;
    wss.on("connection", (ws, req) => this._handleConnection(ws, req));
  }

  _handleConnection(ws, req) {
    const url = new URL(req.url, "http://localhost");
    // Token auth: URL param or Authorization header.
    // SECURITY: ?token=xxx in URL may leak via logs/Referrer; prefer Authorization: Bearer header.
    let token = url.searchParams.get("token");
    if (!token) {
      const authHeader = req.headers["authorization"] || "";
      if (authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      }
    }

    if (token !== this.token) {
      ws.close(1008, "Invalid token");
      console.log("[mobile-ws] Connection rejected: invalid token");
      return;
    }

    if (this.clients.size >= this.maxClients) {
      ws.close(1013, "Server busy");
      console.log("[mobile-ws] Connection rejected: max clients reached");
      return;
    }

    this.clients.add(ws);
    const clientId = crypto.randomBytes(8).toString("hex");
    const clientIp = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
    const now = Date.now();
    this.clientMeta.set(ws, {
      messageCount: 0,
      windowStart: now,
      clientId: clientId,
      ip: clientIp,
      connectedAt: now,
    });

    // Track connection history
    const historyEntry = { clientId, ip: clientIp, connectedAt: now };
    this.connectionHistory.push(historyEntry);
    if (this.connectionHistory.length > MAX_HISTORY) {
      this.connectionHistory = this.connectionHistory.slice(-MAX_HISTORY);
    }

    console.log("[mobile-ws] Client connected (total: " + this.clients.size + ")");
    this.emit("client-connected", { clientId, ip: clientIp, connectedAt: now });

    // 先发送 clear_sessions，让 Android 进入 syncing 状态
    ws.send(JSON.stringify({
      type: "clear_sessions",
      timestamp: Date.now(),
    }));

    const cacheObj = Object.fromEntries(this.sessionCache);
    const lastEntry = [...this.sessionCache.values()].reverse().find(e => e && e.state && e.state !== "idle") ||
      [...this.sessionCache.values()].reverse().find(e => e) || null;
    ws.send(JSON.stringify({
      type: "snapshot",
      sessions: cacheObj,
      displayState: lastEntry ? (lastEntry.state || "idle") : "idle",
      timestamp: Date.now(),
    }));

    this._startHeartbeat();

    ws.isAlive = true;

    ws.on("message", (data) => {
      ws.isAlive = true; // any message from client = still alive
      const meta = this.clientMeta.get(ws);
      if (!meta) return;
      const now = Date.now();
      if (now - meta.windowStart > RATE_LIMIT_WINDOW_MS) {
        meta.messageCount = 0;
        meta.windowStart = now;
      }
      meta.messageCount++;
      if (meta.messageCount > RATE_LIMIT_MAX_MESSAGES) {
        ws.close(1008, "Rate limit exceeded");
        console.log("[mobile-ws] Connection closed: rate limit exceeded");
        return;
      }

      // Parse client messages and dispatch to handlers
      try {
        const msg = JSON.parse(data);
        for (const handler of this._messageHandlers) {
          try { handler(ws, msg); } catch (e) { console.warn("[mobile-ws] message handler error:", e.message); }
        }
      } catch (e) { console.warn("[mobile-ws] invalid message:", e.message); }
    });

    ws.on("close", () => {
      const meta = this.clientMeta.get(ws);
      this.clients.delete(ws);
      this.clientMeta.delete(ws);
      console.log("[mobile-ws] Client disconnected (total: " + this.clients.size + ")");
      this.emit("client-disconnected", { clientId: meta && meta.clientId });
      if (this.clients.size === 0) this._stopHeartbeat();
    });

    ws.on("error", (err) => {
      console.error("[mobile-ws] Client error:", err.message);
      this.clients.delete(ws);
      this.clientMeta.delete(ws);
    });
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (client.isAlive === false) {
          client.terminate();
          this.clients.delete(client);
          this.clientMeta.delete(client);
          continue;
        }
        client.isAlive = false;
        // JSON ping for Android watchdog (OkHttp rejects ws protocol-level ping frames)
        try {
          client.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
        } catch {}
      }
    }, this.heartbeatIntervalMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /** Evict stale and oversized session cache entries to prevent unbounded memory growth. */
  _evictSessionCache() {
    if (this.sessionCache.size <= SESSION_CACHE_MAX_SIZE) return;
    const now = Date.now();
    // First pass: remove expired entries
    for (const [id, entry] of this.sessionCache) {
      if (entry._cachedAt && now - entry._cachedAt > SESSION_CACHE_TTL_MS) {
        this.sessionCache.delete(id);
      }
    }
    // If still over limit, remove oldest entries
    if (this.sessionCache.size > SESSION_CACHE_MAX_SIZE) {
      const entries = [...this.sessionCache.entries()]
        .sort((a, b) => (a[1]._cachedAt || 0) - (b[1]._cachedAt || 0));
      const toRemove = entries.length - SESSION_CACHE_MAX_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.sessionCache.delete(entries[i][0]);
      }
    }
  }

  broadcastState(sessionId, stateData) {
    const isReal = (stateData.state && stateData.state !== "idle") ||
      (Array.isArray(stateData.recentEvents) &&
        stateData.recentEvents.some(e => e && e.event && e.event !== "SessionStart"));
    const enriched = { ...stateData, isReal, updatedAt: Date.now() };
    this.sessionCache.set(sessionId, { ...enriched, _cachedAt: Date.now() });
    this._evictSessionCache();
    const message = JSON.stringify({
      type: "state",
      sessionId,
      data: enriched,
      ...enriched,
      displayState: enriched.displayState || enriched.state || "idle",
      timestamp: Date.now(),
    });
    this._broadcast(message);
  }

  broadcastSessionSnapshot(snapshot) {
    const sessionsMap = {};
    for (const entry of snapshot.sessions) {
      // buildSessionSnapshotEntry() does not produce a `mobile` sub-object,
      // so derive the mobile-specific fields from the entry itself.
      const mobile = entry.mobile || buildMobileFields(entry);
      if (mobile.isVisible === false) continue;
      sessionsMap[entry.id] = {
        sessionId: entry.id,
        displayState: entry.state,
        badge: entry.badge,
        chipText: mobile.chipText,
        chipColor: mobile.chipColor,
        dotColor: mobile.dotColor,
        isVisible: mobile.isVisible,
        displayTitle: entry.displayTitle,
        cwd: entry.cwd || null,
        updatedAt: entry.updatedAt,
        agentId: entry.agentId,
        recentEvents: entry.recentEvents || [],
        lastOutput: entry.lastOutput || null,
        isReal: entry.isReal,
        resolvedSvg: entry.resolvedSvg || null,
        hookState: entry.hookState || null,
      };
      // Reconcile sessionCache: patch stale badges from oneshot states.
      // broadcastState() caches the oneshot badge (e.g. "interrupted" for error),
      // but the snapshot computes the correct badge from the authoritative session state.
      // Without this, newly connecting clients receive stale badges from the cache.
      const cached = this.sessionCache.get(entry.id);
      if (cached && cached.badge !== entry.badge) {
        cached.badge = entry.badge;
        cached.displayState = entry.state;
      }
    }
    const lastSession = snapshot.sessions.find(s => s.id === snapshot.hudLastSessionId) || snapshot.sessions[0];
    const displayState = lastSession ? lastSession.state : "idle";
    const message = JSON.stringify({
      type: "snapshot",
      sessions: sessionsMap,
      displayState,
      timestamp: Date.now(),
    });
    this._broadcast(message);
  }

  removeSession(sessionId) {
    if (!this.sessionCache.has(sessionId)) return;
    this.sessionCache.delete(sessionId);
    const message = JSON.stringify({
      type: "session_deleted",
      sessionId,
      timestamp: Date.now(),
    });
    this._broadcast(message);
  }

  broadcastToolOutput(sessionId, toolData) {
    const message = JSON.stringify({
      type: "tool_output",
      sessionId,
      ...toolData,  // 展平 toolName, output, event 到顶层
      timestamp: Date.now(),
    });
    this._broadcast(message);
  }

  getSessionCache() {
    return new Map(this.sessionCache);
  }

  getClientCount() {
    return this.clients.size + this.externalClients.size;
  }

  onClientMessage(handler) {
    this._messageHandlers.add(handler);
  }

  offClientMessage(handler) {
    this._messageHandlers.delete(handler);
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    this._broadcast(message);
  }

  getClientInfoList() {
    const list = [];
    for (const ws of this.clients) {
      const meta = this.clientMeta.get(ws);
      list.push({
        id: meta?.clientId || "unknown",
        ip: meta?.ip || "--",
        connectedAt: meta?.connectedAt || null,
      });
    }
    for (const [id, info] of this.externalClients) {
      list.push({
        id,
        ip: info.ip || "--",
        connectedAt: info.connectedAt || null,
      });
    }
    return list;
  }

  getConnectionHistory() {
    return [...this.connectionHistory];
  }

  registerExternalClient(clientId, info) {
    const now = Date.now();
    this.externalClients.set(clientId, {
      ip: info.ip || "unknown",
      connectedAt: info.connectedAt || now,
      res: info.res || null,
    });
    this.connectionHistory.push({ clientId, ip: info.ip || "unknown", connectedAt: now });
    if (this.connectionHistory.length > MAX_HISTORY) {
      this.connectionHistory = this.connectionHistory.slice(-MAX_HISTORY);
    }
    console.log("[mobile-ws] External client registered (total: " + this.getClientCount() + ")");
    this.emit("client-connected", { clientId, ip: info.ip || "unknown", connectedAt: now });
  }

  unregisterExternalClient(clientId) {
    if (!this.externalClients.has(clientId)) return;
    this.externalClients.delete(clientId);
    console.log("[mobile-ws] External client unregistered (total: " + this.getClientCount() + ")");
    this.emit("client-disconnected", { clientId });
  }

  loadConnectionHistory(history) {
    if (Array.isArray(history)) {
      this.connectionHistory = history.slice(-MAX_HISTORY);
    }
  }

  setMaxClients(max) {
    if (typeof max === "number" && max >= 1 && max <= 10) {
      this.maxClients = max;
    }
  }

  disconnectClient(clientId) {
    for (const ws of this.clients) {
      const meta = this.clientMeta.get(ws);
      if (meta && meta.clientId === clientId) {
        try { ws.send(JSON.stringify({ type: "disconnect", timestamp: Date.now() })); } catch {}
        ws.close(1000, "Disconnected by server");
        return true;
      }
    }
    const ext = this.externalClients.get(clientId);
    if (ext) {
      if (ext.res) {
        try { ext.res.write(`data: ${JSON.stringify({ type: "disconnect", timestamp: Date.now() })}\n\n`); } catch {}
        try { ext.res.end(); } catch {}
      }
      this.externalClients.delete(clientId);
      this.emit("client-disconnected", { clientId });
      return true;
    }
    return false;
  }

  // ── HTTP: PWA static files + API (all token-protected) ──

  getLocalIP() {
    const ifaces = os.networkInterfaces();
    const wlan = /WLAN|Wi-?Fi|Wireless|无线/i;
    for (const n of Object.keys(ifaces)) {
      if (wlan.test(n)) { for (const i of ifaces[n]) { if (i.family === "IPv4" && !i.internal) return i.address; } }
    }
    for (const n of Object.keys(ifaces)) {
      for (const i of ifaces[n]) { if (i.family === "IPv4" && !i.internal) return i.address; }
    }
    return "127.0.0.1";
  }

  _extractToken(req) {
    try {
      const u = new URL(req.url, "http://localhost");
      const t = u.searchParams.get("token");
      if (t) return t;
    } catch {}
    const h = req.headers["authorization"] || "";
    return h.startsWith("Bearer ") ? h.slice(7) : null;
  }

  handleRequest(req, res) {
    const reqToken = this._extractToken(req);
    if (!reqToken || reqToken !== this.token) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clawd</title><style>body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center;max-width:400px;padding:2rem}h1{font-size:1.5rem}p{color:#a0a0a0}</style></head><body><div class="box"><h1>\u{1f512} 需要连接信息</h1><p>请在 Clawd 桌面端「设置 → 移动端」获取带 Token 的链接。</p></div></body></html>');
      return;
    }
    let urlPath;
    try { urlPath = new URL(req.url, "http://localhost").pathname; } catch { res.writeHead(400); res.end(); return; }
    if (urlPath === "/api/connection-info") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ status: "ok", port: this._port || null, lanIp: this.getLocalIP(), token: this.token, clientCount: this.getClientCount() }));
      return;
    }
    if (urlPath === "/mobile/" || urlPath === "/mobile") urlPath = "/mobile/index.html";
    if (!urlPath.startsWith("/mobile/")) { res.writeHead(404); res.end(); return; }
    const rel = urlPath.slice("/mobile/".length);
    const filePath = path.join(PWA_DIR, rel);
    if (!filePath.startsWith(PWA_DIR)) { res.writeHead(403); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      let content = data;
      if (ext === ".html") content = Buffer.from(data.toString("utf-8").replace("<head>", '<head><meta name="clawd-token" content="' + this.token + '">'));
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
      res.end(content);
    });
  }

  setPort(port) { this._port = port; }

  close() {
    this._stopHeartbeat();
    for (const client of this.clients) { client.close(1001, "Server shutting down"); }
    this.clients.clear();
    this.clientMeta.clear();
    for (const [, ext] of this.externalClients) { if (ext.res) { try { ext.res.end(); } catch {} } }
    this.externalClients.clear();
    if (this.wss) this.wss.close();
  }

  _broadcast(message) {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

module.exports = { MobileWSServer };

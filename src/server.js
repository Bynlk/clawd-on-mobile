// src/server.js — HTTP server + routes (/state, /permission, /health)
// Extracted from main.js L1337-1528

const http = require("http");
const {
  DEFAULT_SERVER_PORT,
  RUNTIME_CONFIG_PATH,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimePort,
  writeRuntimeConfig,
} = require("../hooks/server-config");
const {
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  createClaudeSettingsWatcher,
} = require("./claude-settings-watcher");
const { createIntegrationSyncRuntime } = require("./integration-sync");
const {
  sendStateHealthResponse,
  handleStatePost,
} = require("./server-route-state");
const {
  handlePermissionPost,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
} = require("./server-route-permission");
const {
  getCodexOfficialTurnKey,
  resolveCodexOfficialHookState,
} = require("./server-codex-official-turns");
const {
  HOOK_EVENT_RING_SIZE_PER_AGENT,
  createSingleRequestHookEventRecorder,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
} = require("./server-hook-events");
const {
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeCodexPermissionToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  findPendingPermissionForStateEvent,
} = require("./server-permission-utils");
const { MobileWSServer } = require("./mobile-ws-server");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

module.exports = function initServer(ctx) {

// CORS origin whitelist — defaults to localhost only; set CLAWD_CORS_ORIGINS=* to allow all
const CORS_ORIGINS = process.env.CLAWD_CORS_ORIGINS === "*"
  ? "*"
  : (process.env.CLAWD_CORS_ORIGINS || "http://localhost,http://127.0.0.1,https://localhost,https://127.0.0.1")
      .split(",").map(s => s.trim()).filter(Boolean);

function getAllowedCorsOrigin(req) {
  if (CORS_ORIGINS === "*") return "*";
  const origin = req.headers["origin"] || "";
  if (CORS_ORIGINS.includes(origin)) return origin;
  return null; // no CORS header — browser will block
}

const createHttpServer = ctx.createHttpServer || http.createServer.bind(http);
const setImmediateFn = ctx.setImmediate || setImmediate;
const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
const clearRuntimeConfigFn = ctx.clearRuntimeConfig || clearRuntimeConfig;
const getPortCandidatesFn = ctx.getPortCandidates || getPortCandidates;
const readRuntimePortFn = ctx.readRuntimePort || readRuntimePort;
const writeRuntimeConfigFn = ctx.writeRuntimeConfig || writeRuntimeConfig;

let httpServer = null;

// Persist mobile state to survive restarts
const MOBILE_STATE_PATH = require("path").join(
  (typeof ctx.getDataDir === "function" ? ctx.getDataDir() : require("os").homedir()),
  ".clawd-mobile-state.json"
);

function loadMobileState() {
  try {
    const data = require("fs").readFileSync(MOBILE_STATE_PATH, "utf8");
    return JSON.parse(data);
  } catch { return {}; }
}

function saveMobileState(patch) {
  try {
    const current = loadMobileState();
    const updated = { ...current, ...patch, savedAt: Date.now() };
    require("fs").writeFileSync(MOBILE_STATE_PATH, JSON.stringify(updated, null, 2));
  } catch (err) {
    console.warn("[mobile] Failed to save state:", err.message);
  }
}

const savedState = loadMobileState();
const MOBILE_TOKEN = savedState.token || crypto.randomBytes(16).toString("hex");
if (!savedState.token) saveMobileState({ token: MOBILE_TOKEN });

let mobileWS = null;
let activeServerPort = null;
let mobileHttpServer = null;
let mobileServerPort = null;
const mobileSSEClients = new Set();
const pendingMobileApprovals = new Map();
const codexOfficialTurns = new Map();
const recentHookEvents = new Map();

function shouldDropForDnd() {
  if (typeof ctx.shouldDropForDnd === "function") {
    try {
      return !!ctx.shouldDropForDnd();
    } catch {}
  }
  return !!ctx.doNotDisturb;
}

function recordHookEvent(data, route, outcome) {
  return recordHookEventInBuffer(recentHookEvents, data, route, outcome, { now: nowFn });
}

function createRequestHookRecorder(data, defaultRoute) {
  return createSingleRequestHookEventRecorder(recordHookEvent, data, defaultRoute);
}

function getRecentHookEvents(options = {}) {
  return getRecentHookEventsFromBuffer(recentHookEvents, options);
}

function clearRecentHookEvents(agentId) {
  if (typeof agentId === "string" && agentId) recentHookEvents.delete(agentId);
  else recentHookEvents.clear();
}

function shouldManageClaudeHooks() {
  return ctx.manageClaudeHooksAutomatically !== false;
}

function isAgentEnabled(agentId) {
  if (typeof ctx.isAgentEnabled !== "function") return true;
  return ctx.isAgentEnabled(agentId) !== false;
}

function getHookServerPort() {
  return activeServerPort || readRuntimePortFn() || DEFAULT_SERVER_PORT;
}

function getRuntimeStatus() {
  let address = null;
  try {
    address = httpServer && typeof httpServer.address === "function" ? httpServer.address() : null;
  } catch {
    address = null;
  }
  const addressPort = address && typeof address === "object" && Number.isInteger(address.port)
    ? address.port
    : null;
  const port = activeServerPort || addressPort || null;
  const runtimePort = readRuntimePortFn();
  return {
    listening: !!port && (!httpServer || httpServer.listening !== false),
    port,
    runtimePath: typeof ctx.runtimeConfigPath === "string" ? ctx.runtimeConfigPath : RUNTIME_CONFIG_PATH,
    runtimePort,
    runtimeFileExists: Number.isInteger(runtimePort),
    runtimeMatches: Number.isInteger(port) && runtimePort === port,
  };
}

const integrationSync = createIntegrationSyncRuntime({
  ctx,
  getHookServerPort,
  shouldManageClaudeHooks,
  isAgentEnabled,
  startClaudeSettingsWatcher,
  stopClaudeSettingsWatcher,
});
const {
  syncClawdHooks,
  syncGeminiHooks,
  syncAntigravityHooks,
  syncCursorHooks,
  syncCodeBuddyHooks,
  syncKiroHooks,
  syncKimiHooks,
  syncCodexHooks,
  syncOpencodePlugin,
  syncPiExtension,
  syncIntegrationForAgent,
  repairIntegrationForAgent,
  stopIntegrationForAgent,
  syncEnabledStartupIntegrations,
} = integrationSync;

function repairRuntimeStatus() {
  const status = getRuntimeStatus();
  if (status && status.listening && Number.isInteger(status.port)) {
    const written = writeRuntimeConfigFn(status.port);
    return written
      ? { status: "ok" }
      : { status: "error", message: "Failed to write runtime config" };
  }
  if (!httpServer) {
    startHttpServer();
    return { status: "ok" };
  }
  return {
    status: "error",
    message: "Local server is not listening; restart Clawd",
  };
}

const claudeSettingsWatcher = createClaudeSettingsWatcher({
  ...ctx,
  shouldManageClaudeHooks,
  isAgentEnabled,
  getHookServerPort,
  syncClawdHooks,
});

// Watch ~/.claude/ directory for settings.json overwrites (e.g. CC-Switch)
// that wipe our hooks. Re-register when hooks disappear.
// Watch the directory (not the file) because atomic rename replaces the inode
// and fs.watch on the old file silently stops firing on Windows.
function startClaudeSettingsWatcher() {
  return claudeSettingsWatcher.start();
}

function stopClaudeSettingsWatcher() {
  return claudeSettingsWatcher.stop();
}

function startHttpServer() {
  httpServer = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      sendStateHealthResponse(res, { getHookServerPort });
    } else if (req.method === "POST" && req.url === "/state") {
      handleStatePost(req, res, {
        ctx,
        createRequestHookRecorder,
        shouldDropForDnd,
        codexOfficialTurns,
        mobileWS,
        broadcastHookEvent,
      });
    } else if (req.method === "POST" && req.url === "/permission") {
      handlePermissionPost(req, res, {
        ctx,
        createRequestHookRecorder,
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  mobileWS = new MobileWSServer(httpServer, {
    token: MOBILE_TOKEN,
    maxClients: savedState.mobileMaxClients || 10,
    heartbeatIntervalMs: 30000,
  });

  // Load persisted connection history
  const savedHistory = savedState.connectionHistory;
  if (savedHistory) mobileWS.loadConnectionHistory(savedHistory);

  // Forward WS events to settings window and persist state
  function notifyMobileState() {
    try {
      const { BrowserWindow } = require("electron");
      for (const bw of BrowserWindow.getAllWindows()) {
        if (bw && !bw.isDestroyed()) {
          bw.webContents.send("settings-changed", {
            mobileStatus: mobileWS.getClientCount() > 0 ? "Connected" : "Listening",
            mobileClients: mobileWS.getClientInfoList(),
          });
        }
      }
    } catch {}
    // Persist connection history
    saveMobileState({ connectionHistory: mobileWS.getConnectionHistory() });
  }

  mobileWS.on("client-connected", notifyMobileState);
  mobileWS.on("client-disconnected", notifyMobileState);

  const listenPorts = getPortCandidatesFn();
  let listenIndex = 0;
  httpServer.on("error", (err) => {
    const bindHost = process.env.CLAWD_BIND_HOST || "0.0.0.0";
    if (!activeServerPort && err.code === "EADDRINUSE" && listenIndex < listenPorts.length - 1) {
      listenIndex++;
      httpServer.listen(listenPorts[listenIndex], bindHost);
      return;
    }
    if (!activeServerPort && err.code === "EADDRINUSE") {
      const firstPort = listenPorts[0];
      const lastPort = listenPorts[listenPorts.length - 1];
      console.warn(`Ports ${firstPort}-${lastPort} are occupied — state sync and permission bubbles are disabled`);
    } else {
      console.error("HTTP server error:", err.message);
    }
  });

  httpServer.on("listening", () => {
    activeServerPort = listenPorts[listenIndex];
    writeRuntimeConfigFn(activeServerPort);
    const logHost = process.env.CLAWD_BIND_HOST || "0.0.0.0";
    console.log(`Clawd state server listening on ${logHost}:${activeServerPort}`);
    console.log(`  Mobile companion token: ${MOBILE_TOKEN.slice(0, 4)}… (set via QR scan or settings page)`);
    // Defer hook/plugin registration off the startup path. Each sync call
    // reads+parses+writes a config JSON (50-150ms cumulative on slow disks),
    // and they operate on independent files for independent agents, so
    // none of them need to block the HTTP server from accepting traffic.
    setImmediateFn(() => {
      syncEnabledStartupIntegrations();
    });
  });

  const bindHost = process.env.CLAWD_BIND_HOST || "0.0.0.0";
  httpServer.listen(listenPorts[listenIndex], bindHost);
}

function broadcastHookEvent(eventData) {
  if (mobileSSEClients.size === 0) {
    if (eventData.type === "permission_request") {
      console.log(`[mobile-sse] broadcastHookEvent type=${eventData.type} SKIPPED — no SSE clients connected`);
    }
    return;
  }
  const data = `data: ${JSON.stringify(eventData)}\n\n`;
  console.log(`[mobile-sse] broadcastHookEvent type=${eventData.type} clients=${mobileSSEClients.size}`);
  for (const client of mobileSSEClients) {
    try { client.write(data); } catch { mobileSSEClients.delete(client); }
  }
}

function startMobileServer() {
  const MOBILE_PORT = 23334;
  mobileHttpServer = createHttpServer((req, res) => {
    // WebSocket upgrade on /mobile/ws is handled by wsServerMobile below

    if (req.method === "GET" && req.url.startsWith("/mobile/stream")) {
      // Token authentication
      const streamUrl = new URL(req.url, "http://localhost");
      let streamToken = streamUrl.searchParams.get("token");
      if (!streamToken) {
        const authHeader = req.headers["authorization"] || "";
        if (authHeader.startsWith("Bearer ")) streamToken = authHeader.slice(7);
      }
      if (streamToken !== MOBILE_TOKEN) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
      const corsOrigin = getAllowedCorsOrigin(req);
      const corsHeaders = corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {};
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...corsHeaders,
      });
      res.write(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`);
      // Tell client to flush stale sessions before snapshot arrives
      res.write(`data: ${JSON.stringify({ type: "clear_sessions", timestamp: Date.now() })}\n\n`);
      mobileSSEClients.add(res);
      const sseClientId = "sse_" + crypto.randomBytes(8).toString("hex");
      const sseClientIp = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
      res._sseClientId = sseClientId;
      if (mobileWS) {
        mobileWS.registerExternalClient(sseClientId, { ip: sseClientIp, res });
        // Send current session cache to the new client so syncing state resolves
        const cache = mobileWS.getSessionCache ? mobileWS.getSessionCache() : new Map();
        const displayState = typeof ctx.resolveDisplayState === "function"
          ? ctx.resolveDisplayState()
          : "idle";
        if (cache.size > 0) {
          res.write(`data: ${JSON.stringify({ type: "snapshot", sessions: Object.fromEntries(cache), displayState, timestamp: Date.now() })}\n\n`);
        } else {
          // No sessions — still resolve syncing state
          res.write(`data: ${JSON.stringify({ type: "snapshot", sessions: {}, displayState, timestamp: Date.now() })}\n\n`);
        }
      }
      console.log(`[mobile-sse] Client connected (total: ${mobileSSEClients.size})`);
      // SSE heartbeat: keep TCP alive and detect dead clients
      const pingInterval = setInterval(() => {
        try { res.write(`data: ${JSON.stringify({ type: "ping", timestamp: Date.now() })}\n\n`); }
        catch { clearInterval(pingInterval); mobileSSEClients.delete(res); if (mobileWS && res._sseClientId) mobileWS.unregisterExternalClient(res._sseClientId); }
      }, 15000);
      req.on("close", () => {
        clearInterval(pingInterval);
        mobileSSEClients.delete(res);
        if (mobileWS && res._sseClientId) mobileWS.unregisterExternalClient(res._sseClientId);
        console.log(`[mobile-sse] Client disconnected (total: ${mobileSSEClients.size})`);
      });
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/mobile/approve")) {
      // Token authentication
      const approveUrl = new URL(req.url, "http://localhost");
      let approveToken = approveUrl.searchParams.get("token");
      if (!approveToken) {
        const authHeader = req.headers["authorization"] || "";
        if (authHeader.startsWith("Bearer ")) approveToken = authHeader.slice(7);
      }
      if (approveToken !== MOBILE_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let data;
        try { data = JSON.parse(body); } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
        const { id, decision } = data;
        if (!id || (decision !== "allow" && decision !== "deny")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "need { id, decision: \"allow\"|\"deny\" }" }));
          return;
        }
        const pending = pendingMobileApprovals.get(id);
        if (!pending) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "request not found or expired" }));
          return;
        }
        clearTimeout(pending.timer);
        pendingMobileApprovals.delete(id);
        const resolvedDecision = (decision === "allow" && Number.isFinite(data.suggestionIndex))
          ? `suggestion:${data.suggestionIndex}`
          : decision;
        // Elicitation: forward updatedInput (answers) to resolvePermissionEntry
        if (decision === "allow" && data.updatedInput && pending.entry) {
          pending.entry.resolvedUpdatedInput = data.updatedInput;
        }
        try { pending.resolve(resolvedDecision); } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === "OPTIONS") {
      const corsOrigin = getAllowedCorsOrigin(req);
      if (!corsOrigin) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  mobileHttpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[mobile-sse] Port ${MOBILE_PORT} occupied, mobile SSE disabled`);
    } else {
      console.error("[mobile-sse] Server error:", err.message);
    }
  });

  // Add WebSocket support on mobile port at /mobile/ws
  const WebSocket = require("ws");
  const wsServerMobile = new WebSocket.Server({ server: mobileHttpServer, path: "/mobile/ws" });
  wsServerMobile.on("connection", (ws, req) => {
    if (mobileWS) {
      mobileWS._handleConnection(ws, req);
    } else {
      ws.close(1013, "Server not ready");
    }
  });
  console.log(`[mobile-ws] WebSocket endpoint at /mobile/ws on port ${MOBILE_PORT}`);

  const mobileBindHost = process.env.CLAWD_BIND_HOST || "0.0.0.0";
  mobileHttpServer.listen(MOBILE_PORT, mobileBindHost, () => {
    mobileServerPort = MOBILE_PORT;
    console.log(`[mobile-sse] Listening on ${mobileBindHost}:${MOBILE_PORT}`);
  });
}

function stopMobileServer() {
  for (const client of mobileSSEClients) {
    try { client.end(); } catch {}
  }
  mobileSSEClients.clear();
  for (const [, pending] of pendingMobileApprovals) {
    try { clearTimeout(pending.timer); } catch {}
  }
  pendingMobileApprovals.clear();
  if (mobileHttpServer) {
    mobileHttpServer.close();
    mobileHttpServer = null;
  }
}

function cleanup() {
  stopMobileServer();
  clearRuntimeConfigFn();
  stopClaudeSettingsWatcher();
  if (mobileWS) mobileWS.close();
  if (httpServer) httpServer.close();
}

return {
  startHttpServer,
  getHookServerPort,
  getRuntimeStatus,
  getRecentHookEvents,
  clearRecentHookEvents,
  syncClawdHooks,
  syncGeminiHooks,
  syncAntigravityHooks,
  syncCursorHooks,
  syncCodeBuddyHooks,
  syncKiroHooks,
  syncKimiHooks,
  syncCodexHooks,
  syncOpencodePlugin,
  syncPiExtension,
  syncIntegrationForAgent,
  repairIntegrationForAgent,
  repairRuntimeStatus,
  stopIntegrationForAgent,
  startClaudeSettingsWatcher,
  stopClaudeSettingsWatcher,
  cleanup,
  getMobileWS: () => mobileWS,
  getMobileToken: () => MOBILE_TOKEN,
  getHookServerPort: () => activeServerPort,
  saveMobileState,
  broadcastHookEvent,
  startMobileServer,
  getPendingMobileApprovals: () => pendingMobileApprovals,
};

};

module.exports.__test = {
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeCodexPermissionToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  findPendingPermissionForStateEvent,
  getCodexOfficialTurnKey,
  resolveCodexOfficialHookState,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
  createSingleRequestHookEventRecorder,
  HOOK_EVENT_RING_SIZE_PER_AGENT,
};

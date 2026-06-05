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
const CLAUDE_HOOK_GUARD_NOTICE_TTL_MS = 30 * 60 * 1000;

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
    const tmpPath = MOBILE_STATE_PATH + ".tmp";
    require("fs").writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
    require("fs").renameSync(tmpPath, MOBILE_STATE_PATH);
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
const pendingMobileApprovals = new Map();
let lastClaudeHookGuardNotice = null;
const codexOfficialTurns = new Map();
const recentHookEvents = new Map();

/**
 * Resolve a pending mobile approval by ID.
 * Shared by HTTP /mobile/approve and WS permission_response handlers.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
function resolveMobileApproval(id, data) {
  if (!id) return { ok: false, error: "missing id" };
  const decision = data.decision || data.behavior;
  if (!decision || (decision !== "allow" && decision !== "deny")) {
    return { ok: false, error: "need decision: allow|deny" };
  }
  const pending = pendingMobileApprovals.get(id);
  if (!pending) {
    return { ok: false, error: "request not found or expired" };
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
  try { pending.resolve(resolvedDecision); } catch (e) { console.warn("[mobile] approval resolve error:", e.message); }
  return { ok: true };
}

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

function getClaudeHookGuardStatus() {
  if (!lastClaudeHookGuardNotice) return null;
  if (nowFn() - lastClaudeHookGuardNotice.at > CLAUDE_HOOK_GUARD_NOTICE_TTL_MS) return null;
  return { ...lastClaudeHookGuardNotice };
}

function clearClaudeHookGuardStatus() {
  const hadNotice = !!lastClaudeHookGuardNotice;
  lastClaudeHookGuardNotice = null;
  return hadNotice;
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
  syncIntegrationForAgent: syncIntegrationForAgentBase,
  repairIntegrationForAgent: repairIntegrationForAgentBase,
  stopIntegrationForAgent,
  syncEnabledStartupIntegrations,
} = integrationSync;

function notifySuspiciousShrink(before, after) {
  lastClaudeHookGuardNotice = {
    type: "suspicious-shrink",
    at: nowFn(),
    before: before ? { ...before } : null,
    after: after ? { ...after } : null,
  };
  if (typeof ctx.notifySuspiciousShrink === "function") {
    ctx.notifySuspiciousShrink(before, after, lastClaudeHookGuardNotice);
  }
}

function shouldClearClaudeHookGuardAfterSync(agentId, result) {
  if (agentId !== "claude-code") return false;
  if (result === false) return false;
  if (result && typeof result === "object" && result.status === "error") return false;
  return true;
}

function clearClaudeHookGuardAfterClaudeSync(agentId, result) {
  if (shouldClearClaudeHookGuardAfterSync(agentId, result)) clearClaudeHookGuardStatus();
  return result;
}

function syncIntegrationForAgent(agentId) {
  return clearClaudeHookGuardAfterClaudeSync(agentId, syncIntegrationForAgentBase(agentId));
}

function repairIntegrationForAgent(agentId, options = {}) {
  return clearClaudeHookGuardAfterClaudeSync(agentId, repairIntegrationForAgentBase(agentId, options));
}

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
  notifySuspiciousShrink,
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

  // Register WS message handler for approval responses from Android
  mobileWS.onClientMessage((ws, msg) => {
    if (msg.type === "permission_response" || msg.type === "elicitation_response") {
      const result = resolveMobileApproval(msg.id || msg.requestId, msg);
      try {
        ws.send(JSON.stringify({
          type: "approval_result",
          id: msg.id || msg.requestId,
          ...result,
          timestamp: Date.now(),
        }));
      } catch (e) { console.warn("[mobile-ws] send approval_result error:", e.message); }
    }
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
    } catch (e) { console.warn("[mobile] notifyMobileState error:", e.message); }
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
  if (!mobileWS || mobileWS.getClientCount() === 0) {
    if (eventData.type === "permission_request") {
      console.log(`[mobile-ws] broadcastHookEvent type=${eventData.type} SKIPPED — no WS clients connected`);
    }
    return;
  }
  console.log(`[mobile-ws] broadcastHookEvent type=${eventData.type} clients=${mobileWS.getClientCount()}`);
  mobileWS.broadcast(eventData);
}

function startMobileServer() {
  const MOBILE_PORT = 23334;
  mobileHttpServer = createHttpServer((req, res) => {
    // All HTTP requests go through MobileWSServer.handleRequest (token-protected)
    if (mobileWS) {
      mobileWS.handleRequest(req, res);
    } else {
      res.writeHead(503);
      res.end("Server not ready");
    }
  });

  let mobilePortFallback = false;
  mobileHttpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !mobilePortFallback) {
      mobilePortFallback = true;
      console.warn(`[mobile-ws] Port ${MOBILE_PORT} occupied, trying ${MOBILE_PORT + 1}`);
      mobileHttpServer.listen(MOBILE_PORT + 1, mobileBindHost);
    } else if (err.code === "EADDRINUSE") {
      console.warn(`[mobile-ws] Ports ${MOBILE_PORT}-${MOBILE_PORT + 1} both occupied, mobile server disabled`);
    } else {
      console.error("[mobile-ws] Server error:", err.message);
    }
  });

  // WebSocket: /mobile/ws (Android) and /ws (PWA)
  const WebSocket = require("ws");
  const wsAndroid = new WebSocket.Server({ server: mobileHttpServer, path: "/mobile/ws" });
  wsAndroid.on("connection", (ws, req) => {
    if (mobileWS) mobileWS._handleConnection(ws, req);
    else ws.close(1013, "Server not ready");
  });
  const wsPwa = new WebSocket.Server({ server: mobileHttpServer, path: "/ws" });
  wsPwa.on("connection", (ws, req) => {
    if (mobileWS) mobileWS._handleConnection(ws, req);
    else ws.close(1013, "Server not ready");
  });
  console.log(`[mobile-ws] WebSocket endpoint at /mobile/ws on port ${MOBILE_PORT}`);

  const mobileBindHost = process.env.CLAWD_BIND_HOST || "0.0.0.0";
  mobileHttpServer.listen(MOBILE_PORT, mobileBindHost, () => {
    mobileServerPort = MOBILE_PORT;
    if (mobileWS) mobileWS.setPort(MOBILE_PORT);
    console.log(`[mobile-ws] Listening on ${mobileBindHost}:${MOBILE_PORT}`);
  });
}

function stopMobileServer() {
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
  clearClaudeHookGuardStatus();
  stopClaudeSettingsWatcher();
  if (mobileWS) mobileWS.close();
  if (httpServer) httpServer.close();
}

return {
  startHttpServer,
  getHookServerPort,
  getRuntimeStatus,
  getClaudeHookGuardStatus,
  clearClaudeHookGuardStatus,
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

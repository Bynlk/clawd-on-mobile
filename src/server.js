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
const QRCode = require("qrcode");

module.exports = function initServer(ctx) {

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

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        candidates.push({ name, address: addr.address });
      }
    }
  }

  // Prefer LAN addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  const lan = candidates.find(c =>
    /^192\.168\./.test(c.address) ||
    /^10\./.test(c.address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(c.address)
  );

  if (lan) {
    console.log(`[Mobile] Selected LAN IP: ${lan.address} (${lan.name})`);
    return lan.address;
  }

  // Fallback to first non-internal
  const fallback = candidates[0];
  if (fallback) {
    console.log(`[Mobile] Fallback IP: ${fallback.address} (${fallback.name})`);
    return fallback.address;
  }

  console.log("[Mobile] No external IPv4 found, using 127.0.0.1");
  return "127.0.0.1";
}

async function handleMobileQrImage(req, res) {
  const pairUrl = `clawd://${getLocalIP()}:23334/${MOBILE_TOKEN}`;
  try {
    const buffer = await QRCode.toBuffer(pairUrl, {
      width: 300,
      margin: 2,
      color: { dark: "#ffffff", light: "#1a1a2e" },
      type: "png",
    });
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache",
    });
    res.end(buffer);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("QR generation failed: " + err.message);
  }
}

async function handleMobilePairPage(req, res) {
  const pairUrl = `clawd://${getLocalIP()}:23334/${MOBILE_TOKEN}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(pairUrl, {
      width: 300,
      margin: 2,
      color: { dark: "#ffffff", light: "#1a1a2e" },
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clawd Mobile 配对</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e; color: #eee;
      font-family: -apple-system, system-ui, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .pair-card {
      background: #16213e; border-radius: 16px; padding: 32px;
      text-align: center; max-width: 400px; width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #a0a0b0; margin-bottom: 24px; font-size: 14px; }
    .qr-container {
      background: #fff; border-radius: 12px;
      display: inline-block; padding: 16px; margin-bottom: 24px;
    }
    .qr-container img { display: block; }
    .info {
      background: #0f3460; border-radius: 8px;
      padding: 12px; font-family: monospace; font-size: 13px;
      word-break: break-all; margin-bottom: 16px;
    }
    .steps { text-align: left; font-size: 14px; line-height: 2; }
    .steps li { margin-left: 20px; }
    .token { color: #6c5ce7; font-weight: bold; }
  </style>
</head>
<body>
  <div class="pair-card">
    <h1>Clawd Mobile</h1>
    <p class="subtitle">扫码配对，开始监控</p>
    <div class="qr-container">
      <img src="${qrDataUrl}" alt="QR Code">
    </div>
    <div class="info">
      ${getLocalIP()}:23334<br>
      Token: <span class="token">${MOBILE_TOKEN}</span>
    </div>
    <ol class="steps">
      <li>手机打开 Clawd Mobile PWA</li>
      <li>点击「扫码配对」</li>
      <li>对准此 QR 码</li>
      <li>自动连接成功</li>
    </ol>
  </div>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("QR generation failed: " + err.message);
  }
}

const MOBILE_DIR = path.join(__dirname, "..", "mobile");
const MOBILE_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveMobileStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/mobile/" || urlPath === "/mobile") urlPath = "/mobile/index.html";

  const filePath = path.join(MOBILE_DIR, path.relative("/mobile", urlPath));

  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(MOBILE_DIR);
  if (!resolvedPath.startsWith(resolvedBase)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MOBILE_MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  });
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
    } else if (req.method === "GET" && req.url === "/mobile/pair") {
      handleMobilePairPage(req, res);
    } else if (req.method === "GET" && req.url === "/mobile/qr") {
      handleMobileQrImage(req, res);
    } else if (req.method === "GET" && req.url.startsWith("/mobile/")) {
      serveMobileStatic(req, res);
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
    if (!activeServerPort && err.code === "EADDRINUSE" && listenIndex < listenPorts.length - 1) {
      listenIndex++;
      httpServer.listen(listenPorts[listenIndex], "0.0.0.0");
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
    console.log(`Clawd state server listening on 127.0.0.1:${activeServerPort}`);
    console.log(`  Mobile companion token: ${MOBILE_TOKEN}`);
    // mDNS 服务广播
    try {
      const bonjour = require("bonjour")();
      const mdnsService = bonjour.publish({
        name: "Clawd Desktop",
        type: "clawd",
        protocol: "tcp",
        port: activeServerPort,
        txt: {
          path: "/ws",
          token_required: "true",
          version: "1",
          app: "clawd-on-desk",
        },
      });
      console.log(`  mDNS: _clawd._tcp on port ${activeServerPort}`);
      mobileWS._bonjour = bonjour;
      mobileWS._mdnsService = mdnsService;
    } catch (err) {
      console.warn("[mDNS] Failed to publish:", err.message);
    }
    // 终端 QR 码
    QRCode.toString(
      `clawd://${getLocalIP()}:23334/${MOBILE_TOKEN}`,
      { type: "terminal", small: true },
      (err, str) => {
        if (!err) console.log(str);
      }
    );
    // Defer hook/plugin registration off the startup path. Each sync call
    // reads+parses+writes a config JSON (50-150ms cumulative on slow disks),
    // and they operate on independent files for independent agents, so
    // none of them need to block the HTTP server from accepting traffic.
    setImmediateFn(() => {
      syncEnabledStartupIntegrations();
    });
  });

  httpServer.listen(listenPorts[listenIndex], "0.0.0.0");
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
    if (req.method === "GET" && req.url === "/mobile/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
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
        if (cache.size > 0) {
          res.write(`data: ${JSON.stringify({ type: "snapshot", sessions: Object.fromEntries(cache), timestamp: Date.now() })}\n\n`);
        } else {
          // No sessions — still resolve syncing state
          res.write(`data: ${JSON.stringify({ type: "snapshot", sessions: {}, timestamp: Date.now() })}\n\n`);
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

    if (req.method === "POST" && req.url === "/mobile/approve") {
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
        try { pending.resolve(decision); } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
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

  mobileHttpServer.listen(MOBILE_PORT, "0.0.0.0", () => {
    mobileServerPort = MOBILE_PORT;
    console.log(`[mobile-sse] Listening on 0.0.0.0:${MOBILE_PORT}`);
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
  if (mobileWS && mobileWS._mdnsService) {
    mobileWS._mdnsService.stop();
  }
  if (mobileWS && mobileWS._bonjour) {
    mobileWS._bonjour.destroy();
  }
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

"use strict";

// src/mobile-server-integration.js
// Extracted mobile companion integration logic from server.js.
// Centralizes MobileWSServer lifecycle, token management, approval resolution,
// and hook event broadcasting for Android companion app support.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { MobileWSServer } = require("./mobile-ws-server");

/**
 * Initialize mobile companion server state.
 * Creates the MobileWSServer instance, loads persisted token, and sets up
 * the WS message handler for approval responses.
 *
 * @param {object} ctx - Server context
 * @param {object} options
 * @param {Function} options.createHttpServer - HTTP server factory
 * @param {Function} options.getPortCandidates - Port candidate list provider
 * @returns {object} Mobile integration state (mobileWS, MOBILE_TOKEN, etc.)
 */
function initMobileServer(ctx, options = {}) {
  const createHttpServer = options.createHttpServer || require("http").createServer.bind(require("http"));

  // Inject mobile chip derivation into ctx so server-route-state.js
  // can use it without importing mobile-specific modules.
  ctx.deriveMobileChipFields = deriveMobileChipFields;

  // Persist mobile state to survive restarts
  const MOBILE_STATE_PATH = path.join(
    (typeof ctx.getDataDir === "function" ? ctx.getDataDir() : os.homedir()),
    ".clawd-mobile-state.json"
  );

  function loadMobileState() {
    try {
      const data = fs.readFileSync(MOBILE_STATE_PATH, "utf8");
      return JSON.parse(data);
    } catch (e) {
      console.warn("[mobile] loadMobileState failed:", e.message);
      return {};
    }
  }

  function saveMobileState(patch) {
    try {
      const current = loadMobileState();
      const updated = { ...current, ...patch, savedAt: Date.now() };
      const tmpPath = MOBILE_STATE_PATH + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
      fs.renameSync(tmpPath, MOBILE_STATE_PATH);
    } catch (err) {
      console.warn("[mobile] Failed to save state:", err.message);
    }
  }

  const savedState = loadMobileState();
  const MOBILE_TOKEN = savedState.token || crypto.randomBytes(16).toString("hex");
  if (!savedState.token) saveMobileState({ token: MOBILE_TOKEN });

  const pendingMobileApprovals = new Map();
  let mobileWS = null;
  let mobileHttpServer = null;
  let mobileServerPort = null;

  /**
   * Resolve a pending mobile approval by ID.
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

  /**
   * Broadcast a hook event to all connected mobile clients.
   */
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

  /**
   * Start the mobile companion server on port 23334.
   * Creates a separate HTTP server for WebSocket upgrades and REST API.
   *
   * @param {object} [httpServer] - Main HTTP server (for MobileWSServer attachment)
   * @param {object} [options] - Options
   * @param {boolean} [options.skipHttpServer] - Skip creating mobile HTTP server (for testing)
   */
  function startMobileServer(httpServer, options = {}) {
    if (httpServer) {
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
    }

    // Skip creating mobile HTTP server if requested (e.g., in tests)
    if (options.skipHttpServer) {
      console.log("[mobile-ws] Skipping mobile HTTP server creation (skipHttpServer=true)");
      return;
    }

    const MOBILE_PORT = 23334;
    mobileHttpServer = createHttpServer((req, res) => {
      // Skip WebSocket upgrade requests — handled by ws library's upgrade listener
      if (req.headers && req.headers.upgrade && /websocket/i.test(req.headers.upgrade)) return;
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

    // WebSocket: single server, manual upgrade for /mobile/ws (Android) and /ws (PWA)
    const WebSocket = require("ws");
    const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, autoPong: false });
    mobileHttpServer.on("upgrade", (req, socket, head) => {
      const urlPath = (require("url").parse(req.url || "").pathname || "");
      if (urlPath === "/mobile/ws" || urlPath === "/ws") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });
    if (mobileWS) mobileWS.attachWSS(wss);
    console.log(`[mobile-ws] WebSocket endpoint at /mobile/ws on port ${MOBILE_PORT}`);

    const mobileBindHost = process.env.CLAWD_BIND_HOST || "0.0.0.0";
    mobileHttpServer.listen(MOBILE_PORT, mobileBindHost, () => {
      mobileServerPort = MOBILE_PORT;
      if (mobileWS) mobileWS.setPort(MOBILE_PORT);
      console.log(`[mobile-ws] Listening on ${mobileBindHost}:${MOBILE_PORT}`);
    });
  }

  /**
   * Stop the mobile companion server and clean up pending approvals.
   */
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

  /**
   * Set up permission hooks on the server context.
   * This replaces the monkey-patch approach in main.js with clean callbacks.
   *
   * @param {object} ctx - Server context
   * @param {Function} resolvePermissionEntry - Permission resolution function
   */
  function setupPermissionHooks(ctx, resolvePermissionEntry) {
    ctx.onPermissionAdded = function(permEntry, id) {
      if (permEntry && permEntry.res && permEntry.agentId !== "opencode") {
        console.log(`[mobile-bridge] broadcasting permission_request id=${id}`);
        // Generate labels for mobile clients (desktop bubble-renderer does this client-side)
        const mobileSuggestions = (permEntry.suggestions || []).map((s) => {
          if (s.label) return s;
          let label = "Always Allow";
          if (s.type === "setMode") {
            if (s.mode === "acceptEdits") label = "Auto-accept edits";
            else if (s.mode === "plan") label = "Switch to plan mode";
            else label = s.mode || label;
          } else if (s.type === "addRules") {
            const rule = Array.isArray(s.rules) && s.rules[0] ? s.rules[0] : s;
            const rc = rule.ruleContent || s.ruleContent;
            const tn = rule.toolName || s.toolName || "";
            if (rc) {
              label = rc.includes("**")
                ? `Allow ${tn} in ${rc.split("**")[0].replace(/[\\/]$/, "").split(/[\\/]/).pop() || rc}`
                : `Always allow: ${rc.length > 30 ? rc.slice(0, 29) + "…" : rc}`;
            }
          }
          return { ...s, label };
        });
        broadcastHookEvent({
          type: "permission_request",
          id,
          sessionId: permEntry.sessionId,
          toolName: permEntry.toolName,
          agentId: permEntry.agentId,
          toolInput: permEntry.toolInput || null,
          suggestions: mobileSuggestions,
          timestamp: Date.now(),
        });
        const timer = setTimeout(() => {
          if (!pendingMobileApprovals.has(id)) return;
          pendingMobileApprovals.delete(id);
          try { resolvePermissionEntry(permEntry, "deny", "Mobile approval timed out"); } catch {}
        }, 60000);
        pendingMobileApprovals.set(id, {
          entry: permEntry,
          timer,
          resolve: (decision) => {
            try { resolvePermissionEntry(permEntry, decision, "Mobile approval"); } catch {}
          },
        });
      }
    };

    ctx.onPermissionRemoved = function(permEntry) {
      if (permEntry && permEntry._mobileApprovalId) {
        const pending = pendingMobileApprovals.get(permEntry._mobileApprovalId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingMobileApprovals.delete(permEntry._mobileApprovalId);
        }
      }
    };
  }

  /**
   * Set up mobile state change hooks on the server context.
   * This allows server-route-state.js to broadcast state changes to mobile clients.
   *
   * @param {object} ctx - Server context
   */
  function setupStateChangeHooks(ctx) {
    ctx.onMobileStateChange = function(sessionId, changeType, data) {
      if (mobileWS) {
        mobileWS.broadcastState(sessionId, data);
      }
      broadcastHookEvent({
        type: changeType,
        sessionId,
        ...data,
        timestamp: Date.now(),
      });
    };

    ctx.onMobileToolOutput = function(sessionId, data) {
      if (mobileWS) {
        mobileWS.broadcastToolOutput(sessionId, data);
      }
      broadcastHookEvent({
        type: "tool_output",
        sessionId,
        ...data,
        timestamp: Date.now(),
      });
    };

    ctx.onMobileSessionSnapshot = function(snapshot) {
      if (mobileWS) {
        mobileWS.broadcastSessionSnapshot(snapshot);
      }
    };

    ctx.onMobileSessionRemoved = function(sessionId) {
      if (mobileWS) {
        mobileWS.removeSession(sessionId);
      }
      broadcastHookEvent({ type: "session_deleted", sessionId, timestamp: Date.now() });
    };

    ctx.onMobileMaxClientsChange = function(maxClients) {
      if (mobileWS) {
        mobileWS.setMaxClients(maxClients);
      }
    };
  }

  return {
    mobileWS,
    MOBILE_TOKEN,
    pendingMobileApprovals,
    loadMobileState,
    saveMobileState,
    resolveMobileApproval,
    broadcastHookEvent,
    startMobileServer,
    stopMobileServer,
    setupPermissionHooks,
    setupStateChangeHooks,
    getMobileWS: () => mobileWS,
    getMobileToken: () => MOBILE_TOKEN,
    getPendingMobileApprovals: () => pendingMobileApprovals,
  };
}

// ── Mobile chip fields (extracted from state-session-snapshot.js) ──
// Pure logic: maps session state + recent events to status bar text+color
// for the Android companion app.

const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);
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

function deriveMobileChipFields(state, recentEvents) {
  const lastEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null;
  const lastEventName = lastEvent && lastEvent.event ? lastEvent.event : null;
  const isOneshot = ONESHOT_STATES.has(state);
  const effectiveState = isOneshot ? "idle" : state;
  if (effectiveState === "idle") {
    if (ERROR_EVENTS.has(lastEventName)) {
      return { text: "出错", color: "#ef4444" };
    }
    if (isOneshot) {
      if (lastEventName && EVENT_CHIP_MAP[lastEventName]) return EVENT_CHIP_MAP[lastEventName];
      return ACTIVE_CHIP_MAP[state] || null;
    }
    return null;
  }
  if (lastEventName && EVENT_CHIP_MAP[lastEventName]) {
    return EVENT_CHIP_MAP[lastEventName];
  }
  return ACTIVE_CHIP_MAP[effectiveState] || null;
}

module.exports = { initMobileServer, deriveMobileChipFields };

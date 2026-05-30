(function() {
  "use strict";

  // === Constants ===

  var STATE_CONFIG = {
    error:        { icon: "error",        color: "#ef4444", priority: 0, label: "错误" },
    attention:    { icon: "attention",    color: "#b45309", priority: 1, label: "需要关注" },
    working:      { icon: "working",      color: "#22c55e", priority: 2, label: "工作中" },
    juggling:     { icon: "juggling",     color: "#22c55e", priority: 2, label: "多任务" },
    thinking:     { icon: "thinking",     color: "#3b82f6", priority: 3, label: "思考中" },
    notification: { icon: "notification", color: "#d97757", priority: 4, label: "通知" },
    sweeping:     { icon: "sweeping",     color: "#71717a", priority: 5, label: "清理中" },
    carrying:     { icon: "carrying",     color: "#71717a", priority: 5, label: "搬运中" },
    idle:         { icon: "idle",         color: "#71717a", priority: 6, label: "空闲" },
    sleeping:     { icon: "sleeping",     color: "#a1a1aa", priority: 7, label: "休眠" },
  };

  var CONNECTION_STATES = {
    connected:    { dot: "connected", text: "已连接", color: "#22c55e" },
    connecting:   { dot: "connecting", text: "连接中...", color: "#b45309" },
    reconnecting: { dot: "reconnecting", text: "重连中...", color: "#ef4444" },
    disconnected: { dot: "", text: "", color: "#52525b" },
    auth_failed:  { dot: "", text: "认证失败", color: "#ef4444" },
  };

  var EVENT_LABELS_CN = {
    UserPromptSubmit: "用户输入",
    PreToolUse: "工具启动",
    PostToolUse: "工具完成",
    PostToolUseFailure: "工具失败",
    Stop: "已完成",
    SessionStart: "会话开始",
    SessionEnd: "会话结束",
    PermissionRequest: "需要权限",
    Notification: "通知",
    SubagentStart: "子代理启动",
    SubagentStop: "子代理停止",
  };

  var STALE_TIMEOUT_MS = 5 * 60 * 1000;
  var MAX_HISTORY = 5;

  // === Utilities ===

  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function icon(name) {
    return (typeof ICONS !== "undefined" && ICONS[name]) || "";
  }

  function shortPath(p) {
    if (!p) return "";
    var parts = p.split(/[/\\]/);
    return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : p;
  }

  function formatAgo(ts) {
    if (!ts) return "";
    var sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return "刚刚";
    if (sec < 60) return sec + "秒前";
    if (sec < 3600) return Math.floor(sec / 60) + "分钟前";
    return Math.floor(sec / 3600) + "小时前";
  }

  function eventLabel(eventName) {
    return EVENT_LABELS_CN[eventName] || (typeof EVENT_LABELS !== "undefined" && EVENT_LABELS[eventName]) || eventName || "";
  }

  function log(msg) {
    var el = document.getElementById("log-content");
    if (!el) return;
    var line = document.createElement("div");
    var now = new Date();
    var ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(function(n) { return String(n).padStart(2, "0"); }).join(":");
    line.textContent = "[" + ts + "] " + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function showToast(message, type) {
    type = type || "info";
    var container = document.getElementById("toast-container");
    var toast = document.createElement("div");
    toast.className = "toast " + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s";
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  }

  // === NotificationManager ===

  class NotificationManager {
    constructor() {
      this.permission = "default";
      this.lastStates = new Map();
    }

    requestPermission() {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") { this.permission = "granted"; return; }
      if (Notification.permission !== "denied") {
        var self = this;
        Notification.requestPermission().then(function(p) { self.permission = p; });
      }
    }

    onStateChange(sessionId, data) {
      if (this.permission !== "granted") return;
      if (document.visibilityState === "visible") return;
      var prev = this.lastStates.get(sessionId);
      this.lastStates.set(sessionId, data.state);
      var s = data.state;
      var config = STATE_CONFIG[s];
      if (!config) return;
      if (s === "error" || s === "attention") {
        this._notify(config.label, (data.agentId || "Agent") + " - " + config.label, s);
      } else if ((prev === "working" || prev === "thinking") && s === "idle") {
        this._notify("任务完成", (data.agentId || "Agent") + " 已完成任务", "idle");
      }
    }

    onApprovalNeeded(data) {
      if (this.permission !== "granted") return;
      if (document.visibilityState === "visible") return;
      this._notify("需要操作", (data.agentId || "Agent") + " 请求权限", "notification");
    }

    _notify(title, body, tag) {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(function(reg) {
            reg.showNotification(title, { body: body, tag: "clawd-" + (tag || "default"), icon: "/mobile/icon-192.png" });
          });
        } else {
          new Notification(title, { body: body, tag: "clawd-" + (tag || "default") });
        }
      } catch {}
    }
  }

  // === ApprovalManager ===

  class ApprovalManager {
    constructor() {
      this.pending = new Map();
      this.overlay = document.getElementById("approval-overlay");
      this.onSend = null;
    }

    showRequest(msg) {
      var requestId = msg.requestId;
      if (!requestId) return;
      this.pending.set(requestId, msg);
      this._render();
      log("Approval request: " + (msg.data ? msg.data.toolName || msg.data.prompt || "unknown" : "unknown"));
    }

    dismiss(requestId) {
      this.pending.delete(requestId);
      this._render();
    }

    _render() {
      if (this.pending.size === 0) {
        this.overlay.classList.add("hidden");
        this.overlay.innerHTML = "";
        return;
      }

      var self = this;
      var html = '<div class="approval-sheet">';

      this.pending.forEach(function(msg, requestId) {
        var data = msg.data || {};
        var isPermission = msg.type === "permission_request";

        html += '<div class="approval-card">';
        html += '<div class="approval-header">';
        html += '<span class="approval-icon">' + icon("shield") + '</span>';
        html += '<span class="approval-agent">' + esc(data.agentId || "Agent") + '</span>';
        html += '<span class="approval-type">' + (isPermission ? "权限请求" : "选择操作") + '</span>';
        html += '</div>';

        if (isPermission) {
          if (data.toolName) html += '<div class="approval-tool">' + icon("tool") + ' ' + esc(data.toolName) + '</div>';
          if (data.toolInputSummary) html += '<div class="approval-summary">' + esc(data.toolInputSummary) + '</div>';
          html += '<div class="approval-actions">';
          if (data.suggestions && data.suggestions.length > 0) {
            for (var i = 0; i < data.suggestions.length; i++) {
              var sug = data.suggestions[i];
              var cls = sug.behavior === "allow" ? "allow" : sug.behavior === "deny" ? "deny" : "neutral";
              html += '<button class="approval-btn ' + cls + '" data-request="' + requestId + '" data-behavior="' + esc(sug.behavior || "") + '" data-index="' + i + '">' + esc(sug.label || sug.behavior || "选择") + '</button>';
            }
          } else {
            html += '<button class="approval-btn allow" data-request="' + requestId + '" data-behavior="allow">允许</button>';
            html += '<button class="approval-btn deny" data-request="' + requestId + '" data-behavior="deny">拒绝</button>';
          }
          html += '</div>';
        } else {
          if (data.prompt) html += '<div class="approval-summary">' + esc(data.prompt) + '</div>';
          html += '<div class="approval-actions">';
          if (data.options && data.options.length > 0) {
            for (var j = 0; j < data.options.length; j++) {
              var opt = data.options[j];
              html += '<button class="approval-btn neutral" data-request="' + requestId + '" data-elicitation="true" data-value="' + esc(opt.value || "") + '">' + esc(opt.label || opt.value || "选择") + '</button>';
            }
          }
          html += '</div>';
        }

        var timeout = data.timeout || 90000;
        html += '<div class="approval-timer"><div class="approval-timer-bar" style="animation-duration:' + timeout + 'ms"></div></div>';
        html += '</div>';
      });

      html += '</div>';
      this.overlay.innerHTML = html;
      this.overlay.classList.remove("hidden");

      this.overlay.querySelectorAll(".approval-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var rid = this.getAttribute("data-request");
          var behavior = this.getAttribute("data-behavior");
          var isElicitation = this.getAttribute("data-elicitation") === "true";
          var value = this.getAttribute("data-value");

          if (isElicitation) {
            if (self.onSend) self.onSend({ type: "elicitation_response", requestId: rid, answers: { value: value } });
          } else {
            var suggestionIndex = this.getAttribute("data-index");
            var payload = { type: "permission_response", requestId: rid, behavior: behavior };
            if (suggestionIndex !== null && suggestionIndex !== "") payload.suggestionIndex = parseInt(suggestionIndex, 10);
            if (self.onSend) self.onSend(payload);
          }
          self.dismiss(rid);
        });
      });
    }
  }

  // === ConnectionManager ===

  class ConnectionManager {
    constructor() {
      this.ws = null;
      this.config = null;
      this.reconnectDelay = 1000;
      this.maxReconnectDelay = 30000;
      this.reconnectTimer = null;
      this.state = "disconnected";
      this.onStateChange = null;
      this.onMessage = null;
    }

    connect(config) {
      this.config = config;
      this._saveToHistory(config);
      this._doConnect();
    }

    _doConnect() {
      if (this.ws) { try { this.ws.close(); } catch {} }
      var host = this.config.host;
      var port = this.config.port;
      var token = this.config.token;
      var url = "ws://" + host + ":" + port + "/ws?token=" + token;

      this._setState("connecting");
      log("Connecting to " + host + ":" + port + "...");

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        log("WebSocket create failed: " + err.message);
        this._scheduleReconnect();
        return;
      }

      var self = this;

      this.ws.onopen = function() {
        self.reconnectDelay = 1000;
        self._setState("connected");
        log("Connected");
        showToast("已连接到桌面端", "success");
      };

      this.ws.onmessage = function(event) {
        try {
          var msg = JSON.parse(event.data);
          if (self.onMessage) self.onMessage(msg);
        } catch {}
      };

      this.ws.onclose = function(event) {
        if (event.code === 1008) {
          self._setState("auth_failed");
          log("Auth failed (invalid token)");
          showToast("认证失败，请重新扫码", "error");
          return;
        }
        if (self.state === "connected") log("Disconnected (code: " + event.code + ")");
        self._scheduleReconnect();
      };

      this.ws.onerror = function() {};
    }

    send(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
      }
    }

    _scheduleReconnect() {
      this._setState("reconnecting");
      var self = this;
      this.reconnectTimer = setTimeout(function() {
        self.reconnectDelay = Math.min(self.reconnectDelay * 2, self.maxReconnectDelay);
        self._doConnect();
      }, this.reconnectDelay);
    }

    disconnect() {
      clearTimeout(this.reconnectTimer);
      if (this.ws) { try { this.ws.close(1000, "User disconnect"); } catch {} }
      this.ws = null;
      this._setState("disconnected");
      log("Disconnected by user");
    }

    _setState(state) {
      this.state = state;
      if (this.onStateChange) this.onStateChange(state);
    }

    _saveToHistory(config) {
      var history = [];
      try { history = JSON.parse(localStorage.getItem("clawd-history") || "[]"); } catch {}
      var entry = { host: config.host, port: config.port, token: config.token, timestamp: Date.now() };
      var filtered = history.filter(function(h) { return h.host !== config.host || h.port !== config.port; });
      filtered.unshift(entry);
      localStorage.setItem("clawd-history", JSON.stringify(filtered.slice(0, MAX_HISTORY)));
    }

    getHistory() {
      try { return JSON.parse(localStorage.getItem("clawd-history") || "[]"); }
      catch { return []; }
    }

    deleteHistory(index) {
      var history = this.getHistory();
      history.splice(index, 1);
      localStorage.setItem("clawd-history", JSON.stringify(history));
    }
  }

  // === SessionRenderer ===

  class SessionRenderer {
    constructor(container) {
      this.container = container;
      this.sessions = new Map();
      this.staleTimer = null;
      this.expandedSet = new Set();
    }

    updateFromSnapshot(sessions) {
      this.sessions.clear();
      for (var sid in sessions) {
        if (sessions.hasOwnProperty(sid)) this.sessions.set(sid, sessions[sid]);
      }
      this.render();
    }

    updateState(sessionId, data) {
      var existing = this.sessions.get(sessionId) || {};
      var merged = {};
      for (var k in existing) { if (existing.hasOwnProperty(k)) merged[k] = existing[k]; }
      for (var k2 in data) { if (data.hasOwnProperty(k2)) merged[k2] = data[k2]; }
      merged.updatedAt = Date.now();
      this.sessions.set(sessionId, merged);
      this.render();
    }

    removeSession(sessionId) {
      this.sessions.delete(sessionId);
      this.expandedSet.delete(sessionId);
      this.render();
    }

    toggleExpand(sid) {
      if (this.expandedSet.has(sid)) {
        this.expandedSet.delete(sid);
      } else {
        this.expandedSet.add(sid);
      }
      this.render();
    }

    render() {
      var self = this;
      var entries = [];
      this.sessions.forEach(function(v, k) { entries.push([k, v]); });

      entries.sort(function(a, b) {
        var pa = (STATE_CONFIG[a[1].state] || STATE_CONFIG.idle).priority;
        var pb = (STATE_CONFIG[b[1].state] || STATE_CONFIG.idle).priority;
        if (pa !== pb) return pa - pb;
        return (b[1].updatedAt || 0) - (a[1].updatedAt || 0);
      });

      if (entries.length === 0) {
        this.container.innerHTML = '<div class="empty-state" id="empty-state">' +
          '<div class="empty-icon">' + icon("paw") + '</div>' +
          '<div class="empty-text">扫码配对开始监控</div>' +
          '<button id="btn-scan-empty" class="primary-btn">扫码配对</button>' +
          '</div>';
        var scanBtn = document.getElementById("btn-scan-empty");
        if (scanBtn) scanBtn.addEventListener("click", function() {
          var app = window._clawdApp;
          if (app) app._openScanner();
        });
        return;
      }

      var html = '<div class="section-label">活跃会话 &middot; ' + entries.length + '</div>';
      for (var i = 0; i < entries.length; i++) {
        html += this._renderCard(entries[i][0], entries[i][1]);
      }
      this.container.innerHTML = html;

      // bind expand toggles
      this.container.querySelectorAll(".card-footer").forEach(function(el) {
        el.addEventListener("click", function() {
          var sid = this.getAttribute("data-sid");
          self.toggleExpand(sid);
        });
      });
    }

    _renderCard(sid, s) {
      var config = STATE_CONFIG[s.state] || STATE_CONFIG.idle;
      var isExpanded = this.expandedSet.has(sid);
      var events = (s.recentEvents || []);
      var hasEvents = events.length > 0;
      var stateKey = s.state || "idle";

      var html = '<div class="session-card" data-sid="' + sid + '">';

      // Header: agent dot + agent name + badge
      html += '<div class="card-header">';
      html += '<div class="card-agent">';
      html += '<div class="agent-dot"></div>';
      html += '<span class="agent-name">' + esc((s.agentId || "agent").toUpperCase()) + '</span>';
      html += '</div>';
      html += '<span class="state-badge ' + stateKey + '">' + config.label + '</span>';
      html += '</div>';

      // Title
      html += '<div class="card-title">' + esc(s.sessionTitle || s.agentId || "") + '</div>';

      // Meta row
      html += '<div class="card-meta">';
      if (s.agentId) {
        html += '<span class="meta-item">' + icon("tool") + '<span>Agent</span></span>';
      }
      if (s.cwd) {
        html += '<div class="meta-divider"></div>';
        html += '<span class="meta-item mono">' + icon("folder") + '<span>' + esc(shortPath(s.cwd)) + '</span></span>';
      }
      html += '</div>';

      // Last output preview
      if (s.lastOutput && s.lastOutput.output) {
        html += '<div class="card-output">' + esc(s.lastOutput.output) + '</div>';
      }

      // Divider
      html += '<div class="card-divider"></div>';

      // Footer: events + chevron
      html += '<div class="card-footer" data-sid="' + sid + '">';
      html += '<div class="footer-events">';
      html += icon("activity");
      html += '<span>最近事件</span>';
      if (hasEvents) {
        html += '<span class="event-count">' + events.length + '</span>';
      }
      html += '</div>';
      html += '<span class="footer-chevron">' + (isExpanded ? icon("collapse") : icon("expand")) + '</span>';
      html += '</div>';

      // Expanded events
      if (isExpanded && hasEvents) {
        html += this._renderEventHistory(events);
      }

      html += '</div>'; // .session-card
      return html;
    }

    _renderEventHistory(events) {
      var html = '<div class="event-history">';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var evConfig = STATE_CONFIG[ev.state] || STATE_CONFIG.idle;
        var label = eventLabel(ev.event);
        var time = formatAgo(ev.at);
        html += '<div class="event-row">';
        html += '<div class="event-dot" style="background:' + evConfig.color + '"></div>';
        html += '<div class="event-line" style="background:' + evConfig.color + '"></div>';
        html += '<span class="event-label">' + esc(label) + '</span>';
        html += '<span class="event-time">' + time + '</span>';
        html += '</div>';
      }
      html += '</div>';
      return html;
    }

    startStaleCleanup() {
      var self = this;
      this.staleTimer = setInterval(function() {
        var now = Date.now();
        var changed = false;
        self.sessions.forEach(function(s, sid) {
          if (s.state === "sleeping" && now - (s.updatedAt || 0) > STALE_TIMEOUT_MS) {
            self.sessions.delete(sid);
            changed = true;
          }
        });
        if (changed) self.render();
      }, 30000);
    }
  }

  // === QrScanner ===

  class QrScanner {
    constructor(videoElement, canvasElement) {
      this.video = videoElement;
      this.canvas = canvasElement;
      this.ctx = canvasElement.getContext("2d", { willReadFrequently: true });
      this.stream = null;
      this.scanning = false;
      this.onResult = null;
      this.onError = null;
    }

    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        var err = new Error("此浏览器不支持摄像头访问");
        if (this.onError) this.onError(err);
        throw err;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        this.video.srcObject = this.stream;
        await this.video.play();
        this.scanning = true;
        this._scanFrame();
      } catch (err) {
        var msg = "摄像头访问失败";
        if (err.name === "NotAllowedError") msg = "请允许摄像头权限后重试";
        if (err.name === "NotFoundError") msg = "未找到摄像头设备";
        var error = new Error(msg);
        if (this.onError) this.onError(error);
        throw error;
      }
    }

    stop() {
      this.scanning = false;
      if (this.stream) {
        this.stream.getTracks().forEach(function(t) { t.stop(); });
        this.stream = null;
      }
    }

    _scanFrame() {
      if (!this.scanning) return;
      var self = this;

      if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this.ctx.drawImage(this.video, 0, 0);

        var imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        if (typeof jsQR !== "undefined") {
          var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
          if (code && code.data) {
            var parsed = this._parseClawdUrl(code.data);
            if (parsed) {
              this.stop();
              if (this.onResult) this.onResult(parsed);
              return;
            }
          }
        }
      }

      requestAnimationFrame(function() { self._scanFrame(); });
    }

    _parseClawdUrl(data) {
      var match = data.match(/^clawd:\/\/([^:]+):(\d+)\/([a-f0-9]{16,})$/);
      if (match) return { host: match[1], port: parseInt(match[2], 10), token: match[3] };

      try {
        var obj = JSON.parse(data);
        if (obj.host && obj.port && obj.token) return { host: obj.host, port: parseInt(obj.port, 10), token: obj.token };
      } catch {}

      try {
        var url = new URL(data);
        if (url.protocol === "clawd:") return { host: url.hostname, port: parseInt(url.port, 10), token: url.pathname.slice(1) };
      } catch {}

      return null;
    }
  }

  // === App ===

  class App {
    constructor() {
      this.connection = new ConnectionManager();
      this.renderer = new SessionRenderer(document.getElementById("session-list"));
      this.scanner = new QrScanner(
        document.getElementById("qr-video"),
        document.getElementById("qr-canvas")
      );
      this.approval = new ApprovalManager();
      this.notifier = new NotificationManager();
      this._outputs = {};

      window._clawdApp = this;

      this._bindEvents();
      this._bindConnection();
      this._bindApproval();
      this._initThemeColor();
      this.renderer.startStaleCleanup();

      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/mobile/sw.js").catch(function() {});
      }
    }

    _initThemeColor() {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) return;
      var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
      function update() {
        meta.setAttribute("content", darkQuery.matches ? "#111318" : "#f5f5f7");
      }
      update();
      darkQuery.addEventListener("change", update);
    }

    _bindEvents() {
      var self = this;

      // QR scan buttons
      document.getElementById("btn-cancel-scan").addEventListener("click", function() { self._closeScanner(); });
      document.getElementById("btn-scan-empty")?.addEventListener("click", function() { self._openScanner(); });

      // Settings
      document.getElementById("btn-close-settings").addEventListener("click", function() { self._closeSettings(); });
      document.getElementById("btn-connect").addEventListener("click", function() { self._manualConnect(); });
      document.getElementById("btn-disconnect").addEventListener("click", function() { self.connection.disconnect(); });

      // Devices
      document.getElementById("btn-close-devices").addEventListener("click", function() {
        document.getElementById("devices-panel").classList.add("hidden");
      });

      // Bottom nav tabs
      document.querySelectorAll(".nav-tab").forEach(function(tab) {
        tab.addEventListener("click", function() {
          var tabIndex = parseInt(this.getAttribute("data-tab"), 10);
          self._onNavTab(tabIndex);
        });
      });

      // Log toggle
      document.getElementById("btn-toggle-log").addEventListener("click", function() {
        document.getElementById("log-panel").classList.toggle("collapsed");
      });

      // Copy buttons
      document.querySelectorAll(".copy-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var field = btn.getAttribute("data-copy");
          var text = document.getElementById("info-" + field).textContent;
          navigator.clipboard.writeText(text).then(function() {
            btn.textContent = "已复制";
            setTimeout(function() { btn.textContent = "复制"; }, 1500);
          });
        });
      });

      this.scanner.onResult = function(info) {
        self._closeScanner();
        self.connection.connect(info);
      };
      this.scanner.onError = function(err) {
        showToast(err.message, "error");
        self._closeScanner();
      };
    }

    _onNavTab(index) {
      // Update active state
      document.querySelectorAll(".nav-tab").forEach(function(t, i) {
        t.classList.toggle("active", i === index);
      });

      if (index === 0) {
        // Sessions - already visible
      } else if (index === 1) {
        document.getElementById("devices-panel").classList.remove("hidden");
      } else if (index === 2) {
        this._openSettings();
      }
    }

    _bindConnection() {
      var self = this;

      this.connection.onStateChange = function(state) {
        self._updateConnectionStatus(state);
        if (state === "connected") self.notifier.requestPermission();
      };

      this.connection.onMessage = function(msg) {
        if (msg.type === "snapshot") {
          self.renderer.updateFromSnapshot(msg.sessions || {});
          log("Snapshot: " + Object.keys(msg.sessions || {}).length + " sessions");
        } else if (msg.type === "state") {
          self.renderer.updateState(msg.sessionId, msg.data);
          self.notifier.onStateChange(msg.sessionId, msg.data);
        } else if (msg.type === "session_deleted") {
          self.renderer.removeSession(msg.sessionId);
          log("Session deleted: " + msg.sessionId);
        } else if (msg.type === "tool_output") {
          // Store last output on session data for display
          var sid = msg.sessionId;
          var session = self.renderer.sessions.get(sid);
          if (session) {
            session.lastOutput = { toolName: msg.data.toolName, output: (msg.data.output || "").substring(0, 200), at: msg.timestamp || Date.now() };
            self.renderer.render();
          }
        } else if (msg.type === "permission_request") {
          self.approval.showRequest({ type: "permission_request", requestId: msg.requestId, data: msg.data || msg });
          self.notifier.onApprovalNeeded(msg.data || msg);
        } else if (msg.type === "elicitation_request") {
          self.approval.showRequest({ type: "elicitation_request", requestId: msg.requestId, data: msg.data || msg });
          self.notifier.onApprovalNeeded(msg.data || msg);
        }
      };
    }

    _updateConnectionStatus(state) {
      var config = CONNECTION_STATES[state] || CONNECTION_STATES.disconnected;
      var dot = document.getElementById("connection-dot");
      var text = document.getElementById("connection-text");

      dot.className = "connection-dot " + config.dot;

      if (state === "connected") {
        text.textContent = config.text;
        text.className = "connection-text connected";
      } else if (state === "disconnected") {
        text.textContent = "";
        text.className = "connection-text";
      } else {
        text.textContent = config.text;
        text.className = "connection-text";
      }
    }

    _bindApproval() {
      var self = this;
      this.approval.onSend = function(response) {
        self.connection.send(response);
        log("Sent: " + response.type);
      };
    }

    _openScanner() {
      var overlay = document.getElementById("qr-overlay");
      overlay.classList.remove("hidden");
      this.scanner.start().catch(function(err) {
        showToast(err.message, "error");
        overlay.classList.add("hidden");
      });
    }

    _closeScanner() {
      this.scanner.stop();
      document.getElementById("qr-overlay").classList.add("hidden");
    }

    _openSettings() {
      var panel = document.getElementById("settings-panel");
      panel.classList.remove("hidden");
      this._renderHistory();

      if (this.connection.config) {
        document.getElementById("input-host").value = this.connection.config.host || "";
        document.getElementById("input-port").value = this.connection.config.port || "";
        document.getElementById("input-token").value = this.connection.config.token || "";
      }

      var info = document.getElementById("current-info");
      if (this.connection.config) {
        info.style.display = "block";
        document.getElementById("info-host").textContent = this.connection.config.host || "—";
        document.getElementById("info-port").textContent = this.connection.config.port || "—";
        document.getElementById("info-token").textContent = this.connection.config.token || "—";
      } else {
        info.style.display = "none";
      }
    }

    _closeSettings() {
      document.getElementById("settings-panel").classList.add("hidden");
    }

    _manualConnect() {
      var host = document.getElementById("input-host").value.trim();
      var port = parseInt(document.getElementById("input-port").value, 10);
      var token = document.getElementById("input-token").value.trim();

      if (!host || !port || !token) {
        showToast("请填写完整连接信息", "error");
        return;
      }

      this.connection.connect({ host: host, port: port, token: token });
      this._closeSettings();
    }

    _renderHistory() {
      var history = this.connection.getHistory();
      var container = document.getElementById("connection-history");
      if (history.length === 0) { container.innerHTML = ""; return; }

      var self = this;
      var html = '<h4 style="margin:16px 0 8px;font-size:14px;color:var(--muted)">连接历史</h4>';
      history.forEach(function(h, i) {
        var ago = formatAgo(h.timestamp);
        html += '<div class="history-item">';
        html += '<span class="history-addr">' + esc(h.host) + ':' + h.port + '</span>';
        html += '<span class="history-time">' + ago + '</span>';
        html += '<button class="history-connect" data-index="' + i + '">连接</button>';
        html += '<button class="history-delete" data-index="' + i + '">&times;</button>';
        html += '</div>';
      });
      container.innerHTML = html;

      container.querySelectorAll(".history-connect").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var idx = parseInt(this.getAttribute("data-index"), 10);
          var entry = self.connection.getHistory()[idx];
          if (entry) { self.connection.connect(entry); self._closeSettings(); }
        });
      });

      container.querySelectorAll(".history-delete").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var idx = parseInt(this.getAttribute("data-index"), 10);
          self.connection.deleteHistory(idx);
          self._renderHistory();
        });
      });
    }
  }

  // === Init ===

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() { new App(); });
  } else {
    new App();
  }

})();

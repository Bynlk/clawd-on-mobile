(function() {
  "use strict";

  // === 常量 ===

  var STATE_CONFIG = {
    error:        { icon: "error",        color: "#ef4444", priority: 0, label: "错误" },
    attention:    { icon: "attention",    color: "#b45309", priority: 1, label: "需要关注" },
    working:      { icon: "working",      color: "#16803c", priority: 2, label: "工作中" },
    juggling:     { icon: "juggling",     color: "#16803c", priority: 2, label: "多任务" },
    thinking:     { icon: "thinking",     color: "#3b82f6", priority: 3, label: "思考中" },
    notification: { icon: "notification", color: "#d97757", priority: 4, label: "通知" },
    sweeping:     { icon: "sweeping",     color: "#71717a", priority: 5, label: "清理中" },
    carrying:     { icon: "carrying",     color: "#71717a", priority: 5, label: "搬运中" },
    idle:         { icon: "idle",         color: "#71717a", priority: 6, label: "空闲" },
    sleeping:     { icon: "sleeping",     color: "#a1a1aa", priority: 7, label: "休眠" },
  };

  var CONNECTION_STATES = {
    connected:    { dot: "connected", text: "已连接", color: "#16803c" },
    connecting:   { dot: "connecting", text: "连接中...", color: "#b45309" },
    reconnecting: { dot: "reconnecting", text: "重连中...", color: "#ef4444" },
    disconnected: { dot: "", text: "未连接", color: "#71717a" },
    auth_failed:  { dot: "", text: "认证失败", color: "#ef4444" },
  };

  var STALE_TIMEOUT_MS = 5 * 60 * 1000;
  var MAX_HISTORY = 5;

  // === 工具函数 ===

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
    return (typeof EVENT_LABELS !== "undefined" && EVENT_LABELS[eventName]) || eventName || "";
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

  // === Toast ===

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
      if (Notification.permission === "granted") {
        this.permission = "granted";
        return;
      }
      if (Notification.permission !== "denied") {
        var self = this;
        Notification.requestPermission().then(function(p) {
          self.permission = p;
        });
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
          if (data.toolName) {
            html += '<div class="approval-tool">' + icon("tool") + ' ' + esc(data.toolName) + '</div>';
          }
          if (data.toolInputSummary) {
            html += '<div class="approval-summary">' + esc(data.toolInputSummary) + '</div>';
          }
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
          // elicitation
          if (data.prompt) {
            html += '<div class="approval-summary">' + esc(data.prompt) + '</div>';
          }
          html += '<div class="approval-actions">';
          if (data.options && data.options.length > 0) {
            for (var j = 0; j < data.options.length; j++) {
              var opt = data.options[j];
              html += '<button class="approval-btn neutral" data-request="' + requestId + '" data-elicitation="true" data-value="' + esc(opt.value || "") + '">' + esc(opt.label || opt.value || "选择") + '</button>';
            }
          }
          html += '</div>';
        }

        // timeout bar
        var timeout = data.timeout || 90000;
        html += '<div class="approval-timer"><div class="approval-timer-bar" style="animation-duration:' + timeout + 'ms"></div></div>';
        html += '</div>';
      });

      html += '</div>';
      this.overlay.innerHTML = html;
      this.overlay.classList.remove("hidden");

      // bind buttons
      this.overlay.querySelectorAll(".approval-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var rid = this.getAttribute("data-request");
          var behavior = this.getAttribute("data-behavior");
          var isElicitation = this.getAttribute("data-elicitation") === "true";
          var value = this.getAttribute("data-value");

          if (isElicitation) {
            if (self.onSend) {
              self.onSend({
                type: "elicitation_response",
                requestId: rid,
                answers: { value: value },
              });
            }
          } else {
            var suggestionIndex = this.getAttribute("data-index");
            var payload = {
              type: "permission_response",
              requestId: rid,
              behavior: behavior,
            };
            if (suggestionIndex !== null && suggestionIndex !== "") {
              payload.suggestionIndex = parseInt(suggestionIndex, 10);
            }
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
      if (this.ws) {
        try { this.ws.close(); } catch {}
      }

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
        if (self.state === "connected") {
          log("Disconnected (code: " + event.code + ")");
        }
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
      if (this.ws) {
        try { this.ws.close(1000, "User disconnect"); } catch {}
      }
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
      var filtered = history.filter(function(h) {
        return h.host !== config.host || h.port !== config.port;
      });
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
        if (sessions.hasOwnProperty(sid)) {
          this.sessions.set(sid, sessions[sid]);
        }
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

      var html = "";
      for (var i = 0; i < entries.length; i++) {
        html += this._renderCard(entries[i][0], entries[i][1]);
      }
      this.container.innerHTML = html;

      // bind expand toggles
      this.container.querySelectorAll(".expand-trigger").forEach(function(el) {
        el.addEventListener("click", function() {
          var sid = this.getAttribute("data-sid");
          self.toggleExpand(sid);
        });
      });
    }

    _renderCard(sid, s) {
      var config = STATE_CONFIG[s.state] || STATE_CONFIG.idle;
      var ago = formatAgo(s.updatedAt);
      var isExpanded = this.expandedSet.has(sid);
      var events = (s.recentEvents || []);
      var hasEvents = events.length > 0;
      var isActive = s.state === "working" || s.state === "thinking" || s.state === "juggling";

      var html = '<div class="session-card" data-sid="' + sid + '">';

      // state dot (7px)
      html += '<div class="state-dot" style="background:' + config.color +
        (isActive ? ';animation:pulse 2s infinite' : '') + '"></div>';

      // main content
      html += '<div class="main">';

      // title
      html += '<div class="session-title">' + esc(s.sessionTitle || s.agentId || sid) + '</div>';

      // meta row
      html += '<div class="meta">';
      if (s.agentId) {
        html += '<span class="agent-id">' + esc(s.agentId) + '</span>';
      }
      html += '<span class="state-label" style="color:' + config.color + '">' + config.label + '</span>';
      html += '</div>';

      // tool info
      if (s.toolName) {
        html += '<div class="tool-info">' + icon("tool") + '<span>' + esc(s.toolName) + '</span></div>';
      }

      // cwd
      if (s.cwd) {
        html += '<div class="cwd">' + icon("folder") + '<span>' + esc(shortPath(s.cwd)) + '</span></div>';
      }

      // expand trigger
      if (hasEvents) {
        var chevronIcon = isExpanded ? icon("collapse") : icon("expand");
        html += '<div class="expand-trigger" data-sid="' + sid + '">';
        html += '<span class="expand-chevron">' + chevronIcon + '</span>';
        html += '<span class="expand-label">最近事件 (' + events.length + ')</span>';
        html += '</div>';

        if (isExpanded) {
          html += this._renderEventHistory(events);
        }
      }

      // output panel
      html += this._renderOutputPanel(sid);

      // footer
      html += '<div class="session-footer">' + icon("clock") + ' ' + ago + '</div>';
      html += '</div>'; // .main
      html += '</div>'; // .session-card
      return html;
    }

    _renderOutputPanel(sid) {
      var outputs = window._clawdApp ? window._clawdApp._outputs[sid] : null;
      if (!outputs || outputs.length === 0) return '';
      var html = '<div class="output-panel">';
      outputs.forEach(function(o) {
        html += '<div class="output-entry">' +
          '<span class="output-time">' + formatAgo(o.at) + '</span>' +
          '<span class="tool-name">' + esc(o.toolName || '') + '</span>: ' +
          '<span>' + esc((o.output || '').substring(0, 200)) + '</span>' +
        '</div>';
      });
      return html + '</div>';
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
          var code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
          });
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
        if (obj.host && obj.port && obj.token) {
          return { host: obj.host, port: parseInt(obj.port, 10), token: obj.token };
        }
      } catch {}

      try {
        var url = new URL(data);
        if (url.protocol === "clawd:") {
          return { host: url.hostname, port: parseInt(url.port, 10), token: url.pathname.slice(1) };
        }
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
      // Set theme-color based on color scheme
      var meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) return;
      var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
      function update() {
        meta.setAttribute("content", darkQuery.matches ? "#1c1c1f" : "#f5f5f7");
      }
      update();
      darkQuery.addEventListener("change", update);
    }

    _bindEvents() {
      var self = this;

      document.getElementById("btn-scan").addEventListener("click", function() { self._openScanner(); });
      document.getElementById("btn-cancel-scan").addEventListener("click", function() { self._closeScanner(); });

      document.getElementById("btn-settings").addEventListener("click", function() { self._openSettings(); });
      document.getElementById("btn-close-settings").addEventListener("click", function() { self._closeSettings(); });
      document.getElementById("btn-connect").addEventListener("click", function() { self._manualConnect(); });
      document.getElementById("btn-disconnect").addEventListener("click", function() { self.connection.disconnect(); });

      document.getElementById("btn-toggle-log").addEventListener("click", function() {
        document.getElementById("log-panel").classList.toggle("collapsed");
      });

      // Copy buttons in settings
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

    _bindConnection() {
      var self = this;

      this.connection.onStateChange = function(state) {
        self._updateFloatingHeader(state);
        if (state === "connected") {
          self.notifier.requestPermission();
        }
      };

      this.connection.onMessage = function(msg) {
        if (msg.type === "snapshot") {
          self.renderer.updateFromSnapshot(msg.sessions || {});
          log("Snapshot: " + Object.keys(msg.sessions || {}).length + " sessions");
        } else if (msg.type === "state") {
          self.renderer.updateState(msg.sessionId, msg.data);
          self.notifier.onStateChange(msg.sessionId, msg.data);
        } else if (msg.type === "tool_output") {
          var sid = msg.sessionId;
          if (!self._outputs[sid]) self._outputs[sid] = [];
          self._outputs[sid].unshift({
            at: msg.timestamp || Date.now(),
            toolName: msg.data.toolName,
            output: msg.data.output
          });
          if (self._outputs[sid].length > 20) self._outputs[sid].pop();
          self.renderer.render();
        } else if (msg.type === "permission_request") {
          self.approval.showRequest({ type: "permission_request", requestId: msg.requestId, data: msg.data || msg });
          self.notifier.onApprovalNeeded(msg.data || msg);
        } else if (msg.type === "elicitation_request") {
          self.approval.showRequest({ type: "elicitation_request", requestId: msg.requestId, data: msg.data || msg });
          self.notifier.onApprovalNeeded(msg.data || msg);
        }
      };
    }

    _updateFloatingHeader(state) {
      var config = CONNECTION_STATES[state] || CONNECTION_STATES.disconnected;
      var dot = document.getElementById("status-dot");
      var label = document.getElementById("host-label");

      dot.className = "status-dot " + config.dot;

      if (state === "connected" && this.connection.config) {
        label.textContent = this.connection.config.host + ":" + this.connection.config.port;
      } else {
        label.textContent = "";
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

      // Show connection info
      var info = document.getElementById("current-info");
      if (this.connection.config && this.connection.state === "connected") {
        info.style.display = "block";
        document.getElementById("info-host").textContent = this.connection.config.host;
        document.getElementById("info-port").textContent = this.connection.config.port;
        document.getElementById("info-token").textContent = this.connection.config.token;
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
      if (history.length === 0) {
        container.innerHTML = "";
        return;
      }

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
          if (entry) {
            self.connection.connect(entry);
            self._closeSettings();
          }
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

  // === 初始化 ===

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() { new App(); });
  } else {
    new App();
  }

})();

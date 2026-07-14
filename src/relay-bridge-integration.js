"use strict";

const WebSocket = require("ws");
const { EventEmitter } = require("node:events");

const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const MSG_BUFFER_MAX = 50;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Relay bridge config is required");
  }
  let parsed;
  try { parsed = new URL(input.url); } catch (_) { throw new TypeError("Relay bridge url is invalid"); }
  if (!['ws:', 'wss:'].includes(parsed.protocol)
      || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Relay bridge url must be a ws/wss origin");
  }
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 4096) {
    throw new TypeError("Relay bridge token is required");
  }
  return { url: input.url.replace(/\/$/, ""), token: input.token };
}

class RelayBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.localToken = typeof options.localToken === "string" ? options.localToken : "";
    this.getLocalToken = typeof options.getLocalToken === "function"
      ? options.getLocalToken
      : () => this.localToken;
    this.getLocalPort = typeof options.getLocalPort === "function" ? options.getLocalPort : () => 23334;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.config = null;
    this.running = false;
    this.relayWs = null;
    this.localWs = null;
    this._localSockets = new Set();
    this.msgBuffer = [];
    this.relayReconnectTimer = null;
    this.localReconnectTimer = null;
    this._status = "disconnected";
    this._peerOnline = false;
    this._generation = 0;
    this._relayOpen = false;
    this._localOpen = false;
    this._reconnectAttempt = 0;
    this._lastFailure = null;
    this._stopPromise = null;
    this._disposePromise = null;
    this._disposed = false;
    this._prefsDisposers = [];
    this._prefsGeneration = 0;
    this._prefsState = null;
  }

  get status() { return this._status; }
  get peerOnline() { return this._peerOnline; }

  configure(input) {
    if (this._disposed) throw new Error("Relay bridge is disposed");
    const config = normalizeConfig(input);
    if (this.running) {
      if (this.config && this.config.url === config.url && this.config.token === config.token) return this;
      throw new Error("Relay bridge is running");
    }
    this.config = config;
    this._lastFailure = null;
    return this;
  }

  init(prefs) {
    if (this._disposed) throw new Error("Relay bridge is disposed");
    if (!prefs || typeof prefs.get !== "function") {
      throw new TypeError("Relay bridge prefs must expose get(name)");
    }
    this._clearPrefsListeners();
    const current = {
      generation: ++this._prefsGeneration,
      enabled: Boolean(prefs.get("relayEnabled")),
      url: prefs.get("relayUrl") || "",
      token: prefs.get("relayToken") || "",
      revision: 0,
      appliedRevision: -1,
      reconcilePromise: null,
    };
    this._prefsState = current;
    this._reconcilePrefs(current);

    if (typeof prefs.subscribeKey === "function" || typeof prefs.on === "function") {
      const listen = (name, handler) => {
        if (typeof prefs.subscribeKey === "function") {
          const dispose = prefs.subscribeKey(name, handler);
          if (typeof dispose === "function") this._prefsDisposers.push(dispose);
          return;
        }
        prefs.on(name, handler);
        this._prefsDisposers.push(() => {
          if (typeof prefs.off === "function") prefs.off(name, handler);
        });
      };
      listen("relayEnabled", (value) => {
        current.enabled = Boolean(value);
        this._reconcilePrefs(current);
      });
      listen("relayUrl", (value) => {
        current.url = value || "";
        this._reconcilePrefs(current);
      });
      listen("relayToken", (value) => {
        current.token = value || "";
        this._reconcilePrefs(current);
      });
    }
    return this;
  }

  start() {
    if (this._disposed) throw new Error("Relay bridge is disposed");
    if (this.running) return this;
    if (!this.config) throw new Error("Relay bridge is not configured");
    this.running = true;
    this._generation += 1;
    this._relayOpen = false;
    this._localOpen = false;
    this._lastFailure = null;
    this._setStatus("connecting");
    this.connectToRelay(this._generation);
    return this;
  }

  waitUntilConnected(timeoutMs = 15_000) {
    if (this._status === "connected") return Promise.resolve();
    if (this._lastFailure) return Promise.reject(codedError(this._lastFailure));
    if (!this.running) return Promise.reject(codedError("relay_not_running"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.off("status", onStatus);
        this.off("failure", onFailure);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onStatus = (status) => { if (status === "connected") finish(); };
      const onFailure = (failure) => finish(codedError(failure.errorCode));
      const timer = setTimeout(() => finish(codedError("relay_connect_timeout")), timeoutMs);
      this.on("status", onStatus);
      this.on("failure", onFailure);
    });
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    this.running = false;
    this._generation += 1;
    this._relayOpen = false;
    this._localOpen = false;
    this._peerOnline = false;
    this.clearTimers();
    const relay = this.relayWs;
    const locals = new Set(this._localSockets);
    if (this.localWs) locals.add(this.localWs);
    this.relayWs = null;
    this.localWs = null;
    this._localSockets.clear();
    this.msgBuffer = [];
    this._setStatus("disconnected");
    this.emit("peer", false);
    this.closeWs(relay, "bridge stopped");
    for (const local of locals) this.closeWs(local, "bridge stopped");
    const stopping = Promise.resolve();
    const wrapped = stopping.finally(() => {
      if (this._stopPromise === wrapped) this._stopPromise = null;
    });
    this._stopPromise = wrapped;
    return wrapped;
  }

  destroy() {
    return this.dispose();
  }

  clearConfig() {
    this.config = null;
    this.msgBuffer = [];
    this._lastFailure = null;
    return this;
  }

  dispose() {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    const hasActivity = this.running || this.relayWs || this.localWs
      || this._localSockets.size || this.relayReconnectTimer || this.localReconnectTimer;
    const stopping = hasActivity ? this.stop() : (this._stopPromise || Promise.resolve());
    this.clearConfig();
    this._prefsState = null;
    this._prefsGeneration += 1;
    this._clearPrefsListeners();
    this.removeAllListeners();
    this._disposePromise = Promise.resolve(stopping);
    return this._disposePromise;
  }

  connectToRelay(generation = this._generation) {
    if (!this._active(generation)) return;
    const relayUrl = `${this.config.url}/mobile/ws?role=pc`;
    let ws;
    try {
      ws = new this.WebSocketImpl(relayUrl, {
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
    } catch (_) {
      this._reportFailure("relay_connect_failed", generation);
      return;
    }
    this.relayWs = ws;

    ws.on("open", () => {
      if (!this._activeSocket(generation, "relayWs", ws)) return;
      this._relayOpen = true;
      this._reconnectAttempt = 0;
      this.clearRelayReconnect();
      this.connectToLocal(generation);
      this._markConnected(generation);
    });
    ws.on("unexpected-response", (_request, response) => {
      if (!this._activeSocket(generation, "relayWs", ws)) return;
      const code = response && [401, 403].includes(response.statusCode)
        ? "relay_auth_failed" : "relay_connect_failed";
      this._reportFailure(code, generation);
    });
    ws.on("message", (data) => {
      if (!this._activeSocket(generation, "relayWs", ws)) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "peer_connected") {
          this._peerOnline = true;
          this.emit("peer", true);
          return;
        }
        if (message.type === "peer_disconnected") {
          this._peerOnline = false;
          this.emit("peer", false);
          return;
        }
        if (message.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() })); } catch (_) {}
          return;
        }
      } catch (_) {}
      this.forwardToLocal(data);
    });
    ws.on("close", () => {
      if (!this._activeSocket(generation, "relayWs", ws)) return;
      this.relayWs = null;
      this._relayOpen = false;
      this._peerOnline = false;
      this.emit("peer", false);
      this._reportFailure("relay_connect_failed", generation);
      if (this._active(generation)) this.scheduleRelayReconnect(generation);
    });
    ws.on("error", () => {
      if (!this._activeSocket(generation, "relayWs", ws)) return;
      this._reportFailure("relay_connect_failed", generation);
    });
  }

  connectToLocal(generation = this._generation) {
    if (!this._active(generation)) return;
    const existing = this.localWs;
    if (existing && (existing.readyState === this.WebSocketImpl.OPEN
        || existing.readyState === this.WebSocketImpl.CONNECTING)) {
      this.clearLocalReconnect();
      this._localOpen = existing.readyState === this.WebSocketImpl.OPEN;
      this._markConnected(generation);
      return;
    }
    this.clearLocalReconnect();
    if (existing) {
      this.localWs = null;
      this._localOpen = false;
      this.closeWs(existing, "local socket replaced");
    }
    let localToken;
    let localPort;
    try {
      localToken = this.getLocalToken();
      localPort = this.getLocalPort();
    } catch (_) {
      this._reportFailure("local_connect_failed", generation);
      return;
    }
    if (typeof localToken !== "string" || localToken.length === 0 || localToken.length > 4096
        || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      this._reportFailure("local_connect_failed", generation);
      return;
    }
    const localUrl = `ws://127.0.0.1:${localPort}/mobile/ws?role=pc`;
    let ws;
    try {
      ws = new this.WebSocketImpl(localUrl, {
        headers: { Authorization: `Bearer ${localToken}` },
      });
    } catch (_) {
      this._reportFailure("local_connect_failed", generation);
      return;
    }
    this.localWs = ws;
    this._localSockets.add(ws);
    ws.on("open", () => {
      if (!this._activeSocket(generation, "localWs", ws)) return;
      this._localOpen = true;
      this.clearLocalReconnect();
      this.flushBuffer();
      this._markConnected(generation);
    });
    ws.on("message", (data) => {
      if (this._activeSocket(generation, "localWs", ws)) this.forwardToRelay(data);
    });
    ws.on("close", () => {
      this._localSockets.delete(ws);
      if (!this._activeSocket(generation, "localWs", ws)) return;
      this.localWs = null;
      this._localOpen = false;
      this._setStatus("connecting");
      if (this._active(generation)) this.scheduleLocalReconnect(generation);
    });
    ws.on("error", () => {
      if (this._activeSocket(generation, "localWs", ws)) {
        this._reportFailure("local_connect_failed", generation);
      }
    });
  }

  forwardToLocal(data) {
    if (this.localWs && this.localWs.readyState === this.WebSocketImpl.OPEN) this.localWs.send(data);
    else this.bufferMsg(data);
  }

  forwardToRelay(data) {
    if (this.relayWs && this.relayWs.readyState === this.WebSocketImpl.OPEN) this.relayWs.send(data);
  }

  bufferMsg(data) {
    if (this.msgBuffer.length >= MSG_BUFFER_MAX) this.msgBuffer.shift();
    this.msgBuffer.push(data);
  }

  flushBuffer() {
    while (this.msgBuffer.length && this.localWs && this.localWs.readyState === this.WebSocketImpl.OPEN) {
      this.localWs.send(this.msgBuffer.shift());
    }
  }

  scheduleRelayReconnect(generation = this._generation) {
    this.clearRelayReconnect();
    const delay = this.getReconnectDelay();
    this._setStatus("connecting");
    this.relayReconnectTimer = setTimeout(() => this.connectToRelay(generation), delay);
  }

  scheduleLocalReconnect(generation = this._generation) {
    this.clearLocalReconnect();
    this.localReconnectTimer = setTimeout(() => this.connectToLocal(generation), RECONNECT_INITIAL_MS);
  }

  getReconnectDelay() {
    this._reconnectAttempt += 1;
    const base = RECONNECT_INITIAL_MS * (RECONNECT_BACKOFF_MULTIPLIER ** (this._reconnectAttempt - 1));
    return Math.min(base + Math.random() * base * 0.3, RECONNECT_MAX_MS);
  }

  clearRelayReconnect() {
    if (this.relayReconnectTimer) clearTimeout(this.relayReconnectTimer);
    this.relayReconnectTimer = null;
  }

  clearLocalReconnect() {
    if (this.localReconnectTimer) clearTimeout(this.localReconnectTimer);
    this.localReconnectTimer = null;
  }

  clearTimers() {
    this.clearRelayReconnect();
    this.clearLocalReconnect();
  }

  closeWs(ws, reason) {
    if (!ws) return;
    try {
      if (ws.readyState === this.WebSocketImpl.OPEN && typeof ws.close === "function") ws.close(1000, reason);
      else if (typeof ws.terminate === "function") ws.terminate();
      else if (typeof ws.close === "function") ws.close(1000, reason);
    } catch (_) {}
  }

  _active(generation) {
    return this.running && generation === this._generation;
  }

  _activeSocket(generation, field, socket) {
    return this._active(generation) && this[field] === socket;
  }

  _markConnected(generation) {
    if (this._active(generation) && this._relayOpen && this._localOpen) {
      this._lastFailure = null;
      this._setStatus("connected");
    }
  }

  _reportFailure(errorCode, generation) {
    if (!this._active(generation)) return;
    this._lastFailure = errorCode;
    this.emit("failure", { errorCode, generation });
  }

  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this.emit("status", status);
  }

  _clearPrefsListeners() {
    while (this._prefsDisposers.length) {
      try { this._prefsDisposers.pop()(); } catch (_) {}
    }
  }

  _reconcilePrefs(state) {
    if (this._prefsState !== state || state.generation !== this._prefsGeneration) {
      return Promise.resolve();
    }
    state.revision += 1;
    if (state.reconcilePromise) return state.reconcilePromise;

    const reconcile = async () => {
      while (this._prefsState === state
          && state.generation === this._prefsGeneration
          && state.appliedRevision !== state.revision) {
        const revision = state.revision;
        let desiredConfig = null;
        if (state.enabled && state.url && state.token) {
          try { desiredConfig = normalizeConfig(state); } catch (_) {}
        }

        if (!desiredConfig) {
          if (this.running) await this.stop();
          if (this._prefsState !== state || revision !== state.revision) continue;
          this.clearConfig();
          state.appliedRevision = revision;
          continue;
        }

        const sameConfig = this.config
          && this.config.url === desiredConfig.url
          && this.config.token === desiredConfig.token;
        if (this.running && sameConfig) {
          state.appliedRevision = revision;
          continue;
        }
        if (this.running) await this.stop();
        if (this._prefsState !== state
            || state.generation !== this._prefsGeneration
            || revision !== state.revision
            || !state.enabled || !state.url || !state.token) continue;
        this.configure(desiredConfig).start();
        state.appliedRevision = revision;
      }
    };

    const promise = reconcile();
    state.reconcilePromise = promise;
    const settled = () => {
      if (state.reconcilePromise === promise) state.reconcilePromise = null;
      if (this._prefsState === state && state.appliedRevision !== state.revision) {
        this._reconcilePrefs(state);
      }
    };
    promise.then(settled, settled);
    return promise;
  }
}

let instance = null;

function initRelayBridge(prefs, options = {}) {
  if (instance) instance.destroy();
  instance = new RelayBridge(options);
  instance.init(prefs);
  return instance;
}

function getRelayBridge() { return instance; }

module.exports = { initRelayBridge, getRelayBridge, RelayBridge };

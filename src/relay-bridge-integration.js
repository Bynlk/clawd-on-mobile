// src/relay-bridge-integration.js — Relay bridge 集成到 Electron 主进程
// 将 relay-bridge.js 的功能封装为可管理的模块

"use strict";

const WebSocket = require("ws");
const { EventEmitter } = require("events");

const TAG = "[relay-bridge]";

// 重连参数
const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const MSG_BUFFER_MAX = 50;

class RelayBridge extends EventEmitter {
  constructor() {
    super();
    this.relayWs = null;
    this.localWs = null;
    this.config = null;
    this.running = false;
    this.msgBuffer = [];
    this.relayReconnectTimer = null;
    this.localReconnectTimer = null;
    this._status = "disconnected"; // disconnected | connecting | connected
    this._peerOnline = false;
  }

  /** 当前连接状态 */
  get status() { return this._status; }

  /** 对端是否在线 */
  get peerOnline() { return this._peerOnline; }

  /**
   * 初始化并启动 relay bridge
   * @param {object} prefs — prefs 模块实例，读取 relay 配置
   */
  init(prefs) {
    this.config = {
      enabled: prefs.get("relayEnabled") || false,
      url: prefs.get("relayUrl") || "",
      token: prefs.get("relayToken") || "",
    };

    if (!this.config.enabled || !this.config.url || !this.config.token) {
      console.log(TAG, "未启用或未配置，跳过");
      return;
    }

    this.start();

    // 监听 prefs 变更
    if (prefs.on) {
      prefs.on("relayEnabled", (val) => {
        this.config.enabled = val;
        if (val) this.start(); else this.stop();
      });
      prefs.on("relayUrl", (val) => {
        this.config.url = val;
        if (this.config.enabled) { this.stop(); this.start(); }
      });
      prefs.on("relayToken", (val) => {
        this.config.token = val;
        if (this.config.enabled) { this.stop(); this.start(); }
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._status = "connecting";
    this.emit("status", this._status);
    console.log(TAG, "启动 relay bridge...");
    this.connectToRelay();
  }

  stop() {
    this.running = false;
    this._status = "disconnected";
    this._peerOnline = false;
    this.emit("status", this._status);
    this.emit("peer", false);
    this.clearTimers();
    this.closeWs(this.relayWs, "bridge stopped");
    this.closeWs(this.localWs, "bridge stopped");
    this.relayWs = null;
    this.localWs = null;
    this.msgBuffer = [];
    console.log(TAG, "已停止");
  }

  destroy() {
    this.stop();
    this.removeAllListeners();
  }

  // --- Relay 连接 ---

  connectToRelay() {
    if (!this.running) return;
    const { url, token } = this.config;
    const relayUrl = `${url}/mobile/ws?role=pc`;

    console.log(TAG, `连接 relay: ${url}`);
    const ws = new WebSocket(relayUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      console.log(TAG, "已连接到 relay");
      this.relayWs = ws;
      this._status = "connected";
      this.emit("status", this._status);
      this.clearRelayReconnect();
      // 连接本地 hook server
      this.connectToLocal();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // 过滤 relay 控制消息
        if (msg.type === "peer_connected") {
          this._peerOnline = true;
          this.emit("peer", true);
          console.log(TAG, `对端 (${msg.role}) 已连接`);
          return;
        }
        if (msg.type === "peer_disconnected") {
          this._peerOnline = false;
          this.emit("peer", false);
          console.log(TAG, `对端 (${msg.role}) 已断开`);
          return;
        }
        if (msg.type === "ping") {
          // 回复 pong
          try { ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() })); } catch {}
          return;
        }
      } catch {}
      // 转发到本地
      this.forwardToLocal(data);
    });

    ws.on("close", (code, reason) => {
      console.log(TAG, `relay 连接断开: ${code} ${reason}`);
      this.relayWs = null;
      this._peerOnline = false;
      this.emit("peer", false);
      if (this.running) this.scheduleRelayReconnect();
    });

    ws.on("error", (err) => {
      console.error(TAG, "relay 连接错误:", err.message);
    });
  }

  // --- Local 连接 ---

  connectToLocal() {
    if (!this.running) return;
    // 连接到本地 mobile WS server（端口 23334，路径 /mobile/ws）
    const localUrl = "ws://localhost:23334/mobile/ws?role=pc";
    console.log(TAG, `连接本地: ${localUrl}`);

    const ws = new WebSocket(localUrl);

    ws.on("open", () => {
      console.log(TAG, "已连接到本地 hook server");
      this.localWs = ws;
      this.clearLocalReconnect();
      // 发送缓冲消息
      this.flushBuffer();
    });

    ws.on("message", (data) => {
      // 转发到 relay
      this.forwardToRelay(data);
    });

    ws.on("close", (code) => {
      console.log(TAG, `本地连接断开: ${code}`);
      this.localWs = null;
      if (this.running) this.scheduleLocalReconnect();
    });

    ws.on("error", (err) => {
      console.error(TAG, "本地连接错误:", err.message);
    });
  }

  // --- 消息转发 ---

  forwardToLocal(data) {
    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(data);
    } else {
      this.bufferMsg(data);
    }
  }

  forwardToRelay(data) {
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      this.relayWs.send(data);
    }
  }

  bufferMsg(data) {
    if (this.msgBuffer.length >= MSG_BUFFER_MAX) {
      this.msgBuffer.shift(); // 丢弃最旧的
    }
    this.msgBuffer.push(data);
  }

  flushBuffer() {
    while (this.msgBuffer.length > 0) {
      const msg = this.msgBuffer.shift();
      if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
        this.localWs.send(msg);
      }
    }
  }

  // --- 重连逻辑 ---

  scheduleRelayReconnect() {
    this.clearRelayReconnect();
    const delay = this.getReconnectDelay();
    console.log(TAG, `${delay / 1000}s 后重连 relay...`);
    this._status = "connecting";
    this.emit("status", this._status);
    this.relayReconnectTimer = setTimeout(() => this.connectToRelay(), delay);
  }

  scheduleLocalReconnect() {
    this.clearLocalReconnect();
    const delay = Math.min(RECONNECT_INITIAL_MS, RECONNECT_MAX_MS);
    console.log(TAG, `${delay / 1000}s 后重连本地...`);
    this.localReconnectTimer = setTimeout(() => this.connectToLocal(), delay);
  }

  getReconnectDelay() {
    // 简单的指数退避 + jitter
    const base = RECONNECT_INITIAL_MS;
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, RECONNECT_MAX_MS);
  }

  clearRelayReconnect() {
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
  }

  clearLocalReconnect() {
    if (this.localReconnectTimer) {
      clearTimeout(this.localReconnectTimer);
      this.localReconnectTimer = null;
    }
  }

  clearTimers() {
    this.clearRelayReconnect();
    this.clearLocalReconnect();
  }

  closeWs(ws, reason) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, reason); } catch {}
    }
  }
}

// 单例
let instance = null;

/**
 * 初始化 relay bridge（从 prefs 读取配置）
 * @param {object} prefs — prefs 模块实例
 */
function initRelayBridge(prefs) {
  if (instance) instance.destroy();
  instance = new RelayBridge();
  instance.init(prefs);
  return instance;
}

/**
 * 获取当前 relay bridge 实例
 */
function getRelayBridge() {
  return instance;
}

module.exports = { initRelayBridge, getRelayBridge, RelayBridge };

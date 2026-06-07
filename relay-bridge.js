// relay-bridge.js — PC 端桥接脚本，连接中继服务器
// 用法: node relay-bridge.js <relay-url> <token>
// 示例: node relay-bridge.js ws://your-server:7891 your-token

const WebSocket = require("ws");

const RELAY_URL = process.argv[2];
const TOKEN = process.argv[3];
const LOCAL_TOKEN = process.argv[4] || TOKEN; // 本地 hook server token

if (!RELAY_URL || !TOKEN) {
  console.error("用法: node relay-bridge.js <relay-url> <token> [local-token]");
  console.error("示例: node relay-bridge.js ws://your-server:7891 your-token");
  process.exit(1);
}
const LOCAL_WS_URL = `ws://localhost:23333/ws?token=${LOCAL_TOKEN}`; // PC 本地 hook server

let relayWs = null;
let localWs = null;
let reconnectTimer = null;
let lastSnapshotSent = 0; // 上次发送 snapshot 的时间
let reconnectDelay = 5000; // 初始重连延迟 5s
const RECONNECT_MAX_DELAY = 60000; // 最大重连延迟 60s
const messageBuffer = []; // 本地重连期间缓存的手机消息
const MESSAGE_BUFFER_MAX = 50;

function connectToRelay() {
  const url = `${RELAY_URL}?token=${TOKEN}&role=pc`;
  console.log(`[bridge] 连接中继服务器: ${RELAY_URL}`);

  relayWs = new WebSocket(url);

  relayWs.on("open", () => {
    console.log("[bridge] ✅ 已连接中继服务器");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Reset backoff on successful connection
    reconnectDelay = 5000;
    // 连接中继后立即连接本地 hook server
    connectToLocal();
  });

  relayWs.on("message", (data) => {
    // 从中继收到的消息（来自手机），转发到本地 hook server
    let msg;
    try { msg = JSON.parse(data); } catch { msg = null; }

    // 忽略中继控制消息和心跳
    if (msg && (msg.type === "peer_connected" || msg.type === "peer_disconnected" || msg.type === "ping")) {
      return;
    }

    console.log("[bridge] 📥 收到手机消息，转发到本地");

    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(data);
    } else {
      // 本地未连接时，缓存消息（上限 MESSAGE_BUFFER_MAX）
      if (messageBuffer.length < MESSAGE_BUFFER_MAX) {
        messageBuffer.push(data);
      }
      connectToLocal();
    }
  });

  relayWs.on("close", () => {
    console.log(`[bridge] ❌ 中继连接断开，${reconnectDelay / 1000}秒后重连...`);
    scheduleReconnect();
  });

  relayWs.on("error", (err) => {
    console.error("[bridge] 中继错误:", err.message);
  });
}

function connectToLocal() {
  if (localWs && localWs.readyState === WebSocket.OPEN) return;

  console.log("[bridge] 连接本地 hook server...");
  localWs = new WebSocket(LOCAL_WS_URL);

  localWs.on("open", () => {
    console.log("[bridge] ✅ 已连接本地 hook server");
    // Flush buffered messages from reconnection window
    if (messageBuffer.length > 0) {
      console.log(`[bridge] 📤 刷出 ${messageBuffer.length} 条缓存消息`);
      for (const buffered of messageBuffer) {
        if (localWs && localWs.readyState === WebSocket.OPEN) {
          localWs.send(buffered);
        }
      }
      messageBuffer.length = 0;
    }
    lastSnapshotSent = Date.now();
  });

  localWs.on("message", (data) => {
    // 从本地收到的消息（来自 PC），转发到中继
    let msgType = "unknown";
    try { msgType = JSON.parse(data).type; } catch {}
    console.log(`[bridge] 📤 收到本地消息: ${msgType}，转发到中继`);
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(data);
    }
  });

  localWs.on("close", () => {
    console.log("[bridge] 本地连接断开");
    localWs = null;
  });

  localWs.on("error", (err) => {
    console.error("[bridge] 本地错误:", err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToRelay();
  }, reconnectDelay);
  // Exponential backoff with jitter, capped at RECONNECT_MAX_DELAY
  reconnectDelay = Math.min(reconnectDelay * 2 * (0.5 + Math.random()), RECONNECT_MAX_DELAY);
}

// 启动
console.log("=== Clawd 中继桥接 ===");
console.log(`中继服务器: ${RELAY_URL}`);
console.log(`本地服务: ${LOCAL_WS_URL}`);
console.log("");

connectToRelay();

// 优雅退出
process.on("SIGINT", () => {
  console.log("\n[bridge] 正在关闭...");
  if (relayWs) relayWs.close();
  if (localWs) localWs.close();
  process.exit(0);
});

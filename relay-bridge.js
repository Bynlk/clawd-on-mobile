// relay-bridge.js — PC 端桥接脚本，连接中继服务器
// 用法: node relay-bridge.js <relay-url> <token>
// 示例: node relay-bridge.js ws://your-server:7891 your-token

const WebSocket = require("ws");

const RELAY_URL = process.argv[2] || "ws://localhost:7891";
const TOKEN = process.argv[3] || "test-token";
const LOCAL_TOKEN = process.argv[4] || TOKEN; // 本地 hook server token
const LOCAL_WS_URL = `ws://localhost:23333/ws?token=${LOCAL_TOKEN}`; // PC 本地 hook server

let relayWs = null;
let localWs = null;
let reconnectTimer = null;
let lastSnapshotSent = 0; // 上次发送 snapshot 的时间

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

    // 收到手机消息时，如果距离上次 snapshot 超过 5 秒，重新获取
    const now = Date.now();
    if (now - lastSnapshotSent > 5000) {
      console.log("[bridge] 🔄 重新获取 snapshot...");
      if (localWs) { localWs.close(); localWs = null; }
      setTimeout(() => connectToLocal(), 300);
      lastSnapshotSent = now;
    }

    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(data);
    } else {
      connectToLocal();
      setTimeout(() => {
        if (localWs && localWs.readyState === WebSocket.OPEN) {
          localWs.send(data);
        }
      }, 500);
    }
  });

  relayWs.on("close", () => {
    console.log("[bridge] ❌ 中继连接断开，5秒后重连...");
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
  }, 5000);
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

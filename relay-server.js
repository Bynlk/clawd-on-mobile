// relay-server.js — 简易 WebSocket 中继服务器
// 用法: node relay-server.js
// 环境变量: PORT (默认 7891), TOKEN (可选，不设则用 URL 参数)

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7891;
const FIXED_TOKEN = process.env.TOKEN || null;

const wss = new WebSocketServer({ port: PORT });
const pairs = new Map(); // token → { pc: WebSocket, phone: WebSocket }

console.log(`[relay] 中继服务器启动在端口 ${PORT}`);
if (FIXED_TOKEN) console.log(`[relay] 固定 token: ${FIXED_TOKEN.slice(0, 4)}…`);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");

  // 心跳
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // 支持多种 token 传递方式: URL 参数 或 Authorization header
  let token = FIXED_TOKEN || url.searchParams.get("token");
  if (!token) {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  // 支持多种 role 传递方式: URL 参数 或 路径判断
  let role = url.searchParams.get("role");
  if (!role) {
    // Android 连接 /mobile/ws 路径默认为 phone
    if (url.pathname === "/mobile/ws" || url.pathname === "/mobile/stream") {
      role = "phone";
    }
  }

  if (!token || !["pc", "phone"].includes(role)) {
    ws.close(4000, "需要 token 和 role 参数");
    console.log(`[relay] 连接被拒绝: 缺少 token 或 role (path: ${url.pathname})`);
    return;
  }

  if (!pairs.has(token)) pairs.set(token, {});
  const pair = pairs.get(token);

  // 同一角色重复连接，关闭旧的
  if (pair[role] && pair[role].readyState === pair[role].OPEN) {
    pair[role].close(4001, "被新连接替换");
  }
  pair[role] = ws;

  const peer = role === "pc" ? "phone" : "pc";
  console.log(`[relay] ${role} 已连接 (token: ${token.slice(0, 8)}...)`);
  console.log(`[relay] 当前状态: PC=${pair.pc ? "✅" : "❌"} Phone=${pair.phone ? "✅" : "❌"}`);

  // 通知对端已连接
  const peerWsOnConnect = pair[peer];
  if (peerWsOnConnect && peerWsOnConnect.readyState === peerWsOnConnect.OPEN) {
    peerWsOnConnect.send(JSON.stringify({ type: "peer_connected", role }));
  }

  // 转发消息
  ws.on("message", (data) => {
    ws.isAlive = true; // 任何消息 = 客户端存活
    const peerWs = pair[peer];
    if (peerWs && peerWs.readyState === peerWs.OPEN) {
      peerWs.send(data);
    }
  });

  // 断开清理
  ws.on("close", () => {
    delete pair[role];
    console.log(`[relay] ${role} 已断开 (token: ${token.slice(0, 8)}...)`);
    console.log(`[relay] 当前状态: PC=${pair.pc ? "✅" : "❌"} Phone=${pair.phone ? "✅" : "❌"}`);

    const peerWsOnClose = pair[peer];
    if (peerWsOnClose && peerWsOnClose.readyState === peerWsOnClose.OPEN) {
      peerWsOnClose.send(JSON.stringify({ type: "peer_disconnected", role }));
    }
    if (!pair.pc && !pair.phone) pairs.delete(token);
  });

  ws.on("error", (err) => {
    console.error(`[relay] ${role} 错误:`, err.message);
  });
});

// 心跳检测 (30秒，仅发 JSON ping — OkHttp 不支持协议级 ping 帧)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    // 不调用 ws.ping() — OkHttp 会因 "Control frames must be final" 拒绝协议级 ping
    try {
      ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    } catch {}
  });
}, 30000);

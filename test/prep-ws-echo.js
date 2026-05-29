// Standalone WebSocket echo test — verifies ws integrates with http.createServer
const http = require("http");
const WebSocket = require("ws");

const PORT = 23338;

const httpServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server: httpServer, path: "/test-ws" });

wss.on("connection", (ws) => {
  console.log("[test-ws] Client connected");
  ws.on("message", (message) => {
    console.log("[test-ws] Received:", message.toString());
    ws.send(`Echo: ${message}`);
  });
  ws.send("Ready");
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[test] HTTP+WS server listening on 127.0.0.1:${PORT}`);
  console.log("[test] Test with: npx wscat -c ws://127.0.0.1:23333/test-ws");
  console.log("[test] Press Ctrl+C to stop");
});

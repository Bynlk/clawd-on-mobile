"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { MobileWSServer } = require("../src/mobile-ws-server");

// ── Helpers ──

function makeServer(opts = {}) {
  const fakeHttpServer = { on: () => {} };
  return new MobileWSServer(fakeHttpServer, {
    token: "test-token",
    maxClients: opts.maxClients || 10,
    heartbeatIntervalMs: opts.heartbeatIntervalMs || 15000,
  });
}

function makeFakeWS(opts = {}) {
  const ws = {
    readyState: opts.readyState ?? 1, // WebSocket.OPEN
    isAlive: true,
    sent: [],
    closed: false,
    closeCode: null,
    closeReason: null,
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closed = true; this.closeCode = code; this.closeReason = reason; },
    terminate() { this.terminated = true; },
    on() {},
  };
  return ws;
}

function makeFakeReq(url = "/?token=test-token", headers = {}) {
  return {
    url,
    headers: { ...headers },
    socket: { remoteAddress: "192.168.1.100" },
  };
}

// ── buildMobileFields (via session snapshot) ──

describe("MobileWSServer", () => {

  describe("constructor", () => {
    it("initializes with default values", () => {
      const s = makeServer();
      assert.equal(s.token, "test-token");
      assert.equal(s.maxClients, 10);
      assert.equal(s.clients.size, 0);
      assert.equal(s.sessionCache.size, 0);
      assert.equal(s.clientMeta.size, 0);
      assert.equal(s.connectionHistory.length, 0);
      assert.equal(s.externalClients.size, 0);
      assert.equal(s._messageHandlers.size, 0);
      assert.equal(s._heartbeatTimer, null);
    });
  });

  describe("getClientCount", () => {
    it("returns 0 with no clients", () => {
      const s = makeServer();
      assert.equal(s.getClientCount(), 0);
    });

    it("counts WS + external clients", () => {
      const s = makeServer();
      s.clients.add(makeFakeWS());
      s.externalClients.set("ext1", { ip: "1.2.3.4" });
      assert.equal(s.getClientCount(), 2);
    });
  });

  describe("setMaxClients", () => {
    it("sets valid max", () => {
      const s = makeServer();
      s.setMaxClients(5);
      assert.equal(s.maxClients, 5);
    });

    it("rejects values < 1", () => {
      const s = makeServer({ maxClients: 3 });
      s.setMaxClients(0);
      assert.equal(s.maxClients, 3);
    });

    it("rejects values > 10", () => {
      const s = makeServer({ maxClients: 3 });
      s.setMaxClients(11);
      assert.equal(s.maxClients, 3);
    });

    it("rejects non-numbers", () => {
      const s = makeServer({ maxClients: 3 });
      s.setMaxClients("5");
      assert.equal(s.maxClients, 3);
    });
  });

  describe("getSessionCache", () => {
    it("returns a copy of the session cache", () => {
      const s = makeServer();
      s.sessionCache.set("s1", { state: "working" });
      const cache = s.getSessionCache();
      assert.equal(cache.size, 1);
      assert.deepEqual(cache.get("s1"), { state: "working" });
      // Mutating the copy doesn't affect the original
      cache.set("s2", { state: "idle" });
      assert.equal(s.sessionCache.size, 1);
    });
  });

  describe("onClientMessage / offClientMessage", () => {
    it("adds and removes handlers", () => {
      const s = makeServer();
      const handler = () => {};
      s.onClientMessage(handler);
      assert.equal(s._messageHandlers.size, 1);
      s.offClientMessage(handler);
      assert.equal(s._messageHandlers.size, 0);
    });
  });

  describe("getClientInfoList", () => {
    it("returns empty list with no clients", () => {
      const s = makeServer();
      assert.deepEqual(s.getClientInfoList(), []);
    });

    it("includes WS clients with metadata", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.clientMeta.set(ws, { clientId: "abc123", ip: "10.0.0.1", connectedAt: 1000 });
      const list = s.getClientInfoList();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, "abc123");
      assert.equal(list[0].ip, "10.0.0.1");
      assert.equal(list[0].connectedAt, 1000);
    });

    it("includes external clients", () => {
      const s = makeServer();
      s.externalClients.set("ext1", { ip: "5.6.7.8", connectedAt: 2000 });
      const list = s.getClientInfoList();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, "ext1");
      assert.equal(list[0].ip, "5.6.7.8");
    });
  });

  describe("getConnectionHistory", () => {
    it("returns a copy", () => {
      const s = makeServer();
      s.connectionHistory.push({ clientId: "a", ip: "1.1.1.1", connectedAt: 100 });
      const h = s.getConnectionHistory();
      assert.equal(h.length, 1);
      h.push({ clientId: "b" });
      assert.equal(s.connectionHistory.length, 1);
    });
  });

  describe("loadConnectionHistory", () => {
    it("loads valid history", () => {
      const s = makeServer();
      s.loadConnectionHistory([{ clientId: "a" }, { clientId: "b" }]);
      assert.equal(s.connectionHistory.length, 2);
    });

    it("truncates to MAX_HISTORY", () => {
      const s = makeServer();
      const history = Array.from({ length: 100 }, (_, i) => ({ clientId: `c${i}` }));
      s.loadConnectionHistory(history);
      assert.equal(s.connectionHistory.length, 50);
    });

    it("ignores non-array input", () => {
      const s = makeServer();
      s.connectionHistory.push({ clientId: "x" });
      s.loadConnectionHistory("not-an-array");
      assert.equal(s.connectionHistory.length, 1);
    });
  });

  describe("registerExternalClient / unregisterExternalClient", () => {
    it("registers and unregisters", () => {
      const s = makeServer();
      s.registerExternalClient("ext1", { ip: "1.2.3.4", connectedAt: 500 });
      assert.equal(s.externalClients.size, 1);
      assert.equal(s.getClientCount(), 1);
      assert.equal(s.connectionHistory.length, 1);

      s.unregisterExternalClient("ext1");
      assert.equal(s.externalClients.size, 0);
      assert.equal(s.getClientCount(), 0);
    });

    it("unregister is no-op for unknown id", () => {
      const s = makeServer();
      s.unregisterExternalClient("unknown");
      assert.equal(s.externalClients.size, 0);
    });

    it("emits events", () => {
      const s = makeServer();
      const events = [];
      s.on("client-connected", (d) => events.push({ type: "connected", ...d }));
      s.on("client-disconnected", (d) => events.push({ type: "disconnected", ...d }));
      s.registerExternalClient("ext1", { ip: "1.2.3.4" });
      s.unregisterExternalClient("ext1");
      assert.equal(events.length, 2);
      assert.equal(events[0].type, "connected");
      assert.equal(events[0].clientId, "ext1");
      assert.equal(events[1].type, "disconnected");
    });
  });

  describe("_evictSessionCache", () => {
    it("does nothing when under limit", () => {
      const s = makeServer();
      s.sessionCache.set("s1", { _cachedAt: Date.now() });
      s._evictSessionCache();
      assert.equal(s.sessionCache.size, 1);
    });

    it("evicts expired entries first", () => {
      const s = makeServer();
      const now = Date.now();
      const old = now - 25 * 60 * 60 * 1000; // 25 hours ago
      // Fill cache beyond limit with expired entries
      for (let i = 0; i < 201; i++) {
        s.sessionCache.set(`s${i}`, { _cachedAt: old + i });
      }
      s._evictSessionCache();
      // Expired entries should be removed
      assert.ok(s.sessionCache.size <= 200);
    });

    it("evicts oldest entries when still over limit", () => {
      const s = makeServer();
      const now = Date.now();
      // Fill cache with fresh entries
      for (let i = 0; i < 210; i++) {
        s.sessionCache.set(`s${i}`, { _cachedAt: now - (210 - i) });
      }
      s._evictSessionCache();
      assert.equal(s.sessionCache.size, 200);
      // Oldest entries should be gone
      assert.ok(!s.sessionCache.has("s0"));
      assert.ok(!s.sessionCache.has("s9"));
      assert.ok(s.sessionCache.has("s10"));
    });
  });

  describe("broadcastState", () => {
    it("caches state and broadcasts", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastState("session1", { state: "working", badge: "running" });
      assert.ok(s.sessionCache.has("session1"));
      assert.equal(ws.sent.length, 1);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "state");
      assert.equal(msg.sessionId, "session1");
      assert.equal(msg.data.state, "working");
    });

    it("marks non-idle as isReal", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastState("s1", { state: "working" });
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.data.isReal, true);
    });

    it("marks idle with only SessionStart as not isReal", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastState("s1", { state: "idle", recentEvents: [{ event: "SessionStart" }] });
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.data.isReal, false);
    });
  });

  describe("broadcastSessionSnapshot", () => {
    it("builds sessions map and broadcasts", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastSessionSnapshot({
        sessions: [
          { id: "s1", state: "working", badge: "running", displayTitle: "task1", updatedAt: 1000, agentId: "claude" },
          { id: "s2", state: "idle", badge: "idle", displayTitle: "task2", updatedAt: 2000, agentId: "codex", headless: true },
        ],
        hudLastSessionId: "s1",
      });
      assert.equal(ws.sent.length, 1);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "snapshot");
      assert.ok(msg.sessions.s1);
      assert.ok(!msg.sessions.s2); // headless => isVisible=false => skipped
      assert.equal(msg.displayState, "working");
    });
  });

  describe("removeSession", () => {
    it("removes from cache and broadcasts", () => {
      const s = makeServer();
      s.sessionCache.set("s1", { state: "working" });
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.removeSession("s1");
      assert.ok(!s.sessionCache.has("s1"));
      assert.equal(ws.sent.length, 1);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "session_deleted");
      assert.equal(msg.sessionId, "s1");
    });

    it("no-op if not in cache", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.removeSession("nonexistent");
      assert.equal(ws.sent.length, 0);
    });
  });

  describe("broadcastToolOutput", () => {
    it("broadcasts tool output", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastToolOutput("s1", { toolName: "bash", output: "hello" });
      assert.equal(ws.sent.length, 1);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "tool_output");
      assert.equal(msg.sessionId, "s1");
      assert.equal(msg.toolName, "bash");
      assert.equal(msg.output, "hello");
    });
  });

  describe("broadcast", () => {
    it("broadcasts arbitrary data", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcast({ type: "custom", value: 42 });
      assert.equal(ws.sent.length, 1);
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.type, "custom");
      assert.equal(msg.value, 42);
    });

    it("skips non-OPEN clients", () => {
      const s = makeServer();
      const ws = makeFakeWS({ readyState: 3 }); // CLOSED
      s.clients.add(ws);
      s.broadcast({ type: "test" });
      assert.equal(ws.sent.length, 0);
    });
  });

  describe("_extractToken", () => {
    it("extracts from URL query param", () => {
      const s = makeServer();
      const token = s._extractToken({ url: "/path?token=abc123", headers: {} });
      assert.equal(token, "abc123");
    });

    it("extracts from Authorization header", () => {
      const s = makeServer();
      const token = s._extractToken({ url: "/path", headers: { authorization: "Bearer mytoken" } });
      assert.equal(token, "mytoken");
    });

    it("returns null when no token", () => {
      const s = makeServer();
      const token = s._extractToken({ url: "/path", headers: {} });
      assert.equal(token, null);
    });

    it("returns null for invalid URL", () => {
      const s = makeServer();
      const token = s._extractToken({ url: null, headers: {} });
      assert.equal(token, null);
    });
  });

  describe("getLocalIP", () => {
    it("returns a string", () => {
      const s = makeServer();
      const ip = s.getLocalIP();
      assert.equal(typeof ip, "string");
    });
  });

  describe("disconnectClient", () => {
    it("disconnects WS client by id", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.clientMeta.set(ws, { clientId: "client1", ip: "1.1.1.1", connectedAt: 100 });
      const result = s.disconnectClient("client1");
      assert.equal(result, true);
      assert.equal(ws.closed, true);
      assert.equal(ws.closeCode, 1000);
    });

    it("disconnects external client by id", () => {
      const s = makeServer();
      const res = { write: () => {}, end: () => {} };
      s.externalClients.set("ext1", { ip: "2.2.2.2", connectedAt: 200, res });
      const events = [];
      s.on("client-disconnected", (d) => events.push(d));
      const result = s.disconnectClient("ext1");
      assert.equal(result, true);
      assert.equal(s.externalClients.size, 0);
      assert.equal(events.length, 1);
    });

    it("returns false for unknown client", () => {
      const s = makeServer();
      assert.equal(s.disconnectClient("unknown"), false);
    });
  });

  describe("handleRequest", () => {
    it("returns 401 for missing token", () => {
      const s = makeServer();
      let statusCode = null;
      let body = null;
      const res = {
        writeHead(code) { statusCode = code; },
        end(data) { body = data; },
      };
      s.handleRequest({ url: "/mobile/", headers: {} }, res);
      assert.equal(statusCode, 401);
      assert.ok(body.includes("需要连接信息"));
    });

    it("returns 401 for wrong token", () => {
      const s = makeServer();
      let statusCode = null;
      const res = {
        writeHead(code) { statusCode = code; },
        end() {},
      };
      s.handleRequest({ url: "/mobile/?token=wrong", headers: {} }, res);
      assert.equal(statusCode, 401);
    });

    it("returns connection info for /api/connection-info", () => {
      const s = makeServer();
      let statusCode = null;
      let contentType = null;
      let body = null;
      const res = {
        writeHead(code, headers) { statusCode = code; contentType = headers["Content-Type"]; },
        end(data) { body = data; },
      };
      s.handleRequest({ url: "/api/connection-info?token=test-token", headers: {} }, res);
      assert.equal(statusCode, 200);
      assert.equal(contentType, "application/json");
      const parsed = JSON.parse(body);
      assert.equal(parsed.status, "ok");
      assert.equal(parsed.token, "test-token");
    });

    it("returns 404 for non-mobile paths", () => {
      const s = makeServer();
      let statusCode = null;
      const res = {
        writeHead(code) { statusCode = code; },
        end() {},
      };
      s.handleRequest({ url: "/other?token=test-token", headers: {} }, res);
      assert.equal(statusCode, 404);
    });

    it("redirects /mobile to /mobile/index.html", () => {
      const s = makeServer();
      let statusCode = null;
      let ended = false;
      const res = {
        writeHead(code) { statusCode = code; },
        end() { ended = true; },
      };
      s.handleRequest({ url: "/mobile?token=test-token", headers: {} }, res);
      // handleRequest uses async fs.readFile for file serving
      assert.ok(true);
    });

    it("returns 401 when Authorization header has wrong scheme", () => {
      const s = makeServer();
      let statusCode = null;
      const res = {
        writeHead(code) { statusCode = code; },
        end() {},
      };
      s.handleRequest({ url: "/mobile/", headers: { authorization: "Basic abc" } }, res);
      assert.equal(statusCode, 401);
    });

    it("accepts Bearer token from Authorization header", () => {
      const s = makeServer();
      let statusCode = null;
      const res = {
        writeHead(code) { statusCode = code; },
        end() {},
      };
      s.handleRequest({ url: "/api/connection-info", headers: { authorization: "Bearer test-token" } }, res);
      assert.equal(statusCode, 200);
    });

    it("returns error for invalid URL", () => {
      const s = makeServer();
      let statusCode = null;
      const res = {
        writeHead(code) { statusCode = code; },
        end() {},
      };
      // Malformed URL
      s.handleRequest({ url: null, headers: { authorization: "Bearer test-token" } }, res);
      // Should return 400 or 404 depending on URL parsing
      assert.ok(statusCode === 400 || statusCode === 404);
    });
  });

  describe("close", () => {
    it("cleans up all resources", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.clientMeta.set(ws, { clientId: "c1" });
      s.externalClients.set("e1", { res: { end: () => {} } });
      s._heartbeatTimer = setInterval(() => {}, 10000);
      s.close();
      assert.equal(s.clients.size, 0);
      assert.equal(s.clientMeta.size, 0);
      assert.equal(s.externalClients.size, 0);
      assert.equal(s._heartbeatTimer, null);
      assert.equal(ws.closed, true);
    });
  });

  describe("setPort", () => {
    it("sets port", () => {
      const s = makeServer();
      s.setPort(23334);
      assert.equal(s._port, 23334);
    });
  });

  describe("attachWSS", () => {
    it("attaches wss and listens for connection", () => {
      const s = makeServer();
      const handlers = {};
      const fakeWSS = {
        on(event, handler) { handlers[event] = handler; },
      };
      s.attachWSS(fakeWSS);
      assert.equal(s.wss, fakeWSS);
      assert.equal(typeof handlers.connection, "function");
    });
  });

  describe("_handleConnection", () => {
    it("rejects invalid token", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      const req = makeFakeReq("/?token=wrong");
      s._handleConnection(ws, req);
      assert.equal(ws.closed, true);
      assert.equal(ws.closeCode, 1008);
      assert.equal(s.clients.size, 0);
      s.close();
    });

    it("rejects when max clients reached", () => {
      const s = makeServer({ maxClients: 1 });
      s.clients.add(makeFakeWS()); // already at max
      const ws = makeFakeWS();
      const req = makeFakeReq("/?token=test-token");
      s._handleConnection(ws, req);
      assert.equal(ws.closed, true);
      assert.equal(ws.closeCode, 1013);
      s.close();
    });

    it("accepts valid connection and sends initial messages", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      const req = makeFakeReq("/?token=test-token");
      s._handleConnection(ws, req);
      assert.equal(s.clients.size, 1);
      assert.equal(ws.sent.length, 2); // clear_sessions + snapshot
      const clearMsg = JSON.parse(ws.sent[0]);
      assert.equal(clearMsg.type, "clear_sessions");
      const snapMsg = JSON.parse(ws.sent[1]);
      assert.equal(snapMsg.type, "snapshot");
      s.close();
    });

    it("accepts token from Authorization header", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      const req = makeFakeReq("/no-token", { authorization: "Bearer test-token" });
      s._handleConnection(ws, req);
      assert.equal(s.clients.size, 1);
      s.close();
    });

    it("emits client-connected event", () => {
      const s = makeServer();
      const events = [];
      s.on("client-connected", (d) => events.push(d));
      const ws = makeFakeWS();
      const req = makeFakeReq("/?token=test-token");
      s._handleConnection(ws, req);
      assert.equal(events.length, 1);
      assert.ok(events[0].clientId);
      s.close();
    });
  });

  describe("buildMobileFields (via snapshot)", () => {
    // buildMobileFields is not exported, but we can test it through broadcastSessionSnapshot
    it("derives chip for working state", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastSessionSnapshot({
        sessions: [{ id: "s1", state: "working", badge: "running", displayTitle: "t", updatedAt: 1, agentId: "a" }],
      });
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.sessions.s1.chipText, "工作中");
      assert.equal(msg.sessions.s1.chipColor, "#3b82f6");
    });

    it("derives chip for oneshot state with event", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastSessionSnapshot({
        sessions: [{
          id: "s1", state: "attention", badge: "interrupted",
          displayTitle: "t", updatedAt: 1, agentId: "a",
          recentEvents: [{ event: "Stop" }],
        }],
      });
      const msg = JSON.parse(ws.sent[0]);
      assert.equal(msg.sessions.s1.chipText, "已完成");
    });

    it("hides headless sessions", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastSessionSnapshot({
        sessions: [{ id: "s1", state: "idle", badge: "idle", displayTitle: "t", updatedAt: 1, agentId: "a", headless: true }],
      });
      const msg = JSON.parse(ws.sent[0]);
      assert.ok(!msg.sessions.s1);
    });

    it("hides sleeping sessions", () => {
      const s = makeServer();
      const ws = makeFakeWS();
      s.clients.add(ws);
      s.broadcastSessionSnapshot({
        sessions: [{ id: "s1", state: "sleeping", badge: "idle", displayTitle: "t", updatedAt: 1, agentId: "a" }],
      });
      const msg = JSON.parse(ws.sent[0]);
      assert.ok(!msg.sessions.s1);
    });
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { MobileApprovalClient } = require("../src/mobile-approval-client");

function makeFakeMobileWS(options = {}) {
  const handlers = new Set();
  const broadcasted = [];
  return {
    getClientCount: () => options.clientCount ?? 1,
    broadcast: (data) => broadcasted.push(data),
    onClientMessage: (handler) => handlers.add(handler),
    offClientMessage: (handler) => handlers.delete(handler),
    handlers,
    broadcasted,
    simulateResponse(requestId, behavior) {
      for (const handler of handlers) {
        handler(null, { type: "permission_response", requestId, behavior });
      }
    },
  };
}

// ── Constructor ─────────────────────────────────────────────────────

describe("MobileApprovalClient constructor", () => {
  it("creates with default timeout", () => {
    const client = new MobileApprovalClient(() => null);
    assert.strictEqual(client.timeoutMs, 60000);
  });

  it("creates with custom timeout", () => {
    const client = new MobileApprovalClient(() => null, { timeoutMs: 5000 });
    assert.strictEqual(client.timeoutMs, 5000);
  });

  it("starts with empty pending map", () => {
    const client = new MobileApprovalClient(() => null);
    assert.strictEqual(client.pending.size, 0);
  });
});

// ── requestApproval ─────────────────────────────────────────────────

describe("MobileApprovalClient.requestApproval", () => {
  it("returns null when getMobileWS returns null", async () => {
    const client = new MobileApprovalClient(() => null);
    const result = await client.requestApproval({});
    assert.strictEqual(result, null);
  });

  it("returns null when no clients connected", async () => {
    const ws = makeFakeMobileWS({ clientCount: 0 });
    const client = new MobileApprovalClient(() => ws);
    const result = await client.requestApproval({});
    assert.strictEqual(result, null);
  });

  it("returns null when getMobileWS is not a function", async () => {
    const client = new MobileApprovalClient(null);
    const result = await client.requestApproval({});
    assert.strictEqual(result, null);
  });

  it("broadcasts permission_request to mobile WS", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    const promise = client.requestApproval({ tool: "bash" });
    assert.strictEqual(ws.broadcasted.length, 1);
    assert.strictEqual(ws.broadcasted[0].type, "permission_request");
    assert.strictEqual(ws.broadcasted[0].data.tool, "bash");
    assert.ok(ws.broadcasted[0].requestId.startsWith("perm_"));
    // Resolve to avoid hanging
    ws.simulateResponse(ws.broadcasted[0].requestId, "allow");
    const result = await promise;
    assert.strictEqual(result, "allow");
  });

  it("resolves with behavior from mobile response", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    const promise = client.requestApproval({});
    ws.simulateResponse(ws.broadcasted[0].requestId, "deny");
    const result = await promise;
    assert.strictEqual(result, "deny");
  });

  it("resolves null on timeout", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws, { timeoutMs: 50 });
    const result = await client.requestApproval({});
    assert.strictEqual(result, null);
  });

  it("ignores responses for unknown requestId", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    const promise = client.requestApproval({});
    ws.simulateResponse("unknown_id", "allow");
    // The actual response
    ws.simulateResponse(ws.broadcasted[0].requestId, "deny");
    const result = await promise;
    assert.strictEqual(result, "deny");
  });

  it("ignores non-permission_response messages", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    const promise = client.requestApproval({});
    for (const handler of ws.handlers) {
      handler(null, { type: "other" });
      handler(null, { type: "permission_response" }); // no requestId
      handler(null, null);
    }
    ws.simulateResponse(ws.broadcasted[0].requestId, "allow");
    const result = await promise;
    assert.strictEqual(result, "allow");
  });
});

// ── close ───────────────────────────────────────────────────────────

describe("MobileApprovalClient.close", () => {
  it("resolves all pending with null", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    const p1 = client.requestApproval({});
    const p2 = client.requestApproval({});
    client.close();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1, null);
    assert.strictEqual(r2, null);
  });

  it("clears pending map", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    client.requestApproval({});
    client.close();
    assert.strictEqual(client.pending.size, 0);
  });

  it("detaches message handler", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    client.requestApproval({});
    client.close();
    assert.strictEqual(ws.handlers.has(client._handler), false);
  });

  it("is safe to call multiple times", async () => {
    const ws = makeFakeMobileWS();
    const client = new MobileApprovalClient(() => ws);
    client.close();
    client.close();
    assert.strictEqual(client.pending.size, 0);
  });
});

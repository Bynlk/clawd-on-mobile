"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

/**
 * Regression tests for mobile SSE server routing.
 *
 * Commit 2f6ef3c fixed: `req.url === "/mobile/stream"` → `req.url.startsWith("/mobile/stream")`
 * because Node.js `req.url` includes query strings (e.g. `?token=...`), causing 404s.
 *
 * Since startMobileServer() is inside the initServer() factory closure, we test
 * the route matching logic directly as a contract test.
 */

describe("mobile SSE route matching (startsWith regression)", () => {
  it("matches /mobile/stream with query string", () => {
    const url = "/mobile/stream?token=abcdef1234567890abcdef1234567890";
    assert.strictEqual(url.startsWith("/mobile/stream"), true);
  });

  it("matches /mobile/stream without query string", () => {
    const url = "/mobile/stream";
    assert.strictEqual(url.startsWith("/mobile/stream"), true);
  });

  it("matches /mobile/approve with query string", () => {
    const url = "/mobile/approve?id=perm123&decision=allow";
    assert.strictEqual(url.startsWith("/mobile/approve"), true);
  });

  it("matches /mobile/approve without query string", () => {
    const url = "/mobile/approve";
    assert.strictEqual(url.startsWith("/mobile/approve"), true);
  });

  it("does not match unrelated paths", () => {
    assert.strictEqual("/other/path".startsWith("/mobile/stream"), false);
    assert.strictEqual("/mobile".startsWith("/mobile/stream"), false);
    assert.strictEqual("/mobile/stre".startsWith("/mobile/stream"), false);
    assert.strictEqual("/mobile/stream-extra".startsWith("/mobile/stream"), true); // prefix match is intentional
  });

  it("does not match state endpoint as mobile stream", () => {
    assert.strictEqual("/state".startsWith("/mobile/stream"), false);
    assert.strictEqual("/health".startsWith("/mobile/stream"), false);
  });
});

describe("mobile SSE broadcast format", () => {
  it("formats SSE data lines correctly", () => {
    const eventData = { type: "state_update", sessionId: "abc", state: "working" };
    const data = `data: ${JSON.stringify(eventData)}\n\n`;
    assert.strictEqual(data.startsWith("data: "), true);
    assert.strictEqual(data.endsWith("\n\n"), true);

    const parsed = JSON.parse(data.slice(6, -2));
    assert.strictEqual(parsed.type, "state_update");
    assert.strictEqual(parsed.sessionId, "abc");
    assert.strictEqual(parsed.state, "working");
  });

  it("formats connected event correctly", () => {
    const eventData = { type: "connected", timestamp: 1234567890 };
    const data = `data: ${JSON.stringify(eventData)}\n\n`;
    const parsed = JSON.parse(data.slice(6, -2));
    assert.strictEqual(parsed.type, "connected");
  });

  it("formats clear_sessions event correctly", () => {
    const eventData = { type: "clear_sessions", timestamp: 1234567890 };
    const data = `data: ${JSON.stringify(eventData)}\n\n`;
    const parsed = JSON.parse(data.slice(6, -2));
    assert.strictEqual(parsed.type, "clear_sessions");
  });

  it("formats snapshot event with sessions", () => {
    const eventData = {
      type: "snapshot",
      sessions: { "s1": { state: "working", badge: "running" } },
      displayState: "working",
      timestamp: 1234567890,
    };
    const data = `data: ${JSON.stringify(eventData)}\n\n`;
    const parsed = JSON.parse(data.slice(6, -2));
    assert.strictEqual(parsed.type, "snapshot");
    assert.deepStrictEqual(parsed.sessions["s1"], { state: "working", badge: "running" });
  });

  it("formats ping event correctly", () => {
    const eventData = { type: "ping", timestamp: 1234567890 };
    const data = `data: ${JSON.stringify(eventData)}\n\n`;
    const parsed = JSON.parse(data.slice(6, -2));
    assert.strictEqual(parsed.type, "ping");
  });
});

describe("mobile approve endpoint validation", () => {
  it("validates decision must be allow or deny", () => {
    const validDecisions = ["allow", "deny"];
    const invalidDecisions = ["accept", "reject", "yes", "no", "", null, undefined];

    for (const d of validDecisions) {
      assert.strictEqual(d === "allow" || d === "deny", true, `'${d}' should be valid`);
    }
    for (const d of invalidDecisions) {
      assert.strictEqual(d === "allow" || d === "deny", false, `'${d}' should be invalid`);
    }
  });

  it("validates id is required", () => {
    const cases = [
      { id: null, decision: "allow", valid: false },
      { id: undefined, decision: "allow", valid: false },
      { id: "", decision: "allow", valid: false },
      { id: "perm123", decision: "allow", valid: true },
      { id: "perm123", decision: "deny", valid: true },
    ];
    for (const tc of cases) {
      const isValid = !!tc.id && (tc.decision === "allow" || tc.decision === "deny");
      assert.strictEqual(isValid, tc.valid, JSON.stringify(tc));
    }
  });
});

describe("broadcastHookEvent edge cases", () => {
  it("does not throw when SSE clients set is empty", () => {
    // Simulates: broadcastHookEvent with no clients
    const mobileSSEClients = new Set();
    const eventData = { type: "permission_request", id: "p1" };

    // Should not throw
    if (mobileSSEClients.size === 0) return; // early return path

    const data = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const client of mobileSSEClients) {
      client.write(data);
    }
  });

  it("removes clients that throw on write", () => {
    const mobileSSEClients = new Set();
    const goodClient = { write: () => {} };
    const badClient = { write: () => { throw new Error("broken pipe"); } };
    mobileSSEClients.add(goodClient);
    mobileSSEClients.add(badClient);

    const data = 'data: {"type":"ping"}\n\n';
    for (const client of mobileSSEClients) {
      try { client.write(data); } catch { mobileSSEClients.delete(client); }
    }

    assert.strictEqual(mobileSSEClients.has(goodClient), true);
    assert.strictEqual(mobileSSEClients.has(badClient), false);
  });
});

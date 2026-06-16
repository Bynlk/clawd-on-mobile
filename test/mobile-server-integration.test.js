"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { initMobileServer, deriveMobileChipFields } = require("../src/mobile-server-integration");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── deriveMobileChipFields ──

describe("deriveMobileChipFields", () => {
  it("returns null for idle with no events", () => {
    const result = deriveMobileChipFields("idle", []);
    assert.equal(result, null);
  });

  it("returns error chip for idle with error event", () => {
    const result = deriveMobileChipFields("idle", [{ event: "StopFailure" }]);
    assert.equal(result.text, "出错");
    assert.equal(result.color, "#ef4444");
  });

  it("returns error chip for ApiError event", () => {
    const result = deriveMobileChipFields("idle", [{ event: "ApiError" }]);
    assert.equal(result.text, "出错");
  });

  it("returns event chip for oneshot state with known event", () => {
    const result = deriveMobileChipFields("attention", [{ event: "Stop" }]);
    assert.equal(result.text, "已完成");
    assert.equal(result.color, "#22c55e");
  });

  it("returns active chip for oneshot state with unknown event", () => {
    const result = deriveMobileChipFields("notification", [{ event: "SomeUnknown" }]);
    assert.equal(result.text, "通知");
    assert.equal(result.color, "#d97706");
  });

  it("returns active chip for oneshot with no events", () => {
    const result = deriveMobileChipFields("sweeping", []);
    assert.equal(result.text, "清理中");
  });

  it("returns active chip for working state", () => {
    const result = deriveMobileChipFields("working", []);
    assert.equal(result.text, "工作中");
    assert.equal(result.color, "#3b82f6");
  });

  it("returns event chip for working state with event", () => {
    const result = deriveMobileChipFields("working", [{ event: "PermissionRequest" }]);
    assert.equal(result.text, "需要权限");
  });

  it("returns null for unknown active state", () => {
    const result = deriveMobileChipFields("unknown_state", []);
    assert.equal(result, null);
  });

  it("handles error state as oneshot", () => {
    const result = deriveMobileChipFields("error", [{ event: "Stop" }]);
    assert.equal(result.text, "已完成");
  });

  it("handles carrying state as oneshot", () => {
    const result = deriveMobileChipFields("carrying", []);
    assert.equal(result.text, "搬运中");
  });
});

// ── initMobileServer ──

describe("initMobileServer", () => {
  it("returns expected function signatures", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const result = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    assert.equal(typeof result.getMobileWS, "function");
    assert.equal(typeof result.getMobileToken, "function");
    assert.equal(typeof result.getPendingMobileApprovals, "function");
    assert.equal(typeof result.saveMobileState, "function");
    assert.equal(typeof result.broadcastHookEvent, "function");
    assert.equal(typeof result.startMobileServer, "function");
    assert.equal(typeof result.stopMobileServer, "function");
    assert.equal(typeof result.setupPermissionHooks, "function");
    assert.equal(typeof result.setupStateChangeHooks, "function");
    assert.equal(typeof result.resolveMobileApproval, "function");
  });

  it("injects deriveMobileChipFields into ctx", () => {
    const ctx = { getDataDir: () => "/tmp" };
    initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    assert.equal(typeof ctx.deriveMobileChipFields, "function");
    assert.equal(ctx.deriveMobileChipFields("working", []).text, "工作中");
  });
});

// ── resolveMobileApproval ──

describe("resolveMobileApproval", () => {
  it("rejects missing id", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const { resolveMobileApproval } = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    const result = resolveMobileApproval(null, { decision: "allow" });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("missing id"));
  });

  it("rejects missing decision", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const { resolveMobileApproval } = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    const result = resolveMobileApproval("id1", {});
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("need decision"));
  });

  it("rejects invalid decision", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const { resolveMobileApproval } = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    const result = resolveMobileApproval("id1", { decision: "maybe" });
    assert.equal(result.ok, false);
  });

  it("rejects unknown id", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const { resolveMobileApproval } = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    const result = resolveMobileApproval("unknown", { decision: "allow" });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("not found"));
  });

  it("accepts 'behavior' as alternative to 'decision'", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    // We can't easily add to pendingMobileApprovals without going through
    // the full flow, but we can verify the 'behavior' path is accepted
    // by checking it returns "not found" (not "need decision")
    const result = integration.resolveMobileApproval("id1", { behavior: "allow" });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("not found"));
  });
});

// ── setupPermissionHooks ──

describe("setupPermissionHooks", () => {
  it("sets onPermissionAdded and onPermissionRemoved on ctx", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});
    assert.equal(typeof ctx.onPermissionAdded, "function");
    assert.equal(typeof ctx.onPermissionRemoved, "function");
  });
});

// ── setupStateChangeHooks ──

describe("setupStateChangeHooks", () => {
  it("sets state change hooks on ctx", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    assert.equal(typeof ctx.onMobileStateChange, "function");
    assert.equal(typeof ctx.onMobileToolOutput, "function");
    assert.equal(typeof ctx.onMobileSessionSnapshot, "function");
    assert.equal(typeof ctx.onMobileSessionRemoved, "function");
    assert.equal(typeof ctx.onMobileMaxClientsChange, "function");
  });
});

// ── loadMobileState ──

describe("loadMobileState", () => {
  function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mobile-test-"));
  }

  it("returns parsed object for valid JSON file", () => {
    const tmpDir = makeTmpDir();
    try {
      const ctx = { getDataDir: () => tmpDir };
      const integration = initMobileServer(ctx, {
        createHttpServer: () => ({ listen: () => {}, on: () => {} }),
      });
      // Overwrite the file created by init with known data
      const statePath = path.join(tmpDir, ".clawd-mobile-state.json");
      fs.writeFileSync(statePath, JSON.stringify({ token: "abc123", mobileMaxClients: 5 }));
      const result = integration.loadMobileState();
      assert.equal(result.token, "abc123");
      assert.equal(result.mobileMaxClients, 5);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns empty object for invalid JSON file", () => {
    const tmpDir = makeTmpDir();
    try {
      const ctx = { getDataDir: () => tmpDir };
      const integration = initMobileServer(ctx, {
        createHttpServer: () => ({ listen: () => {}, on: () => {} }),
      });
      const statePath = path.join(tmpDir, ".clawd-mobile-state.json");
      fs.writeFileSync(statePath, "not valid json {{{");
      const result = integration.loadMobileState();
      assert.deepEqual(result, {});
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns empty object when file does not exist", () => {
    const tmpDir = makeTmpDir();
    try {
      const ctx = { getDataDir: () => tmpDir };
      const integration = initMobileServer(ctx, {
        createHttpServer: () => ({ listen: () => {}, on: () => {} }),
      });
      // Remove the file created during init
      const statePath = path.join(tmpDir, ".clawd-mobile-state.json");
      try { fs.unlinkSync(statePath); } catch {}
      const result = integration.loadMobileState();
      assert.deepEqual(result, {});
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── saveMobileState ──

describe("saveMobileState", () => {
  it("writes patch data and reads back via loadMobileState", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-test-"));
    try {
      const ctx = { getDataDir: () => tmpDir };
      const integration = initMobileServer(ctx, {
        createHttpServer: () => ({ listen: () => {}, on: () => {} }),
      });
      integration.saveMobileState({ customField: "hello", mobileMaxClients: 7 });
      const result = integration.loadMobileState();
      assert.equal(result.customField, "hello");
      assert.equal(result.mobileMaxClients, 7);
      assert.equal(typeof result.savedAt, "number");
      // Token from init should be preserved
      assert.ok(result.token);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("merges patches without losing existing fields", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-test-"));
    try {
      const ctx = { getDataDir: () => tmpDir };
      const integration = initMobileServer(ctx, {
        createHttpServer: () => ({ listen: () => {}, on: () => {} }),
      });
      integration.saveMobileState({ fieldA: "a" });
      integration.saveMobileState({ fieldB: "b" });
      const result = integration.loadMobileState();
      assert.equal(result.fieldA, "a");
      assert.equal(result.fieldB, "b");
      assert.ok(result.token);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── broadcastHookEvent ──

describe("broadcastHookEvent", () => {
  it("does not throw when mobileWS is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const { broadcastHookEvent } = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    assert.doesNotThrow(() => {
      broadcastHookEvent({ type: "state_change", sessionId: "s1" });
    });
  });

  it("does not throw for permission_request type with no clients", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const { broadcastHookEvent } = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    assert.doesNotThrow(() => {
      broadcastHookEvent({ type: "permission_request", id: "p1" });
    });
  });

  it("broadcasts to connected clients when mobileWS has clients", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    const sent = [];
    const mockClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data) => sent.push(JSON.parse(data)),
    };
    mobileWS.clients.add(mockClient);

    integration.broadcastHookEvent({ type: "test_event", sessionId: "s1" });

    assert.ok(sent.length >= 1);
    assert.equal(sent[0].type, "test_event");
    assert.equal(sent[0].sessionId, "s1");

    mobileWS.clients.delete(mockClient);
    integration.stopMobileServer();
  });
});

// ── ctx.onPermissionAdded (hook behavior) ──

describe("ctx.onPermissionAdded (hook behavior)", () => {
  it("broadcasts permission_request and adds to pending approvals", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    const permEntry = {
      res: true,
      sessionId: "sess-1",
      toolName: "Bash",
      agentId: "claude",
      toolInput: { command: "ls" },
      suggestions: [{ type: "allow" }],
    };
    ctx.onPermissionAdded(permEntry, "approval-1");

    const approvals = integration.getPendingMobileApprovals();
    assert.ok(approvals.has("approval-1"));
    assert.equal(approvals.get("approval-1").entry, permEntry);

    clearTimeout(approvals.get("approval-1").timer);
  });

  it("does not add when agentId is opencode", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    ctx.onPermissionAdded(
      { res: true, sessionId: "s1", toolName: "Bash", agentId: "opencode", suggestions: [] },
      "approval-oc"
    );
    assert.ok(!integration.getPendingMobileApprovals().has("approval-oc"));
  });

  it("does not add when permEntry.res is falsy", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    ctx.onPermissionAdded(
      { sessionId: "s1", toolName: "Bash", agentId: "claude", suggestions: [] },
      "approval-nores"
    );
    assert.ok(!integration.getPendingMobileApprovals().has("approval-nores"));
  });

  it("does not add when permEntry is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    ctx.onPermissionAdded(null, "approval-null");
    assert.ok(!integration.getPendingMobileApprovals().has("approval-null"));
  });

  it("generates labels for suggestions without labels", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    const permEntry = {
      res: true,
      sessionId: "s1",
      toolName: "Bash",
      agentId: "claude",
      suggestions: [
        { type: "setMode", mode: "acceptEdits" },
        { type: "setMode", mode: "plan" },
        { type: "setMode", mode: "other" },
        { type: "addRules", rules: [{ ruleContent: "some rule", toolName: "Bash" }] },
        { type: "addRules", rules: [{ ruleContent: "a/b/**deep/path**", toolName: "Read" }] },
        { type: "allow", label: "Already labeled" },
      ],
    };
    ctx.onPermissionAdded(permEntry, "approval-labels");

    const approvals = integration.getPendingMobileApprovals();
    const pending = approvals.get("approval-labels");
    assert.ok(pending);

    clearTimeout(pending.timer);
  });
});

// ── ctx.onPermissionRemoved (hook behavior) ──

describe("ctx.onPermissionRemoved (hook behavior)", () => {
  it("clears timer and removes pending approval", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    const permEntry = {
      res: true,
      sessionId: "s1",
      toolName: "Bash",
      agentId: "claude",
      suggestions: [],
    };
    ctx.onPermissionAdded(permEntry, "approval-rm");

    const approvals = integration.getPendingMobileApprovals();
    assert.ok(approvals.has("approval-rm"));

    permEntry._mobileApprovalId = "approval-rm";
    ctx.onPermissionRemoved(permEntry);

    assert.ok(!approvals.has("approval-rm"));
  });

  it("does not throw when _mobileApprovalId is not set", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    assert.doesNotThrow(() => {
      ctx.onPermissionRemoved({ sessionId: "s1" });
    });
  });

  it("does not throw when permEntry is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupPermissionHooks(ctx, () => {});

    assert.doesNotThrow(() => {
      ctx.onPermissionRemoved(null);
    });
  });
});

// ── ctx.onMobileStateChange (hook behavior) ──

describe("ctx.onMobileStateChange (hook behavior)", () => {
  it("calls broadcastState on mobileWS and broadcastHookEvent", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    const sent = [];
    const mockClient = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    mobileWS.clients.add(mockClient);

    ctx.onMobileStateChange("sess-1", "state_change", { state: "working" });

    // broadcastState sends "state" type, broadcastHookEvent sends "state_change" type
    const stateMsgs = sent.filter((m) => m.type === "state");
    const changeMsgs = sent.filter((m) => m.type === "state_change");
    assert.ok(stateMsgs.length >= 1, "should have state message from broadcastState");
    assert.ok(changeMsgs.length >= 1, "should have state_change message from broadcastHookEvent");

    mobileWS.clients.delete(mockClient);
    integration.stopMobileServer();
  });

  it("does not throw when mobileWS is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    assert.doesNotThrow(() => {
      ctx.onMobileStateChange("s1", "state_change", { state: "idle" });
    });
  });
});

// ── ctx.onMobileToolOutput (hook behavior) ──

describe("ctx.onMobileToolOutput (hook behavior)", () => {
  it("calls broadcastToolOutput on mobileWS and broadcastHookEvent", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    const sent = [];
    const mockClient = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    mobileWS.clients.add(mockClient);

    ctx.onMobileToolOutput("sess-1", { toolName: "Bash", output: "hello" });

    const toolMsgs = sent.filter((m) => m.type === "tool_output");
    assert.ok(toolMsgs.length >= 1, "should have tool_output messages");

    mobileWS.clients.delete(mockClient);
    integration.stopMobileServer();
  });

  it("does not throw when mobileWS is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    assert.doesNotThrow(() => {
      ctx.onMobileToolOutput("s1", { toolName: "Bash" });
    });
  });
});

// ── ctx.onMobileSessionSnapshot (hook behavior) ──

describe("ctx.onMobileSessionSnapshot (hook behavior)", () => {
  it("calls broadcastSessionSnapshot on mobileWS", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    const sent = [];
    const mockClient = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    mobileWS.clients.add(mockClient);

    ctx.onMobileSessionSnapshot({
      sessions: [
        { id: "s1", state: "working", badge: "running", headless: false },
        { id: "s2", state: "sleeping", badge: "idle", headless: false },
      ],
      hudLastSessionId: "s1",
    });

    const snapshotMsgs = sent.filter((m) => m.type === "snapshot");
    assert.ok(snapshotMsgs.length >= 1, "should have snapshot message");
    // sleeping sessions should be filtered out (isVisible = false)
    assert.ok(
      !("s2" in (snapshotMsgs[0].sessions || {})),
      "sleeping session should be filtered"
    );

    mobileWS.clients.delete(mockClient);
    integration.stopMobileServer();
  });

  it("does not throw when mobileWS is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    assert.doesNotThrow(() => {
      ctx.onMobileSessionSnapshot({ sessions: [], hudLastSessionId: null });
    });
  });
});

// ── ctx.onMobileSessionRemoved (hook behavior) ──

describe("ctx.onMobileSessionRemoved (hook behavior)", () => {
  it("calls removeSession on mobileWS and broadcasts session_deleted", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    const sent = [];
    const mockClient = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    mobileWS.clients.add(mockClient);

    ctx.onMobileSessionRemoved("sess-1");

    const deletedMsgs = sent.filter((m) => m.type === "session_deleted");
    assert.ok(deletedMsgs.length >= 1, "should have session_deleted message");
    assert.equal(deletedMsgs[0].sessionId, "sess-1");

    mobileWS.clients.delete(mockClient);
    integration.stopMobileServer();
  });

  it("does not throw when mobileWS is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    assert.doesNotThrow(() => {
      ctx.onMobileSessionRemoved("s1");
    });
  });
});

// ── ctx.onMobileMaxClientsChange (hook behavior) ──

describe("ctx.onMobileMaxClientsChange (hook behavior)", () => {
  it("calls setMaxClients on mobileWS", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    ctx.onMobileMaxClientsChange(7);
    assert.equal(mobileWS.maxClients, 7);

    integration.stopMobileServer();
  });

  it("does not throw when mobileWS is null", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    assert.doesNotThrow(() => {
      ctx.onMobileMaxClientsChange(5);
    });
  });

  it("rejects out-of-range values via setMaxClients validation", () => {
    const ctx = { getDataDir: () => "/tmp" };
    const integration = initMobileServer(ctx, {
      createHttpServer: () => ({ listen: () => {}, on: () => {} }),
    });
    integration.setupStateChangeHooks(ctx);
    integration.startMobileServer({}, { skipHttpServer: true });

    const mobileWS = integration.getMobileWS();
    const original = mobileWS.maxClients;
    ctx.onMobileMaxClientsChange(20); // above max of 10
    assert.equal(mobileWS.maxClients, original, "should not change for out-of-range value");

    integration.stopMobileServer();
  });
});

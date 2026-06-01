"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  CODEX_OFFICIAL_HOOK_SOURCE,
  MAX_CODEX_OFFICIAL_TURNS,
  CODEX_SESSION_ROLE_SUBAGENT,
  pruneCodexOfficialTurns,
  getCodexOfficialTurnKey,
  classifyCodexOfficialSession,
  resolveCodexOfficialHookState,
} = require("../src/server-codex-official-turns");

// ── Constants ───────────────────────────────────────────────────────

describe("codex-official-turns constants", () => {
  it("CODEX_OFFICIAL_HOOK_SOURCE is codex-official", () => { assert.strictEqual(CODEX_OFFICIAL_HOOK_SOURCE, "codex-official"); });
  it("MAX_CODEX_OFFICIAL_TURNS is 200", () => { assert.strictEqual(MAX_CODEX_OFFICIAL_TURNS, 200); });
  it("CODEX_SESSION_ROLE_SUBAGENT is subagent", () => { assert.strictEqual(CODEX_SESSION_ROLE_SUBAGENT, "subagent"); });
});

// ── getCodexOfficialTurnKey ─────────────────────────────────────────

describe("getCodexOfficialTurnKey", () => {
  it("returns null for null turnId", () => { assert.strictEqual(getCodexOfficialTurnKey("s1", null), null); });
  it("returns null for empty turnId", () => { assert.strictEqual(getCodexOfficialTurnKey("s1", ""), null); });
  it("returns formatted key", () => { assert.strictEqual(getCodexOfficialTurnKey("s1", "t1"), "s1|t1"); });
  it("defaults sessionId to default", () => { assert.strictEqual(getCodexOfficialTurnKey(null, "t1"), "default|t1"); });
  it("defaults sessionId when undefined", () => { assert.strictEqual(getCodexOfficialTurnKey(undefined, "t1"), "default|t1"); });
});

// ── pruneCodexOfficialTurns ─────────────────────────────────────────

describe("pruneCodexOfficialTurns", () => {
  it("does nothing for null turns", () => { assert.doesNotThrow(() => pruneCodexOfficialTurns(null)); });
  it("does nothing when under limit", () => {
    const turns = new Map([["a", 1], ["b", 2]]);
    pruneCodexOfficialTurns(turns);
    assert.strictEqual(turns.size, 2);
  });
  it("prunes oldest entries when over limit", () => {
    const turns = new Map();
    for (let i = 0; i < MAX_CODEX_OFFICIAL_TURNS + 10; i++) turns.set(`k${i}`, i);
    pruneCodexOfficialTurns(turns);
    assert.strictEqual(turns.size, MAX_CODEX_OFFICIAL_TURNS);
    assert.ok(!turns.has("k0"));
    assert.ok(turns.has(`k${MAX_CODEX_OFFICIAL_TURNS + 9}`));
  });
  it("does nothing at exact limit", () => {
    const turns = new Map();
    for (let i = 0; i < MAX_CODEX_OFFICIAL_TURNS; i++) turns.set(`k${i}`, i);
    pruneCodexOfficialTurns(turns);
    assert.strictEqual(turns.size, MAX_CODEX_OFFICIAL_TURNS);
  });
});

// ── classifyCodexOfficialSession ────────────────────────────────────

describe("classifyCodexOfficialSession", () => {
  it("returns unknown for null classifier", () => {
    assert.strictEqual(classifyCodexOfficialSession({}, null), "unknown");
  });
  it("returns unknown for classifier without registerSession", () => {
    assert.strictEqual(classifyCodexOfficialSession({}, {}), "unknown");
  });
  it("returns unknown when classifier throws", () => {
    const classifier = { registerSession: () => { throw new Error("bad"); } };
    assert.strictEqual(classifyCodexOfficialSession({}, classifier), "unknown");
  });
  it("calls classifier with sessionId and payload", () => {
    const calls = [];
    const classifier = { registerSession: (sid, opts) => { calls.push({ sid, opts }); return "primary"; } };
    const result = classifyCodexOfficialSession({ session_id: "s1", codex_session_role: "primary" }, classifier);
    assert.strictEqual(result, "primary");
    assert.strictEqual(calls[0].sid, "s1");
    assert.strictEqual(calls[0].opts.hookRole, "primary");
  });
  it("defaults sessionId to default", () => {
    const calls = [];
    const classifier = { registerSession: (sid) => { calls.push(sid); return "primary"; } };
    classifyCodexOfficialSession({}, classifier);
    assert.strictEqual(calls[0], "default");
  });
});

// ── resolveCodexOfficialHookState ───────────────────────────────────

describe("resolveCodexOfficialHookState", () => {
  function codexData(event, overrides = {}) {
    return { agent_id: "codex", hook_source: CODEX_OFFICIAL_HOOK_SOURCE, event, ...overrides };
  }

  it("passes through non-codex agent", () => {
    const result = resolveCodexOfficialHookState({ agent_id: "claude-code" }, "working", new Map());
    assert.strictEqual(result.state, "working");
    assert.strictEqual(result.drop, false);
  });

  it("passes through null data", () => {
    const result = resolveCodexOfficialHookState(null, "working", new Map());
    assert.strictEqual(result.state, "working");
    assert.strictEqual(result.drop, false);
  });

  it("passes through non-codex-official hook_source", () => {
    const result = resolveCodexOfficialHookState({ agent_id: "codex", hook_source: "other" }, "working", new Map());
    assert.strictEqual(result.state, "working");
    assert.strictEqual(result.drop, false);
  });

  it("drops Stop with stop_hook_active=true", () => {
    const result = resolveCodexOfficialHookState(codexData("Stop", { stop_hook_active: true, turn_id: "t1", session_id: "s1" }), "working", new Map());
    assert.strictEqual(result.drop, true);
    assert.strictEqual(result.state, "working");
  });

  it("deletes turn from map on Stop with stop_hook_active", () => {
    const turns = new Map([["s1|t1", { sessionId: "s1", hadToolUse: false }]]);
    resolveCodexOfficialHookState(codexData("Stop", { stop_hook_active: true, turn_id: "t1", session_id: "s1" }), "working", turns);
    assert.strictEqual(turns.has("s1|t1"), false);
  });

  it("records UserPromptSubmit as new turn", () => {
    const turns = new Map();
    resolveCodexOfficialHookState(codexData("UserPromptSubmit", { turn_id: "t1", session_id: "s1" }), "working", turns);
    assert.strictEqual(turns.size, 1);
    assert.strictEqual(turns.get("s1|t1").hadToolUse, false);
  });

  it("marks hadToolUse on PreToolUse", () => {
    const turns = new Map([["s1|t1", { sessionId: "s1", hadToolUse: false }]]);
    resolveCodexOfficialHookState(codexData("PreToolUse", { turn_id: "t1", session_id: "s1" }), "working", turns);
    assert.strictEqual(turns.get("s1|t1").hadToolUse, true);
  });

  it("marks hadToolUse on PostToolUse", () => {
    const turns = new Map([["s1|t1", { sessionId: "s1", hadToolUse: false }]]);
    resolveCodexOfficialHookState(codexData("PostToolUse", { turn_id: "t1", session_id: "s1" }), "working", turns);
    assert.strictEqual(turns.get("s1|t1").hadToolUse, true);
  });

  it("Stop with toolUse returns attention state", () => {
    const turns = new Map([["s1|t1", { sessionId: "s1", hadToolUse: true }]]);
    const result = resolveCodexOfficialHookState(codexData("Stop", { turn_id: "t1", session_id: "s1" }), "working", turns);
    assert.strictEqual(result.state, "attention");
    assert.strictEqual(result.drop, false);
  });

  it("Stop without toolUse returns idle state", () => {
    const turns = new Map([["s1|t1", { sessionId: "s1", hadToolUse: false }]]);
    const result = resolveCodexOfficialHookState(codexData("Stop", { turn_id: "t1", session_id: "s1" }), "working", turns);
    assert.strictEqual(result.state, "idle");
    assert.strictEqual(result.drop, false);
  });

  it("Stop without turnKey returns idle", () => {
    const result = resolveCodexOfficialHookState(codexData("Stop", { session_id: "s1" }), "working", new Map());
    assert.strictEqual(result.state, "idle");
  });

  it("subagent Stop returns headless idle", () => {
    const classifier = { registerSession: () => "subagent" };
    const result = resolveCodexOfficialHookState(codexData("Stop", { turn_id: "t1", session_id: "s1", codex_session_role: "subagent" }), "working", new Map([["s1|t1", { sessionId: "s1", hadToolUse: true }]]), classifier);
    assert.strictEqual(result.state, "idle");
    assert.strictEqual(result.headless, true);
  });

  it("subagent events carry headless flag", () => {
    const classifier = { registerSession: () => "subagent" };
    const result = resolveCodexOfficialHookState(codexData("UserPromptSubmit", { turn_id: "t1", session_id: "s1", codex_session_role: "subagent" }), "working", new Map(), classifier);
    assert.strictEqual(result.headless, true);
  });

  it("non-subagent events do not carry headless flag", () => {
    const classifier = { registerSession: () => "primary" };
    const result = resolveCodexOfficialHookState(codexData("UserPromptSubmit", { turn_id: "t1", session_id: "s1" }), "working", new Map(), classifier);
    assert.strictEqual(result.headless, undefined);
  });

  it("passes through unknown events unchanged", () => {
    const result = resolveCodexOfficialHookState(codexData("PreCompact", { turn_id: "t1", session_id: "s1" }), "working", new Map());
    assert.strictEqual(result.state, "working");
    assert.strictEqual(result.drop, false);
  });
});

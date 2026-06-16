"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionModule() {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
        globalShortcut: {
          register() { return true; },
          unregister() {},
          isRegistered() { return false; },
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    ...overrides,
  };
}

// ── sanitizeCopilotPermissionDecision ──────────────────────────────────

describe("sanitizeCopilotPermissionDecision", () => {
  const mod = loadPermissionModule();
  const sanitize = mod.__test.sanitizeCopilotPermissionDecision;

  it("returns null for null input", () => {
    assert.equal(sanitize(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(sanitize(undefined), null);
  });

  it("returns null for numeric input", () => {
    assert.equal(sanitize(42), null);
  });

  it("returns null for object with invalid behavior", () => {
    assert.equal(sanitize({ behavior: "ask" }), null);
    assert.equal(sanitize({ behavior: "force_ask" }), null);
    assert.equal(sanitize({ behavior: "maybe" }), null);
  });

  it("returns null for empty object without behavior", () => {
    assert.equal(sanitize({}), null);
  });

  it("returns allow decision from object input", () => {
    assert.deepEqual(sanitize({ behavior: "allow" }), { behavior: "allow" });
  });

  it("returns deny decision from object without message", () => {
    assert.deepEqual(sanitize({ behavior: "deny" }), { behavior: "deny" });
  });

  it("includes message on deny when provided as a non-empty string", () => {
    assert.deepEqual(
      sanitize({ behavior: "deny", message: "Blocked by policy" }),
      { behavior: "deny", message: "Blocked by policy" }
    );
  });

  it("accepts string shorthand for allow", () => {
    assert.deepEqual(sanitize("allow"), { behavior: "allow" });
  });

  it("accepts string shorthand for deny with second-argument message", () => {
    assert.deepEqual(sanitize("deny", "Not allowed"), {
      behavior: "deny",
      message: "Not allowed",
    });
  });

  it("drops message on allow even when provided", () => {
    const result = sanitize({ behavior: "allow", message: "should be dropped" });
    assert.deepEqual(result, { behavior: "allow" });
    assert.equal(result.message, undefined);
  });

  it("drops non-string message on deny", () => {
    assert.deepEqual(sanitize({ behavior: "deny", message: 123 }), { behavior: "deny" });
  });

  it("drops empty-string message on deny", () => {
    assert.deepEqual(sanitize({ behavior: "deny", message: "" }), { behavior: "deny" });
  });
});

// ── buildCopilotPermissionResponseBody ─────────────────────────────────

describe("buildCopilotPermissionResponseBody", () => {
  const mod = loadPermissionModule();
  const build = mod.__test.buildCopilotPermissionResponseBody;

  it("returns '{}' for null input", () => {
    assert.equal(build(null), "{}");
  });

  it("returns '{}' for undefined input", () => {
    assert.equal(build(undefined), "{}");
  });

  it("returns '{}' for invalid behavior", () => {
    assert.equal(build({ behavior: "ask" }), "{}");
  });

  it("returns '{}' for non-string non-object input", () => {
    assert.equal(build(42), "{}");
    assert.equal(build(true), "{}");
  });

  it("wraps allow decision in plain JSON (no hookSpecificOutput envelope)", () => {
    const parsed = JSON.parse(build("allow"));
    assert.deepEqual(parsed, { behavior: "allow" });
  });

  it("wraps deny with message in JSON", () => {
    const parsed = JSON.parse(build("deny", "Blocked by policy"));
    assert.deepEqual(parsed, { behavior: "deny", message: "Blocked by policy" });
  });

  it("wraps deny without message in JSON", () => {
    const parsed = JSON.parse(build({ behavior: "deny" }));
    assert.deepEqual(parsed, { behavior: "deny" });
  });
});

// ── computePassiveNotifyRemainingMs ────────────────────────────────────

describe("computePassiveNotifyRemainingMs", () => {
  const mod = loadPermissionModule();
  const compute = mod.__test.computePassiveNotifyRemainingMs;

  it("returns 0 when autoCloseMs is zero", () => {
    assert.equal(compute(Date.now(), 0), 0);
  });

  it("returns 0 when autoCloseMs is negative", () => {
    assert.equal(compute(Date.now(), -5000), 0);
  });

  it("returns 0 when autoCloseMs is NaN", () => {
    assert.equal(compute(Date.now(), NaN), 0);
  });

  it("returns 0 when autoCloseMs is Infinity", () => {
    assert.equal(compute(Date.now(), Infinity), 0);
  });

  it("returns totalMs when createdAt is 0 (invalid)", () => {
    assert.equal(compute(0, 5000), 5000);
  });

  it("returns totalMs when createdAt is negative", () => {
    assert.equal(compute(-100, 5000), 5000);
  });

  it("returns totalMs when createdAt is NaN", () => {
    assert.equal(compute(NaN, 5000), 5000);
  });

  it("returns correct remaining time for partially elapsed window", () => {
    // createdAt=97000, autoCloseMs=5000, now=100000 → elapsed=3000, remaining=2000
    assert.equal(compute(97000, 5000, 100000), 2000);
  });

  it("returns 0 when fully elapsed", () => {
    assert.equal(compute(100000, 5000, 105000), 0);
  });

  it("returns 0 when over-elapsed", () => {
    assert.equal(compute(100000, 5000, 120000), 0);
  });

  it("returns totalMs when now equals createdAt (zero elapsed)", () => {
    assert.equal(compute(100000, 5000, 100000), 5000);
  });
});

// ── buildPermissionFocusEntry ──────────────────────────────────────────

describe("buildPermissionFocusEntry", () => {
  const mod = loadPermissionModule();
  const build = mod.__test.buildPermissionFocusEntry;

  it("returns null for null input", () => {
    assert.equal(build(null), null);
  });

  it("returns null for non-object inputs", () => {
    assert.equal(build("string"), null);
    assert.equal(build(42), null);
    assert.equal(build(true), null);
  });

  it("returns null when sessionId is missing", () => {
    assert.equal(build({ agentId: "claude-code" }), null);
  });

  it("returns null when sessionId is empty string", () => {
    assert.equal(build({ sessionId: "" }), null);
  });

  it("returns null when sessionId is falsy (0)", () => {
    assert.equal(build({ sessionId: 0 }), null);
  });

  it("builds minimal entry with sessionId and null agentId", () => {
    assert.deepEqual(build({ sessionId: "sess-1" }), { id: "sess-1", agentId: null });
  });

  it("includes agentId when provided", () => {
    const result = build({ sessionId: "s1", agentId: "codex" });
    assert.equal(result.agentId, "codex");
  });

  it("coerces numeric sessionId to string", () => {
    const result = build({ sessionId: 123 });
    assert.equal(result.id, "123");
  });

  it("includes all optional fields when truthy", () => {
    const result = build({
      sessionId: "s1",
      agentId: "claude-code",
      sourcePid: 111,
      cwd: "/repo",
      agentPid: 222,
      pidChain: [333, 222],
      host: "remote-host",
      platform: "linux",
      model: "sonnet-4",
      codexOriginator: "Codex Desktop",
      codexSource: "vscode",
    });
    assert.deepEqual(result, {
      id: "s1",
      agentId: "claude-code",
      sourcePid: 111,
      cwd: "/repo",
      agentPid: 222,
      pidChain: [333, 222],
      host: "remote-host",
      platform: "linux",
      model: "sonnet-4",
      codexOriginator: "Codex Desktop",
      codexSource: "vscode",
    });
  });

  it("omits falsy optional fields from the output", () => {
    const result = build({
      sessionId: "s1",
      sourcePid: 0,
      cwd: "",
      agentPid: null,
      pidChain: undefined,
      host: "",
      platform: "",
      model: "",
      codexOriginator: "",
      codexSource: "",
    });
    assert.equal(result.sourcePid, undefined);
    assert.equal(result.cwd, undefined);
    assert.equal(result.agentPid, undefined);
    assert.equal(result.pidChain, undefined);
    assert.equal(result.host, undefined);
    assert.equal(result.platform, undefined);
    assert.equal(result.model, undefined);
    assert.equal(result.codexOriginator, undefined);
    assert.equal(result.codexSource, undefined);
  });
});

// ── isRemoteApprovalActionable (tested via maybeStartRemoteApproval) ──

describe("isRemoteApprovalActionable", () => {
  function createHarness(ctxOverrides = {}) {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});
      },
    };
    const perm = loadPermissionModule()(makeCtx({
      getTelegramApprovalClient: () => client,
      ...ctxOverrides,
    }));
    return { perm, requests };
  }

  function makeEntry(overrides = {}) {
    return {
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "npm test", description: "Run project tests" },
      agentId: "claude-code",
      ...overrides,
    };
  }

  it("rejects null and undefined entries", () => {
    const { perm } = createHarness();
    assert.equal(perm.maybeStartRemoteApproval(null), false);
    assert.equal(perm.maybeStartRemoteApproval(undefined), false);
  });

  it("rejects elicitation entries", () => {
    const { perm } = createHarness();
    const entry = makeEntry({ isElicitation: true });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
  });

  it("rejects passive-notify entries (codex and kimi)", () => {
    const { perm } = createHarness();
    const codex = makeEntry({ isCodexNotify: true });
    const kimi = makeEntry({ isKimiNotify: true });
    perm.pendingPermissions.push(codex, kimi);
    assert.equal(perm.maybeStartRemoteApproval(codex), false);
    assert.equal(perm.maybeStartRemoteApproval(kimi), false);
  });

  it("rejects agent-specific non-actionable flags", () => {
    const { perm } = createHarness();
    for (const flag of ["isOpencode", "isAntigravity", "isCopilotCli"]) {
      const entry = makeEntry({ [flag]: true });
      perm.pendingPermissions.push(entry);
      assert.equal(perm.maybeStartRemoteApproval(entry), false, `should reject ${flag}`);
    }
  });

  it("rejects ExitPlanMode and AskUserQuestion tools", () => {
    const { perm } = createHarness();
    for (const toolName of ["ExitPlanMode", "AskUserQuestion"]) {
      const entry = makeEntry({ toolName });
      perm.pendingPermissions.push(entry);
      assert.equal(perm.maybeStartRemoteApproval(entry), false, `should reject ${toolName}`);
    }
  });

  it("rejects passthrough tools that auto-allow without a bubble", () => {
    const { perm } = createHarness();
    const passthroughTools = [
      "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput",
    ];
    for (const toolName of passthroughTools) {
      const entry = makeEntry({ toolName });
      perm.pendingPermissions.push(entry);
      assert.equal(perm.maybeStartRemoteApproval(entry), false, `should reject ${toolName}`);
    }
  });

  it("rejects entries from headless sessions", () => {
    const sessions = new Map([["s1", { cwd: "/repo", headless: true }]]);
    const { perm } = createHarness({ sessions });
    const entry = makeEntry();
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
  });

  it("accepts a valid actionable entry when a Telegram client is available", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry();
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);
  });

  it("accepts entries from non-headless sessions", () => {
    const sessions = new Map([["s1", { cwd: "/repo", headless: false }]]);
    const { perm, requests } = createHarness({ sessions });
    const entry = makeEntry();
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);
  });
});

// ── buildRemoteApprovalSummary (tested via Telegram payload detail) ────

describe("buildRemoteApprovalSummary", () => {
  function createHarness() {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});
      },
    };
    const perm = loadPermissionModule()(makeCtx({
      getTelegramApprovalClient: () => client,
    }));
    return { perm, requests };
  }

  function makeEntry(toolInputOverrides = {}) {
    return {
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "npm test", ...toolInputOverrides },
      agentId: "claude-code",
    };
  }

  it("uses description as the summary text", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry({ description: "Run project tests" });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.ok(requests[0].detail.includes("Summary: Run project tests"));
  });

  it("falls back to summary field when description is absent", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry({ summary: "Executing test suite" });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.ok(requests[0].detail.includes("Summary: Executing test suite"));
  });

  it("falls back to reason field when description and summary are absent", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry({ reason: "User requested this action" });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.ok(requests[0].detail.includes("Summary: User requested this action"));
  });

  it("refuses to send a Telegram card when no description, summary, or reason exists", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry(); // only has command
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.equal(requests.length, 0);
  });

  it("redacts sensitive tokens found in the summary text", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry({
      description: "Run tests with sk-abcdefghijklmnop and Bearer eyJhbGciOiJIUzI1NiJ9.xyz123",
    });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    const detail = requests[0].detail;
    assert.ok(!detail.includes("sk-abcdefghijklmnop"), "should redact sk- token");
    assert.ok(!detail.includes("eyJhbGciOiJIUzI1NiJ9.xyz123"), "should redact Bearer token");
    assert.ok(detail.includes("<redacted"), "should contain redacted marker");
  });

  it("prefers description over summary when both are present", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntry({ description: "Primary desc", summary: "Fallback summary" });
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.ok(requests[0].detail.includes("Summary: Primary desc"));
    assert.ok(!requests[0].detail.includes("Fallback summary"));
  });
});

// ── buildRemoteSuggestionLabel + buildRemoteSuggestionButtons ──────────

describe("buildRemoteSuggestionLabel and buildRemoteSuggestionButtons", () => {
  function createHarness() {
    const requests = [];
    const client = {
      isEnabled: () => true,
      requestApproval: (payload) => {
        requests.push(payload);
        return new Promise(() => {});
      },
    };
    const perm = loadPermissionModule()(makeCtx({
      getTelegramApprovalClient: () => client,
    }));
    return { perm, requests };
  }

  function makeEntryWithSuggestions(suggestions) {
    return {
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "npm test", description: "Run tests" },
      agentId: "claude-code",
      suggestions,
    };
  }

  it("maps setMode/acceptEdits suggestion to 'Auto edits'", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
    ]);
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Auto edits" },
    ]);
  });

  it("maps setMode/plan suggestion to 'Plan mode'", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "setMode", mode: "plan", destination: "localSettings" },
    ]);
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Plan mode" },
    ]);
  });

  it("maps addRules/allow with toolName to 'Always {toolName}'", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "npm test" }] },
    ]);
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Always Bash" },
    ]);
  });

  it("maps addRules/deny with toolName to 'Always deny {toolName}'", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "addRules", behavior: "deny", rules: [{ toolName: "Bash" }] },
    ]);
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Always deny Bash" },
    ]);
  });

  it("deduplicates suggestions that produce identical labels", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
      { type: "setMode", mode: "acceptEdits", destination: "projectSettings" },
    ]);
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Auto edits" },
    ]);
  });

  it("preserves the original suggestion index for non-duplicate entries", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
      { type: "setMode", mode: "plan", destination: "localSettings" },
    ]);
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Auto edits" },
      { index: 1, label: "Plan mode" },
    ]);
  });

  it("excludes suggestions from non-rich agents (e.g. codex)", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
    ]);
    entry.agentId = "codex";
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(requests[0], "suggestions"),
      false,
      "non-rich agent payloads should not include suggestions"
    );
  });

  it("omits the suggestions field when entry has no suggestions array", () => {
    const { perm, requests } = createHarness();
    const entry = {
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "npm test", description: "Run tests" },
      agentId: "claude-code",
    };
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(requests[0], "suggestions"),
      false,
      "payload should not include suggestions when none are provided"
    );
  });

  it("supports codebuddy as a rich agent with suggestions", () => {
    const { perm, requests } = createHarness();
    const entry = makeEntryWithSuggestions([
      { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
    ]);
    entry.agentId = "codebuddy";
    perm.pendingPermissions.push(entry);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(requests[0].suggestions, [
      { index: 0, label: "Auto edits" },
    ]);
  });
});

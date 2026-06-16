"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

// ── Helpers ────────────────────────────────────────────────────────────

function loadPermissionWithElectron(fakeElectron = null) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return fakeElectron || {
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

function createFakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    headersSent: false,
    _listeners: new Map(),
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
    },
    end(data) {
      if (data) this.body += String(data);
      this.writableEnded = true;
      this.writableFinished = true;
    },
    on(event, handler) {
      this._listeners.set(event, handler);
      return this;
    },
    removeListener(event, handler) {
      if (this._listeners.get(event) === handler) this._listeners.delete(event);
      return this;
    },
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
      this.writableFinished = true;
      const handler = this._listeners.get("close");
      if (handler) handler();
    },
  };
  return res;
}

function createFakeBubble() {
  const bubble = {
    hidden: false,
    destroyed: false,
    webContents: {
      send(event) {
        if (event === "permission-hide") bubble.hidden = true;
      },
    },
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
  };
  return bubble;
}

function createDecisionHarness() {
  const focusCalls = [];
  const fakeElectron = {
    BrowserWindow: Object.assign(class {}, {
      fromWebContents(sender) { return sender && sender.__window ? sender.__window : null; },
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const initPermission = loadPermissionWithElectron(fakeElectron);
  const api = initPermission({
    sessions: new Map(),
    hideBubbles: false,
    petHidden: false,
    win: null,
    lang: "en",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    focusTerminalForSession: (sessionId, options) => focusCalls.push([sessionId, options]),
    permDebugLog: null,
  });
  return { api, focusCalls };
}

function makePermEntry(agentFlag, overrides = {}) {
  return {
    res: createFakeRes(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: `${overrides.agentId || agentFlag}:s1`,
    bubble: createFakeBubble(),
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "npm test" },
    createdAt: Date.now(),
    agentId: overrides.agentId || agentFlag,
    ...{ [agentFlag]: true },
    ...overrides,
  };
}

// ── sendCopilotPermissionResponse ──────────────────────────────────────

describe("sendCopilotPermissionResponse (via resolvePermissionEntry)", () => {
  it("sends 200 with {behavior:'allow'} JSON for allow decision", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isCopilotCli", { agentId: "copilot-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, 200);
    assert.equal(perm.res.headers["Content-Type"], "application/json");
    assert.equal(perm.res.headers["x-clawd-server"], "clawd-on-mobile");
    const body = JSON.parse(perm.res.body);
    assert.deepEqual(body, { behavior: "allow" });
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 200 with {behavior:'deny'} JSON for deny decision (message not passed via handleDecide)", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isCopilotCli", { agentId: "copilot-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny");

    assert.equal(perm.res.statusCode, 200);
    const body = JSON.parse(perm.res.body);
    assert.equal(body.behavior, "deny");
    // handleDecide does not pass a message for deny; only the bubble-closed
    // auto-resolve path passes "Bubble window closed by user"
    assert.equal(body.message, undefined);
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 for no-decision (deny-and-focus)", () => {
    const { api, focusCalls } = createDecisionHarness();
    const perm = makePermEntry("isCopilotCli", { agentId: "copilot-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny-and-focus");

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0][0], "copilot-cli:s1");
  });

  it("sends 204 for unsupported Copilot bubble actions", () => {
    for (const behavior of ["suggestion:0", "opencode-always"]) {
      const { api } = createDecisionHarness();
      const perm = makePermEntry("isCopilotCli", { agentId: "copilot-cli" });
      api.pendingPermissions.push(perm);

      api.handleDecide({ sender: { __window: perm.bubble } }, behavior);

      assert.equal(perm.res.statusCode, 204, `behavior=${behavior} should send 204`);
      assert.equal(perm.res.body, "");
      assert.equal(api.pendingPermissions.length, 0);
    }
  });

  it("does not send response when res is already destroyed", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isCopilotCli", { agentId: "copilot-cli" });
    perm.res.destroy();
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    // res.destroyed triggers "no-decision" guard; statusCode stays null
    assert.equal(perm.res.statusCode, null);
    assert.equal(api.pendingPermissions.length, 0);
  });
});

// ── sendQwenCodePermissionResponse ─────────────────────────────────────

describe("sendQwenCodePermissionResponse (via resolvePermissionEntry)", () => {
  it("sends 200 with hookSpecificOutput envelope containing {behavior:'allow'} for allow decision", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isQwenCode", { agentId: "qwen-code" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, 200);
    assert.equal(perm.res.headers["Content-Type"], "application/json");
    assert.equal(perm.res.headers["x-clawd-server"], "clawd-on-mobile");
    const body = JSON.parse(perm.res.body);
    // QwenCode uses the same hookSpecificOutput envelope as Codex
    assert.deepEqual(body, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 200 with hookSpecificOutput envelope containing {behavior:'deny'} for deny decision", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isQwenCode", { agentId: "qwen-code" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny");

    assert.equal(perm.res.statusCode, 200);
    const body = JSON.parse(perm.res.body);
    // QwenCode uses the Codex envelope; handleDecide does not pass a message
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
    assert.equal(body.hookSpecificOutput.hookEventName, "PermissionRequest");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 for no-decision (deny-and-focus)", () => {
    const { api, focusCalls } = createDecisionHarness();
    const perm = makePermEntry("isQwenCode", { agentId: "qwen-code" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny-and-focus");

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0][0], "qwen-code:s1");
  });

  it("sends 204 for unsupported Qwen bubble actions", () => {
    for (const behavior of ["suggestion:0", "opencode-always"]) {
      const { api } = createDecisionHarness();
      const perm = makePermEntry("isQwenCode", { agentId: "qwen-code" });
      api.pendingPermissions.push(perm);

      api.handleDecide({ sender: { __window: perm.bubble } }, behavior);

      assert.equal(perm.res.statusCode, 204, `behavior=${behavior} should send 204`);
      assert.equal(perm.res.body, "");
      assert.equal(api.pendingPermissions.length, 0);
    }
  });

  it("skips writing to a res that is already writableEnded", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isQwenCode", { agentId: "qwen-code" });
    perm.res.writableEnded = true;
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, null, "should not writeHead when writableEnded");
    assert.equal(api.pendingPermissions.length, 0);
  });
});

// ── sendAntigravityPermissionResponse ──────────────────────────────────

describe("sendAntigravityPermissionResponse (via resolvePermissionEntry)", () => {
  it("sends 200 with {decision:'allow', allowTool:true} for allow", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isAntigravity", { agentId: "antigravity-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, 200);
    assert.equal(perm.res.headers["Content-Type"], "application/json");
    assert.equal(perm.res.headers["x-clawd-server"], "clawd-on-mobile");
    const body = JSON.parse(perm.res.body);
    assert.equal(body.decision, "allow");
    assert.equal(body.allowTool, true);
    assert.equal(body.permissionOverrides, undefined);
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 200 with {decision:'deny'} for deny", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isAntigravity", { agentId: "antigravity-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny");

    assert.equal(perm.res.statusCode, 200);
    const body = JSON.parse(perm.res.body);
    assert.equal(body.decision, "deny");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 for no-decision (deny-and-focus)", () => {
    const { api, focusCalls } = createDecisionHarness();
    const perm = makePermEntry("isAntigravity", { agentId: "antigravity-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny-and-focus");

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(focusCalls.length, 1);
  });

  it("sends 204 for unsupported Antigravity bubble actions", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isAntigravity", { agentId: "antigravity-cli" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "suggestion:0");

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("does not respond when res has headersSent already", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isAntigravity", { agentId: "antigravity-cli" });
    perm.res.headersSent = true;
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, null, "should not writeHead when headersSent");
    assert.equal(api.pendingPermissions.length, 0);
  });
});

// ── sendHermesPermissionResponse ───────────────────────────────────────

describe("sendHermesPermissionResponse (via resolvePermissionEntry)", () => {
  it("sends 200 with {decision:'allow'} for allow", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isHermes", { agentId: "hermes" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, 200);
    assert.equal(perm.res.headers["Content-Type"], "application/json");
    assert.equal(perm.res.headers["x-clawd-server"], "clawd-on-mobile");
    const body = JSON.parse(perm.res.body);
    assert.equal(body.decision, "allow");
    assert.equal(body.message, undefined);
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 200 with {decision:'deny'} for deny (message omitted when not passed)", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isHermes", { agentId: "hermes" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny");

    assert.equal(perm.res.statusCode, 200);
    const body = JSON.parse(perm.res.body);
    assert.equal(body.decision, "deny");
    // handleDecide does not pass a message for plain deny; message || undefined = undefined
    assert.equal(body.message, undefined);
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 for no-decision (deny-and-focus)", () => {
    const { api, focusCalls } = createDecisionHarness();
    const perm = makePermEntry("isHermes", { agentId: "hermes" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "deny-and-focus");

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0][0], "hermes:s1");
  });

  it("sends 200 with {decision:'allow', answers} for elicitation allow", () => {
    const { api } = createDecisionHarness();
    // toolInput must contain a questions array so buildElicitationUpdatedInput
    // can match answers back to questions by their .question property
    const perm = makePermEntry("isHermes", {
      agentId: "hermes",
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{ question: "What path?" }],
      },
    });
    api.pendingPermissions.push(perm);

    // Elicitation submit via object behavior triggers buildElicitationUpdatedInput
    api.handleDecide({ sender: { __window: perm.bubble } }, {
      type: "elicitation-submit",
      answers: { "What path?": "/src/index.ts" },
    });

    assert.equal(perm.res.statusCode, 200);
    const body = JSON.parse(perm.res.body);
    assert.equal(body.decision, "allow");
    assert.deepEqual(body.answers, { "What path?": "/src/index.ts" });
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 for unsupported Hermes bubble actions", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isHermes", { agentId: "hermes" });
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "opencode-always");

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("does not respond when res is already destroyed", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isHermes", { agentId: "hermes" });
    perm.res.destroy();
    api.pendingPermissions.push(perm);

    api.handleDecide({ sender: { __window: perm.bubble } }, "allow");

    assert.equal(perm.res.statusCode, null);
    assert.equal(api.pendingPermissions.length, 0);
  });
});

// ── No-decision cleanup paths ──────────────────────────────────────────

describe("cleanup sends no-decision for fail-open agents", () => {
  it("sends 204 no-decision for Copilot on cleanup", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isCopilotCli", { agentId: "copilot-cli" });
    api.pendingPermissions.push(perm);

    api.cleanup();

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 no-decision for Qwen on cleanup", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isQwenCode", { agentId: "qwen-code" });
    api.pendingPermissions.push(perm);

    api.cleanup();

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 no-decision for Antigravity on cleanup", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isAntigravity", { agentId: "antigravity-cli" });
    api.pendingPermissions.push(perm);

    api.cleanup();

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });

  it("sends 204 no-decision for Hermes on cleanup", () => {
    const { api } = createDecisionHarness();
    const perm = makePermEntry("isHermes", { agentId: "hermes" });
    api.pendingPermissions.push(perm);

    api.cleanup();

    assert.equal(perm.res.statusCode, 204);
    assert.equal(perm.res.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });
});

// ── DND dismissal path ─────────────────────────────────────────────────

describe("dismissPermissionsForDnd sends no-decision for all agent types", () => {
  it("dismisses Copilot, Qwen, Antigravity, and Hermes as no-decision", () => {
    const { api } = createDecisionHarness();
    const copilotRes = createFakeRes();
    const qwenRes = createFakeRes();
    const antigravityRes = createFakeRes();
    const hermesRes = createFakeRes();

    api.pendingPermissions.push(
      { ...makePermEntry("isCopilotCli", { agentId: "copilot-cli" }), res: copilotRes },
      { ...makePermEntry("isQwenCode", { agentId: "qwen-code" }), res: qwenRes },
      { ...makePermEntry("isAntigravity", { agentId: "antigravity-cli" }), res: antigravityRes },
      { ...makePermEntry("isHermes", { agentId: "hermes" }), res: hermesRes },
    );

    assert.equal(api.dismissPermissionsForDnd(), 4);

    assert.equal(copilotRes.statusCode, 204);
    assert.equal(copilotRes.body, "");
    assert.equal(qwenRes.statusCode, 204);
    assert.equal(qwenRes.body, "");
    assert.equal(antigravityRes.statusCode, 204);
    assert.equal(antigravityRes.body, "");
    assert.equal(hermesRes.statusCode, 204);
    assert.equal(hermesRes.body, "");
    assert.equal(api.pendingPermissions.length, 0);
  });
});

// ── dismissPermissionsByAgent ──────────────────────────────────────────

describe("dismissPermissionsByAgent sends no-decision for matching agent", () => {
  it("dismisses Hermes permissions as no-decision when agent matches", () => {
    const { api } = createDecisionHarness();
    const hermesRes = createFakeRes();
    const otherRes = createFakeRes();

    api.pendingPermissions.push(
      { ...makePermEntry("isHermes", { agentId: "hermes" }), res: hermesRes },
      { res: otherRes, abortHandler: () => {}, sessionId: "claude:s1", bubble: createFakeBubble(), hideTimer: null, agentId: "claude-code", toolName: "Bash", toolInput: {} },
    );

    assert.equal(api.dismissPermissionsByAgent("hermes"), 1);

    assert.equal(hermesRes.statusCode, 204);
    assert.equal(hermesRes.body, "");
    assert.equal(otherRes.destroyed, false);
    assert.equal(api.pendingPermissions.length, 1);
  });
});

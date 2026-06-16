"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createIntegrationSyncRuntime } = require("../src/integration-sync");

function makeRuntime(overrides = {}) {
  const calls = [];
  const repairOptions = [];
  const ctx = {
    autoStartWithClaude: true,
    syncClawdHooksImpl: (options) => {
      calls.push({ name: "claude", options });
      return { status: "ok", source: "claude" };
    },
    syncGeminiHooksImpl: () => calls.push({ name: "gemini" }),
    syncAntigravityHooksImpl: () => calls.push({ name: "antigravity" }),
    syncCursorHooksImpl: () => calls.push({ name: "cursor" }),
    syncCopilotHooksImpl: () => calls.push({ name: "copilot" }),
    syncCodeBuddyHooksImpl: () => calls.push({ name: "codebuddy" }),
    syncKiroHooksImpl: () => calls.push({ name: "kiro" }),
    syncKimiHooksImpl: () => calls.push({ name: "kimi" }),
    syncQwenHooksImpl: () => calls.push({ name: "qwen" }),
    syncCodexHooksImpl: () => calls.push({ name: "codex" }),
    repairCodexHooksImpl: (options) => {
      calls.push({ name: "codex-repair" });
      repairOptions.push(options);
      return { status: "ok", message: "done" };
    },
    syncOpencodePluginImpl: () => calls.push({ name: "opencode" }),
    syncPiExtensionImpl: () => calls.push({ name: "pi" }),
    syncOpenClawPluginImpl: () => calls.push({ name: "openclaw" }),
    repairOpenClawPluginImpl: () => {
      calls.push({ name: "openclaw-repair" });
      return { status: "ok", message: "done" };
    },
    syncHermesPluginImpl: () => calls.push({ name: "hermes" }),
    ...(overrides.ctx || {}),
  };
  const runtime = createIntegrationSyncRuntime({
    ctx,
    getHookServerPort: () => 24444,
    shouldManageClaudeHooks: () => true,
    isAgentEnabled: () => true,
    startClaudeSettingsWatcher: () => calls.push({ name: "watcher:start" }),
    stopClaudeSettingsWatcher: () => {
      calls.push({ name: "watcher:stop" });
      return "stopped";
    },
    ...overrides,
  });
  return { runtime, calls, repairOptions };
}

describe("integration sync runtime", () => {
  it("syncClawdHooks passes auto-start and the current server port", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncClawdHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    assert.deepStrictEqual(calls, [
      { name: "claude", options: { autoStart: true, port: 24444 } },
    ]);
  });

  it("startup syncs enabled integrations in the server order and starts the Claude watcher after Claude sync", () => {
    const disabled = new Set(["cursor-agent", "opencode"]);
    const { runtime, calls } = makeRuntime({
      isAgentEnabled: (agentId) => !disabled.has(agentId),
    });

    runtime.syncEnabledStartupIntegrations();

    assert.deepStrictEqual(calls.map((entry) => entry.name), [
      "claude",
      "watcher:start",
      "gemini",
      "antigravity",
      "copilot",
      "codebuddy",
      "kiro",
      "kimi",
      "qwen",
      "codex",
      "pi",
      "openclaw",
      "hermes",
    ]);
  });

  it("syncIntegrationForAgent respects Claude management gate", () => {
    const { runtime, calls } = makeRuntime({
      shouldManageClaudeHooks: () => false,
    });

    assert.strictEqual(runtime.syncIntegrationForAgent("claude-code"), false);
    assert.deepStrictEqual(calls, []);
  });

  it("syncIntegrationForAgent starts the Claude watcher after a managed Claude sync", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncIntegrationForAgent("claude-code");

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["claude", "watcher:start"]);
  });

  it("syncIntegrationForAgent('copilot-cli') invokes the Copilot syncer", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncIntegrationForAgent("copilot-cli");

    assert.ok(result === true || (result && typeof result === "object"));
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["copilot"]);
  });

  it("repairIntegrationForAgent('copilot-cli') routes through syncCopilotHooks (no separate repair)", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("copilot-cli");

    assert.ok(result === true || (result && typeof result === "object"));
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["copilot"]);
  });

  it("repairIntegrationForAgent uses Codex repair and passes options through", () => {
    const { runtime, calls, repairOptions } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("codex", { forceCodexHooksFeature: true });

    assert.deepStrictEqual(result, { status: "ok", message: "done" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["codex-repair"]);
    assert.deepStrictEqual(repairOptions, [{ forceCodexHooksFeature: true }]);
  });

  it("repairIntegrationForAgent uses OpenClaw repair", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("openclaw");

    assert.deepStrictEqual(result, { status: "ok", message: "done" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["openclaw-repair"]);
  });

  it("stopIntegrationForAgent only stops the Claude watcher", () => {
    const { runtime, calls } = makeRuntime();

    assert.strictEqual(runtime.stopIntegrationForAgent("codex"), false);
    assert.strictEqual(runtime.stopIntegrationForAgent("claude-code"), "stopped");
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["watcher:stop"]);
  });

  // -- Error-path tests: when the ctx.*Impl mock throws, each sync returns { status: "error" } --

  it("syncClawdHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncClawdHooksImpl: () => {
          throw new Error("claude-broken");
        },
      },
    });

    const result = runtime.syncClawdHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "claude-broken");
  });

  it("syncGeminiHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncGeminiHooksImpl: () => {
          throw new Error("gemini-broken");
        },
      },
    });

    const result = runtime.syncGeminiHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "gemini-broken");
  });

  it("syncAntigravityHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncAntigravityHooksImpl: () => {
          throw new Error("antigravity-broken");
        },
      },
    });

    const result = runtime.syncAntigravityHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "antigravity-broken");
  });

  it("syncCodeBuddyHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncCodeBuddyHooksImpl: () => {
          throw new Error("codebuddy-broken");
        },
      },
    });

    const result = runtime.syncCodeBuddyHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "codebuddy-broken");
  });

  it("syncCopilotHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncCopilotHooksImpl: () => {
          throw new Error("copilot-broken");
        },
      },
    });

    const result = runtime.syncCopilotHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "copilot-broken");
  });

  it("syncCodexHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncCodexHooksImpl: () => {
          throw new Error("codex-broken");
        },
      },
    });

    const result = runtime.syncCodexHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "codex-broken");
  });

  it("syncOpencodePlugin returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncOpencodePluginImpl: () => {
          throw new Error("opencode-broken");
        },
      },
    });

    const result = runtime.syncOpencodePlugin();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "opencode-broken");
  });

  it("syncPiExtension returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncPiExtensionImpl: () => {
          throw new Error("pi-broken");
        },
      },
    });

    const result = runtime.syncPiExtension();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "pi-broken");
  });

  it("syncOpenClawPlugin returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncOpenClawPluginImpl: () => {
          throw new Error("openclaw-broken");
        },
      },
    });

    const result = runtime.syncOpenClawPlugin();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "openclaw-broken");
  });

  it("repairOpenClawPlugin returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        repairOpenClawPluginImpl: () => {
          throw new Error("openclaw-repair-broken");
        },
      },
    });

    const result = runtime.repairOpenClawPlugin();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "openclaw-repair-broken");
  });

  it("syncHermesPlugin returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncHermesPluginImpl: () => {
          throw new Error("hermes-broken");
        },
      },
    });

    const result = runtime.syncHermesPlugin();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "hermes-broken");
  });

  it("repairCodexHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        repairCodexHooksImpl: () => {
          throw new Error("codex-repair-broken");
        },
      },
    });

    const result = runtime.repairCodexHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "codex-repair-broken");
  });

  // -- Error path with no err.message: fallback message is used --

  it("syncClawdHooks uses fallback message when error has no message property", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncClawdHooksImpl: () => {
          const err = new Error();
          err.message = undefined;
          throw err;
        },
      },
    });

    const result = runtime.syncClawdHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "Failed to sync Claude hooks");
  });

  it("syncGeminiHooks uses fallback message when error has no message property", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncGeminiHooksImpl: () => {
          const err = new Error();
          err.message = undefined;
          throw err;
        },
      },
    });

    const result = runtime.syncGeminiHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "Failed to sync Gemini hooks");
  });

  it("syncQoderHooks uses fallback message when error has no message property", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncQoderHooksImpl: () => {
          const err = new Error();
          err.message = undefined;
          throw err;
        },
      },
    });

    const result = runtime.syncQoderHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "Failed to sync Qoder hooks");
  });

  // -- Direct tests for syncQoderHooks, syncKiroHooks, syncKimiHooks, syncQwenHooks, syncCursorHooks --

  it("syncQoderHooks delegates to ctx.syncQoderHooksImpl", () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncQoderHooksImpl: () => {
          calls.push({ name: "qoder" });
          return { status: "ok", source: "qoder" };
        },
      },
    });

    const result = runtime.syncQoderHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "qoder" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["qoder"]);
  });

  it("syncQoderHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncQoderHooksImpl: () => {
          throw new Error("qoder-broken");
        },
      },
    });

    const result = runtime.syncQoderHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "qoder-broken");
  });

  it("syncKiroHooks delegates to ctx.syncKiroHooksImpl", () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncKiroHooksImpl: () => {
          calls.push({ name: "kiro" });
          return { status: "ok", source: "kiro" };
        },
      },
    });

    const result = runtime.syncKiroHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "kiro" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["kiro"]);
  });

  it("syncKiroHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncKiroHooksImpl: () => {
          throw new Error("kiro-broken");
        },
      },
    });

    const result = runtime.syncKiroHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "kiro-broken");
  });

  it("syncKimiHooks delegates to ctx.syncKimiHooksImpl", () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncKimiHooksImpl: () => {
          calls.push({ name: "kimi" });
          return { status: "ok", source: "kimi" };
        },
      },
    });

    const result = runtime.syncKimiHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "kimi" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["kimi"]);
  });

  it("syncKimiHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncKimiHooksImpl: () => {
          throw new Error("kimi-broken");
        },
      },
    });

    const result = runtime.syncKimiHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "kimi-broken");
  });

  it("syncQwenHooks delegates to ctx.syncQwenHooksImpl", () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncQwenHooksImpl: () => {
          calls.push({ name: "qwen" });
          return { status: "ok", source: "qwen" };
        },
      },
    });

    const result = runtime.syncQwenHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "qwen" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["qwen"]);
  });

  it("syncQwenHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncQwenHooksImpl: () => {
          throw new Error("qwen-broken");
        },
      },
    });

    const result = runtime.syncQwenHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "qwen-broken");
  });

  it("syncCursorHooks delegates to ctx.syncCursorHooksImpl", () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncCursorHooksImpl: () => {
          calls.push({ name: "cursor" });
          return { status: "ok", source: "cursor" };
        },
      },
    });

    const result = runtime.syncCursorHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "cursor" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["cursor"]);
  });

  it("syncCursorHooks returns error status when the impl throws", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncCursorHooksImpl: () => {
          throw new Error("cursor-broken");
        },
      },
    });

    const result = runtime.syncCursorHooks();

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "cursor-broken");
  });

  // -- repairCodexHooks warning path --

  it("repairCodexHooks returns error status when the impl returns warnings", () => {
    const { runtime } = makeRuntime({
      ctx: {
        repairCodexHooksImpl: () => ({
          status: "error",
          message: "Codex hooks were repaired, but missing config file; unsupported version",
        }),
      },
    });

    const result = runtime.repairCodexHooks();

    assert.strictEqual(result.status, "error");
    assert.ok(result.message.includes("missing config file"));
  });

  it("repairCodexHooks returns error status when registerCodexHooks returns warnings (fallback path)", () => {
    const codexInstall = require("../hooks/codex-install");
    const originalRegister = codexInstall.registerCodexHooks;
    codexInstall.registerCodexHooks = () => ({
      added: 1,
      updated: 0,
      configChanged: false,
      warnings: ["missing config file", "unsupported version"],
    });

    try {
      const { runtime } = makeRuntime({ ctx: { repairCodexHooksImpl: undefined } });
      const result = runtime.repairCodexHooks();

      assert.strictEqual(result.status, "error");
      assert.ok(result.message.includes("missing config file"));
      assert.ok(result.message.includes("unsupported version"));
    } finally {
      codexInstall.registerCodexHooks = originalRegister;
    }
  });

  it("repairCodexHooks returns ok status when registerCodexHooks returns no warnings (fallback path)", () => {
    const codexInstall = require("../hooks/codex-install");
    const originalRegister = codexInstall.registerCodexHooks;
    codexInstall.registerCodexHooks = () => ({
      added: 1,
      updated: 0,
      configChanged: true,
      warnings: [],
    });

    try {
      const { runtime } = makeRuntime({ ctx: { repairCodexHooksImpl: undefined } });
      const result = runtime.repairCodexHooks();

      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.configChanged, true);
      assert.ok(result.message.includes("updated"));
    } finally {
      codexInstall.registerCodexHooks = originalRegister;
    }
  });

  // -- syncIntegrationForAgent / repairIntegrationForAgent edge cases --

  it("syncIntegrationForAgent returns false for an unknown agent", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncIntegrationForAgent("nonexistent-agent");

    assert.strictEqual(result, false);
    assert.deepStrictEqual(calls, []);
  });

  it("repairIntegrationForAgent returns false for an unknown agent", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("nonexistent-agent");

    assert.strictEqual(result, false);
    assert.deepStrictEqual(calls, []);
  });

  it("repairIntegrationForAgent('claude-code') delegates to syncIntegrationForAgent", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("claude-code");

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["claude", "watcher:start"]);
  });

  // -- syncHermesPlugin skipped path --

  it("syncHermesPlugin returns skipped when hermes is not installed", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncHermesPluginImpl: undefined,
        isHermesInstalledImpl: () => false,
      },
    });

    const result = runtime.syncHermesPlugin();

    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "hermes-not-installed");
  });

  it("syncHermesPlugin returns error when registerHermesPlugin returns an error result", () => {
    const hermesInstall = require("../hooks/hermes-install");
    const originalIsInstalled = hermesInstall.isHermesInstalled;
    const originalRegister = hermesInstall.registerHermesPlugin;
    hermesInstall.isHermesInstalled = () => true;
    hermesInstall.registerHermesPlugin = () => ({
      status: "error",
      message: "hermes register failed",
    });

    try {
      const { runtime } = makeRuntime({ ctx: { syncHermesPluginImpl: undefined, isHermesInstalledImpl: undefined } });
      const result = runtime.syncHermesPlugin();

      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.message, "hermes register failed");
    } finally {
      hermesInstall.isHermesInstalled = originalIsInstalled;
      hermesInstall.registerHermesPlugin = originalRegister;
    }
  });

  it("does not log Pi extension sync when the managed files are already current", () => {
    const piInstall = require("../hooks/pi-install");
    const originalRegister = piInstall.registerPiExtension;
    const originalLog = console.log;
    const logs = [];
    piInstall.registerPiExtension = () => ({
      installed: true,
      skipped: false,
      updated: false,
      extensionDir: "C:/Users/Tester/.pi/agent/extensions/clawd-on-desk",
    });
    console.log = (message) => logs.push(message);

    try {
      const { runtime } = makeRuntime({ ctx: { syncPiExtensionImpl: undefined } });
      const result = runtime.syncPiExtension();

      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.installed, true);
      assert.deepStrictEqual(logs, []);
    } finally {
      piInstall.registerPiExtension = originalRegister;
      console.log = originalLog;
    }
  });
});

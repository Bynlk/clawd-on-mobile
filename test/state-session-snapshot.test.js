"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  deriveSessionBadge,
  deriveMobileChipFields,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
} = require("../src/state-session-snapshot");

const STATE_PRIORITY = {
  error: 8,
  notification: 7,
  sweeping: 6,
  attention: 5,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  idle: 1,
  sleeping: 0,
};

function session(state, overrides = {}) {
  return {
    state,
    updatedAt: 1000,
    cwd: "",
    agentId: "claude-code",
    recentEvents: [],
    ...overrides,
  };
}

describe("state-session-snapshot badges", () => {
  it("derives running, done, interrupted, and idle badges", () => {
    assert.strictEqual(deriveSessionBadge(session("working")), "running");
    assert.strictEqual(deriveSessionBadge(session("sleeping")), "idle");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "event_msg:task_complete", state: "attention", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      requiresCompletionAck: true,
      recentEvents: [{ event: "stale-cleanup", state: "sleeping", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "PostToolUseFailure", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "StopFailure", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "ApiError", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(null), "idle");
  });
});

describe("state-session-snapshot builder", () => {
  it("builds ordered dashboard/menu groups and HUD summary with injected deps", () => {
    const sessions = new Map([
      ["old-working", session("working", {
        updatedAt: 1000,
        cwd: "/tmp/old-project",
        sessionTitle: "Fix login",
        platform: "webui",
        model: "gpt-5.4",
        provider: "openai",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
      ["latest-remote", session("idle", {
        updatedAt: 3000,
        cwd: "/tmp/latest-project",
        agentId: "codex",
        host: "remote-box",
        headless: true,
        recentEvents: [{ event: "MysteryEvent", state: "idle", at: 2900 }],
      })],
      ["error-local", session("error", {
        updatedAt: 2000,
        cwd: "/tmp/error-project",
        agentId: "missing-agent",
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: (agentId) => agentId === "missing-agent" ? null : `icon:${agentId}`,
    });

    assert.deepStrictEqual(snapshot.orderedIds, ["latest-remote", "error-local", "old-working"]);
    assert.deepStrictEqual(snapshot.menuOrderedIds, ["error-local", "old-working", "latest-remote"]);
    assert.deepStrictEqual(snapshot.groups, [
      { host: "", ids: ["error-local", "old-working"] },
      { host: "remote-box", ids: ["latest-remote"] },
    ]);
    assert.strictEqual(snapshot.hudTotalNonIdle, 2);
    assert.strictEqual(snapshot.hudLastSessionId, "error-local");
    assert.strictEqual(snapshot.hudLastTitle, "error-project");
    assert.strictEqual(snapshot.lastSessionId, "latest-remote");
    assert.strictEqual(snapshot.lastTitle, "latest-project");

    const oldWorking = snapshot.sessions.find((entry) => entry.id === "old-working");
    assert.strictEqual(oldWorking.badge, "running");
    assert.strictEqual(oldWorking.iconUrl, "icon:claude-code");
    assert.strictEqual(oldWorking.platform, "webui");
    assert.strictEqual(oldWorking.model, "gpt-5.4");
    assert.strictEqual(oldWorking.provider, "openai");
    assert.strictEqual(oldWorking.sessionTitle, "Fix login");
    assert.strictEqual(oldWorking.displayTitle, "Fix login");
    assert.deepStrictEqual(oldWorking.lastEvent, {
      labelKey: "eventLabelPreToolUse",
      rawEvent: "PreToolUse",
      at: 900,
    });

    const taskCompleteSnapshot = buildSessionSnapshot(new Map([
      ["remote-complete", session("idle", {
        agentId: "codex",
        host: "remote-box",
        recentEvents: [{ event: "event_msg:task_complete", state: "attention", at: 3300 }],
      })],
      ["local-complete", session("idle", {
        agentId: "codex",
        host: null,
        recentEvents: [{ event: "event_msg:task_complete", state: "attention", at: 3400 }],
      })],
      ["remote-stale-complete", session("idle", {
        agentId: "codex",
        host: "remote-box",
        requiresCompletionAck: true,
        recentEvents: [
          { event: "event_msg:task_complete", state: "attention", at: 3500 },
          { event: "stale-cleanup", state: "sleeping", at: 3600 },
        ],
      })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const taskComplete = taskCompleteSnapshot.sessions.find((entry) => entry.id === "remote-complete");
    assert.strictEqual(taskComplete.badge, "done");
    assert.deepStrictEqual(taskComplete.lastEvent, {
      labelKey: "eventLabelStop",
      rawEvent: "event_msg:task_complete",
      at: 3300,
    });
    const localComplete = taskCompleteSnapshot.sessions.find((entry) => entry.id === "local-complete");
    assert.strictEqual(localComplete.badge, "done");
    assert.strictEqual(localComplete.requiresCompletionAck, false);
    const staleComplete = taskCompleteSnapshot.sessions.find((entry) => entry.id === "remote-stale-complete");
    assert.strictEqual(staleComplete.badge, "done");
    assert.deepStrictEqual(staleComplete.lastEvent, {
      labelKey: "eventLabelStop",
      rawEvent: "event_msg:task_complete",
      at: 3500,
    });

    const latestRemote = snapshot.sessions.find((entry) => entry.id === "latest-remote");
    assert.strictEqual(latestRemote.headless, true);
    assert.strictEqual(latestRemote.displayTitle, "latest-project");
    assert.deepStrictEqual(latestRemote.lastEvent, {
      labelKey: null,
      rawEvent: "MysteryEvent",
      at: 2900,
    });
  });

  it("exposes focus target metadata for terminal and Codex Desktop sessions", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["terminal", session("working", { sourcePid: 123 })],
      ["webui", session("working", { sourcePid: 456, platform: "webui" })],
      ["codex:019e115a-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "Codex Desktop",
        codexSource: "vscode",
      })],
    ]));

    const byId = new Map(snapshot.sessions.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get("terminal").canFocus, true);
    assert.deepStrictEqual(byId.get("terminal").focusTarget, { type: "terminal", url: null });
    assert.strictEqual(byId.get("webui").canFocus, false);
    assert.strictEqual(byId.get("webui").focusTarget, null);
    assert.strictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").canFocus, true);
    assert.deepStrictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").focusTarget, {
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.strictEqual(byId.get("codex:019e115a-4df2-7ed0-b90e-8e6345aca777").codexSource, "vscode");
  });

  it("does not expose focus targets for sessions hidden from the focusable UI surface", () => {
    const hiddenEndedSession = session("idle", {
      sourcePid: 123,
      pidReachable: true,
      agentPid: null,
      recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
    });
    const snapshot = buildSessionSnapshot(new Map([
      ["headless", session("working", { sourcePid: 123, headless: true })],
      ["sleeping", session("sleeping", { sourcePid: 123 })],
      ["remote", session("working", { sourcePid: 123, host: "remote-box" })],
      ["hidden", hiddenEndedSession],
      ["codex:019e115a-4df2-7ed0-b90e-8e6345aca777", session("working", {
        agentId: "codex",
        codexOriginator: "Codex Desktop",
        headless: true,
      })],
    ]), {
      sessionHudCleanupDetached: true,
      isProcessAlive: () => false,
    });

    for (const entry of snapshot.sessions) {
      assert.strictEqual(entry.canFocus, false, entry.id);
      assert.strictEqual(entry.focusTarget, null, entry.id);
    }
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "hidden").hiddenFromHud, true);
  });

  it("applies aliases, Codex thread names, and Kiro cwd-scoped alias keys", () => {
    const sessions = new Map([
      ["claude-local", session("working", {
        updatedAt: 3000,
        cwd: "/repo/a",
        agentId: "claude-code",
        sessionTitle: "Raw title",
      })],
      ["codex:abc", session("thinking", {
        updatedAt: 2000,
        cwd: "/repo/b",
        agentId: "codex",
        sessionTitle: "Auto Summary",
      })],
      ["default", session("working", {
        updatedAt: 1000,
        cwd: "/repo/c",
        agentId: "kiro-cli",
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      sessionAliases: {
        "local|claude-code|claude-local": { title: "Claude review", updatedAt: 100 },
        "local|kiro-cli|default": { title: "Legacy Kiro", updatedAt: 100 },
        "local|kiro-cli|default|cwd:%2Frepo%2Fc": { title: "Kiro repo C", updatedAt: 200 },
      },
      readCodexThreadName: (id) => id === "codex:abc" ? "Thread name" : null,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "claude-local").displayTitle, "Claude review");
    const codex = snapshot.sessions.find((entry) => entry.id === "codex:abc");
    assert.strictEqual(codex.sessionTitle, "Thread name");
    assert.strictEqual(codex.displayTitle, "Thread name");
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "default").displayTitle, "Kiro repo C");

    assert.deepStrictEqual(
      [...getActiveSessionAliasKeys(sessions)].sort(),
      [
        "local|claude-code|claude-local",
        "local|codex|codex:abc",
        "local|kiro-cli|default|cwd:%2Frepo%2Fc",
      ].sort()
    );
  });

  it("marks detached ended idle sessions hidden from HUD only when cleanup is enabled and pid is dead", () => {
    const sessions = new Map([
      ["done-local", session("idle", {
        updatedAt: 3000,
        sourcePid: 9999,
        pidReachable: true,
        recentEvents: [{ event: "Stop", state: "attention", at: 2900 }],
      })],
      ["idle-local", session("idle", {
        updatedAt: 2000,
        sourcePid: 9998,
        pidReachable: true,
        recentEvents: [{ event: "AfterAgent", state: "idle", at: 1900 }],
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      sessionHudCleanupDetached: true,
      isProcessAlive: () => false,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "done-local").hiddenFromHud, true);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "idle-local").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "idle-local");
  });

  it("snapshot signatures include visible fields but ignore icon URL churn", () => {
    const base = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:a",
    });
    const sameExceptIcon = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:b",
    });
    const differentTitle = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Other title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:a",
    });

    assert.strictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(sameExceptIcon));
    assert.notStrictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(differentTitle));
  });

  // ── PR2: requiresCompletionAck exposure ──
  it("entry includes requiresCompletionAck=false for normal sessions", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["a", session("idle", { recentEvents: [{ event: "PreToolUse", state: "idle", at: 1 }] })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const entry = snapshot.sessions.find((s) => s.id === "a");
    assert.strictEqual(entry.requiresCompletionAck, false);
  });

  it("entry includes requiresCompletionAck=true when the session flag is set", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["a", session("idle", {
        requiresCompletionAck: true,
        recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
      })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const entry = snapshot.sessions.find((s) => s.id === "a");
    assert.strictEqual(entry.requiresCompletionAck, true);
  });

  it("ackedAt stays internal — does NOT appear in the snapshot entry", () => {
    const snapshot = buildSessionSnapshot(new Map([
      ["a", session("idle", { ackedAt: 12345, requiresCompletionAck: false })],
    ]), { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const entry = snapshot.sessions.find((s) => s.id === "a");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "ackedAt"), false);
  });

  it("snapshot signature changes when requiresCompletionAck flips", () => {
    const baseSessions = new Map([
      ["a", session("idle", { recentEvents: [{ event: "Stop", state: "idle", at: 1 }] })],
    ]);
    const flaggedSessions = new Map([
      ["a", session("idle", {
        requiresCompletionAck: true,
        recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
      })],
    ]);
    const base = buildSessionSnapshot(baseSessions, { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    const flagged = buildSessionSnapshot(flaggedSessions, { statePriority: STATE_PRIORITY, getAgentIconUrl: () => null });
    assert.notStrictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(flagged));
  });
});

describe("deriveMobileChipFields", () => {
  // ── Non-oneshot active states ──────────────────────────────────────

  it("returns working chip for working state", () => {
    const result = deriveMobileChipFields("working", []);
    assert.deepStrictEqual(result, { text: "工作中", color: "#22c55e" });
  });

  it("returns thinking chip for thinking state", () => {
    const result = deriveMobileChipFields("thinking", []);
    assert.deepStrictEqual(result, { text: "思考中", color: "#6366f1" });
  });

  it("returns juggling chip for juggling state", () => {
    const result = deriveMobileChipFields("juggling", []);
    assert.deepStrictEqual(result, { text: "多任务", color: "#d97706" });
  });

  it("returns error chip for error state", () => {
    const result = deriveMobileChipFields("error", []);
    assert.deepStrictEqual(result, { text: "错误", color: "#ef4444" });
  });

  it("returns notification chip for notification state", () => {
    const result = deriveMobileChipFields("notification", []);
    assert.deepStrictEqual(result, { text: "通知", color: "#d97706" });
  });

  it("returns attention chip for attention state", () => {
    const result = deriveMobileChipFields("attention", []);
    assert.deepStrictEqual(result, { text: "需要关注", color: "#b45309" });
  });

  it("returns sweeping chip for sweeping state", () => {
    const result = deriveMobileChipFields("sweeping", []);
    assert.deepStrictEqual(result, { text: "清理中", color: "#a1a1aa" });
  });

  it("returns carrying chip for carrying state", () => {
    const result = deriveMobileChipFields("carrying", []);
    assert.deepStrictEqual(result, { text: "搬运中", color: "#a1a1aa" });
  });

  // ── Idle state (non-oneshot) ──────────────────────────────────────

  it("returns null for idle state with no events", () => {
    assert.strictEqual(deriveMobileChipFields("idle", []), null);
  });

  it("returns null for idle state with non-chip events", () => {
    assert.strictEqual(deriveMobileChipFields("idle", [{ event: "PreToolUse" }]), null);
  });

  // ── Oneshot states ────────────────────────────────────────────────

  it("returns event chip for oneshot state with Stop event", () => {
    const result = deriveMobileChipFields("attention", [{ event: "Stop" }]);
    assert.deepStrictEqual(result, { text: "已完成", color: "#71717a" });
  });

  it("returns event chip for oneshot state with event_msg:task_complete", () => {
    const result = deriveMobileChipFields("attention", [{ event: "event_msg:task_complete" }]);
    assert.deepStrictEqual(result, { text: "已完成", color: "#71717a" });
  });

  it("returns state chip fallback for oneshot state with no matching event", () => {
    const result = deriveMobileChipFields("attention", [{ event: "PreToolUse" }]);
    assert.deepStrictEqual(result, { text: "需要关注", color: "#b45309" });
  });

  it("returns state chip fallback for oneshot state with empty events", () => {
    const result = deriveMobileChipFields("error", []);
    // error is oneshot AND in ACTIVE_CHIP_MAP, so returns ACTIVE_CHIP_MAP["error"]
    assert.deepStrictEqual(result, { text: "错误", color: "#ef4444" });
  });

  it("returns error chip for oneshot state with error event", () => {
    const result = deriveMobileChipFields("idle", [{ event: "StopFailure" }]);
    assert.deepStrictEqual(result, { text: "出错", color: "#ef4444" });
  });

  it("returns error chip for oneshot state with ApiError event", () => {
    const result = deriveMobileChipFields("idle", [{ event: "ApiError" }]);
    assert.deepStrictEqual(result, { text: "出错", color: "#ef4444" });
  });

  it("returns error chip for oneshot state with PostToolUseFailure event", () => {
    const result = deriveMobileChipFields("idle", [{ event: "PostToolUseFailure" }]);
    assert.deepStrictEqual(result, { text: "出错", color: "#ef4444" });
  });

  // ── Event-based chip for active non-oneshot states ────────────────

  it("returns event chip for active state with PermissionRequest event", () => {
    const result = deriveMobileChipFields("working", [{ event: "PermissionRequest" }]);
    assert.deepStrictEqual(result, { text: "等待中", color: "#d97706" });
  });

  it("returns event chip for active state with Elicitation event", () => {
    const result = deriveMobileChipFields("working", [{ event: "Elicitation" }]);
    assert.deepStrictEqual(result, { text: "等待中", color: "#d97706" });
  });

  it("returns event chip for active state with WorktreeCreate event", () => {
    const result = deriveMobileChipFields("working", [{ event: "WorktreeCreate" }]);
    assert.deepStrictEqual(result, { text: "工作树", color: "#60a5fa" });
  });

  it("returns state chip when event is not in EVENT_CHIP_MAP", () => {
    const result = deriveMobileChipFields("working", [{ event: "PreToolUse" }]);
    assert.deepStrictEqual(result, { text: "工作中", color: "#22c55e" });
  });

  // ── Multiple events: uses last event ──────────────────────────────

  it("uses last event for chip derivation", () => {
    const result = deriveMobileChipFields("working", [
      { event: "PreToolUse" },
      { event: "PermissionRequest" },
    ]);
    assert.deepStrictEqual(result, { text: "等待中", color: "#d97706" });
  });

  // ── Unknown state ─────────────────────────────────────────────────

  it("returns null for unknown non-oneshot state", () => {
    assert.strictEqual(deriveMobileChipFields("unknown_state", []), null);
  });
});

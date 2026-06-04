"use strict";

const DEFAULT_HOOK_AGENT_ID = "claude-code";

const HOOK_SOURCE_AGENT_IDS = new Map([
  ["antigravity-hook", "antigravity-cli"],
  ["codex-official", "codex"],
  ["copilot-hook", "copilot-cli"],
  ["opencode-plugin", "opencode"],
  ["openclaw-plugin", "openclaw"],
  ["pi-extension", "pi"],
]);

function normalizeHookText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveHookAgentId(data) {
  const explicit = normalizeHookText(data && data.agent_id);
  if (explicit) {
    return { agentId: explicit, source: "explicit", defaulted: false };
  }

  const hookSource = normalizeHookText(data && data.hook_source);
  const sourceAgentId = HOOK_SOURCE_AGENT_IDS.get(hookSource);
  if (sourceAgentId) {
    return { agentId: sourceAgentId, source: "hook-source", defaulted: false };
  }

  return { agentId: DEFAULT_HOOK_AGENT_ID, source: "default", defaulted: true };
}

module.exports = {
  DEFAULT_HOOK_AGENT_ID,
  HOOK_SOURCE_AGENT_IDS,
  resolveHookAgentId,
};

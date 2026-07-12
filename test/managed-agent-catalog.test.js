"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ManagedAgentCatalog } = require("../src/managed-agent-catalog");

function catalog(options = {}) {
  return new ManagedAgentCatalog({
    agents: options.agents || [
      { id: "codex", name: "Codex", processNames: { linux: ["codex"] } },
      { id: "claude-code", name: "Claude", processNames: { linux: ["claude"] } },
    ],
    platform: "linux",
    isAgentEnabled: options.isAgentEnabled || ((id) => id === "codex"),
    commandExists: options.commandExists || ((command) => command === "codex"),
    directoryExists: options.directoryExists || ((dir) => ["/home/me", "/repo"].includes(dir)),
    homeDir: "/home/me",
    processCwd: "/repo",
    getSessionDirectories: options.getSessionDirectories || (() => ["/repo", "/missing"]),
  });
}

describe("ManagedAgentCatalog", () => {
  it("lists only enabled agents whose command is available", () => {
    assert.deepEqual(catalog().listAgents(), [
      { id: "codex", name: "Codex", command: "codex", args: [] },
    ]);
  });

  it("returns only normalized existing allowed directories", () => {
    assert.deepEqual(catalog().listDirectories(), ["/home/me", "/repo"]);
  });

  it("validates agent and directory on create", () => {
    assert.deepEqual(catalog().resolveCreateRequest({ agentId: "codex", cwd: "/repo" }), {
      agentId: "codex",
      cwd: "/repo",
      command: "codex",
      args: [],
    });
    assert.throws(
      () => catalog().resolveCreateRequest({ agentId: "missing", cwd: "/repo" }),
      /agent_not_available/,
    );
    assert.throws(
      () => catalog().resolveCreateRequest({ agentId: "codex", cwd: "/private" }),
      /directory_not_allowed/,
    );
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ManagedSessionRuntime } = require("../src/managed-session-runtime");

function fakePtyProvider() {
  const processes = [];
  return {
    processes,
    spawn(command, args, options) {
      let dataHandler = () => {};
      let exitHandler = () => {};
      const process = {
        command,
        args,
        options,
        writes: [],
        resizes: [],
        killed: false,
        write(value) { this.writes.push(value); },
        resize(cols, rows) { this.resizes.push([cols, rows]); },
        kill() { this.killed = true; },
        onData(handler) { dataHandler = handler; return { dispose() {} }; },
        onExit(handler) { exitHandler = handler; return { dispose() {} }; },
        emitData(value) { dataHandler(value); },
        emitExit(value) { exitHandler(value); },
      };
      processes.push(process);
      return process;
    },
  };
}

function createRuntime() {
  const pty = fakePtyProvider();
  const catalog = {
    resolveCreateRequest: ({ agentId, cwd }) => ({ agentId, cwd, command: "codex", args: [] }),
    listAgents: () => [{ id: "codex", name: "Codex", command: "codex", args: [] }],
    listDirectories: () => ["/repo"],
  };
  let id = 0;
  const runtime = new ManagedSessionRuntime({
    ptyProvider: pty,
    catalog,
    createId: () => `s${++id}`,
    now: () => 100,
  });
  return { runtime, pty };
}

describe("ManagedSessionRuntime", () => {
  it("spawns a managed PTY and records output", () => {
    const { runtime, pty } = createRuntime();
    const session = runtime.create({ agentId: "codex", cwd: "/repo", cols: 100, rows: 30 });
    assert.equal(session.id, "s1");
    assert.equal(pty.processes[0].command, "codex");
    assert.equal(pty.processes[0].options.cwd, "/repo");

    pty.processes[0].emitData("hello\n");
    assert.equal(runtime.historyAfter("s1", 0).records[0].text, "hello\n");
  });

  it("writes messages, raw controls, resizes, and interrupts", () => {
    const { runtime, pty } = createRuntime();
    runtime.create({ agentId: "codex", cwd: "/repo" });
    runtime.write("s1", "hello", { submit: true });
    runtime.write("s1", "\u001b[A", { submit: false, raw: true });
    runtime.resize("s1", 120, 40);
    runtime.interrupt("s1");

    assert.deepEqual(pty.processes[0].writes, ["hello\r", "\u001b[A", "\u0003"]);
    assert.deepEqual(pty.processes[0].resizes, [[120, 40]]);
    assert.equal(runtime.historyAfter("s1", 0).records[0].kind, "user_input");
  });

  it("records exit and disposes running processes", () => {
    const { runtime, pty } = createRuntime();
    runtime.create({ agentId: "codex", cwd: "/repo" });
    pty.processes[0].emitExit({ exitCode: 7, signal: 0 });
    assert.equal(runtime.listSessions()[0].status, "exited");
    assert.equal(runtime.historyAfter("s1", 0).records.at(-1).kind, "exit");

    runtime.create({ agentId: "codex", cwd: "/repo" });
    runtime.dispose();
    assert.equal(pty.processes[1].killed, true);
    assert.deepEqual(runtime.listSessions(), []);
  });

  it("rejects commands for unknown or exited sessions", () => {
    const { runtime, pty } = createRuntime();
    assert.throws(() => runtime.write("missing", "x"), /session_not_found/);
    runtime.create({ agentId: "codex", cwd: "/repo" });
    pty.processes[0].emitExit({ exitCode: 0, signal: 0 });
    assert.throws(() => runtime.write("s1", "x"), /session_not_running/);
  });

  it("does not leave a stale managed session when PTY spawn fails", () => {
    const catalog = {
      resolveCreateRequest: ({ agentId, cwd }) => ({ agentId, cwd, command: "codex", args: [] }),
      listAgents: () => [],
      listDirectories: () => ["/repo"],
    };
    const runtime = new ManagedSessionRuntime({
      catalog,
      ptyProvider: { spawn() { throw new Error("spawn_failed"); } },
      createId: () => "failed-session",
      now: () => 100,
    });

    assert.throws(() => runtime.create({ agentId: "codex", cwd: "/repo" }), /spawn_failed/);
    assert.deepEqual(runtime.listSessions(), []);
  });

  it("correlates hook sessions by agent and cwd and appends structured tool events", () => {
    const { runtime } = createRuntime();
    runtime.create({ agentId: "codex", cwd: "/repo" });
    assert.equal(runtime.linkHookSession("agent-session", { agentId: "codex", cwd: "/repo" }), "s1");
    runtime.appendHookEvent("agent-session", {
      kind: "tool_call",
      toolName: "Bash",
      text: "npm test",
    });
    runtime.appendHookEvent("agent-session", {
      kind: "tool_result",
      toolName: "Bash",
      text: "all green",
    });

    const structured = runtime.historyAfter("s1", 0).records.filter((record) => record.kind.startsWith("tool_"));
    assert.deepEqual(structured.map((record) => record.kind), ["tool_call", "tool_result"]);
    assert.equal(structured[1].toolName, "Bash");
  });

  it("does not guess hook correlation when multiple managed sessions match", () => {
    const { runtime } = createRuntime();
    runtime.create({ agentId: "codex", cwd: "/repo" });
    runtime.create({ agentId: "codex", cwd: "/repo" });

    assert.equal(runtime.linkHookSession("ambiguous", { agentId: "codex", cwd: "/repo" }), null);
    assert.equal(runtime.appendHookEvent("ambiguous", {
      agentId: "codex",
      cwd: "/repo",
      kind: "tool_call",
      text: "must not leak",
    }), null);
  });

  it("clears hook links when a managed session exits", () => {
    const { runtime, pty } = createRuntime();
    runtime.create({ agentId: "codex", cwd: "/repo" });
    assert.equal(runtime.linkHookSession("agent-session", { agentId: "codex", cwd: "/repo" }), "s1");

    pty.processes[0].emitExit({ exitCode: 0, signal: 0 });

    assert.equal(runtime.appendHookEvent("agent-session", { kind: "tool_result", text: "late" }), null);
  });

  it("splits oversized PTY output into relay-safe sequenced records without losing text", () => {
    const { runtime, pty } = createRuntime();
    runtime.create({ agentId: "codex", cwd: "/repo" });
    const output = "界".repeat(40_000);

    pty.processes[0].emitData(output);

    const records = runtime.historyAfter("s1", 0, 100).records;
    assert.ok(records.length > 1);
    assert.equal(records.map((record) => record.text).join(""), output);
    assert.equal(records.map((record) => record.raw).join(""), output);
    assert.ok(records.every((record) => Buffer.byteLength(JSON.stringify(record), "utf8") < 48 * 1024));
  });
});

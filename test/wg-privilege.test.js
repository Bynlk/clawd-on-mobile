"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  createPrivilegeEscalator,
  makeLinuxEscalator,
  makeUnsupportedEscalator,
  isPkexecDenial,
} = require("../src/wg-privilege");

function makeFakeSpawn(script) {
  const calls = [];
  function fakeSpawn(cmd, args) {
    const rule = script(cmd, args) || { code: 0, stderr: "", stdout: "" };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (d) => { child._stdin = d || ""; } };
    calls.push({ cmd, args, get stdin() { return child._stdin; } });
    process.nextTick(() => {
      if (rule.stdout) child.stdout.emit("data", Buffer.from(rule.stdout));
      if (rule.stderr) child.stderr.emit("data", Buffer.from(rule.stderr));
      child.emit("exit", rule.code);
    });
    return child;
  }
  fakeSpawn.calls = calls;
  return fakeSpawn;
}

test("isPkexecDenial flags 126/127 only", () => {
  assert.equal(isPkexecDenial(126), true);
  assert.equal(isPkexecDenial(127), true);
  assert.equal(isPkexecDenial(0), false);
  assert.equal(isPkexecDenial(1), false);
});

test("linux escalator prefixes argv with pkexec and forwards stdin (SEC-3)", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const esc = makeLinuxEscalator({ spawn });
  const r = await esc({ argv: ["/bin/sh", "-c", "echo hi", "clawd", "arg"], stdin: "CONFDATA" });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(spawn.calls[0].cmd, "pkexec");
  assert.deepEqual(spawn.calls[0].args, ["/bin/sh", "-c", "echo hi", "clawd", "arg"]);
  assert.equal(spawn.calls[0].stdin, "CONFDATA");
});

test("linux escalator marks 126 as denied", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 126, stderr: "dismissed" }));
  const esc = makeLinuxEscalator({ spawn });
  const r = await esc({ argv: ["/bin/sh", "-c", "true"] });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
});

test("linux escalator marks pkexec-missing (ENOENT) as denied", async () => {
  const spawn = makeFakeSpawn(() => ({ code: -1, stderr: "spawn pkexec ENOENT" }));
  const esc = makeLinuxEscalator({ spawn });
  const r = await esc({ argv: ["/bin/sh", "-c", "true"] });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.match(r.stderr, /not available/);
});

test("linux escalator rejects empty argv", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const esc = makeLinuxEscalator({ spawn });
  const r = await esc({ argv: [] });
  assert.equal(r.ok, false);
});

test("unsupported escalator always reports denied", async () => {
  const esc = makeUnsupportedEscalator("darwin");
  const r = await esc({ argv: ["/bin/sh"] });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.match(r.stderr, /darwin/);
});

test("createPrivilegeEscalator picks linux vs unsupported by platform", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const linux = createPrivilegeEscalator({ platform: "linux", spawn });
  const rl = await linux({ argv: ["/bin/sh", "-c", "true"] });
  assert.equal(rl.ok, true);

  const mac = createPrivilegeEscalator({ platform: "darwin" });
  const rm = await mac({ argv: ["/bin/sh"] });
  assert.equal(rm.ok, false);
  assert.equal(rm.denied, true);
});

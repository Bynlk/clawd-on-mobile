"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn: nodeSpawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  WgRelaySidecar,
  parseStatusLine,
  sidecarPathFor,
} = require("../src/wg-relay-sidecar");

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.writableEnded = false;
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk, callback) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    if (typeof callback === "function") queueMicrotask(callback);
  }

  destroy() {
    this.writableEnded = true;
  }
}

class FakeOutput extends EventEmitter {
  push(chunk) {
    this.emit("data", Buffer.from(chunk));
  }
}

class FakeChild extends EventEmitter {
  constructor(pid = 321) {
    super();
    this.pid = pid;
    this.stdin = new FakeInput();
    this.stdout = new FakeOutput();
    this.stderr = new FakeOutput();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }
}

function fixture(overrides = {}) {
  const children = [];
  const spawnCalls = [];
  const logs = [];
  const spawn = (file, args, options) => {
    const child = new FakeChild(300 + children.length);
    children.push(child);
    spawnCalls.push({ file, args, options });
    return child;
  };
  const sidecar = new WgRelaySidecar({
    spawn,
    platform: "linux",
    arch: "x64",
    appRoot: "/opt/clawd-src",
    resourcesPath: "/opt/clawd-resources",
    isPackaged: false,
    startupTimeoutMs: 40,
    stopTimeoutMs: 20,
    forceKillTimeoutMs: 20,
    log: (...parts) => logs.push(parts.join(" ")),
    ...overrides,
  });
  return { children, logs, sidecar, spawnCalls };
}

function emitReady(child, listen = "127.0.0.1:43127") {
  child.stdout.push(`${JSON.stringify({ type: "ready", listen })}\n`);
}

const config = Object.freeze({
  PrivateKey: "PRIVATE-SECRET",
  Address: "10.8.0.2/32",
  ServerPublicKey: "PUBLIC-SECRET",
  Endpoint: "relay.example.com:51820",
  AllowedIP: "10.8.0.0/24",
  ForwardAddress: "10.8.0.1:7891",
  KeepaliveSeconds: 25,
});

test("sidecarPathFor resolves every supported platform and architecture", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      const executable = platform === "win32" ? "clawd-wg-tunnel.exe" : "clawd-wg-tunnel";
      assert.equal(sidecarPathFor({
        platform, arch, isPackaged: false, appRoot: "/app",
      }), path.join("/app", "sidecars", "wg-relay-tunnel", "bin", `${platform}-${arch}`, executable));
      assert.equal(sidecarPathFor({
        platform, arch, isPackaged: true, resourcesPath: "/resources",
      }), path.join("/resources", "sidecars", "wg-relay-tunnel", `${platform}-${arch}`, executable));
    }
  }
});

test("sidecarPathFor accepts only absolute controlled dev or packaged roots", () => {
  assert.throws(() => sidecarPathFor({ platform: "freebsd", arch: "x64", appRoot: "/app" }), /unsupported/i);
  assert.throws(() => sidecarPathFor({ platform: "linux", arch: "ia32", appRoot: "/app" }), /unsupported/i);
  assert.throws(() => sidecarPathFor({ platform: "linux", arch: "x64", appRoot: "relative" }), /absolute/i);
  assert.throws(() => sidecarPathFor({
    platform: "linux", arch: "x64", isPackaged: true, resourcesPath: "../escape",
  }), /absolute/i);
});

test("parseStatusLine accepts strict ready and redacted error records", () => {
  assert.deepEqual(parseStatusLine('{"type":"ready","listen":"127.0.0.1:43127"}'), {
    type: "ready", listen: "127.0.0.1:43127",
  });
  assert.deepEqual(parseStatusLine('{"type":"ready","listen":"[::1]:43127"}'), {
    type: "ready", listen: "[::1]:43127",
  });
  assert.deepEqual(parseStatusLine('{"type":"error","status":"failed","errorCode":"device_start_failed"}'), {
    type: "error", status: "failed", errorCode: "device_start_failed",
  });
});

test("parseStatusLine preserves every Go sidecar error code and genericizes unknown values", () => {
  const goCodes = [
    "invalid_config", "invalid_json", "trailing_data", "stdin_failed",
    "invalid_private_key", "invalid_server_public_key", "invalid_allowed_ip",
    "invalid_address", "invalid_endpoint", "invalid_forward_address", "invalid_keepalive",
    "device_create_failed", "device_config_failed", "device_start_failed",
    "endpoint_resolution_failed", "endpoint_resolution_canceled", "endpoint_resolution_timeout",
    "listen_failed", "listener_failed", "device_stopped", "listener_stopped",
  ];
  for (const errorCode of goCodes) {
    assert.equal(parseStatusLine(JSON.stringify({ type: "error", status: "failed", errorCode })).errorCode, errorCode);
  }
  for (const errorCode of ["bad code", "valid_but_unknown_code", "a".repeat(64), "secret_token_must_not_escape", "x".repeat(200)]) {
    const parsed = parseStatusLine(JSON.stringify({ type: "error", status: "failed", errorCode }));
    assert.equal(parsed.errorCode, "sidecar_failed");
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(errorCode));
  }
});

test("parseStatusLine rejects non-loopback, malformed, extra, duplicate, and oversized records", () => {
  for (const line of [
    '{"type":"ready","listen":"0.0.0.0:43127"}',
    '{"type":"ready","listen":"127.0.0.1:0"}',
    '{"type":"ready","listen":"127.0.0.1:43127","token":"secret"}',
    '{"type":"ready","type":"ready","listen":"127.0.0.1:43127"}',
    "not-json",
  ]) {
    assert.throws(() => parseStatusLine(line), (error) => error.code === "sidecar_protocol_error");
  }
  assert.throws(
    () => parseStatusLine(`{"type":"ready","listen":"127.0.0.1:43127","x":"${"a".repeat(5000)}"}`),
    (error) => error.code === "sidecar_output_limit",
  );
});

test("start writes one JSON document to stdin, closes it, and keeps secrets out of argv/env/logs", async () => {
  const fx = fixture();
  const started = fx.sidecar.start(config);
  assert.equal(fx.children.length, 1);
  emitReady(fx.children[0]);

  const ready = await started;

  assert.deepEqual(ready, { listen: "127.0.0.1:43127", generation: 1 });
  assert.deepEqual(fx.spawnCalls[0].args, []);
  assert.equal(fx.spawnCalls[0].options.shell, false);
  assert.equal(fx.children[0].stdin.writableEnded, true);
  assert.equal(Buffer.concat(fx.children[0].stdin.chunks).toString("utf8"), `${JSON.stringify(config)}\n`);
  const publicLaunch = JSON.stringify({
    args: fx.spawnCalls[0].args,
    env: fx.spawnCalls[0].options.env,
    logs: fx.logs,
  });
  assert.doesNotMatch(publicLaunch, /PRIVATE-SECRET|PUBLIC-SECRET|relay\.example\.com/);
});

test("stdin finish is transport-only and the ready child remains active until stop", async () => {
  const fx = fixture({
    killProcess(child, force) {
      child.kill(force ? "SIGKILL" : "SIGTERM");
      queueMicrotask(() => child.emit("exit", 0, null));
    },
  });
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;
  fx.children[0].stdin.emit("finish");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.sidecar.status, "ready");
  assert.deepEqual(fx.children[0].kills, []);
  await fx.sidecar.stop();
  assert.deepEqual(fx.children[0].kills, ["SIGTERM"]);
});

test("Node manager and the real Go protocol keep running after stdin EOF until stop", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "POSIX signal smoke runs in Task 11 CI" : false,
}, async (t) => {
  const projectRoot = path.join(__dirname, "..");
  const goRoot = path.join(projectRoot, "sidecars", "wg-relay-tunnel");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-relay-contract-"));
  const binary = path.join(tempDir, "wg-relay-contract.test");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  execFileSync("go", ["test", "-c", "-o", binary, "."], { cwd: goRoot, stdio: "pipe" });

  let child = null;
  let failure = null;
  const sidecar = new WgRelaySidecar({
    platform: process.platform,
    arch: process.arch,
    appRoot: projectRoot,
    isPackaged: false,
    startupTimeoutMs: 5_000,
    stopTimeoutMs: 2_000,
    forceKillTimeoutMs: 1_000,
    spawn(_file, _args, options) {
      child = nodeSpawn(binary, ["-test.run=^TestNodeManagerContractHelper$"], {
        ...options,
        cwd: goRoot,
        env: { WG_RELAY_NODE_CONTRACT_HELPER: "1" },
      });
      return child;
    },
  });
  sidecar.on("failure", (event) => { failure = event; });
  t.after(async () => { await sidecar.dispose(); });

  const privateKey = Buffer.alloc(32);
  privateKey[0] = 8;
  privateKey[31] = 64;
  await sidecar.start({
    PrivateKey: privateKey.toString("base64"),
    Address: "10.8.0.2/32",
    ServerPublicKey: Buffer.alloc(32, 2).toString("base64"),
    Endpoint: "relay.example.com:51820",
    AllowedIP: "10.8.0.0/24",
    ForwardAddress: "10.8.0.1:7891",
    KeepaliveSeconds: 25,
  });
  assert.equal(child.stdin.writableEnded, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(failure, null);
  assert.equal(sidecar.status, "ready");
  assert.equal(child.exitCode, null);

  await sidecar.stop();
  assert.equal(sidecar.status, "idle");
  assert.notEqual(child.exitCode, null);
});

test("start rejects malformed output and enforces stdout byte and line limits", async (t) => {
  await t.test("malformed", async () => {
    const fx = fixture();
    const started = fx.sidecar.start(config);
    fx.children[0].stdout.push("garbage\n");
    await assert.rejects(started, (error) => error.code === "sidecar_protocol_error");
  });
  await t.test("bytes", async () => {
    const fx = fixture({ maxStdoutBytes: 32 });
    const started = fx.sidecar.start(config);
    fx.children[0].stdout.push("x".repeat(33));
    await assert.rejects(started, (error) => error.code === "sidecar_output_limit");
  });
  await t.test("lines", async () => {
    const fx = fixture({ maxStatusLines: 1 });
    const failures = [];
    fx.sidecar.on("failure", (failure) => failures.push(failure));
    const started = fx.sidecar.start(config);
    emitReady(fx.children[0]);
    await started;
    emitReady(fx.children[0]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures[0] && failures[0].errorCode, "sidecar_output_limit");
  });
});

test("stdout rejects leading, trailing, and cross-chunk blank status lines", async (t) => {
  for (const [name, chunks] of [
    ["leading", ["\n", '{"type":"ready","listen":"127.0.0.1:43127"}\n']],
    ["trailing", ['{"type":"ready","listen":"127.0.0.1:43127"}\n\n']],
    ["cross-chunk", ['{"type":"ready","listen":"127.0.0.1:43127"}\n', "\n"]],
  ]) {
    await t.test(name, async () => {
      const fx = fixture();
      const failures = [];
      fx.sidecar.on("failure", (failure) => failures.push(failure));
      const started = fx.sidecar.start(config);
      for (const chunk of chunks) fx.children[0].stdout.push(chunk);
      if (name === "leading") {
        await assert.rejects(started, (error) => error.code === "sidecar_protocol_error");
      } else {
        await started;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(failures[0] && failures[0].errorCode, "sidecar_protocol_error");
      }
    });
  }
});

test("stdout residual whitespace or partial JSON fails closed on process exit", async (t) => {
  for (const residual of [" ", "{"]) {
    await t.test(JSON.stringify(residual), async () => {
      const fx = fixture();
      const started = fx.sidecar.start(config);
      fx.children[0].stdout.push(residual);
      fx.children[0].emit("exit", 1, null);
      await assert.rejects(started, (error) => error.code === "sidecar_protocol_error");
    });
  }
});

test("a duplicate ready record fails the active process", async () => {
  const fx = fixture();
  const failures = [];
  fx.sidecar.on("failure", (failure) => failures.push(failure));
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;
  emitReady(fx.children[0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures[0].errorCode, "duplicate_ready");
  assert.equal(failures[0].generation, 1);
  assert.ok(fx.children[0].kills.length > 0);
});

test("startup timeout, spawn error, pre-ready exit, and sidecar error state use stable codes", async (t) => {
  await t.test("timeout", async () => {
    const fx = fixture({ startupTimeoutMs: 5 });
    await assert.rejects(fx.sidecar.start(config), (error) => error.code === "sidecar_startup_timeout");
    assert.ok(fx.children[0].kills.length > 0);
  });
  await t.test("spawn error", async () => {
    const fx = fixture();
    const started = fx.sidecar.start(config);
    fx.children[0].emit("error", new Error("PRIVATE-SECRET must not escape"));
    await assert.rejects(started, (error) => error.code === "sidecar_spawn_failed" && !error.message.includes("PRIVATE"));
  });
  await t.test("exit", async () => {
    const fx = fixture();
    const started = fx.sidecar.start(config);
    fx.children[0].emit("exit", 9, null);
    await assert.rejects(started, (error) => error.code === "sidecar_unexpected_exit");
  });
  await t.test("error status", async () => {
    const fx = fixture();
    const started = fx.sidecar.start(config);
    fx.children[0].stdout.push('{"type":"error","status":"failed","errorCode":"device_start_failed"}\n');
    await assert.rejects(started, (error) => error.code === "device_start_failed");
  });
});

test("unexpected exit after ready emits a redacted failure", async () => {
  const fx = fixture();
  const failure = new Promise((resolve) => fx.sidecar.once("failure", resolve));
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;
  fx.children[0].emit("exit", 23, "PRIVATE-SECRET");
  assert.deepEqual(await failure, {
    errorCode: "sidecar_unexpected_exit", generation: 1,
  });
});

test("stderr is bounded and redacted even when a secret crosses chunks", async () => {
  const fx = fixture({ maxStderrBytes: 64 });
  const started = fx.sidecar.start(config);
  fx.children[0].stderr.push("diagnostic PRIVATE-");
  fx.children[0].stderr.push("SECRET endpoint\n");
  emitReady(fx.children[0]);
  await started;
  assert.doesNotMatch(fx.logs.join("\n"), /PRIVATE|SECRET|diagnostic|endpoint/);
});

test("stop is idempotent, sends SIGTERM, then performs a bounded force kill", async () => {
  const killCalls = [];
  const fx = fixture({
    stopTimeoutMs: 5,
    forceKillTimeoutMs: 5,
    killProcess(child, force, platform) {
      killCalls.push({ child, force, platform });
      child.kill(force ? "SIGKILL" : "SIGTERM");
    },
  });
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;

  const first = fx.sidecar.stop();
  const second = fx.sidecar.stop();
  assert.strictEqual(first, second);
  await first;

  assert.deepEqual(killCalls.map(({ force, platform }) => [force, platform]), [
    [false, "linux"], [true, "linux"],
  ]);
  assert.equal(fx.sidecar.status, "idle");
});

test("failure and synchronous upper-layer stop share one bounded termination", async () => {
  const fx = fixture({ stopTimeoutMs: 5, forceKillTimeoutMs: 5 });
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;

  let stopping;
  fx.sidecar.once("failure", () => { stopping = fx.sidecar.stop(); });
  fx.children[0].stdout.push("not-json\n");
  await stopping;

  assert.deepEqual(fx.children[0].kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(fx.sidecar.status, "idle");
});

test("Windows stop uses the injectable process-tree kill path", async () => {
  const calls = [];
  const fx = fixture({
    platform: "win32",
    stopTimeoutMs: 2,
    forceKillTimeoutMs: 2,
    killProcess(child, force, platform) {
      calls.push([child.pid, force, platform]);
    },
  });
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;
  await fx.sidecar.stop();
  assert.deepEqual(calls, [[300, false, "win32"], [300, true, "win32"]]);
});

test("prompt process exit clears startup and termination timers", async () => {
  const pending = new Set();
  let scheduled = 0;
  const fx = fixture({
    setTimeout(callback) {
      const timer = { callback };
      pending.add(timer);
      scheduled++;
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    killProcess(child) { queueMicrotask(() => child.emit("exit", 0, null)); },
  });
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;
  assert.equal(pending.size, 0);
  await fx.sidecar.stop();
  assert.ok(scheduled >= 2);
  assert.equal(pending.size, 0);
});

test("start calls made while stop is in flight coalesce into one new attempt", async () => {
  const fx = fixture({ stopTimeoutMs: 5, forceKillTimeoutMs: 5 });
  const initial = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await initial;
  const stopping = fx.sidecar.stop();
  const first = fx.sidecar.start(config);
  const duplicate = fx.sidecar.start(config);
  assert.strictEqual(first, duplicate);
  await stopping;
  emitReady(fx.children[1]);
  await first;
  assert.equal(fx.children.length, 2);
  await fx.sidecar.stop();
});

test("duplicate start coalesces and stop cancels stale attempts and late events", async () => {
  const fx = fixture();
  const first = fx.sidecar.start(config);
  const duplicate = fx.sidecar.start(config);
  assert.strictEqual(first, duplicate);
  const stopping = fx.sidecar.stop();
  await assert.rejects(first, (error) => error.code === "sidecar_start_cancelled");
  await stopping;

  const second = fx.sidecar.start(config);
  assert.equal(fx.children.length, 2);
  emitReady(fx.children[0], "127.0.0.1:40001");
  emitReady(fx.children[1], "127.0.0.1:40002");
  assert.deepEqual(await second, { listen: "127.0.0.1:40002", generation: 3 });
});

test("dispose stops the child, removes listeners, and permanently rejects start", async () => {
  const fx = fixture({ stopTimeoutMs: 2, forceKillTimeoutMs: 2 });
  const started = fx.sidecar.start(config);
  emitReady(fx.children[0]);
  await started;
  fx.sidecar.on("failure", () => {});
  await fx.sidecar.dispose();
  assert.equal(fx.sidecar.listenerCount("failure"), 0);
  await assert.rejects(fx.sidecar.start(config), (error) => error.code === "sidecar_disposed");
});

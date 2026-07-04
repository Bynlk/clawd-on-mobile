"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { execScript, sha256Fingerprint } = require("../src/wg-ssh2-exec");

// ── Fake ssh2 Client ──
//
// Mimics the tiny slice of the ssh2 Client surface execScript touches:
//   connect({ hostVerifier, ... })
//   on("ready"|"error")
//   exec("bash -s", cb(err, stream))
// The stream is an EventEmitter with .stderr (EventEmitter), .end(script).
function makeFakeClient(behavior) {
  class FakeStream extends EventEmitter {
    constructor() {
      super();
      this.stderr = new EventEmitter();
      this.ended = null;
    }
    end(script) { this.ended = script; }
  }
  class FakeClient extends EventEmitter {
    connect(opts) {
      this._opts = opts;
      // Simulate host key verification first.
      const fakeKey = Buffer.from(behavior.hostKey || "fake-host-key");
      opts.hostVerifier(fakeKey, (ok) => {
        this._hostKeyOk = ok;
        if (!ok) {
          // ssh2 emits error when hostVerifier rejects.
          process.nextTick(() => this.emit("error", new Error("Host key rejected")));
          return;
        }
        if (behavior.authError) {
          process.nextTick(() => this.emit("error", behavior.authError));
          return;
        }
        process.nextTick(() => this.emit("ready"));
      });
    }
    exec(cmd, cb) {
      this._execCmd = cmd;
      const stream = new FakeStream();
      this._stream = stream;
      process.nextTick(() => {
        cb(null, stream);
        // Drive scripted stderr/stdout/close.
        process.nextTick(() => {
          for (const line of behavior.stderrLines || []) {
            stream.stderr.emit("data", Buffer.from(line + "\n"));
          }
          if (behavior.stdout) stream.emit("data", Buffer.from(behavior.stdout));
          stream.emit("close", behavior.exitCode == null ? 0 : behavior.exitCode);
        });
      });
    }
    end() { this._ended = true; }
  }
  return FakeClient;
}

test("execScript runs bash -s, feeds script, returns code/stdout/stderr", async () => {
  const Client = makeFakeClient({
    stdout: "<<<CLAWD_JSON>>>{}<<<END_CLAWD_JSON>>>",
    stderrLines: ["[wg-relay] step: detect", "[wg-relay] step: install"],
    exitCode: 0,
  });
  const lines = [];
  const r = await execScript({
    host: "1.2.3.4",
    username: "root",
    password: "pw",
    hostKeyVerifier: () => true,
    script: "echo hi",
    onProgress: (l) => lines.push(l),
    deps: { Client },
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /CLAWD_JSON/);
  assert.ok(lines.includes("[wg-relay] step: detect"));
  assert.ok(lines.includes("[wg-relay] step: install"));
});

test("execScript rejects when host key verifier returns false (SEC-6)", async () => {
  const Client = makeFakeClient({ exitCode: 0 });
  await assert.rejects(
    execScript({
      host: "1.2.3.4",
      password: "pw",
      hostKeyVerifier: () => false,
      script: "echo hi",
      deps: { Client },
    }),
    /Host key verification rejected/
  );
});

test("execScript fails closed with no verifier (rejects unknown host key)", async () => {
  const Client = makeFakeClient({ exitCode: 0 });
  await assert.rejects(
    execScript({
      host: "1.2.3.4",
      password: "pw",
      script: "echo hi",
      deps: { Client },
    }),
    /Host key verification rejected/
  );
});

test("execScript surfaces auth errors", async () => {
  const Client = makeFakeClient({
    authError: new Error("All configured authentication methods failed"),
  });
  await assert.rejects(
    execScript({
      host: "1.2.3.4",
      password: "wrong",
      hostKeyVerifier: () => true,
      script: "echo hi",
      deps: { Client },
    }),
    /authentication methods failed/
  );
});

test("execScript propagates non-zero exit code", async () => {
  const Client = makeFakeClient({ exitCode: 13, stdout: "" });
  const r = await execScript({
    host: "1.2.3.4",
    password: "pw",
    hostKeyVerifier: () => true,
    script: "exit 13",
    deps: { Client },
  });
  assert.equal(r.code, 13);
});

test("sha256Fingerprint formats like OpenSSH SHA256:...", () => {
  const fp = sha256Fingerprint(Buffer.from("hello"));
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.ok(!fp.endsWith("="));
});

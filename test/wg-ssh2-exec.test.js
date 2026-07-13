"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { deployBundle, execScript, sha256Fingerprint } = require("../src/wg-ssh2-exec");

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

function makeBundleClient(behavior = {}) {
  const state = {
    connectCalls: 0,
    operations: [],
    commands: [],
    stdin: [],
  };

  class FakeInstallStream extends EventEmitter {
    constructor() {
      super();
      this.stderr = new EventEmitter();
    }
    write(chunk) {
      state.stdin.push({ type: "write", value: String(chunk) });
      return true;
    }
    end(chunk) {
      if (chunk != null) state.stdin.push({ type: "end-data", value: String(chunk) });
      else state.stdin.push({ type: "end" });
      process.nextTick(() => {
        if (behavior.stdout) this.emit("data", Buffer.from(behavior.stdout));
        if (behavior.stderr) this.stderr.emit("data", Buffer.from(behavior.stderr));
        this.emit("close", behavior.exitCode == null ? 0 : behavior.exitCode);
      });
    }
  }

  class FakeBundleClient extends EventEmitter {
    connect(options) {
      state.connectCalls += 1;
      state.connectOptions = options;
      const key = Buffer.from(behavior.hostKey || "bundle-host-key");
      options.hostVerifier(key, (accepted) => {
        state.hostAccepted = accepted;
        if (!accepted) {
          process.nextTick(() => this.emit("error", new Error("Host key rejected")));
          return;
        }
        process.nextTick(() => this.emit("ready"));
      });
    }
    sftp(callback) {
      state.operations.push("sftp");
      const sftp = {
        mkdir(remotePath, options, done) {
          state.operations.push(`mkdir:${remotePath}:${options.mode.toString(8)}`);
          done(null);
        },
        writeFile(remotePath, contents, options, done) {
          state.operations.push(`write:${remotePath}:${options.mode.toString(8)}:${Buffer.isBuffer(contents)}`);
          done(behavior.uploadError || null);
        },
      };
      process.nextTick(() => callback(null, sftp));
    }
    exec(command, callback) {
      state.operations.push("exec");
      state.commands.push(command);
      process.nextTick(() => callback(null, new FakeInstallStream()));
    }
    end() {
      state.ended = true;
    }
  }

  return { Client: FakeBundleClient, state };
}

function bundleArgs(over = {}) {
  return {
    host: "1.2.3.4",
    port: 2222,
    username: "root",
    password: "ssh-password",
    manifest: [{ localPath: __filename, remotePath: "install-wg-relay.sh", mode: 0o755 }],
    installEnv: { WG_PORT: "51820", WG_SUBNET: "10.8.0.0/24" },
    timeoutMs: 1000,
    ...over,
  };
}

test("deployBundle uses one connection for TOFU, SFTP upload, then one root install exec", async () => {
  const fake = makeBundleClient({ stdout: "installed" });
  const confirmations = [];
  const progress = [];

  const result = await deployBundle(bundleArgs({
    confirmHostKey: async (info) => {
      confirmations.push(info);
      return true;
    },
    onProgress: (event) => progress.push(event),
    deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-test" },
  }));

  assert.equal(fake.state.connectCalls, 1);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0], {
    fingerprint: sha256Fingerprint(Buffer.from("bundle-host-key")),
    host: "1.2.3.4",
    port: 2222,
  });
  assert.deepEqual(fake.state.operations.map((op) => op.split(":")[0]), [
    "sftp", "mkdir", "write", "exec",
  ]);
  assert.equal(fake.state.commands.length, 1);
  assert.match(fake.state.commands[0], /env WG_PORT='51820' WG_SUBNET='10\.8\.0\.0\/24' bash \/tmp\/clawd-relay-test\/install-wg-relay\.sh$/);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "installed");
  assert.equal(result.acceptedFingerprint, confirmations[0].fingerprint);
  assert.deepEqual(progress.map((event) => `${event.stage}:${event.status}`), [
    "connect:start",
    "host-key:start",
    "host-key:ok",
    "connect:ok",
    "upload:start",
    "upload:ok",
    "install:start",
    "install:ok",
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /ssh-password|installed/);
});

test("deployBundle accepts an exact saved fingerprint without confirmation", async () => {
  const hostKey = Buffer.from("known-host-key");
  const fake = makeBundleClient({ hostKey });
  let confirmCalls = 0;

  const result = await deployBundle(bundleArgs({
    expectedFingerprint: sha256Fingerprint(hostKey),
    confirmHostKey: async () => {
      confirmCalls += 1;
      return true;
    },
    deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-known" },
  }));

  assert.equal(confirmCalls, 0);
  assert.equal(result.acceptedFingerprint, sha256Fingerprint(hostKey));
});

test("deployBundle rejects a changed saved fingerprint without confirmation or upload", async () => {
  const fake = makeBundleClient({ hostKey: Buffer.from("changed-host-key") });
  let confirmCalls = 0;

  await assert.rejects(
    deployBundle(bundleArgs({
      expectedFingerprint: sha256Fingerprint(Buffer.from("saved-host-key")),
      confirmHostKey: async () => {
        confirmCalls += 1;
        return true;
      },
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-changed" },
    })),
    /saved SSH host key has changed/i
  );

  assert.equal(confirmCalls, 0);
  assert.equal(fake.state.operations.length, 0);
});

test("deployBundle non-root install writes sudo password before closing installer stdin", async () => {
  const fake = makeBundleClient();

  await deployBundle(bundleArgs({
    username: "deploy",
    confirmHostKey: () => true,
    deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-sudo" },
  }));

  assert.match(fake.state.commands[0], /^sudo -S -p '' env .* bash \/tmp\/clawd-relay-sudo\/install-wg-relay\.sh$/);
  assert.deepEqual(fake.state.stdin, [
    { type: "write", value: "ssh-password\n" },
    { type: "end" },
  ]);
});

test("deployBundle reports an upload failure without starting installation", async () => {
  const fake = makeBundleClient({ uploadError: new Error("upload failed") });
  const progress = [];

  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => true,
      onProgress: (event) => progress.push(event),
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-upload-fail" },
    })),
    /upload failed/
  );

  assert.deepEqual(progress.map((event) => `${event.stage}:${event.status}`), [
    "connect:start",
    "host-key:start",
    "host-key:ok",
    "connect:ok",
    "upload:start",
    "upload:fail",
  ]);
  assert.equal(fake.state.commands.length, 0);
});

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

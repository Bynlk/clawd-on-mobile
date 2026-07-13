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
    verifierCallbackCount: 0,
    verifierValues: [],
    sftpEnded: false,
    streamDestroyed: false,
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
    destroy() {
      state.streamDestroyed = true;
    }
    end(chunk) {
      if (chunk != null) state.stdin.push({ type: "end-data", value: String(chunk) });
      else state.stdin.push({ type: "end" });
      if (behavior.hangInstall) return;
      process.nextTick(() => {
        if (behavior.stdout) this.emit("data", Buffer.from(behavior.stdout));
        if (behavior.stderr) this.stderr.emit("data", Buffer.from(behavior.stderr));
        if (!state.streamDestroyed) this.emit("close", behavior.exitCode == null ? 0 : behavior.exitCode);
      });
    }
  }

  class FakeBundleClient extends EventEmitter {
    connect(options) {
      state.connectCalls += 1;
      state.connectOptions = options;
      const key = Buffer.from(behavior.hostKey || "bundle-host-key");
      options.hostVerifier(key, (accepted) => {
        state.verifierCallbackCount += 1;
        state.verifierValues.push(accepted);
        state.hostAccepted = accepted;
        if (!accepted) {
          const emitRejection = () => this.emit("error", new Error("raw synchronous host rejection"));
          if (behavior.syncErrorOnVerifierReject) emitRejection();
          else process.nextTick(emitRejection);
          return;
        }
        process.nextTick(() => {
          if (behavior.closeBeforeReady) this.emit("close");
          else this.emit("ready");
        });
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
        end() {
          state.sftpEnded = true;
        },
      };
      state.sftp = sftp;
      if (behavior.sftpDelayMs) setTimeout(() => callback(null, sftp), behavior.sftpDelayMs);
      else process.nextTick(() => callback(null, sftp));
    }
    exec(command, callback) {
      state.operations.push("exec");
      state.commands.push(command);
      state.stream = new FakeInstallStream();
      process.nextTick(() => callback(null, state.stream));
    }
    end() {
      state.ended = true;
    }
  }

  return { Client: FakeBundleClient, state };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bundleArgs(over = {}) {
  return {
    host: "1.2.3.4",
    port: 2222,
    username: "root",
    password: "ssh-password",
    manifest: [{ contents: Buffer.from("installer"), remotePath: "install-wg-relay.sh", mode: 0o755 }],
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
    (error) => error.code === "HOST_KEY_CHANGED"
      && error.reason === "host_key_changed"
      && !error.message.includes(sha256Fingerprint(Buffer.from("changed-host-key")))
  );

  assert.equal(confirmCalls, 0);
  assert.equal(fake.state.operations.length, 0);
});

test("deployBundle returns a stable unconfirmed TOFU reason", async () => {
  const fake = makeBundleClient();
  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => false,
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-unconfirmed" },
    })),
    (error) => error.code === "HOST_KEY_UNCONFIRMED"
      && error.reason === "host_key_unconfirmed"
  );
  assert.equal(fake.state.verifierCallbackCount, 1);
  assert.deepEqual(fake.state.verifierValues, [false]);
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

test("deployBundle timeout during delayed SFTP open closes late SFTP and never execs", async () => {
  const fake = makeBundleClient({ sftpDelayMs: 30 });
  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => true,
      timeoutMs: 5,
      deps: {
        Client: fake.Client,
        remoteRoot: "/tmp/clawd-relay-late-sftp",
        bundleModule: { uploadRelayBundle: async () => {} },
      },
    })),
    (error) => error.code === "SSH_TIMEOUT"
  );

  await wait(45);
  assert.equal(fake.state.commands.length, 0);
  assert.equal(fake.state.ended, true);
  assert.equal(fake.state.sftpEnded, true);
});

test("deployBundle timeout during delayed upload closes SFTP and never execs after upload resolves", async () => {
  const fake = makeBundleClient();
  const upload = deferred();
  const started = deferred();
  const promise = deployBundle(bundleArgs({
    confirmHostKey: () => true,
    timeoutMs: 10,
    deps: {
      Client: fake.Client,
      remoteRoot: "/tmp/clawd-relay-late-upload",
      bundleModule: {
        uploadRelayBundle: async () => {
          started.resolve();
          await upload.promise;
        },
      },
    },
  }));
  await started.promise;
  await assert.rejects(promise, (error) => error.code === "SSH_TIMEOUT");
  upload.resolve();
  await wait(10);

  assert.equal(fake.state.commands.length, 0);
  assert.equal(fake.state.sftpEnded, true);
});

test("deployBundle rejects connection close before ready", async () => {
  const fake = makeBundleClient({ closeBeforeReady: true });
  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => true,
      timeoutMs: 30,
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-close-before-ready" },
    })),
    (error) => error.code === "SSH_CONNECTION_CLOSED"
  );
  assert.equal(fake.state.commands.length, 0);
});

test("deployBundle timeout closes an active install channel", async () => {
  const fake = makeBundleClient({ hangInstall: true });
  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => true,
      timeoutMs: 10,
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-hung-install" },
    })),
    (error) => error.code === "SSH_TIMEOUT"
  );
  assert.equal(fake.state.commands.length, 1);
  assert.equal(fake.state.streamDestroyed, true);
});

test("deployBundle aborts a never-ready ssh2 client immediately and removes late work", async () => {
  const state = { connectCalls: 0, ended: false, destroyed: false, lateCallbacks: 0 };
  class NeverReadyClient extends EventEmitter {
    connect() { state.connectCalls += 1; }
    end() { state.ended = true; }
    destroy() { state.destroyed = true; }
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = deployBundle(bundleArgs({
    signal: controller.signal,
    timeoutMs: 5000,
    deps: { Client: NeverReadyClient, remoteRoot: "/tmp/clawd-relay-abort" },
  }));
  controller.abort();

  await assert.rejects(pending, (error) => (
    error.code === "SSH_ABORTED" && error.reason === "aborted"
  ));
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(state.connectCalls, 1);
  assert.equal(state.ended, true);
  assert.equal(state.destroyed, true);
  await wait(20);
  assert.equal(state.lateCallbacks, 0);
});

test("deployBundle closes a late SFTP callback after abort and never starts exec", async () => {
  const fake = makeBundleClient({ sftpDelayMs: 40 });
  const controller = new AbortController();
  const pending = deployBundle(bundleArgs({
    signal: controller.signal,
    timeoutMs: 5000,
    confirmHostKey: () => true,
    deps: {
      Client: fake.Client,
      remoteRoot: "/tmp/clawd-relay-abort-sftp",
      bundleModule: { uploadRelayBundle: async () => {} },
    },
  }));
  await wait(5);
  controller.abort();

  await assert.rejects(pending, (error) => error.code === "SSH_ABORTED");
  await wait(60);
  assert.equal(fake.state.sftpEnded, true);
  assert.equal(fake.state.commands.length, 0);
});

test("deployBundle abort settles an active installer and removes stream listeners", async () => {
  const fake = makeBundleClient({ hangInstall: true });
  const controller = new AbortController();
  const pending = deployBundle(bundleArgs({
    signal: controller.signal,
    timeoutMs: 5000,
    confirmHostKey: () => true,
    deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-abort-install" },
  }));
  while (!fake.state.stream) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, (error) => error.code === "SSH_ABORTED");
  assert.equal(fake.state.streamDestroyed, true);
  assert.equal(fake.state.stream.listenerCount("data"), 0);
  assert.equal(fake.state.stream.listenerCount("error"), 0);
  assert.equal(fake.state.stream.listenerCount("close"), 0);
  assert.equal(fake.state.stream.stderr.listenerCount("data"), 0);
});

test("deployBundle maps synchronous TOFU confirmation throws and invokes verifier callback once", async () => {
  const fake = makeBundleClient();
  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => { throw new Error("sensitive confirmation detail"); },
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-confirm-throw" },
    })),
    (error) => error.code === "HOST_KEY_CONFIRMATION_FAILED"
      && !error.message.includes("sensitive confirmation detail")
  );
  assert.equal(fake.state.verifierCallbackCount, 1);
  assert.deepEqual(fake.state.verifierValues, [false]);
  assert.equal(fake.state.ended, true);
});

test("deployBundle preserves structured TOFU failures when verifier rejection emits an error synchronously", async (t) => {
  const cases = [
    {
      name: "changed saved fingerprint",
      args: {
        expectedFingerprint: sha256Fingerprint(Buffer.from("saved-host-key")),
        confirmHostKey: () => true,
      },
      code: "HOST_KEY_CHANGED",
      reason: "host_key_changed",
    },
    {
      name: "unknown host rejected by user",
      args: { confirmHostKey: () => false },
      code: "HOST_KEY_UNCONFIRMED",
      reason: "host_key_unconfirmed",
    },
    {
      name: "host confirmation throws synchronously",
      args: { confirmHostKey: () => { throw new Error("sensitive confirmation detail"); } },
      code: "HOST_KEY_CONFIRMATION_FAILED",
      reason: "host_key_confirmation_failed",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fake = makeBundleClient({
        hostKey: Buffer.from("changed-host-key"),
        syncErrorOnVerifierReject: true,
      });
      await assert.rejects(
        deployBundle(bundleArgs({
          ...entry.args,
          deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-sync-reject" },
        })),
        (error) => error.code === entry.code
          && error.reason === entry.reason
          && !error.message.includes("raw synchronous host rejection")
          && !error.message.includes("sensitive confirmation detail")
      );
      assert.equal(fake.state.verifierCallbackCount, 1);
      assert.deepEqual(fake.state.verifierValues, [false]);
      assert.equal(fake.state.ended, true);
      assert.equal(fake.state.operations.length, 0);
    });
  }
});

test("deployBundle pending TOFU confirmation cannot revive after timeout", async () => {
  const fake = makeBundleClient();
  const confirmation = deferred();
  const promise = deployBundle(bundleArgs({
    confirmHostKey: () => confirmation.promise,
    timeoutMs: 10,
    deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-late-confirm" },
  }));
  await assert.rejects(promise, (error) => error.code === "SSH_TIMEOUT");
  confirmation.resolve(true);
  await wait(10);

  assert.equal(fake.state.verifierCallbackCount, 1);
  assert.deepEqual(fake.state.verifierValues, [false]);
  assert.equal(fake.state.operations.length, 0);
});

test("deployBundle rejects CR or LF in a non-root sudo password before connect", async () => {
  for (const password of ["bad\npassword", "bad\rpassword"]) {
    const fake = makeBundleClient();
    await assert.rejects(
      deployBundle(bundleArgs({
        username: "deploy",
        password,
        confirmHostKey: () => true,
        deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-password" },
      })),
      (error) => error.code === "INVALID_SUDO_PASSWORD"
    );
    assert.equal(fake.state.connectCalls, 0);
    assert.equal(fake.state.commands.length, 0);
  }
});

test("deployBundle bounds combined stdout and stderr and aborts the install channel", async () => {
  const fake = makeBundleClient({
    stdout: Buffer.alloc(1024 * 1024 + 1, 65),
    stderr: Buffer.alloc(1024 * 1024 + 1, 66),
  });
  await assert.rejects(
    deployBundle(bundleArgs({
      confirmHostKey: () => true,
      deps: { Client: fake.Client, remoteRoot: "/tmp/clawd-relay-output-limit" },
    })),
    (error) => error.code === "OUTPUT_LIMIT"
      && error.reason === "output_limit"
      && !error.message.includes("AAAA")
  );
  assert.equal(fake.state.streamDestroyed, true);
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

test("execScript abort destroys a never-ready compatibility client", async () => {
  const state = { ended: false, destroyed: false };
  class NeverReadyClient extends EventEmitter {
    connect() {}
    end() { state.ended = true; }
    destroy() { state.destroyed = true; }
  }
  const controller = new AbortController();
  const pending = execScript({
    host: "1.2.3.4",
    password: "pw",
    hostKeyVerifier: () => true,
    script: "echo hi",
    signal: controller.signal,
    timeoutMs: 5000,
    deps: { Client: NeverReadyClient },
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.code === "SSH_ABORTED");
  assert.equal(state.ended, true);
  assert.equal(state.destroyed, true);
});

test("sha256Fingerprint formats like OpenSSH SHA256:...", () => {
  const fp = sha256Fingerprint(Buffer.from("hello"));
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.ok(!fp.endsWith("="));
});

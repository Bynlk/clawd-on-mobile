"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  deploy,
  parseReadback,
  buildRemoteScript,
  buildEnvPreamble,
  makeStepTracker,
  splitHost,
  EXIT_CODE_MAP,
} = require("../src/wg-relay-deploy");

// Build a valid readback JSON payload (base64 conf blobs) wrapped in markers.
function makeReadbackStdout(over = {}) {
  const pcConf = over.pcConf || "[Interface]\nPrivateKey = pcpriv\n";
  const phoneConf = over.phoneConf || "[Interface]\nPrivateKey = phonepriv\n";
  const obj = {
    serverPubKey: over.serverPubKey || "SRVPUB=",
    endpoint: over.endpoint || "1.2.3.4:51820",
    relayAddr: over.relayAddr || "ws://10.8.0.1:7891",
    pcAddress: over.pcAddress || "10.8.0.2/32",
    pcConfB64: over.pcConfB64 != null ? over.pcConfB64 : Buffer.from(pcConf).toString("base64"),
    phoneConfB64: over.phoneConfB64 != null ? over.phoneConfB64 : Buffer.from(phoneConf).toString("base64"),
  };
  return `noise before\n<<<CLAWD_JSON>>>${JSON.stringify(obj)}<<<END_CLAWD_JSON>>>\ntrailing noise`;
}

function keyProfile(over = {}) {
  return {
    id: "wg-1",
    label: "VPS",
    host: "root@1.2.3.4",
    port: 22,
    authMethod: "key",
    identityFile: "/home/u/.ssh/id_ed25519",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
    ...over,
  };
}

// ── splitHost ──
test("splitHost splits user@host, defaults root", () => {
  assert.deepEqual(splitHost("bob@1.2.3.4"), ["bob", "1.2.3.4"]);
  assert.deepEqual(splitHost("1.2.3.4"), ["root", "1.2.3.4"]);
});

// ── buildEnvPreamble ──
test("buildEnvPreamble exports validated tunables", () => {
  const pre = buildEnvPreamble(keyProfile({ wgPort: 51999, wgSubnet: "10.9.0.0/24" }), { relayPort: 8000, forcePhoneKey: true });
  assert.match(pre, /export WG_PORT=51999/);
  assert.match(pre, /export WG_SUBNET='10\.9\.0\.0\/24'/);
  assert.match(pre, /export RELAY_PORT=8000/);
  assert.match(pre, /export FORCE_PHONE_KEY=1/);
});

test("buildEnvPreamble uses defaults", () => {
  const pre = buildEnvPreamble({}, {});
  assert.match(pre, /export WG_PORT=51820/);
  assert.match(pre, /export FORCE_PHONE_KEY=0/);
});

// ── buildRemoteScript ──
test("buildRemoteScript prepends preamble to injected body", () => {
  const s = buildRemoteScript(keyProfile(), {}, { scriptBody: "echo BODY" });
  assert.match(s, /export WG_PORT=51820/);
  assert.match(s, /echo BODY$/);
});

// ── parseReadback ──
test("parseReadback extracts + decodes conf blobs", () => {
  const r = parseReadback(makeReadbackStdout());
  assert.equal(r.ok, true);
  assert.equal(r.readback.serverPubKey, "SRVPUB=");
  assert.match(r.readback.pcConf, /PrivateKey = pcpriv/);
  assert.match(r.readback.phoneConf, /PrivateKey = phonepriv/);
});

test("parseReadback fails without markers", () => {
  const r = parseReadback("just noise, no markers");
  assert.equal(r.ok, false);
  assert.match(r.message, /marker/);
});

test("parseReadback fails on malformed JSON", () => {
  const r = parseReadback("<<<CLAWD_JSON>>>{not json}<<<END_CLAWD_JSON>>>");
  assert.equal(r.ok, false);
  assert.match(r.message, /Malformed/);
});

test("parseReadback fails when required fields missing", () => {
  const r = parseReadback(makeReadbackStdout({ pcConfB64: Buffer.from("").toString("base64"), pcConf: "" }));
  assert.equal(r.ok, false);
});

// ── makeStepTracker ──
test("makeStepTracker maps log lines to progress events", () => {
  const events = [];
  const tracker = makeStepTracker((step, status) => events.push([step, status]));
  tracker.onLine("[wg-relay] step: detect");
  tracker.onLine("[wg-relay] step: install");
  tracker.onLine("some other line");
  tracker.onLine("[wg-relay] step: readback");
  tracker.finishOk();
  // detect start, then when install seen: detect ok + install start ...
  assert.deepEqual(events[0], ["detect", "start"]);
  assert.deepEqual(events[1], ["detect", "ok"]);
  assert.deepEqual(events[2], ["install-wg", "start"]);
  assert.deepEqual(events[events.length - 1], ["readback", "ok"]);
});

// ── deploy: key path happy case ──
function fakeEmitter() {
  const e = new EventEmitter();
  e.events = [];
  e.on("progress", (p) => e.events.push(p));
  return e;
}

test("deploy key path returns readback on exit 0", async () => {
  const emitter = fakeEmitter();
  const fakeSpawn = () => {};
  const deps = {
    scriptBody: "echo body",
    spawn: fakeSpawn,
    runtimeModule: { buildSshArgs: () => ["-T", "root@1.2.3.4"] },
    deployModule: {
      spawnAndWait: async () => ({
        code: 0,
        stdout: makeReadbackStdout(),
        stderr: "[wg-relay] step: detect\n[wg-relay] step: readback\n",
      }),
    },
    runtime: emitter,
  };
  const r = await deploy({ profile: keyProfile(), runtime: { emitter }, deps });
  assert.equal(r.ok, true);
  assert.match(r.readback.pcConf, /pcpriv/);
  // progress emitted with connect start/ok
  assert.ok(emitter.events.some((e) => e.step === "connect" && e.status === "start"));
  assert.ok(emitter.events.some((e) => e.step === "connect" && e.status === "ok"));
});

test("deploy maps non-zero exit code via EXIT_CODE_MAP", async () => {
  const emitter = fakeEmitter();
  const deps = {
    scriptBody: "echo body",
    spawn: () => {},
    runtimeModule: { buildSshArgs: () => ["root@1.2.3.4"] },
    deployModule: {
      spawnAndWait: async () => ({ code: 13, stdout: "", stderr: "boom" }),
    },
    runtime: emitter,
  };
  const r = await deploy({ profile: keyProfile(), runtime: { emitter }, deps });
  assert.equal(r.ok, false);
  assert.equal(r.step, EXIT_CODE_MAP[13].step);
  assert.equal(r.hint, EXIT_CODE_MAP[13].hint);
});

test("deploy password path uses ssh2 module", async () => {
  const emitter = fakeEmitter();
  let execArgs = null;
  const deps = {
    scriptBody: "echo body",
    ssh2Module: {
      execScript: async (a) => {
        execArgs = a;
        return { code: 0, stdout: makeReadbackStdout(), stderr: "" };
      },
    },
    hostKeyVerifier: () => true,
    runtime: emitter,
  };
  const r = await deploy({
    profile: keyProfile({ authMethod: "password", identityFile: undefined }),
    password: "s3cret",
    runtime: { emitter },
    deps,
  });
  assert.equal(r.ok, true);
  assert.equal(execArgs.password, "s3cret");
  assert.equal(execArgs.username, "root");
  assert.equal(execArgs.host, "1.2.3.4");
});

test("deploy maps password-disabled ssh2 error to EX-3", async () => {
  const emitter = fakeEmitter();
  const deps = {
    scriptBody: "echo body",
    ssh2Module: {
      execScript: async () => { throw new Error("password login is disabled"); },
    },
    hostKeyVerifier: () => true,
    runtime: emitter,
  };
  const r = await deploy({
    profile: keyProfile({ authMethod: "password", identityFile: undefined }),
    password: "pw",
    runtime: { emitter },
    deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "password_disabled");
  assert.equal(r.hint, "wgErrPasswordDisabled");
});

test("deploy maps host-key ssh2 error", async () => {
  const emitter = fakeEmitter();
  const deps = {
    scriptBody: "echo body",
    ssh2Module: {
      execScript: async () => { throw new Error("Host key verification rejected by user"); },
    },
    hostKeyVerifier: () => false,
    runtime: emitter,
  };
  const r = await deploy({
    profile: keyProfile({ authMethod: "password", identityFile: undefined }),
    password: "pw",
    runtime: { emitter },
    deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "host_key");
  assert.equal(r.hint, "wgErrHostKey");
});

test("deploy fails gracefully when script cannot be read", async () => {
  const emitter = fakeEmitter();
  const deps = {
    scriptPath: "/nonexistent/path/install.sh",
    spawn: () => {},
    runtime: emitter,
  };
  const r = await deploy({ profile: keyProfile(), runtime: { emitter }, deps });
  assert.equal(r.ok, false);
  assert.equal(r.step, "connect");
  assert.match(r.message, /Cannot read install script/);
});

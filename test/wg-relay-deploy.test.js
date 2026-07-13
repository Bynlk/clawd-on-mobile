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
  STEPS,
} = require("../src/wg-relay-deploy");

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const PRIVATE_KEY = `${"A".repeat(43)}=`;
const PUBLIC_KEY = `${"B".repeat(43)}=`;

function wgConfig(address, over = {}) {
  return [
    "[Interface]",
    `PrivateKey = ${over.privateKey || PRIVATE_KEY}`,
    `Address = ${address}`,
    "",
    "[Peer]",
    `PublicKey = ${over.publicKey || PUBLIC_KEY}`,
    "Endpoint = 1.2.3.4:51820",
    "AllowedIPs = 10.8.0.0/24",
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function valueOr(over, key, fallback) {
  return Object.hasOwn(over, key) ? over[key] : fallback;
}

// Build a valid schemaVersion=1 readback payload wrapped in markers.
function makeReadbackStdout(over = {}) {
  const obj = {
    schemaVersion: valueOr(over, "schemaVersion", 1),
    endpoint: valueOr(over, "endpoint", "1.2.3.4:51820"),
    subnet: valueOr(over, "subnet", "10.8.0.0/24"),
    relayUrl: valueOr(over, "relayUrl", "ws://10.8.0.1:7891"),
    pcConfig: valueOr(over, "pcConfig", wgConfig("10.8.0.2/32")),
    phoneConfig: valueOr(over, "phoneConfig", wgConfig("10.8.0.3/32")),
    relayToken: valueOr(over, "relayToken", TOKEN_A),
    managementToken: valueOr(over, "managementToken", TOKEN_B),
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
test("parseReadback accepts a complete strict schemaVersion=1 payload", () => {
  const r = parseReadback(makeReadbackStdout());
  assert.equal(r.ok, true);
  assert.equal(r.readback.schemaVersion, 1);
  assert.equal(r.readback.subnet, "10.8.0.0/24");
  assert.equal(r.readback.relayUrl, "ws://10.8.0.1:7891");
  assert.match(r.readback.pcConfig, /Address = 10\.8\.0\.2\/32/);
  assert.match(r.readback.phoneConfig, /Address = 10\.8\.0\.3\/32/);
  assert.equal(r.readback.relayToken, TOKEN_A);
  assert.equal(r.readback.managementToken, TOKEN_B);
});

test("parseReadback fails without markers", () => {
  const r = parseReadback("just noise, no markers");
  assert.equal(r.ok, false);
  assert.match(r.message, /marker/);
});

test("parseReadback fails on malformed JSON without echoing its contents", () => {
  const secret = "never-echo-malformed-secret";
  const r = parseReadback(`<<<CLAWD_JSON>>>{${secret}}<<<END_CLAWD_JSON>>>`);
  assert.equal(r.ok, false);
  assert.equal(r.message, "Malformed readback JSON (EX-12)");
  assert.doesNotMatch(r.message, /never-echo-malformed-secret/);
});

test("STEPS exposes bundle stages without dropping legacy key-path stages", () => {
  for (const stage of [
    "connect", "host-key", "upload", "install", "validate",
    "detect", "install-wg", "gen-keys", "write-conf", "start-service", "firewall", "readback",
  ]) {
    assert.ok(STEPS.includes(stage), `missing stage ${stage}`);
  }
});

test("parseReadback rejects every partial or malformed security field", async (t) => {
  const cases = [
    ["wrong schema", { schemaVersion: 2 }],
    ["endpoint without port", { endpoint: "1.2.3.4" }],
    ["public subnet", { subnet: "8.8.8.0/24" }],
    ["non-/24 subnet", { subnet: "10.8.0.0/16" }],
    ["public Relay URL", { relayUrl: "ws://1.2.3.4:7891" }],
    ["secure-websocket Relay URL", { relayUrl: "wss://10.8.0.1:7891" }],
    ["incomplete PC config", { pcConfig: "[Interface]\nPrivateKey = value\n" }],
    ["empty phone config", { phoneConfig: "" }],
    ["short Relay Token", { relayToken: "a".repeat(63) }],
    ["non-hex management Token", { managementToken: "z".repeat(64) }],
  ];
  for (const [name, over] of cases) {
    await t.test(name, () => {
      const r = parseReadback(makeReadbackStdout(over));
      assert.equal(r.ok, false);
      assert.match(r.message, /invalid readback/i);
    });
  }
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
  assert.match(r.readback.pcConfig, /10\.8\.0\.2/);
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

test("deploy password path uses canonical SSH fields and a complete fixture bundle", async () => {
  const emitter = fakeEmitter();
  let deployArgs = null;
  let builtWith = null;
  const manifest = [{ localPath: __filename, remotePath: "install-wg-relay.sh", mode: 0o755 }];
  const deps = {
    appRoot: "/fixture/app",
    bundleModule: {
      buildRelayBundleManifest: (args) => {
        builtWith = args;
        return manifest;
      },
    },
    ssh2Module: {
      deployBundle: async (args) => {
        deployArgs = args;
        for (const [stage, status] of [
          ["connect", "start"], ["host-key", "ok"], ["upload", "ok"], ["install", "ok"],
        ]) args.onProgress({ stage, status });
        return {
          code: 0,
          stdout: makeReadbackStdout(),
          stderr: "",
          acceptedFingerprint: "SHA256:accepted",
        };
      },
    },
    confirmHostKey: () => true,
    runtime: emitter,
  };
  const r = await deploy({
    profile: keyProfile({
      host: "relay.example.com",
      port: undefined,
      sshUsername: "deploy",
      sshPort: 2200,
      sshHostFingerprint: "SHA256:saved",
      authMethod: "password",
      identityFile: undefined,
    }),
    password: "s3cret",
    runtime: { emitter },
    deps,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(builtWith, { appRoot: "/fixture/app" });
  assert.equal(deployArgs.password, "s3cret");
  assert.equal(deployArgs.username, "deploy");
  assert.equal(deployArgs.host, "relay.example.com");
  assert.equal(deployArgs.port, 2200);
  assert.equal(deployArgs.expectedFingerprint, "SHA256:saved");
  assert.equal(deployArgs.confirmHostKey, deps.confirmHostKey);
  assert.equal(deployArgs.manifest, manifest);
  assert.deepEqual(deployArgs.installEnv, {
    WG_PORT: "51820",
    WG_SUBNET: "10.8.0.0/24",
    RELAY_PORT: "7891",
    FORCE_PHONE_KEY: "0",
  });
  assert.equal(r.acceptedFingerprint, "SHA256:accepted");
  assert.ok(emitter.events.some((event) => event.step === "validate" && event.status === "start"));
  assert.ok(emitter.events.some((event) => event.step === "validate" && event.status === "ok"));
  assert.doesNotMatch(JSON.stringify(emitter.events), /s3cret|PrivateKey|aaaaaaaa/);
});

test("deploy password path falls back to legacy user@host and port", async () => {
  let deployArgs;
  const r = await deploy({
    profile: keyProfile({ authMethod: "password", identityFile: undefined }),
    password: "pw",
    deps: {
      bundleModule: { buildRelayBundleManifest: () => [{ remotePath: "install-wg-relay.sh" }] },
      ssh2Module: {
        deployBundle: async (args) => {
          deployArgs = args;
          return { code: 0, stdout: makeReadbackStdout(), stderr: "", acceptedFingerprint: "SHA256:legacy" };
        },
      },
      confirmHostKey: () => true,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(deployArgs.host, "1.2.3.4");
  assert.equal(deployArgs.username, "root");
  assert.equal(deployArgs.port, 22);
});

test("deploy maps password-disabled ssh2 error to EX-3", async () => {
  const emitter = fakeEmitter();
  const deps = {
    scriptBody: "echo body",
    bundleModule: { buildRelayBundleManifest: () => [{ remotePath: "install-wg-relay.sh" }] },
    ssh2Module: {
      deployBundle: async () => { throw new Error("password login is disabled"); },
    },
    confirmHostKey: () => true,
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
    bundleModule: { buildRelayBundleManifest: () => [{ remotePath: "install-wg-relay.sh" }] },
    ssh2Module: {
      deployBundle: async () => { throw new Error("Host key verification rejected by user"); },
    },
    confirmHostKey: () => false,
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

test("deploy never returns or emits a password contained in a transport error", async () => {
  const emitter = fakeEmitter();
  const password = "never-expose-this";
  const r = await deploy({
    profile: keyProfile({ authMethod: "password", identityFile: undefined }),
    password,
    runtime: { emitter },
    deps: {
      bundleModule: { buildRelayBundleManifest: () => [{ remotePath: "install-wg-relay.sh" }] },
      ssh2Module: {
        deployBundle: async () => { throw new Error(`authentication failed: ${password}`); },
      },
      confirmHostKey: () => true,
      runtime: emitter,
    },
  });
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify({ result: r, events: emitter.events }), /never-expose-this/);
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

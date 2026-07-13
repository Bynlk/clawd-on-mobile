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

const TOKEN_A = "aA".repeat(32);
const TOKEN_B = "bB".repeat(32);
const PC_PRIVATE_KEY = Buffer.alloc(32, 1).toString("base64");
const PHONE_PRIVATE_KEY = Buffer.alloc(32, 4).toString("base64");
const PUBLIC_KEY = Buffer.alloc(32, 2).toString("base64");
const OTHER_PUBLIC_KEY = Buffer.alloc(32, 3).toString("base64");

function wgConfig(address, over = {}) {
  const defaultPrivateKey = address.endsWith(".3/32") ? PHONE_PRIVATE_KEY : PC_PRIVATE_KEY;
  const lines = [
    "[Interface]",
    `PrivateKey = ${over.privateKey || defaultPrivateKey}`,
    `Address = ${address}`,
  ];
  if (over.duplicatePrivateKey) lines.push(`PrivateKey = ${over.privateKey || defaultPrivateKey}`);
  if (over.interfaceExtra) lines.push(over.interfaceExtra);
  lines.push(
    "",
    "[Peer]",
    `PublicKey = ${over.publicKey || PUBLIC_KEY}`,
    `Endpoint = ${over.endpoint || "8.8.8.8:51820"}`,
    `AllowedIPs = ${over.allowedIps || "10.8.0.0/24"}`,
    `PersistentKeepalive = ${over.keepalive || "25"}`,
    "",
  );
  if (over.duplicatePeerSection) {
    lines.push(
      "[Peer]",
      `PublicKey = ${over.publicKey || PUBLIC_KEY}`,
      `Endpoint = ${over.endpoint || "8.8.8.8:51820"}`,
      `AllowedIPs = ${over.allowedIps || "10.8.0.0/24"}`,
      `PersistentKeepalive = ${over.keepalive || "25"}`,
      ""
    );
  }
  return lines.join("\n");
}

function valueOr(over, key, fallback) {
  return Object.hasOwn(over, key) ? over[key] : fallback;
}

// Build a valid schemaVersion=1 readback payload wrapped in markers.
function makeReadbackStdout(over = {}) {
  const obj = {
    schemaVersion: valueOr(over, "schemaVersion", 1),
    endpoint: valueOr(over, "endpoint", "8.8.8.8:51820"),
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
    host: "root@8.8.8.8",
    port: 22,
    authMethod: "key",
    identityFile: "/home/u/.ssh/id_ed25519",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
    ...over,
  };
}

function readbackContext(profile = {}, runtime = {}) {
  return {
    profile: keyProfile({ host: "root@8.8.8.8", ...profile }),
    runtime: { relayPort: 7891, ...runtime },
  };
}

// ── splitHost ──
test("splitHost splits user@host, defaults root", () => {
  assert.deepEqual(splitHost("bob@8.8.8.8"), ["bob", "8.8.8.8"]);
  assert.deepEqual(splitHost("8.8.8.8"), ["root", "8.8.8.8"]);
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
    ["endpoint without port", { endpoint: "8.8.8.8" }],
    ["public subnet", { subnet: "8.8.8.0/24" }],
    ["non-/24 subnet", { subnet: "10.8.0.0/16" }],
    ["public Relay URL", { relayUrl: "ws://8.8.8.8:7891" }],
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

test("parseReadback rejects adversarial WireGuard and Relay configurations", async (t) => {
  const endpoint51999 = "8.8.8.8:51999";
  const endpointOtherHost = "9.9.9.9:51820";
  const cases = [
    ["AllowedIPs also routes the public Internet", {
      pcConfig: wgConfig("10.8.0.2/32", { allowedIps: "10.8.0.0/24, 0.0.0.0/0" }),
    }],
    ["PC address is not subnet .2", { pcConfig: wgConfig("10.8.0.4/32") }],
    ["phone address is not subnet .3", { phoneConfig: wgConfig("10.8.0.4/32") }],
    ["Relay host is not subnet .1", { relayUrl: "ws://10.8.0.2:7891" }],
    ["Relay port differs from runtime", { relayUrl: "ws://10.8.0.1:7999" }],
    ["keepalive is not 25", { pcConfig: wgConfig("10.8.0.2/32", { keepalive: "20" }) }],
    ["unknown Interface directive", {
      pcConfig: wgConfig("10.8.0.2/32", { interfaceExtra: "PostUp = expose-secret" }),
    }],
    ["duplicate Interface directive", {
      pcConfig: wgConfig("10.8.0.2/32", { duplicatePrivateKey: true }),
    }],
    ["duplicate Peer section", {
      pcConfig: wgConfig("10.8.0.2/32", { duplicatePeerSection: true }),
    }],
    ["Relay and management tokens are identical", { managementToken: TOKEN_A }],
    ["Relay and management tokens differ only by hex case", {
      managementToken: TOKEN_A.toLowerCase(),
    }],
    ["private key is not 32 bytes", {
      pcConfig: wgConfig("10.8.0.2/32", { privateKey: Buffer.alloc(31, 1).toString("base64") }),
    }],
    ["server public key is malformed base64", {
      pcConfig: wgConfig("10.8.0.2/32", { publicKey: "!".repeat(44) }),
    }],
    ["PC and phone server public keys differ", {
      phoneConfig: wgConfig("10.8.0.3/32", { publicKey: OTHER_PUBLIC_KEY }),
    }],
    ["PC and phone private keys are identical", {
      phoneConfig: wgConfig("10.8.0.3/32", { privateKey: PC_PRIVATE_KEY }),
    }],
    ["endpoint port differs from profile WireGuard port", {
      endpoint: endpoint51999,
      pcConfig: wgConfig("10.8.0.2/32", { endpoint: endpoint51999 }),
      phoneConfig: wgConfig("10.8.0.3/32", { endpoint: endpoint51999 }),
    }],
    ["endpoint host differs from requested literal IP", {
      endpoint: endpointOtherHost,
      pcConfig: wgConfig("10.8.0.2/32", { endpoint: endpointOtherHost }),
      phoneConfig: wgConfig("10.8.0.3/32", { endpoint: endpointOtherHost }),
    }],
    ["readback subnet differs from profile subnet", {
      subnet: "10.9.0.0/24",
      relayUrl: "ws://10.9.0.1:7891",
      pcConfig: wgConfig("10.9.0.2/32", { allowedIps: "10.9.0.0/24" }),
      phoneConfig: wgConfig("10.9.0.3/32", { allowedIps: "10.9.0.0/24" }),
    }],
  ];

  for (const [name, over] of cases) {
    await t.test(name, () => {
      const result = parseReadback(makeReadbackStdout(over), readbackContext());
      assert.equal(result.ok, false);
      assert.match(result.message, /^Invalid readback: [A-Za-z]+ \(EX-12\)$/);
      assert.doesNotMatch(result.message, /expose-secret|PrivateKey|aAaA/);
    });
  }
});

test("parseReadback rejects non-global endpoint IP literals", async (t) => {
  const invalidHosts = [
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ];

  for (const host of invalidHosts) {
    await t.test(host, () => {
      const endpoint = host.includes(":") ? `[${host}]:51820` : `${host}:51820`;
      const result = parseReadback(makeReadbackStdout({
        endpoint,
        pcConfig: wgConfig("10.8.0.2/32", { endpoint }),
        phoneConfig: wgConfig("10.8.0.3/32", { endpoint }),
      }), readbackContext({ host: "relay.example.com", sshUsername: "deploy" }));
      assert.equal(result.ok, false);
      assert.equal(result.message, "Invalid readback: endpoint (EX-12)");
    });
  }
});

test("parseReadback rejects a non-global requested IP even when readback endpoint matches", async (t) => {
  for (const host of ["127.0.0.1", "203.0.113.10", "::ffff:127.0.0.1", "ff02::1"]) {
    await t.test(host, () => {
      const endpoint = host.includes(":") ? `[${host}]:51820` : `${host}:51820`;
      const result = parseReadback(makeReadbackStdout({
        endpoint,
        pcConfig: wgConfig("10.8.0.2/32", { endpoint }),
        phoneConfig: wgConfig("10.8.0.3/32", { endpoint }),
      }), readbackContext({ host, sshUsername: "deploy" }));
      assert.equal(result.ok, false);
      assert.equal(result.message, "Invalid readback: endpoint (EX-12)");
    });
  }
});

test("parseReadback accepts globally routable IPv4 and IPv6 endpoint literals", async (t) => {
  for (const [host, endpoint] of [
    ["8.8.4.4", "8.8.4.4:51820"],
    ["2606:4700:4700::1111", "[2606:4700:4700::1111]:51820"],
  ]) {
    await t.test(host, () => {
      const result = parseReadback(makeReadbackStdout({
        endpoint,
        pcConfig: wgConfig("10.8.0.2/32", { endpoint }),
        phoneConfig: wgConfig("10.8.0.3/32", { endpoint }),
      }), readbackContext({ host, sshUsername: "deploy" }));
      assert.equal(result.ok, true);
    });
  }
});

test("parseReadback requires the exact canonical WireGuard-internal Relay URL", async (t) => {
  const variants = [
    "ws://0x0a080001:7891",
    "ws://168296449:7891",
    "ws://user@10.8.0.1:7891",
    "ws://10.8.0.1:7891/",
    "ws://10.8.0.1:7891/path",
    "ws://10.8.0.1:7891?query=1",
    "ws://10.8.0.1:7891#fragment",
  ];
  for (const relayUrl of variants) {
    await t.test(relayUrl, () => {
      const result = parseReadback(makeReadbackStdout({ relayUrl }), readbackContext());
      assert.equal(result.ok, false);
      assert.equal(result.message, "Invalid readback: relayUrl (EX-12)");
    });
  }
});

test("parseReadback accepts a public endpoint for a requested domain and preserves mixed-case tokens", () => {
  const result = parseReadback(
    makeReadbackStdout(),
    readbackContext({ host: "relay.example.com", sshUsername: "deploy" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.readback.relayToken, TOKEN_A);
  assert.equal(result.readback.managementToken, TOKEN_B);
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
    runtimeModule: { buildSshArgs: () => ["-T", "root@8.8.8.8"] },
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

test("deploy preserves a bounded raw candidate when exit 0 readback fails strict validation", async () => {
  const invalidPhoneConfig = wgConfig("10.8.0.4/32");
  const deps = {
    scriptBody: "echo body",
    spawn: () => {},
    runtimeModule: { buildSshArgs: () => ["-T", "root@8.8.8.8"] },
    deployModule: {
      spawnAndWait: async () => ({
        code: 0,
        stdout: makeReadbackStdout({ phoneConfig: invalidPhoneConfig }),
        stderr: "",
      }),
    },
  };

  const result = await deploy({ profile: keyProfile(), deps });

  assert.equal(result.ok, false);
  assert.equal(result.remoteCommitted, true);
  assert.equal(result.rawReadback.phoneConfig, invalidPhoneConfig);
  assert.equal(result.message, "Invalid readback: phoneConfig (EX-12)");
});

test("deploy key path normalizes canonical SSH fields and preserves legacy host fields", async () => {
  const buildInputs = [];
  const deps = {
    scriptBody: "echo body",
    spawn: () => {},
    runtimeModule: {
      buildSshArgs: (profile) => {
        buildInputs.push(profile);
        return [profile.host];
      },
    },
    deployModule: {
      spawnAndWait: async (_spawn, _command, args) => {
        const endpoint = `${args[0].split("@").at(-1)}:51820`;
        return {
          code: 0,
          stdout: makeReadbackStdout({
            endpoint,
            pcConfig: wgConfig("10.8.0.2/32", { endpoint }),
            phoneConfig: wgConfig("10.8.0.3/32", { endpoint }),
          }),
          stderr: "",
        };
      },
    },
  };
  const canonical = keyProfile({
    host: "8.8.4.4",
    port: undefined,
    sshUsername: "deploy",
    sshPort: 2222,
  });
  const legacy = keyProfile({ host: "legacy@9.9.9.9", port: 2200 });

  assert.equal((await deploy({ profile: canonical, deps })).ok, true);
  assert.equal((await deploy({ profile: legacy, deps })).ok, true);
  assert.equal(buildInputs[0].host, "deploy@8.8.4.4");
  assert.equal(buildInputs[0].port, 2222);
  assert.equal(buildInputs[1].host, "legacy@9.9.9.9");
  assert.equal(buildInputs[1].port, 2200);
});

test("deploy propagates AbortSignal through password SSH and returns stable deploy_aborted", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const pending = deploy({
    profile: { ...keyProfile(), authMethod: "password" },
    password: "secret",
    runtime: {},
    deps: {
      signal: controller.signal,
      runtime: new EventEmitter(),
      bundleModule: { buildRelayBundleManifest: () => [{ remotePath: "installer", contents: Buffer.from("x") }] },
      ssh2Module: {
        deployBundle(args) {
          receivedSignal = args.signal;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("AbortSignal missing")), 100);
            if (args.signal) args.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              const error = new Error("aborted");
              error.code = "SSH_ABORTED";
              error.reason = "aborted";
              reject(error);
            }, { once: true });
          });
        },
      },
    },
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.code === "deploy_aborted");
  assert.equal(receivedSignal, controller.signal);
});

test("deploy propagates AbortSignal to key child transport", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const pending = deploy({
    profile: keyProfile(),
    runtime: {},
    deps: {
      signal: controller.signal,
      runtime: new EventEmitter(),
      scriptBody: "echo test",
      runtimeModule: { buildSshArgs: () => [] },
      deployModule: {
        spawnAndWait(_spawn, _command, _args, options) {
          receivedSignal = options.signal;
          return new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ code: -1, stdout: "", stderr: "missing", spawnError: true }), 100);
            if (options.signal) options.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "", aborted: true });
            }, { once: true });
          });
        },
      },
    },
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.code === "deploy_aborted");
  assert.equal(receivedSignal, controller.signal);
});

test("deploy maps non-zero exit code via EXIT_CODE_MAP", async () => {
  const emitter = fakeEmitter();
  const deps = {
    scriptBody: "echo body",
    spawn: () => {},
    runtimeModule: { buildSshArgs: () => ["root@8.8.8.8"] },
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
  assert.equal(deployArgs.host, "8.8.8.8");
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

test("deploy maps stable transport codes to distinct safe reasons", async (t) => {
  const cases = [
    ["HOST_KEY_CHANGED", "host_key_changed", "wgErrHostKeyChanged"],
    ["HOST_KEY_UNCONFIRMED", "host_key_unconfirmed", "wgErrHostKeyUnconfirmed"],
    ["HOST_KEY_CONFIRMATION_FAILED", "host_key_confirmation_failed", "wgErrHostKeyConfirmationFailed"],
    ["OUTPUT_LIMIT", "output_limit", "wgErrOutputLimit"],
  ];
  for (const [code, reason, hint] of cases) {
    await t.test(code, async () => {
      const secretDetail = "never-return-transport-detail";
      const error = new Error(secretDetail);
      error.code = code;
      const result = await deploy({
        profile: keyProfile({ authMethod: "password", identityFile: undefined }),
        password: "pw",
        deps: {
          bundleModule: { buildRelayBundleManifest: () => [{ remotePath: "install-wg-relay.sh" }] },
          ssh2Module: { deployBundle: async () => { throw error; } },
          confirmHostKey: () => true,
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      assert.equal(result.hint, hint);
      assert.doesNotMatch(JSON.stringify(result), /never-return-transport-detail/);
    });
  }
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

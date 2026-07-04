"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  bringUp,
  bringDown,
  status,
  resolveWgGoPath,
  resolveWgToolPath,
  parseAddress,
  parseAllowedSubnet,
  toSetconf,
  directRunner,
  LINUX_UP_SCRIPT,
  LINUX_DOWN_SCRIPT,
} = require("../src/wg-pc-tunnel");

const PC_CONF = `[Interface]
PrivateKey = SECRETPCPRIVKEY=
Address = 10.8.0.2/32
DNS = 1.1.1.1
MTU = 1420

[Peer]
PublicKey = SRVPUB=
Endpoint = 1.2.3.4:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25`;

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

test("parseAddress reads [Interface] Address", () => {
  assert.equal(parseAddress(PC_CONF), "10.8.0.2/32");
  assert.equal(parseAddress("no address here"), null);
});

test("parseAllowedSubnet reads [Peer] AllowedIPs", () => {
  assert.equal(parseAllowedSubnet(PC_CONF), "10.8.0.0/24");
  assert.equal(parseAllowedSubnet("nothing"), null);
});

test("toSetconf strips wg-quick-only keys but keeps PrivateKey + [Peer]", () => {
  const out = toSetconf(PC_CONF);
  assert.match(out, /\[Interface\]/);
  assert.match(out, /PrivateKey = SECRETPCPRIVKEY=/);
  assert.match(out, /\[Peer\]/);
  assert.match(out, /PublicKey = SRVPUB=/);
  assert.match(out, /Endpoint = 1\.2\.3\.4:51820/);
  assert.doesNotMatch(out, /Address =/);
  assert.doesNotMatch(out, /DNS =/);
  assert.doesNotMatch(out, /MTU =/);
});

test("resolveWgGoPath honors override + platform", () => {
  assert.equal(resolveWgGoPath({ wgGoPath: "/x/wg" }), "/x/wg");
  assert.match(resolveWgGoPath({ platform: "win32", resourcesPath: "/r" }), /wg-bin[\\/]win32[\\/]wireguard\.exe$/);
  assert.match(resolveWgGoPath({ platform: "linux", resourcesPath: "/r" }), /wg-bin[\\/]linux[\\/]wireguard-go$/);
});

test("resolveWgToolPath honors override + platform", () => {
  assert.equal(resolveWgToolPath({ wgToolPath: "/x/wg" }), "/x/wg");
  assert.match(resolveWgToolPath({ platform: "linux", resourcesPath: "/r" }), /wg-bin[\\/]linux[\\/]wg$/);
  assert.equal(resolveWgToolPath({}), "wg");
});

test("bringUp runs ONE escalated batch and passes the conf via stdin (D-UX/SEC-3)", async () => {
  const seen = [];
  const escalator = async ({ argv, stdin }) => {
    seen.push({ argv, stdin });
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const lines = [];
  const r = await bringUp({
    pcConf: PC_CONF,
    ifName: "clawd0",
    privilegeEscalator: escalator,
    onProgress: (l) => lines.push(l),
    deps: { wgGoPath: "/bundled/wireguard-go", wgToolPath: "/bundled/wg" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.address, "10.8.0.2/32");
  assert.equal(r.subnet, "10.8.0.0/24");
  assert.equal(seen.length, 1);
  const { argv, stdin } = seen[0];
  assert.equal(argv[0], "/bin/sh");
  assert.equal(argv[1], "-c");
  assert.deepEqual(argv.slice(3), ["clawd-wg-up", "/bundled/wireguard-go", "clawd0", "10.8.0.2/32", "10.8.0.0/24", "/bundled/wg"]);
  assert.match(stdin, /PrivateKey = SECRETPCPRIVKEY=/);
  assert.ok(!argv.join(" ").includes("SECRETPCPRIVKEY"));
  assert.ok(lines.includes("[wg-pc] step: ready"));
});

test("LINUX_UP_SCRIPT assigns address, brings link up, adds route, setconf from stdin", () => {
  assert.match(LINUX_UP_SCRIPT, /setconf .* \/dev\/stdin/);
  assert.match(LINUX_UP_SCRIPT, /ip address add/);
  assert.match(LINUX_UP_SCRIPT, /ip link set up/);
  assert.match(LINUX_UP_SCRIPT, /ip route add/);
});

test("bringUp without an escalator uses directRunner and really spawns /bin/sh", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const r = await bringUp({
    pcConf: PC_CONF,
    deps: { spawn, wgGoPath: "/bundled/wireguard-go", wgToolPath: "/bundled/wg" },
  });
  assert.equal(r.ok, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, "/bin/sh");
  assert.match(spawn.calls[0].stdin, /PrivateKey/);
});

test("bringUp maps privilege denial to EX-10 privilegeDenied", async () => {
  const escalator = async () => ({ ok: false, code: 126, denied: true, stderr: "dismissed" });
  const r = await bringUp({ pcConf: PC_CONF, privilegeEscalator: escalator, deps: { wgGoPath: "/b/wg" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "privilegeDenied");
  assert.match(r.message, /EX-10/);
});

test("bringUp maps missing bundled runtime (exit 91) to noBinary", async () => {
  const escalator = async () => ({ ok: false, code: 91, stderr: "" });
  const r = await bringUp({ pcConf: PC_CONF, privilegeEscalator: escalator, deps: { wgGoPath: "/missing/wg" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "noBinary");
});

test("bringUp maps iface create failure (exit 92) to ifaceUp", async () => {
  const escalator = async () => ({ ok: false, code: 92, stderr: "cannot create tun" });
  const r = await bringUp({ pcConf: PC_CONF, privilegeEscalator: escalator, deps: { wgGoPath: "/b/wg" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ifaceUp");
});

test("bringUp maps setconf failure (exit 93) to setconf", async () => {
  const escalator = async () => ({ ok: false, code: 93, stderr: "" });
  const r = await bringUp({ pcConf: PC_CONF, privilegeEscalator: escalator, deps: { wgGoPath: "/b/wg" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "setconf");
});

test("bringUp maps address-assign failure (exit 94) to ifaceUp", async () => {
  const escalator = async () => ({ ok: false, code: 94, stderr: "" });
  const r = await bringUp({ pcConf: PC_CONF, privilegeEscalator: escalator, deps: { wgGoPath: "/b/wg" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ifaceUp");
});

test("bringUp rejects malformed conf before escalating", async () => {
  let escalated = false;
  const r = await bringUp({
    pcConf: "garbage",
    privilegeEscalator: async () => { escalated = true; return { ok: true, code: 0 }; },
    deps: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "badConf");
  assert.equal(escalated, false);
});

test("private key never appears in emitted progress lines (SEC-3)", async () => {
  const lines = [];
  await bringUp({
    pcConf: PC_CONF,
    privilegeEscalator: async () => ({ ok: true, code: 0 }),
    onProgress: (l) => lines.push(l),
    deps: { wgGoPath: "/b/wg", wgToolPath: "/b/wg" },
  });
  for (const l of lines) assert.ok(!/SECRETPCPRIVKEY/.test(l), `leak in: ${l}`);
});

test("bringDown deletes the interface via one escalated batch", async () => {
  const seen = [];
  const escalator = async ({ argv }) => { seen.push(argv); return { ok: true, code: 0 }; };
  const r = await bringDown({ ifName: "clawd0", privilegeEscalator: escalator });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.match(LINUX_DOWN_SCRIPT, /ip link del/);
  assert.deepEqual(seen[0].slice(3), ["clawd-wg-down", "clawd0"]);
});

test("bringDown returns ok:false when escalation fails", async () => {
  const r = await bringDown({ privilegeEscalator: async () => ({ ok: false, code: 1 }) });
  assert.equal(r.ok, false);
});

test("status reports up via `ip link show` when interface is not DOWN", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0, stdout: "5: clawd0: <POINTOPOINT,UP> state UNKNOWN" }));
  const r = await status({ ifName: "clawd0", deps: { spawn } });
  assert.equal(r.up, true);
  assert.equal(spawn.calls[0].cmd, "ip");
});

test("status reports down when interface is DOWN", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0, stdout: "5: clawd0: <BROADCAST> state DOWN" }));
  const r = await status({ deps: { spawn } });
  assert.equal(r.up, false);
});

test("status reports down when `ip link show` fails (no such iface)", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 1 }));
  const r = await status({ deps: { spawn } });
  assert.equal(r.up, false);
});

test("directRunner runs argv[0] with the rest as args and forwards stdin", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const run = directRunner(spawn);
  const r = await run({ argv: ["/bin/sh", "-c", "echo hi"], stdin: "payload" });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(spawn.calls[0].cmd, "/bin/sh");
  assert.deepEqual(spawn.calls[0].args, ["-c", "echo hi"]);
  assert.equal(spawn.calls[0].stdin, "payload");
});

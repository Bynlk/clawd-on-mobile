"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  bringUp,
  bringDown,
  status,
  resolveWgGoPath,
  parseAddress,
} = require("../src/wg-pc-tunnel");

const PC_CONF = `[Interface]
PrivateKey = SECRETPCPRIVKEY=
Address = 10.8.0.2/32

[Peer]
PublicKey = SRVPUB=
Endpoint = 1.2.3.4:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25`;

// Fake spawn: scripts exit codes per command; records invocations + stdin.
function makeFakeSpawn(script) {
  const calls = [];
  function fakeSpawn(cmd, args) {
    const key = `${cmd} ${(args || []).join(" ")}`;
    const rule = script(cmd, args) || { code: 0, stderr: "", stdout: "" };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdinData = "";
    child.stdin = { end: (d) => { stdinData = d || ""; child._stdin = stdinData; } };
    calls.push({ cmd, args, key, get stdin() { return child._stdin; } });
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

test("resolveWgGoPath honors override + platform", () => {
  assert.equal(resolveWgGoPath({ wgGoPath: "/x/wg" }), "/x/wg");
  assert.match(resolveWgGoPath({ platform: "win32", resourcesPath: "/r" }), /wg-bin[\\/]win32[\\/]wireguard\.exe$/);
  assert.match(resolveWgGoPath({ platform: "darwin", resourcesPath: "/r" }), /wg-bin[\\/]darwin[\\/]wireguard-go$/);
});

test("bringUp succeeds: escalate → iface up → setconf", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  let setconfConf = null;
  const lines = [];
  const r = await bringUp({
    pcConf: PC_CONF,
    privilegeEscalator: async () => true,
    onProgress: (l) => lines.push(l),
    deps: {
      spawn,
      wgGoPath: "/bundled/wireguard-go",
      setConf: async ({ pcConf }) => { setconfConf = pcConf; return { code: 0 }; },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.address, "10.8.0.2/32");
  assert.ok(lines.includes("[wg-pc] step: ready"));
  // conf passed to setConf in-memory (SEC-3), not written to a file path.
  assert.equal(setconfConf, PC_CONF);
});

test("bringUp fails EX-10 when privilege denied", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const r = await bringUp({
    pcConf: PC_CONF,
    privilegeEscalator: async () => false,
    deps: { spawn, wgGoPath: "/bundled/wg" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "privilegeDenied");
  assert.match(r.message, /EX-10/);
});

test("bringUp rejects malformed conf", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const r = await bringUp({ pcConf: "garbage", privilegeEscalator: async () => true, deps: { spawn } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "badConf");
});

test("bringUp maps iface-up failure", async () => {
  const spawn = makeFakeSpawn((cmd) => {
    if (String(cmd).includes("wireguard")) return { code: 1, stderr: "cannot create tun" };
    return { code: 0 };
  });
  const r = await bringUp({
    pcConf: PC_CONF,
    privilegeEscalator: async () => true,
    deps: { spawn, wgGoPath: "/bundled/wireguard-go" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ifaceUp");
});

test("bringUp maps setconf failure", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const r = await bringUp({
    pcConf: PC_CONF,
    privilegeEscalator: async () => true,
    deps: { spawn, wgGoPath: "/bundled/wg", setConf: async () => ({ code: 1 }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "setconf");
});

test("private key never appears in emitted progress lines (SEC-3)", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const lines = [];
  await bringUp({
    pcConf: PC_CONF,
    privilegeEscalator: async () => true,
    onProgress: (l) => lines.push(l),
    deps: { spawn, wgGoPath: "/bundled/wg", setConf: async () => ({ code: 0 }) },
  });
  for (const l of lines) assert.ok(!/SECRETPCPRIVKEY/.test(l), `leak in: ${l}`);
});

test("bringDown returns ok on exit 0", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0 }));
  const r = await bringDown({ deps: { spawn } });
  assert.equal(r.ok, true);
});

test("status parses latest-handshakes", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 0, stdout: "PUBKEY1\t1700000000\n" }));
  const r = await status({ deps: { spawn } });
  assert.equal(r.up, true);
  assert.equal(r.peers, 1);
  assert.equal(r.handshakeAt, 1700000000);
});

test("status reports down when wg show fails", async () => {
  const spawn = makeFakeSpawn(() => ({ code: 1 }));
  const r = await status({ deps: { spawn } });
  assert.equal(r.up, false);
});

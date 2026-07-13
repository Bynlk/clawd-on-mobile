"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { spawn } = require("node:child_process");

const RELAY_SERVER_PATH = path.join(__dirname, "..", "relay", "relay-server.js");
const RELAY_SERVER_SOURCE = fs.readFileSync(RELAY_SERVER_PATH, "utf8");
const RELAY_TOKEN = "11".repeat(32);
const NEXT_RELAY_TOKEN = "66".repeat(32);
const MANAGEMENT_TOKEN = "aa".repeat(32);
const OLD_PHONE_PRIVATE = Buffer.alloc(32, 1).toString("base64");
const OLD_PHONE_PUBLIC = Buffer.alloc(32, 2).toString("base64");
const NEW_PHONE_PRIVATE = Buffer.alloc(32, 3).toString("base64");
const NEW_PHONE_PUBLIC = Buffer.alloc(32, 4).toString("base64");
const SERVER_PUBLIC = Buffer.alloc(32, 5).toString("base64");
const INNER_PROTOCOL_MAX = 64 * 1024;

function exactJsonBytes(size) {
  const prefix = '{"type":"size_probe","padding":"';
  const suffix = '"}';
  const value = `${prefix}${"x".repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
  assert.equal(Buffer.byteLength(value), size);
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadCreateRelayServer() {
  assert.match(RELAY_SERVER_SOURCE, /createRelayServer/, "relay server must expose a factory");
  const { createRelayServer } = require(RELAY_SERVER_PATH);
  assert.equal(typeof createRelayServer, "function");
  return createRelayServer;
}

async function startRelay(t, overrides = {}) {
  const createRelayServer = loadCreateRelayServer();
  const relay = createRelayServer({
    bindAddr: "127.0.0.1",
    port: 0,
    tokenStore: overrides.tokenStore || { current: () => RELAY_TOKEN },
    management: overrides.management || null,
    log() {},
    now: overrides.now,
    remoteAddressOf: overrides.remoteAddressOf,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs,
    requestDeadlineMs: overrides.requestDeadlineMs,
    closeDeadlineMs: overrides.closeDeadlineMs,
    rateLimitAttempts: overrides.rateLimitAttempts,
    preAuthRateLimitAttempts: overrides.preAuthRateLimitAttempts,
    preAuthRateLimitWindowMs: overrides.preAuthRateLimitWindowMs,
  });
  await relay.listen();
  t.after(() => Promise.race([
    relay.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]));
  return relay;
}

function request(relay, { method = "GET", pathname, headers = {}, body = "", signal }) {
  const address = relay.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      method,
      path: pathname,
      headers,
      signal,
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

function loadManagementModules() {
  const { createDirectoryLock, createFlockLock, createRelayTokenStore } = require("../relay/relay-token-store");
  const { createWgManagement } = require("../relay/wg-management");
  return { createDirectoryLock, createFlockLock, createRelayTokenStore, createWgManagement };
}

function createFlockShim(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-flock-shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = path.join(dir, "flock");
  fs.writeFileSync(command, `#!/usr/bin/env python3
import errno, fcntl, os, subprocess, sys, time
args = sys.argv[1:]
timeout = 0.0
if args[:1] == ["-x"]: args = args[1:]
if args[:1] == ["-w"]:
    timeout = float(args[1]); args = args[2:]
lock_path = args[0]
command = args[1:]
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
deadline = time.monotonic() + timeout
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EAGAIN) or time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.005)
result = subprocess.run(command, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr, close_fds=True)
sys.exit(result.returncode)
`, { mode: 0o755 });
  return command;
}

function directoryFsyncFailingFs(directory, failures) {
  const descriptors = new Map();
  let remaining = failures;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (...args) => {
          const descriptor = target.openSync(...args);
          descriptors.set(descriptor, path.resolve(String(args[0])));
          return descriptor;
        };
      }
      if (property === "closeSync") {
        return (descriptor) => {
          descriptors.delete(descriptor);
          return target.closeSync(descriptor);
        };
      }
      if (property === "fsyncSync") {
        return (descriptor) => {
          if (descriptors.get(descriptor) === path.resolve(directory) && remaining > 0) {
            remaining--;
            const error = new Error("injected parent fsync failure");
            error.code = "EIO";
            throw error;
          }
          return target.fsyncSync(descriptor);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function oldWgConfig() {
  return `[Interface]\nAddress = 10.8.0.1/24\nPrivateKey = server-private\n\n` +
    `[Peer]\n# pc\nPublicKey = ${Buffer.alloc(32, 6).toString("base64")}\nAllowedIPs = 10.8.0.2/32\n\n` +
    `[Peer]\n# phone\nPublicKey = ${OLD_PHONE_PUBLIC}\nAllowedIPs = 10.8.0.3/32\n`;
}

function createManagementFixture(t, options = {}) {
  const { createWgManagement } = loadManagementModules();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wg-management-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    wgConfigPath: path.join(dir, "clawd.conf"),
    phonePrivateKeyPath: path.join(dir, "phone.key"),
    phonePublicKeyPath: path.join(dir, "phone.pub"),
    serverPublicKeyPath: path.join(dir, "server.pub"),
  };
  const oldFiles = {
    [paths.wgConfigPath]: oldWgConfig(),
    [paths.phonePrivateKeyPath]: `${OLD_PHONE_PRIVATE}\n`,
    [paths.phonePublicKeyPath]: `${OLD_PHONE_PUBLIC}\n`,
    [paths.serverPublicKeyPath]: `${SERVER_PUBLIC}\n`,
  };
  for (const [file, contents] of Object.entries(oldFiles)) fs.writeFileSync(file, contents, { mode: 0o600 });

  const calls = [];
  let activeToken = RELAY_TOKEN;
  const tokenStore = options.tokenStore || {
    current: () => activeToken,
    managementToken: () => MANAGEMENT_TOKEN,
    rotate(next) {
      calls.push("persist-token");
      activeToken = next;
      if (options.failAt === "token") throw new Error("token persistence failed");
    },
    restore(previous) {
      calls.push("restore-token");
      activeToken = previous;
    },
    reload() { return activeToken; },
  };
  const pairs = {
    closeToken(token, code) {
      calls.push("close-old");
      assert.equal(token, RELAY_TOKEN);
      assert.equal(code, 4003);
      return true;
    },
  };
  let persistedRecorded = false;
  const tracedFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (from, to) => {
          if (!persistedRecorded && to === paths.wgConfigPath) {
            calls.push("persist-wg");
            persistedRecorded = true;
          }
          if (options.failAt === "persist" && to === paths.phonePublicKeyPath && !String(from).includes("rollback")) {
            throw new Error("file persistence failed");
          }
          if (options.failRollbackFile && String(from).includes("rollback") && !options.rollbackFileFailed) {
            options.rollbackFileFailed = true;
            throw new Error("rollback file failed");
          }
          return target.renameSync(from, to);
        };
      }
      return target[property].bind ? target[property].bind(target) : target[property];
    },
  });
  let liveCalls = 0;
  const command = async (file, args) => {
    assert.equal(file, "wg");
    liveCalls++;
    calls.push(liveCalls === 1 ? "apply-live" : "restore-live");
    if (options.failAt === "apply" && liveCalls === 1) throw new Error("live apply failed");
    if (options.failRollbackLive && liveCalls === 2) throw new Error("live rollback failed");
    return { stdout: "" };
  };
  let verifyCalls = 0;
  const verifyLivePeer = async () => {
    verifyCalls++;
    calls.push("verify-live");
    return !(options.failVerificationAlways || (options.failVerificationOnce && verifyCalls === 1));
  };
  const transactionLock = options.lock || {
    async runExclusive(operation) { return operation(); },
  };
  const management = createWgManagement({
    fs: tracedFs,
    command,
    generateKeyPair: async () => {
      calls.push("generate");
      if (options.failAt === "generate") throw new Error("generation failed");
      return { privateKey: NEW_PHONE_PRIVATE, publicKey: NEW_PHONE_PUBLIC };
    },
    generateRelayToken: () => NEXT_RELAY_TOKEN,
    tokenStore,
    pairs,
    lock: transactionLock,
    verifyLivePeer,
    commandTimeoutMs: options.commandTimeoutMs,
    paths,
    wgInterface: "clawd",
    pcIp: "10.8.0.2",
    phoneIp: "10.8.0.3",
    subnet: "10.8.0.0/24",
    endpoint: "203.0.113.10:51820",
  });
  return { management, tokenStore, pairs, paths, oldFiles, calls, currentToken: () => activeToken };
}

function createConcurrentManagementFixture(t, { failFirst = false } = {}) {
  const { createWgManagement } = loadManagementModules();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wg-management-concurrent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    wgConfigPath: path.join(dir, "clawd.conf"),
    phonePrivateKeyPath: path.join(dir, "phone.key"),
    phonePublicKeyPath: path.join(dir, "phone.pub"),
    serverPublicKeyPath: path.join(dir, "server.pub"),
  };
  fs.writeFileSync(paths.wgConfigPath, oldWgConfig(), { mode: 0o600 });
  fs.writeFileSync(paths.phonePrivateKeyPath, `${OLD_PHONE_PRIVATE}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.phonePublicKeyPath, `${OLD_PHONE_PUBLIC}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.serverPublicKeyPath, `${SERVER_PUBLIC}\n`, { mode: 0o600 });

  const keyPairs = [
    {
      privateKey: Buffer.alloc(32, 7).toString("base64"),
      publicKey: Buffer.alloc(32, 8).toString("base64"),
    },
    {
      privateKey: Buffer.alloc(32, 9).toString("base64"),
      publicKey: Buffer.alloc(32, 10).toString("base64"),
    },
  ];
  const relayTokens = ["77".repeat(32), "88".repeat(32)];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const calls = [];
  const applyArgs = [];
  const closedTokens = [];
  const activeConnections = new Set([RELAY_TOKEN]);
  let generationIndex = 0;
  let relayTokenIndex = 0;
  let activeToken = RELAY_TOKEN;
  const tokenStore = {
    current: () => activeToken,
    managementToken: () => MANAGEMENT_TOKEN,
    rotate(next) {
      activeToken = next;
      activeConnections.add(next);
    },
    restore(previous) { activeToken = previous; },
  };
  const pairs = {
    closeToken(token) {
      closedTokens.push(token);
      activeConnections.delete(token);
      return true;
    },
  };
  const management = createWgManagement({
    fs,
    command: async (_file, args) => {
      calls.push(`apply-${applyArgs.length + 1}`);
      applyArgs.push(args);
      return { stdout: "" };
    },
    generateKeyPair: async () => {
      const index = generationIndex++;
      calls.push(`generate-${index + 1}`);
      if (index === 0) {
        firstStarted.resolve();
        await releaseFirst.promise;
        if (failFirst) throw new Error("first generation failed");
      }
      return keyPairs[index];
    },
    generateRelayToken: () => relayTokens[relayTokenIndex++],
    tokenStore,
    pairs,
    paths,
    wgInterface: "clawd",
    pcIp: "10.8.0.2",
    phoneIp: "10.8.0.3",
    subnet: "10.8.0.0/24",
    endpoint: "203.0.113.10:51820",
  });
  const context = {
    remoteAddress: "10.8.0.2",
    authorization: `Bearer ${MANAGEMENT_TOKEN}`,
    body: { version: 1 },
  };
  return {
    management, context, firstStarted, releaseFirst, calls, applyArgs,
    closedTokens, activeConnections, keyPairs, relayTokens,
  };
}

function connect(relay, role, token, { pathname = "/mobile/ws", headers: extraHeaders = {} } = {}) {
  const { port } = relay.address();
  const headers = { ...extraHeaders };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new WebSocket(`ws://127.0.0.1:${port}${pathname}?role=${role}`, { headers });
}

function rejectedUpgrade(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upgrade rejection timeout")), 1000);
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    ws.once("open", () => reject(new Error("unexpected 101 upgrade")));
    ws.once("error", () => {});
  });
}

function opened(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function closed(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timeout")), 1000);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
    ws.once("error", () => {});
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), 1000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
}

async function nextJsonMessageOfType(ws, type) {
  for (;;) {
    const message = JSON.parse(await nextMessage(ws));
    if (message.type === type) return message;
  }
}

describe("Relay strict authentication and single-phone pairing", () => {
  it("rejects a missing Bearer before WebSocket upgrade with HTTP 401", async (t) => {
    const relay = await startRelay(t);
    const ws = connect(relay, "pc");
    assert.equal(await rejectedUpgrade(ws), 401);
  });

  it("rejects a wrong Bearer before WebSocket upgrade with HTTP 401", async (t) => {
    const relay = await startRelay(t);
    const ws = connect(relay, "phone", "22".repeat(32));
    assert.equal(await rejectedUpgrade(ws), 401);
  });

  it("rate-limits repeated wrong Bearers per source before upgrade without consuming valid capacity", async (t) => {
    let timestamp = 0;
    const relay = await startRelay(t, {
      now: () => timestamp,
      preAuthRateLimitAttempts: 2,
      preAuthRateLimitWindowMs: 1000,
      remoteAddressOf: (req) => req.headers["x-test-source"] || "unknown",
    });
    const wrong = () => connect(relay, "phone", "22".repeat(32), {
      headers: { "X-Test-Source": "attacker" },
    });
    assert.equal(await rejectedUpgrade(wrong()), 401);
    assert.equal(await rejectedUpgrade(wrong()), 401);
    assert.equal(await rejectedUpgrade(wrong()), 429);

    const valid = connect(relay, "phone", RELAY_TOKEN, {
      headers: { "X-Test-Source": "attacker" },
    });
    t.after(() => valid.close());
    await opened(valid);
    assert.equal(valid.readyState, WebSocket.OPEN);

    timestamp = 1001;
    assert.equal(await rejectedUpgrade(wrong()), 401);
  });

  it("rejects path/role with 403 and rate-limits each source independently before upgrade", async (t) => {
    const relay = await startRelay(t, {
      rateLimitAttempts: 2,
      remoteAddressOf: (req) => req.headers["x-test-source"] || "unknown",
    });
    assert.equal(await rejectedUpgrade(connect(relay, "admin", RELAY_TOKEN)), 403);
    assert.equal(await rejectedUpgrade(connect(relay, "pc", RELAY_TOKEN, { pathname: "/public" })), 403);

    const first = connect(relay, "pc", RELAY_TOKEN, { headers: { "X-Test-Source": "source-a" } });
    const second = connect(relay, "phone", RELAY_TOKEN, { headers: { "X-Test-Source": "source-a" } });
    t.after(() => { first.close(); second.close(); });
    await Promise.all([opened(first), opened(second)]);
    const limited = connect(relay, "pc", RELAY_TOKEN, { headers: { "X-Test-Source": "source-a" } });
    assert.equal(await rejectedUpgrade(limited), 429);
    const otherSource = connect(relay, "pc", RELAY_TOKEN, { headers: { "X-Test-Source": "source-b" } });
    t.after(() => otherSource.close());
    await opened(otherSource);
    assert.equal(otherSource.readyState, WebSocket.OPEN);
  });

  it("pairs exactly one authenticated PC and one authenticated phone", async (t) => {
    const relay = await startRelay(t);
    const pc = connect(relay, "pc", RELAY_TOKEN);
    const phone = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => { pc.close(); phone.close(); });
    await Promise.all([opened(pc), opened(phone)]);

    const pair = relay.pairs.get(RELAY_TOKEN);
    assert.equal(pair.pc.readyState, WebSocket.OPEN);
    assert.equal(pair.phone.readyState, WebSocket.OPEN);
    assert.notEqual(pair.pc, pair.phone);
    assert.deepEqual(relay.pairs.countConnections(), { pc: 1, phone: 1 });
  });

  it("closes the prior phone when an authenticated replacement connects", async (t) => {
    const relay = await startRelay(t);
    const first = connect(relay, "phone", RELAY_TOKEN);
    await opened(first);
    const firstClosed = closed(first);

    const replacement = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => replacement.close());
    await opened(replacement);

    assert.notEqual((await firstClosed).code, 1000);
    assert.equal(relay.pairs.get(RELAY_TOKEN).phone.readyState, WebSocket.OPEN);
    assert.deepEqual(relay.pairs.countConnections(), { pc: 0, phone: 1 });
  });

  it("does not emit peer_disconnected when a replaced phone closes after its replacement is current", async (t) => {
    const relay = await startRelay(t);
    const pc = connect(relay, "pc", RELAY_TOKEN);
    const first = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => { pc.close(); first.close(); });
    await Promise.all([opened(pc), opened(first)]);
    const messages = [];
    pc.on("message", (data) => messages.push(JSON.parse(String(data))));

    const firstClosed = closed(first);
    const replacement = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => replacement.close());
    await opened(replacement);
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(messages.some((message) => message.type === "peer_disconnected"), false);
    assert.equal(relay.pairs.get(RELAY_TOKEN).phone.readyState, WebSocket.OPEN);
  });

  it("sends application JSON heartbeats and keeps an idle client alive across three intervals", async (t) => {
    const relay = await startRelay(t, { heartbeatIntervalMs: 10 });
    const phone = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => phone.close());
    await opened(phone);
    let heartbeats = 0;
    let protocolPings = 0;
    phone.on("ping", () => { protocolPings++; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("heartbeat timeout")), 500);
      phone.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type !== "ping") return;
        assert.equal(typeof message.timestamp, "number");
        heartbeats++;
        if (heartbeats >= 3) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    assert.equal(phone.readyState, WebSocket.OPEN);
    assert.equal(protocolPings, 0);
  });

  it("forwards payloads through the managed-session envelope without retaining them", async (t) => {
    const relay = await startRelay(t);
    const pc = connect(relay, "pc", RELAY_TOKEN);
    const phone = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => { pc.close(); phone.close(); });
    await Promise.all([opened(pc), opened(phone)]);

    const inbound = nextJsonMessageOfType(pc, "relay_forward");
    phone.send("secret-payload-never-persisted");
    const envelope = await inbound;

    assert.equal(envelope.payload, "secret-payload-never-persisted");
    const pair = relay.pairs.get(RELAY_TOKEN);
    assert.deepEqual(Object.keys(pair).sort(), ["pc", "phone"]);
    assert.doesNotMatch(JSON.stringify([...relay.pairs.pairs.values()].map(Object.keys)), /secret-payload/);
  });

  it("accepts a targeted PC relay envelope carrying exactly 65536 inner bytes", async (t) => {
    const relay = await startRelay(t);
    const pc = connect(relay, "pc", RELAY_TOKEN);
    const phone = connect(relay, "phone", RELAY_TOKEN);
    t.after(() => { pc.close(); phone.close(); });
    await Promise.all([opened(pc), opened(phone)]);
    const source = nextJsonMessageOfType(pc, "relay_forward");
    phone.send('{"type":"source_probe"}');
    const sourceClientId = (await source).sourceClientId;
    const exact = exactJsonBytes(INNER_PROTOCOL_MAX);
    const delivered = nextMessage(phone);

    pc.send(JSON.stringify({ type: "relay_forward", targetClientId: sourceClientId, payload: exact }));

    assert.equal(await delivered, exact);
    assert.equal(pc.readyState, WebSocket.OPEN);
  });
});

describe("Relay token store", () => {
  it("preserves mixed-case token bytes for exact Bearer authentication", (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-case-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    const mixedRelayToken = "aA".repeat(32);
    const mixedManagementToken = "bB".repeat(32);
    fs.writeFileSync(envPath,
      `RELAY_TOKEN=${mixedRelayToken}\nMANAGEMENT_TOKEN=${mixedManagementToken}\n`,
      { mode: 0o600 });

    const store = createRelayTokenStore({ envPath });
    assert.equal(store.current(), mixedRelayToken);
    assert.equal(store.managementToken(), mixedManagementToken);
  });

  it("atomically updates relay.env as 0600 while preserving management and runtime fields", async (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-store-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    fs.writeFileSync(envPath,
      `RELAY_TOKEN=${RELAY_TOKEN}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n` +
      "BIND_ADDR=10.8.0.1\nPC_IP=10.8.0.2\nPHONE_IP=10.8.0.3\nPORT=7891\n",
      { mode: 0o600 });
    const operations = [];
    const tracedFs = new Proxy(fs, {
      get(target, property) {
        const value = target[property];
        if (["openSync", "writeFileSync", "chmodSync", "fsyncSync", "closeSync", "renameSync"].includes(property)) {
          return (...args) => {
            operations.push(property);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const { createFlockLock } = loadManagementModules();
    const lock = createFlockLock({
      lockPath: path.join(dir, "clawd-relay.lock"),
      flockCommand: createFlockShim(t),
    });
    const store = createRelayTokenStore({ envPath, fs: tracedFs, lock });
    await store.rotate(NEXT_RELAY_TOKEN, RELAY_TOKEN);

    assert.equal(store.current(), NEXT_RELAY_TOKEN);
    assert.equal(store.managementToken(), MANAGEMENT_TOKEN);
    const persisted = fs.readFileSync(envPath, "utf8");
    assert.match(persisted, new RegExp(`RELAY_TOKEN=${NEXT_RELAY_TOKEN}`));
    assert.match(persisted, new RegExp(`MANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}`));
    assert.match(persisted, /BIND_ADDR=10\.8\.0\.1/);
    assert.match(persisted, /PC_IP=10\.8\.0\.2/);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.ok(operations.indexOf("fsyncSync") < operations.indexOf("renameSync"));
    assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp")), false);
  });

  it("reconciles disk and memory after a post-rename parent fsync failure", async (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-uncertain-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    fs.writeFileSync(envPath, `RELAY_TOKEN=${RELAY_TOKEN}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n`, { mode: 0o600 });
    const store = createRelayTokenStore({
      envPath,
      fs: directoryFsyncFailingFs(dir, 1),
      lock: { async runExclusive(operation) { return operation(); } },
    });

    await assert.rejects(store.rotate(NEXT_RELAY_TOKEN, RELAY_TOKEN), (error) => {
      assert.equal(error.commitUncertain, true);
      return true;
    });
    assert.equal(store.current(), NEXT_RELAY_TOKEN);
    assert.match(fs.readFileSync(envPath, "utf8"), new RegExp(`^RELAY_TOKEN=${NEXT_RELAY_TOKEN}$`, "m"));
    assert.equal(await store.reload({ lockHeld: true }), NEXT_RELAY_TOKEN);
  });

  it("rejects malformed or identical Relay and management tokens", (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-invalid-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    fs.writeFileSync(envPath, `RELAY_TOKEN=short\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n`, { mode: 0o600 });
    assert.throws(() => createRelayTokenStore({ envPath }), /RELAY_TOKEN/);
    fs.writeFileSync(envPath, `RELAY_TOKEN=${MANAGEMENT_TOKEN.toUpperCase()}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n`, { mode: 0o600 });
    assert.throws(() => createRelayTokenStore({ envPath }), /distinct/);
  });

  it("reloads relay.env under lock, preserves external fields, and CAS-rejects a stale token", async (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-cas-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    fs.writeFileSync(envPath,
      `RELAY_TOKEN=${RELAY_TOKEN}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\nBIND_ADDR=10.8.0.1\n`,
      { mode: 0o600 });
    const { createFlockLock } = loadManagementModules();
    const lock = createFlockLock({
      lockPath: path.join(dir, "clawd-relay.lock"),
      flockCommand: createFlockShim(t),
    });
    const store = createRelayTokenStore({ envPath, lock });
    fs.writeFileSync(envPath,
      `RELAY_TOKEN=${RELAY_TOKEN}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\nBIND_ADDR=10.8.0.9\nEXTERNAL_FIELD=preserve\n`,
      { mode: 0o600 });

    await store.rotate(NEXT_RELAY_TOKEN, RELAY_TOKEN);
    const persisted = fs.readFileSync(envPath, "utf8");
    assert.match(persisted, /BIND_ADDR=10\.8\.0\.9/);
    assert.match(persisted, /EXTERNAL_FIELD=preserve/);

    fs.writeFileSync(envPath,
      `RELAY_TOKEN=${"77".repeat(32)}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\nBIND_ADDR=10.8.0.10\n`,
      { mode: 0o600 });
    await assert.rejects(store.rotate("88".repeat(32), NEXT_RELAY_TOKEN), (error) => {
      assert.equal(error.code, "stale_token_conflict");
      return true;
    });
    assert.match(fs.readFileSync(envPath, "utf8"), /BIND_ADDR=10\.8\.0\.10/);
  });

  it("rejects an existing relay.env with insecure mode before loading secrets", (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-mode-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    fs.writeFileSync(envPath, `RELAY_TOKEN=${RELAY_TOKEN}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n`, { mode: 0o644 });
    assert.throws(() => createRelayTokenStore({ envPath }), /mode.*0600/i);
    fs.chmodSync(envPath, 0o600);
    assert.throws(() => createRelayTokenStore({ envPath, expectedUid: fs.statSync(envPath).uid + 1 }), /owner/i);
  });

  it("uses a bounded flock lock file and serializes competing owners", async (t) => {
    const { createFlockLock } = loadManagementModules();
    assert.equal(typeof createFlockLock, "function");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-lock-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, "clawd-relay.lock");
    const flockCommand = createFlockShim(t);
    const first = createFlockLock({ lockPath, timeoutMs: 25, flockCommand });
    const second = createFlockLock({ lockPath, timeoutMs: 25, flockCommand });
    const releaseFirst = await first.acquire();
    await assert.rejects(second.acquire(), (error) => error.code === "lock_timeout");
    await releaseFirst();
    const releaseSecond = await second.acquire();
    await releaseSecond();
    assert.equal(fs.statSync(lockPath).isFile(), true);
  });

  it("reacquires the kernel lock after a holding Node child is SIGKILLed", async (t) => {
    const { createFlockLock } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-lock-kill-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, "clawd-relay.lock");
    const flockCommand = createFlockShim(t);
    const modulePath = path.join(__dirname, "..", "relay", "relay-token-store.js");
    const child = spawn(process.execPath, ["-e", `
      const { createFlockLock } = require(${JSON.stringify(modulePath)});
      createFlockLock({
        lockPath: ${JSON.stringify(lockPath)},
        flockCommand: ${JSON.stringify(flockCommand)},
        timeoutMs: 5000,
      }).acquire().then(() => {
        process.stdout.write("HELD\\n");
        setInterval(() => {}, 1000);
      });
    `], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { try { child.kill("SIGKILL"); } catch {} });
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("child did not acquire flock")), 7000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("HELD\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));

    const lock = createFlockLock({ lockPath, flockCommand, timeoutMs: 500 });
    const release = await lock.acquire();
    await release();
  });
});

describe("WireGuard phone rotation transaction", () => {
  it("kills and reaps a hung production command at its deadline", async () => {
    const { defaultCommand } = require("../relay/wg-management");
    assert.equal(typeof defaultCommand, "function");
    const started = Date.now();
    await assert.rejects(
      defaultCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 }),
      (error) => error.code === "command_timeout",
    );
    assert.ok(Date.now() - started < 500);
  });

  it("preserves the phone peer block and rejects duplicate key or AllowedIPs directives", () => {
    const { replacePhonePeer } = require("../relay/wg-management");
    const config = oldWgConfig().replace(
      `PublicKey = ${OLD_PHONE_PUBLIC}\nAllowedIPs = 10.8.0.3/32`,
      `# retained\nPublicKey = ${OLD_PHONE_PUBLIC}\nAllowedIPs = 10.8.0.3/32\nPersistentKeepalive = 25`,
    );
    const replaced = replacePhonePeer(config, OLD_PHONE_PUBLIC, NEW_PHONE_PUBLIC, "10.8.0.3");
    assert.match(replaced, /# retained/);
    assert.match(replaced, /PersistentKeepalive = 25/);
    assert.doesNotMatch(replaced, new RegExp(OLD_PHONE_PUBLIC.replace(/[+]/g, "\\+")));
    for (const duplicate of [
      `PublicKey = ${OLD_PHONE_PUBLIC}\n`,
      "AllowedIPs = 10.8.0.3/32\n",
    ]) {
      const malformed = config.replace("# retained\n", `# retained\n${duplicate}`);
      assert.throws(() => replacePhonePeer(
        malformed, OLD_PHONE_PUBLIC, NEW_PHONE_PUBLIC, "10.8.0.3"
      ), /duplicate|exactly once/);
    }
  });

  it("serializes complete rotations so the second snapshots the first committed state", async (t) => {
    const fixture = createConcurrentManagementFixture(t);
    const first = fixture.management.rotatePhone(fixture.context);
    await fixture.firstStarted.promise;
    const second = fixture.management.rotatePhone(fixture.context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(fixture.calls, ["generate-1"]);
    fixture.releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.relayToken, fixture.relayTokens[0]);
    assert.equal(secondResult.relayToken, fixture.relayTokens[1]);
    assert.equal(fixture.applyArgs.length, 2);
    assert.ok(fixture.applyArgs[0].includes(OLD_PHONE_PUBLIC));
    assert.ok(fixture.applyArgs[1].includes(fixture.keyPairs[0].publicKey));
    assert.deepEqual(fixture.closedTokens, [RELAY_TOKEN, fixture.relayTokens[0]]);
    assert.deepEqual([...fixture.activeConnections], [fixture.relayTokens[1]]);
  });

  it("continues the serialized queue after a failed rotation", async (t) => {
    const fixture = createConcurrentManagementFixture(t, { failFirst: true });
    const first = fixture.management.rotatePhone(fixture.context);
    await fixture.firstStarted.promise;
    const second = fixture.management.rotatePhone(fixture.context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(fixture.calls, ["generate-1"]);
    fixture.releaseFirst.resolve();
    await assert.rejects(first, /rotation_failed/);
    const secondResult = await second;

    assert.equal(secondResult.relayToken, fixture.relayTokens[0]);
    assert.deepEqual(fixture.calls, ["generate-1", "generate-2", "apply-1"]);
    assert.deepEqual(fixture.closedTokens, [RELAY_TOKEN]);
  });

  it("commits in order and returns a complete Task 2-compatible phone config", async (t) => {
    const fixture = createManagementFixture(t);
    const result = await fixture.management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    });

    assert.deepEqual(fixture.calls.slice(0, 5), [
      "generate", "persist-wg", "apply-live", "persist-token", "close-old",
    ]);
    assert.equal(result.version, 1);
    assert.equal(result.relayToken, NEXT_RELAY_TOKEN);
    assert.equal(Object.hasOwn(result, "managementToken"), false);
    assert.match(result.phoneConfig, new RegExp(`PrivateKey = ${NEW_PHONE_PRIVATE.replace(/[+]/g, "\\+")}`));
    assert.match(result.phoneConfig, /Address = 10\.8\.0\.3\/32/);
    assert.match(result.phoneConfig, new RegExp(`PublicKey = ${SERVER_PUBLIC.replace(/[+]/g, "\\+")}`));
    assert.match(result.phoneConfig, /Endpoint = 203\.0\.113\.10:51820/);
    assert.match(result.phoneConfig, /AllowedIPs = 10\.8\.0\.0\/24/);
    assert.match(result.phoneConfig, /PersistentKeepalive = 25/);
    assert.equal(fs.statSync(fixture.paths.wgConfigPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(fixture.paths.phonePrivateKeyPath).mode & 0o777, 0o600);
  });

  it("leaves old state untouched when key generation fails", async (t) => {
    const fixture = createManagementFixture(t, { failAt: "generate" });
    await assert.rejects(() => fixture.management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    }), /rotation_failed/);
    for (const [file, contents] of Object.entries(fixture.oldFiles)) {
      assert.equal(fs.readFileSync(file, "utf8"), contents);
    }
    assert.equal(fixture.currentToken(), RELAY_TOKEN);
    assert.deepEqual(fixture.calls, ["generate"]);
  });

  for (const failure of ["persist", "apply", "token"]) {
    it(`restores files, live peer and token after ${failure} failure`, async (t) => {
      const fixture = createManagementFixture(t, { failAt: failure });
      await assert.rejects(() => fixture.management.rotatePhone({
        remoteAddress: "10.8.0.2",
        authorization: `Bearer ${MANAGEMENT_TOKEN}`,
        body: { version: 1 },
      }), /rotation_failed/);
      for (const [file, contents] of Object.entries(fixture.oldFiles)) {
        assert.equal(fs.readFileSync(file, "utf8"), contents);
      }
      assert.equal(fixture.currentToken(), RELAY_TOKEN);
      assert.equal(fixture.calls.includes("close-old"), false);
      if (failure !== "persist") assert.ok(fixture.calls.includes("restore-live"));
      if (failure === "token") assert.ok(fixture.calls.includes("restore-token"));
    });
  }

  for (const [label, fsyncFailures, expectedCode, expectedHealthy] of [
    ["restores the old token after post-rename uncertainty", 1, "rotation_failed", true],
    ["stays unhealthy when uncertain-token compensation fsync fails", 2, "rollback_failed", false],
  ]) {
    it(label, async (t) => {
      const { createRelayTokenStore } = loadManagementModules();
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-token-compensation-"));
      t.after(() => fs.rmSync(envDir, { recursive: true, force: true }));
      const envPath = path.join(envDir, "relay.env");
      fs.writeFileSync(envPath,
        `RELAY_TOKEN=${RELAY_TOKEN}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\nBIND_ADDR=10.8.0.1\n`,
        { mode: 0o600 });
      const store = createRelayTokenStore({
        envPath,
        fs: directoryFsyncFailingFs(envDir, fsyncFailures),
        lock: { async runExclusive(operation) { return operation(); } },
      });
      const fixture = createManagementFixture(t, { tokenStore: store });
      await assert.rejects(fixture.management.rotatePhone({
        remoteAddress: "10.8.0.2",
        authorization: `Bearer ${MANAGEMENT_TOKEN}`,
        body: { version: 1 },
      }), (error) => error.code === expectedCode);
      assert.equal(store.current(), RELAY_TOKEN);
      assert.match(fs.readFileSync(envPath, "utf8"), new RegExp(`^RELAY_TOKEN=${RELAY_TOKEN}$`, "m"));
      assert.equal(fixture.management.isHealthy(), expectedHealthy);
      assert.equal(fixture.calls.includes("close-old"), false);
    });
  }

  for (const scenario of ["live rollback failure", "file rollback failure", "verification mismatch"]) {
    it(`marks management unhealthy on ${scenario} and recovers only through status`, async (t) => {
      const fixture = createManagementFixture(t, {
        failAt: "token",
        failRollbackLive: scenario === "live rollback failure",
        failRollbackFile: scenario === "file rollback failure",
        failVerificationOnce: scenario === "verification mismatch",
      });
      const context = {
        remoteAddress: "10.8.0.2",
        authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      };
      await assert.rejects(fixture.management.rotatePhone({
        ...context,
        body: { version: 1 },
      }), (error) => {
        assert.equal(error.code, "rollback_failed");
        return true;
      });
      assert.equal(fixture.management.isHealthy(), false);
      const generationsBeforeBlockedRetry = fixture.calls.filter((call) => call === "generate").length;
      await assert.rejects(fixture.management.rotatePhone({
        ...context,
        body: { version: 1 },
      }), (error) => error.code === "rollback_failed");
      assert.equal(
        fixture.calls.filter((call) => call === "generate").length,
        generationsBeforeBlockedRetry,
      );

      const recovered = await fixture.management.status(context);
      assert.deepEqual(recovered, { version: 1, status: "ok" });
      assert.equal(fixture.management.isHealthy(), true);
      for (const [file, contents] of Object.entries(fixture.oldFiles)) {
        assert.equal(fs.readFileSync(file, "utf8"), contents);
      }
      assert.equal(fixture.currentToken(), RELAY_TOKEN);
    });
  }

  it("holds the shared lock around the complete rotation transaction", async (t) => {
    const lockEvents = [];
    const fixture = createManagementFixture(t, {
      lock: {
        async runExclusive(operation) {
          lockEvents.push("lock-acquired");
          try { return await operation(); } finally { lockEvents.push("lock-released"); }
        },
      },
    });
    await fixture.management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    });
    assert.deepEqual(lockEvents, ["lock-acquired", "lock-released"]);
    assert.equal(fixture.calls[0], "generate");
    assert.equal(fixture.calls.at(-1), "close-old");
  });

  it("aborts a timed-out key generation and unblocks the queued rotation", async (t) => {
    const { createWgManagement } = loadManagementModules();
    const base = createManagementFixture(t);
    let generations = 0;
    const management = createWgManagement({
      fs,
      command: async (_file, args) => ({ stdout: args.includes("peers") ? `${OLD_PHONE_PUBLIC}\n` : "" }),
      commandTimeoutMs: 200,
      transactionTimeoutMs: 20,
      generateKeyPair: async ({ signal } = {}) => {
        generations++;
        if (generations === 1) {
          return new Promise((resolve, reject) => {
            if (!signal) return;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return { privateKey: NEW_PHONE_PRIVATE, publicKey: NEW_PHONE_PUBLIC };
      },
      generateRelayToken: () => NEXT_RELAY_TOKEN,
      tokenStore: base.tokenStore,
      pairs: base.pairs,
      lock: { async runExclusive(operation) { return operation(); } },
      verifyLivePeer: async () => true,
      paths: base.paths,
      wgInterface: "clawd",
      pcIp: "10.8.0.2",
      phoneIp: "10.8.0.3",
      subnet: "10.8.0.0/24",
      endpoint: "203.0.113.10:51820",
    });
    const context = {
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    };
    const first = management.rotatePhone(context);
    const second = management.rotatePhone(context);
    await assert.rejects(Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error("test_watchdog_timeout")), 250)),
    ]), (error) => {
      assert.notEqual(error.message, "test_watchdog_timeout");
      assert.equal(error.code, "transaction_timeout");
      return true;
    });
    const result = await second;
    assert.equal(result.relayToken, NEXT_RELAY_TOKEN);
    assert.equal(generations, 2);
  });

  it("waits for compensation and verification before returning transaction_timeout", async (t) => {
    const { createWgManagement } = loadManagementModules();
    const base = createManagementFixture(t);
    let commandCalls = 0;
    let rollbackComplete = false;
    const management = createWgManagement({
      fs,
      command: async (_file, _args, { signal } = {}) => {
        commandCalls++;
        if (commandCalls === 1) {
          return new Promise((resolve, reject) => {
            if (!signal) return;
            signal.addEventListener("abort", () => {
              setTimeout(() => reject(signal.reason), 20);
            }, { once: true });
          });
        }
        rollbackComplete = true;
        return { stdout: "" };
      },
      commandTimeoutMs: 500,
      transactionTimeoutMs: 20,
      generateKeyPair: async () => ({ privateKey: NEW_PHONE_PRIVATE, publicKey: NEW_PHONE_PUBLIC }),
      generateRelayToken: () => NEXT_RELAY_TOKEN,
      tokenStore: base.tokenStore,
      pairs: base.pairs,
      lock: { async runExclusive(operation) { return operation(); } },
      verifyLivePeer: async () => rollbackComplete,
      paths: base.paths,
      wgInterface: "clawd",
      pcIp: "10.8.0.2",
      phoneIp: "10.8.0.3",
      subnet: "10.8.0.0/24",
      endpoint: "203.0.113.10:51820",
    });
    const started = Date.now();
    await assert.rejects(management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    }), (error) => error.code === "transaction_timeout");
    assert.ok(Date.now() - started >= 35);
    assert.equal(rollbackComplete, true);
    assert.equal(base.currentToken(), RELAY_TOKEN);
    for (const [file, contents] of Object.entries(base.oldFiles)) {
      assert.equal(fs.readFileSync(file, "utf8"), contents);
    }
  });

  it("verifies one exact restored old peer with PHONE_IP/32 and no new peer", async (t) => {
    const { createWgManagement } = loadManagementModules();
    for (const [name, allowedIpsOutput, expectedCode] of [
      ["exact", `${OLD_PHONE_PUBLIC}\t10.8.0.3/32\n`, "rotation_failed"],
      ["wrong allowed IP", `${OLD_PHONE_PUBLIC}\t10.8.0.30/32\n`, "rollback_failed"],
      ["new peer remains", `${OLD_PHONE_PUBLIC}\t10.8.0.3/32\n${NEW_PHONE_PUBLIC}\t10.8.0.3/32\n`, "rollback_failed"],
      ["duplicate old peer", `${OLD_PHONE_PUBLIC}\t10.8.0.30/32\n${OLD_PHONE_PUBLIC}\t10.8.0.3/32\n`, "rollback_failed"],
    ]) {
      await t.test(name, async (t) => {
        const base = createManagementFixture(t, { failAt: "token" });
        let commandCalls = 0;
        const management = createWgManagement({
          fs,
          command: async (_file, args) => {
            commandCalls++;
            if (commandCalls === 3) {
              assert.deepEqual(args, ["show", "clawd", "allowed-ips"]);
              return { stdout: allowedIpsOutput };
            }
            return { stdout: "" };
          },
          generateKeyPair: async () => ({ privateKey: NEW_PHONE_PRIVATE, publicKey: NEW_PHONE_PUBLIC }),
          generateRelayToken: () => NEXT_RELAY_TOKEN,
          tokenStore: base.tokenStore,
          pairs: base.pairs,
          lock: { async runExclusive(operation) { return operation(); } },
          paths: base.paths,
          wgInterface: "clawd",
          pcIp: "10.8.0.2",
          phoneIp: "10.8.0.3",
          subnet: "10.8.0.0/24",
          endpoint: "203.0.113.10:51820",
        });
        await assert.rejects(management.rotatePhone({
          remoteAddress: "10.8.0.2",
          authorization: `Bearer ${MANAGEMENT_TOKEN}`,
          body: { version: 1 },
        }), (error) => error.code === expectedCode);
        assert.equal(management.isHealthy(), expectedCode !== "rollback_failed");
      });
    }
  });

  it("shutdown aborts and drains an active rotation so no post-close commit occurs", async (t) => {
    const { createWgManagement } = loadManagementModules();
    const base = createManagementFixture(t);
    const stageStarted = deferred();
    const releaseStage = deferred();
    const management = createWgManagement({
      fs,
      command: async () => ({ stdout: "" }),
      commandTimeoutMs: 500,
      transactionTimeoutMs: 1000,
      generateKeyPair: async ({ signal } = {}) => {
        stageStarted.resolve();
        return new Promise((resolve, reject) => {
          releaseStage.promise.then(() => resolve({
            privateKey: NEW_PHONE_PRIVATE,
            publicKey: NEW_PHONE_PUBLIC,
          }));
          if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      generateRelayToken: () => NEXT_RELAY_TOKEN,
      tokenStore: base.tokenStore,
      pairs: base.pairs,
      lock: { async runExclusive(operation) { return operation(); } },
      verifyLivePeer: async () => true,
      paths: base.paths,
      wgInterface: "clawd",
      pcIp: "10.8.0.2",
      phoneIp: "10.8.0.3",
      subnet: "10.8.0.0/24",
      endpoint: "203.0.113.10:51820",
    });
    const relay = await startRelay(t, { management, closeDeadlineMs: 200, requestDeadlineMs: 1500 });
    const active = management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    });
    await stageStarted.promise;
    await relay.close();
    releaseStage.resolve();
    await assert.rejects(active, (error) => error.code === "shutdown_in_progress");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(base.currentToken(), RELAY_TOKEN);
    assert.equal(base.calls.includes("close-old"), false);
    await assert.rejects(management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    }), (error) => error.code === "shutdown_in_progress");
  });

  it("rejects close with shutdown_failed when an injected stage ignores cancellation", async (t) => {
    const { createWgManagement } = loadManagementModules();
    const base = createManagementFixture(t);
    const stageStarted = deferred();
    const management = createWgManagement({
      fs,
      command: async () => ({ stdout: "" }),
      commandTimeoutMs: 1000,
      transactionTimeoutMs: 5000,
      generateKeyPair: async () => {
        stageStarted.resolve();
        return new Promise(() => {});
      },
      generateRelayToken: () => NEXT_RELAY_TOKEN,
      tokenStore: base.tokenStore,
      pairs: base.pairs,
      lock: { async runExclusive(operation) { return operation(); } },
      verifyLivePeer: async () => true,
      paths: base.paths,
      wgInterface: "clawd",
      pcIp: "10.8.0.2",
      phoneIp: "10.8.0.3",
      subnet: "10.8.0.0/24",
      endpoint: "203.0.113.10:51820",
    });
    const relay = await startRelay(t, { management, closeDeadlineMs: 20, requestDeadlineMs: 6000 });
    void management.rotatePhone({
      remoteAddress: "10.8.0.2",
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      body: { version: 1 },
    }).catch(() => {});
    await stageStarted.promise;
    await assert.rejects(Promise.race([
      relay.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close_watchdog_timeout")), 250)),
    ]), (error) => error.code === "shutdown_failed");
    assert.equal(management.isHealthy(), false);
    assert.equal(base.currentToken(), RELAY_TOKEN);
  });
});

describe("Relay management HTTP API", () => {
  it("returns rollback_failed while management cannot verify recovered old state", async (t) => {
    const fixture = createManagementFixture(t, {
      failAt: "token",
      failVerificationAlways: true,
    });
    const relay = await startRelay(t, { management: fixture.management, remoteAddressOf: () => "10.8.0.2" });
    const headers = {
      Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      "Content-Type": "application/json",
    };
    const rotate = await request(relay, {
      method: "POST",
      pathname: "/api/manage/phone/rotate",
      headers,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rotate.statusCode, 503);
    assert.equal(rotate.body.error, "rollback_failed");
    const status = await request(relay, {
      pathname: "/api/manage/status",
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    });
    assert.equal(status.statusCode, 503);
    assert.equal(status.body.error, "rollback_failed");
  });

  it("times out a partial JSON body", async (t) => {
    const relay = await startRelay(t, {
      management: {
        status: async () => ({ version: 1, status: "ok" }),
        rotatePhone: async () => ({ version: 1 }),
      },
      remoteAddressOf: () => "10.8.0.2",
      requestDeadlineMs: 20,
    });
    const partial = new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: relay.address().port,
        method: "POST",
        path: "/api/manage/phone/rotate",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "20",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.once("error", reject);
      req.write("{");
      t.after(() => req.destroy());
    });
    assert.equal(await Promise.race([
      partial,
      new Promise((_, reject) => setTimeout(() => reject(new Error("body_watchdog_timeout")), 250)),
    ]), 408);
  });

  it("returns transaction_timeout only after delayed rollback and old-token verification", async (t) => {
    const { createWgManagement } = loadManagementModules();
    const base = createManagementFixture(t);
    let commandCalls = 0;
    let rollbackComplete = false;
    const management = createWgManagement({
      fs,
      command: async (_file, _args, { signal } = {}) => {
        commandCalls++;
        if (commandCalls === 1) {
          return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              setTimeout(() => reject(signal.reason), 25);
            }, { once: true });
          });
        }
        rollbackComplete = true;
        return { stdout: "" };
      },
      commandTimeoutMs: 500,
      transactionTimeoutMs: 20,
      generateKeyPair: async () => ({ privateKey: NEW_PHONE_PRIVATE, publicKey: NEW_PHONE_PUBLIC }),
      generateRelayToken: () => NEXT_RELAY_TOKEN,
      tokenStore: base.tokenStore,
      pairs: base.pairs,
      lock: { async runExclusive(operation) { return operation(); } },
      verifyLivePeer: async () => rollbackComplete,
      paths: base.paths,
      wgInterface: "clawd",
      pcIp: "10.8.0.2",
      phoneIp: "10.8.0.3",
      subnet: "10.8.0.0/24",
      endpoint: "203.0.113.10:51820",
    });
    const relay = await startRelay(t, {
      management,
      remoteAddressOf: () => "10.8.0.2",
      requestDeadlineMs: 200,
    });
    const started = Date.now();
    const response = await request(relay, {
      method: "POST",
      pathname: "/api/manage/phone/rotate",
      headers: {
        Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(response.statusCode, 504);
    assert.equal(response.body.error, "transaction_timeout");
    assert.ok(Date.now() - started >= 40);
    assert.equal(rollbackComplete, true);
    assert.equal(base.currentToken(), RELAY_TOKEN);
  });

  it("forces shutdown of lingering HTTP sockets within the close deadline", async (t) => {
    const relay = await startRelay(t, { closeDeadlineMs: 20 });
    const socket = net.connect(relay.address().port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.resume();
    socket.write(
      "POST /api/manage/phone/rotate HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    t.after(() => socket.destroy());
    const socketClosed = new Promise((resolve) => socket.once("close", resolve));
    await assert.rejects(Promise.race([
      relay.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close_watchdog_timeout")), 250)),
    ]), (error) => error.code === "shutdown_failed");
    await Promise.race([
      socketClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("socket_close_timeout")), 250)),
    ]);
    assert.equal(socket.destroyed, true);
  });

  it("accepts management requests only from the exact PC address, including its IPv4-mapped form", async (t) => {
    for (const remoteAddress of ["10.8.0.2", "::ffff:10.8.0.2"]) {
      await t.test(`accepts ${remoteAddress}`, async (t) => {
        const fixture = createManagementFixture(t);
        const relay = await startRelay(t, { management: fixture.management, remoteAddressOf: () => remoteAddress });
        const response = await request(relay, {
          pathname: "/api/manage/status",
          headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.body, { version: 1, status: "ok" });
      });
    }
    for (const remoteAddress of ["10.8.0.20", "::1", "::ffff:127.0.0.1"]) {
      await t.test(`rejects ${remoteAddress}`, async (t) => {
        const fixture = createManagementFixture(t);
        const relay = await startRelay(t, { management: fixture.management, remoteAddressOf: () => remoteAddress });
        const response = await request(relay, {
          pathname: "/api/manage/status",
          headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
        });
        assert.equal(response.statusCode, 403);
      });
    }
  });

  it("requires the exact management Bearer token and never accepts it in the body", async (t) => {
    const fixture = createManagementFixture(t);
    const relay = await startRelay(t, { management: fixture.management, remoteAddressOf: () => "10.8.0.2" });
    for (const authorization of [undefined, `Bearer ${"bb".repeat(32)}`, MANAGEMENT_TOKEN]) {
      const response = await request(relay, {
        pathname: "/api/manage/status",
        headers: authorization ? { Authorization: authorization } : {},
      });
      assert.equal(response.statusCode, 401);
    }
  });

  it("rejects wrong content type, version, shape, and oversized rotation bodies", async (t) => {
    const fixture = createManagementFixture(t);
    const relay = await startRelay(t, { management: fixture.management, remoteAddressOf: () => "10.8.0.2" });
    const auth = { Authorization: `Bearer ${MANAGEMENT_TOKEN}` };
    const cases = [
      { headers: auth, body: JSON.stringify({ version: 1 }), statusCode: 415 },
      { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ version: 2 }), statusCode: 400 },
      { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, token: MANAGEMENT_TOKEN }), statusCode: 400 },
      { headers: { ...auth, "Content-Type": "application/json" }, body: "x".repeat(5000), statusCode: 413 },
    ];
    for (const item of cases) {
      const response = await request(relay, {
        method: "POST",
        pathname: "/api/manage/phone/rotate",
        headers: item.headers,
        body: item.body,
      });
      assert.equal(response.statusCode, item.statusCode);
    }
  });

  it("returns the new phone config/token and disables legacy start/stop endpoints", async (t) => {
    const fixture = createManagementFixture(t);
    const relay = await startRelay(t, { management: fixture.management, remoteAddressOf: () => "10.8.0.2" });
    const response = await request(relay, {
      method: "POST",
      pathname: "/api/manage/phone/rotate",
      headers: {
        Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.relayToken, NEXT_RELAY_TOKEN);
    assert.match(response.body.phoneConfig, /PrivateKey/);
    assert.equal(Object.hasOwn(response.body, "managementToken"), false);

    for (const pathname of ["/api/start", "/api/stop"]) {
      const legacy = await request(relay, { method: "POST", pathname, body: "{}" });
      assert.equal(legacy.statusCode, 404);
    }
  });
});

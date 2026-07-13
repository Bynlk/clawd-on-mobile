"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

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
    remoteAddressOf: overrides.remoteAddressOf,
  });
  await relay.listen();
  t.after(() => relay.close());
  return relay;
}

function request(relay, { method = "GET", pathname, headers = {}, body = "" }) {
  const address = relay.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      method,
      path: pathname,
      headers,
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
  const { createRelayTokenStore } = require("../relay/relay-token-store");
  const { createWgManagement } = require("../relay/wg-management");
  return { createRelayTokenStore, createWgManagement };
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
    return { stdout: "" };
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

function connect(relay, role, token) {
  const { port } = relay.address();
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  return new WebSocket(`ws://127.0.0.1:${port}/mobile/ws?role=${role}`, { headers });
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
  it("closes a missing Bearer token with code 4001", async (t) => {
    const relay = await startRelay(t);
    const ws = connect(relay, "pc");
    const close = closed(ws);
    await opened(ws);
    assert.equal((await close).code, 4001);
  });

  it("closes a wrong Bearer token with code 4001", async (t) => {
    const relay = await startRelay(t);
    const ws = connect(relay, "phone", "22".repeat(32));
    const close = closed(ws);
    await opened(ws);
    assert.equal((await close).code, 4001);
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

  it("atomically updates relay.env as 0600 while preserving management and runtime fields", (t) => {
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

    const store = createRelayTokenStore({ envPath, fs: tracedFs });
    store.rotate(NEXT_RELAY_TOKEN);

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

  it("rejects malformed or identical Relay and management tokens", (t) => {
    const { createRelayTokenStore } = loadManagementModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-token-invalid-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, "relay.env");
    fs.writeFileSync(envPath, `RELAY_TOKEN=short\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n`);
    assert.throws(() => createRelayTokenStore({ envPath }), /RELAY_TOKEN/);
    fs.writeFileSync(envPath, `RELAY_TOKEN=${MANAGEMENT_TOKEN.toUpperCase()}\nMANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}\n`);
    assert.throws(() => createRelayTokenStore({ envPath }), /distinct/);
  });
});

describe("WireGuard phone rotation transaction", () => {
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
});

describe("Relay management HTTP API", () => {
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

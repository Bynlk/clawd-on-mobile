"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { registerWgRelayIpc } = require("../src/wg-relay-ipc");
const { createWgRelayRuntime } = require("../src/wg-relay-runtime");

// ── Mocks (mirror remote-ssh-ipc.test.js conventions) ──

function mockIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: async (channel, payload) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return await fn({}, payload);
    },
    handlers,
  };
}

function mockBrowserWindow() {
  const sentMessages = [];
  const fakeBw = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sentMessages.push({ channel, payload }),
    },
  };
  return { BrowserWindow: { getAllWindows: () => [fakeBw] }, sentMessages };
}

function mockSettingsController(profiles = []) {
  return {
    getSnapshot: () => ({ wgRelay: { profiles } }),
    applyCommand: async () => ({ status: "ok" }),
  };
}

const baseProfile = {
  id: "wg-1",
  label: "My VPS",
  host: "root@1.2.3.4",
  port: 22,
  authMethod: "password",
  wgPort: 51820,
  wgSubnet: "10.8.0.0/24",
};

const okReadback = {
  serverPubKey: "SPUB",
  endpoint: "1.2.3.4:51820",
  relayAddr: "10.8.0.1",
  pcAddress: "10.8.0.2/32",
  pcConf: "[Interface]\nAddress = 10.8.0.2/32\nPrivateKey = PCPRIV\n",
  phoneConf: "[Interface]\nAddress = 10.8.0.3/32\nPrivateKey = PHONEPRIV\n",
};

function setup(opts = {}) {
  const ipcMain = mockIpcMain();
  const { BrowserWindow, sentMessages } = mockBrowserWindow();
  const wgRelayRuntime = createWgRelayRuntime();
  const settingsController = mockSettingsController(opts.profiles || [baseProfile]);
  const ipc = registerWgRelayIpc({
    ipcMain,
    settingsController,
    wgRelayRuntime,
    BrowserWindow,
    spawn: () => { throw new Error("spawn should not be called in these tests"); },
    ...opts.overrides,
  });
  return { ipcMain, sentMessages, wgRelayRuntime, settingsController, ipc };
}

// ── Required deps ──

test("registerWgRelayIpc requires ipcMain", () => {
  assert.throws(() => registerWgRelayIpc({}), /ipcMain/);
});

test("registerWgRelayIpc requires wgRelayRuntime", () => {
  assert.throws(
    () => registerWgRelayIpc({ ipcMain: mockIpcMain(), settingsController: mockSettingsController(), BrowserWindow: {} }),
    /wgRelayRuntime/,
  );
});

// ── Event bridging ──

test("runtime status-changed event broadcasts on wgRelay:status-changed", () => {
  const { sentMessages, wgRelayRuntime, ipc } = setup();
  wgRelayRuntime.setStatus("wg-1", { status: "connected" });
  const msg = sentMessages.find((m) => m.channel === "wgRelay:status-changed");
  assert.ok(msg);
  assert.equal(msg.payload.status, "connected");
  assert.equal(msg.payload.profileId, "wg-1");
  ipc.dispose();
});

test("runtime progress event broadcasts on wgRelay:progress", () => {
  const { sentMessages, wgRelayRuntime, ipc } = setup();
  wgRelayRuntime.emitProgress({ profileId: "wg-1", step: "install-wg", status: "start" });
  const msg = sentMessages.find((m) => m.channel === "wgRelay:progress");
  assert.ok(msg);
  assert.equal(msg.payload.step, "install-wg");
  ipc.dispose();
});

test("dispose() removes handlers and stops broadcasting", () => {
  const { ipcMain, sentMessages, wgRelayRuntime, ipc } = setup();
  ipc.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  wgRelayRuntime.setStatus("wg-1", { status: "connected" });
  assert.equal(sentMessages.length, 0);
});

// ── list-statuses / status ──

test("wgRelay:list-statuses returns runtime statuses", async () => {
  const { ipcMain, wgRelayRuntime, ipc } = setup();
  wgRelayRuntime.setStatus("wg-1", { status: "deploying" });
  const r = await ipcMain.invoke("wgRelay:list-statuses");
  assert.equal(r.status, "ok");
  assert.equal(r.statuses.length, 1);
  assert.equal(r.statuses[0].status, "deploying");
  ipc.dispose();
});

test("wgRelay:status requires a profileId", async () => {
  const { ipcMain, ipc } = setup();
  const r = await ipcMain.invoke("wgRelay:status", null);
  assert.equal(r.status, "error");
  ipc.dispose();
});

// ── Deploy ──

test("wgRelay:deploy translates ok→status and returns the full readback", async () => {
  let receivedPassword = null;
  let receivedForcePhone = null;
  const { ipcMain, ipc } = setup({
    overrides: {
      deployFn: async ({ password, runtime }) => {
        receivedPassword = password;
        receivedForcePhone = runtime && runtime.forcePhoneKey;
        return { ok: true, readback: { ...okReadback } };
      },
    },
  });
  const r = await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "s3cret" });
  assert.equal(r.status, "ok");
  assert.equal(r.readback.serverPubKey, "SPUB");
  assert.equal(r.readback.phoneConf, okReadback.phoneConf); // full readback for QR
  assert.ok(Number.isFinite(r.readback.deployedAt));
  assert.equal(receivedPassword, "s3cret"); // SEC-1: password only via payload
  assert.equal(receivedForcePhone, false);
  ipc.dispose();
});

test("wgRelay:deploy passes regenPhoneOnly through as runtime.forcePhoneKey", async () => {
  let forcePhone = null;
  const { ipcMain, ipc } = setup({
    overrides: {
      deployFn: async ({ runtime }) => {
        forcePhone = runtime && runtime.forcePhoneKey;
        return { ok: true, readback: { ...okReadback } };
      },
    },
  });
  await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", regenPhoneOnly: true, password: "x" });
  assert.equal(forcePhone, true);
  ipc.dispose();
});

test("wgRelay:deploy caches pcConf in memory for a later tunnelUp (SEC-3)", async () => {
  const { ipcMain, wgRelayRuntime, ipc } = setup({
    overrides: { deployFn: async () => ({ ok: true, readback: { ...okReadback } }) },
  });
  await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "x" });
  assert.equal(wgRelayRuntime.getPcConf("wg-1"), okReadback.pcConf);
  ipc.dispose();
});

test("wgRelay:deploy maps failure to error with step/hint", async () => {
  const { ipcMain, ipc } = setup({
    overrides: {
      deployFn: async () => ({ ok: false, step: "detect", hint: "wgErrNoPkgManager", message: "boom" }),
    },
  });
  const r = await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "x" });
  assert.equal(r.status, "error");
  assert.equal(r.step, "detect");
  assert.equal(r.hint, "wgErrNoPkgManager");
  ipc.dispose();
});

test("wgRelay:deploy on unknown profile returns error", async () => {
  const { ipcMain, ipc } = setup();
  const r = await ipcMain.invoke("wgRelay:deploy", { profileId: "nope", password: "x" });
  assert.equal(r.status, "error");
  assert.match(r.message, /not found/);
  ipc.dispose();
});

test("wgRelay:deploy sets status deploying then idle on success", async () => {
  const { ipcMain, sentMessages, ipc } = setup({
    overrides: { deployFn: async () => ({ ok: true, readback: { ...okReadback } }) },
  });
  await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "x" });
  const statuses = sentMessages
    .filter((m) => m.channel === "wgRelay:status-changed")
    .map((m) => m.payload.status);
  assert.ok(statuses.includes("deploying"));
  assert.equal(statuses[statuses.length - 1], "idle");
  ipc.dispose();
});

// ── Tunnel up / down ──

test("wgRelay:tunnel-up fails cleanly when no pcConf is cached", async () => {
  const { ipcMain, ipc } = setup({
    overrides: { bringUpFn: async () => ({ ok: true, ifName: "clawd0" }) },
  });
  const r = await ipcMain.invoke("wgRelay:tunnel-up", "wg-1");
  assert.equal(r.status, "error");
  assert.equal(r.hint, "wgPcErrNoConf");
  ipc.dispose();
});

test("wgRelay:tunnel-up brings up the interface with the cached pcConf", async () => {
  let usedConf = null;
  const { ipcMain, wgRelayRuntime, ipc } = setup({
    overrides: {
      deployFn: async () => ({ ok: true, readback: { ...okReadback } }),
      bringUpFn: async ({ pcConf }) => {
        usedConf = pcConf;
        return { ok: true, ifName: "clawd0", address: "10.8.0.2/32" };
      },
    },
  });
  await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "x" });
  const r = await ipcMain.invoke("wgRelay:tunnel-up", "wg-1");
  assert.equal(r.status, "ok");
  assert.equal(r.address, "10.8.0.2/32");
  assert.equal(usedConf, okReadback.pcConf);
  assert.equal(wgRelayRuntime.getProfileStatus("wg-1").status, "connected");
  ipc.dispose();
});

test("wgRelay:tunnel-up surfaces bringUp failure hint", async () => {
  const { ipcMain, ipc } = setup({
    overrides: {
      deployFn: async () => ({ ok: true, readback: { ...okReadback } }),
      bringUpFn: async () => ({ ok: false, reason: "privilegeDenied", hint: "wgPcErrPrivilege", message: "denied" }),
    },
  });
  await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "x" });
  const r = await ipcMain.invoke("wgRelay:tunnel-up", "wg-1");
  assert.equal(r.status, "error");
  assert.equal(r.hint, "wgPcErrPrivilege");
  ipc.dispose();
});

test("wgRelay:tunnel-down calls bringDown and resets status to idle", async () => {
  let downCalled = false;
  const { ipcMain, wgRelayRuntime, ipc } = setup({
    overrides: {
      bringDownFn: async () => { downCalled = true; return { ok: true }; },
    },
  });
  wgRelayRuntime.setStatus("wg-1", { status: "connected" });
  const r = await ipcMain.invoke("wgRelay:tunnel-down", "wg-1");
  assert.equal(r.status, "ok");
  assert.ok(downCalled);
  assert.equal(wgRelayRuntime.getProfileStatus("wg-1").status, "idle");
  ipc.dispose();
});

test("wgRelay:tunnel-status returns the probe result", async () => {
  const { ipcMain, ipc } = setup({
    overrides: { tunnelStatusFn: async () => ({ up: true, peers: 1, handshakeAt: 123 }) },
  });
  const r = await ipcMain.invoke("wgRelay:tunnel-status", "wg-1");
  assert.equal(r.status, "ok");
  assert.equal(r.tunnel.up, true);
  assert.equal(r.tunnel.peers, 1);
  ipc.dispose();
});

// ── SEC-3: pcConf never persisted through the settings controller ──

test("deploy does NOT write pcConf/phoneConf via settings controller", async () => {
  const writes = [];
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const wgRelayRuntime = createWgRelayRuntime();
  const settingsController = {
    getSnapshot: () => ({ wgRelay: { profiles: [baseProfile] } }),
    applyCommand: async (action, args) => { writes.push({ action, args }); return { status: "ok" }; },
  };
  const ipc = registerWgRelayIpc({
    ipcMain, settingsController, wgRelayRuntime, BrowserWindow,
    spawn: () => {},
    deployFn: async () => ({ ok: true, readback: { ...okReadback } }),
  });
  await ipcMain.invoke("wgRelay:deploy", { profileId: "wg-1", password: "x" });
  // The IPC layer must NOT persist anything itself — the renderer owns the
  // whitelisted applyReadback call. So no controller writes here at all.
  assert.equal(writes.length, 0);
  ipc.dispose();
});

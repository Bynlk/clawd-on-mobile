"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function loadPreload() {
  const exposed = new Map();
  const listeners = new Map();
  const invokes = [];
  const invokeResults = new Map();
  const ipcRenderer = {
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
    invoke(channel, payload) {
      invokes.push({ channel, payload, snapshot: structuredClone(payload) });
      return Promise.resolve(invokeResults.get(channel));
    },
    send() {},
  };
  const contextBridge = {
    exposeInMainWorld(name, value) { exposed.set(name, value); },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "preload-settings.js"), "utf8");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { argv: [] },
    require(id) {
      if (id === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`unexpected preload require: ${id}`);
    },
    structuredClone,
  });
  vm.runInContext(source, context, { filename: "preload-settings.js" });
  return {
    api: exposed.get("wgRelay"),
    emit(channel, payload) {
      for (const listener of listeners.get(channel) || []) listener({}, payload);
    },
    invokeResults,
    invokes,
  };
}

test("preload exposes only the minimal Task 6 wgRelay API", () => {
  const { api } = loadPreload();
  assert.deepEqual(Object.keys(api).sort(), [
    "connect", "deleteLocal", "deploy", "disconnect", "listStatuses",
    "onProgress", "onStatusChanged", "pairingQr", "rotatePhone", "status",
  ]);
  assert.equal(Object.hasOwn(api, "ipcRenderer"), false);
  assert.equal(Object.hasOwn(api, "invoke"), false);
  assert.equal(Object.hasOwn(api, "tunnelUp"), false);
  assert.equal(Object.hasOwn(api, "tunnelDown"), false);
  assert.equal(Object.hasOwn(api, "tunnelStatus"), false);
});

test("preload maps invokes to fixed channels and clones arguments/results", async () => {
  const { api, invokeResults, invokes } = loadPreload();
  const sharedResult = { status: "ok", nested: { value: 1 } };
  for (const channel of [
    "wgRelay:deploy", "wgRelay:connect", "wgRelay:disconnect", "wgRelay:rotate-phone",
    "wgRelay:delete-local", "wgRelay:pairing-qr", "wgRelay:status", "wgRelay:list-statuses",
  ]) invokeResults.set(channel, sharedResult);

  const deployRequest = { profile: { id: "wg-1" }, password: "short-lived" };
  const calls = [
    api.deploy(deployRequest),
    api.connect("wg-1"),
    api.disconnect("wg-1"),
    api.rotatePhone("wg-1"),
    api.deleteLocal("wg-1"),
    api.pairingQr("wg-1"),
    api.status("wg-1"),
    api.listStatuses(),
  ];
  const results = await Promise.all(calls);
  assert.deepEqual(invokes.map((entry) => entry.channel), [
    "wgRelay:deploy", "wgRelay:connect", "wgRelay:disconnect", "wgRelay:rotate-phone",
    "wgRelay:delete-local", "wgRelay:pairing-qr", "wgRelay:status", "wgRelay:list-statuses",
  ]);
  assert.notEqual(invokes[0].payload, deployRequest);
  assert.notEqual(invokes[0].payload.profile, deployRequest.profile);
  assert.deepEqual(invokes.slice(1, 7).map((entry) => entry.snapshot), [
    { profileId: "wg-1" }, { profileId: "wg-1" }, { profileId: "wg-1" },
    { profileId: "wg-1" }, { profileId: "wg-1" }, { profileId: "wg-1" },
  ]);
  assert.equal(invokes[7].snapshot, undefined);
  assert.notEqual(results[0], sharedResult);
  assert.notEqual(results[0].nested, sharedResult.nested);
  results[0].nested.value = 2;
  assert.equal(sharedResult.nested.value, 1);
});

test("status/progress listeners clone payloads and unsubscribe without removing peers", () => {
  const { api, emit } = loadPreload();
  const statusA = [];
  const statusB = [];
  const progress = [];
  const stopA = api.onStatusChanged((payload) => {
    statusA.push(payload);
    payload.status = "mutated";
  });
  const stopB = api.onStatusChanged((payload) => statusB.push(payload));
  const stopProgress = api.onProgress((payload) => progress.push(payload));
  const sourceStatus = { profileId: "wg-1", status: "connected" };
  const sourceProgress = { profileId: "wg-1", step: "install", status: "start" };

  emit("wgRelay:status-changed", sourceStatus);
  emit("wgRelay:progress", sourceProgress);
  assert.equal(statusA[0].status, "mutated");
  assert.equal(statusB[0].status, "connected");
  assert.equal(sourceStatus.status, "connected");
  assert.notEqual(progress[0], sourceProgress);

  stopA();
  stopProgress();
  emit("wgRelay:status-changed", sourceStatus);
  emit("wgRelay:progress", sourceProgress);
  assert.equal(statusA.length, 1);
  assert.equal(statusB.length, 2);
  assert.equal(progress.length, 1);
  stopB();
  assert.doesNotThrow(() => api.onProgress(null)());
});

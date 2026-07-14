"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const TAB_SOURCE = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
const { SUPPORTED_LANGS } = require("../src/i18n");

function deferred() {
  const value = {};
  value.promise = new Promise((resolve, reject) => {
    value.resolve = resolve;
    value.reject = reject;
  });
  return value;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean)); }
  add(...names) {
    const values = this.values();
    for (const name of names) values.add(name);
    this.element.className = [...values].join(" ");
  }
  remove(...names) {
    const values = this.values();
    for (const name of names) values.delete(name);
    this.element.className = [...values].join(" ");
  }
  contains(name) { return this.values().has(name); }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.readOnly = false;
    this.src = "";
    this.alt = "";
    this.classList = new FakeClassList(this);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  set innerHTML(_value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  get innerHTML() { return ""; }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === "id") this.id = text;
    if (name === "class") this.className = text;
    if (name === "type") this.type = text;
    if (name === "src") this.src = text;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
      this.dataset[key] = text;
    }
  }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "src") this.src = "";
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    const value = event || {};
    value.type ||= "click";
    value.target ||= this;
    value.currentTarget = this;
    value.preventDefault ||= () => { value.defaultPrevented = true; };
    value.stopPropagation ||= () => { value.cancelBubble = true; };
    for (const listener of [...(this.listeners.get(value.type) || [])]) listener(value);
    if (value.bubbles !== false && !value.cancelBubble && this.parentNode) {
      this.parentNode.dispatchEvent(value);
    }
    return !value.defaultPrevented;
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const parts = String(selector).trim().split(/\s+/).filter(Boolean);
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child._matches(parts[parts.length - 1])) {
          let ancestor = child.parentNode;
          let index = parts.length - 2;
          while (index >= 0) {
            while (ancestor && !ancestor._matches(parts[index])) ancestor = ancestor.parentNode;
            if (!ancestor) break;
            ancestor = ancestor.parentNode;
            index--;
          }
          if (index < 0) result.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.body = new FakeElement("body", this);
    this.modalRoot = new FakeElement("div", this);
    this.modalRoot.id = "modalRoot";
    this.body.appendChild(this.modalRoot);
    this.activeElement = null;
  }
  createElement(tagName) { return new FakeElement(tagName, this); }
  getElementById(id) { return id === "modalRoot" ? this.modalRoot : null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, ...event });
  }
}

const TRANSLATIONS = {
  wgRelayDeploy: "ONE_CLICK_DEPLOY",
  wgRelayDeploying: "DEPLOYING",
  wgRelayConnect: "CONNECT",
  wgRelayDisconnect: "DISCONNECT",
  wgRelayShowQr: "SHOW_QR",
  wgRelayRotatePhone: "ROTATE_PHONE",
  wgRelayRepair: "REPAIR",
  wgRelayDelete: "DELETE",
  wgRelayRepairDeploy: "REPAIR_DEPLOY",
  wgRelayCancel: "CANCEL",
  wgRelayQrClose: "CLOSE_QR",
  wgRelayRotateConfirmAction: "CONFIRM_ROTATE",
  wgRelayDeleteConfirmAction: "CONFIRM_DELETE",
  wgRelayStatus_idle: "IDLE",
  wgRelayStatus_starting_tunnel: "STARTING_TUNNEL",
  wgRelayStatus_verifying_relay: "VERIFYING_RELAY",
  wgRelayStatus_connecting_relay: "CONNECTING_RELAY",
  wgRelayStatus_connected: "CONNECTED",
  wgRelayStatus_disconnecting: "DISCONNECTING",
  wgRelayStatus_failed: "FAILED",
  wgRelayRecoveryRequired: "REPAIR_REQUIRED",
  wgRelayError_deploy_failed: "SAFE_DEPLOY_ERROR",
  wgRelayError_remote_commit_recovery_required: "SAFE_RECOVERY_ERROR",
  wgRelayError_profile_conflict_recovery_required: "SAFE_CONFLICT_ERROR",
  wgRelayError_health_failed: "SAFE_HEALTH_ERROR",
  wgRelayError_unknown: "SAFE_UNKNOWN_ERROR",
};

const DEPLOYED_PROFILE = Object.freeze({
  id: "wg-test",
  label: "Test relay",
  host: "relay.example.test",
  sshUsername: "root",
  sshPort: 22,
  authMethod: "password",
  wgPort: 51820,
  wgSubnet: "10.8.0.0/24",
  endpoint: "relay.example.test:51820",
  relayAddr: "ws://10.8.0.1:7891",
  lastDeployedAt: 1,
  deployVersion: 1,
});

function createHarness({ profile = null, api = {}, confirmResult = "confirm", runtimeAvailable = true } = {}) {
  const document = new FakeDocument();
  const content = new FakeElement("main", document);
  document.body.appendChild(content);
  const calls = {
    deploy: [], connect: [], disconnect: [], pairingQr: [], rotatePhone: [], deleteLocal: [],
    confirms: [], toasts: [], renders: 0, statusUnsubscribed: 0, progressUnsubscribed: 0,
  };
  const statusListeners = new Set();
  const progressListeners = new Set();
  const defaultApi = {
    deploy: async (request) => ({
      status: "ok", profile: { ...DEPLOYED_PROFILE, ...request.profile },
      state: { profileId: request.profile.id, status: "connected", generation: 1 },
      qr: { version: 1, dataUrl: "data:image/png;base64,ZGVwbG95" },
    }),
    connect: async (profileId) => ({ status: "ok", state: { profileId, status: "connected", generation: 1 } }),
    disconnect: async (profileId) => ({ status: "ok", state: { profileId, status: "idle", generation: 2 } }),
    pairingQr: async () => ({ status: "ok", qr: { version: 1, dataUrl: "data:image/png;base64,cGFpcmluZw==" } }),
    rotatePhone: async (profileId) => ({
      status: "ok",
      state: { profileId, status: "connected", generation: 2 },
      qr: { version: 1, dataUrl: "data:image/png;base64,cm90YXRlZA==" },
    }),
    deleteLocal: async () => ({ status: "ok" }),
    status: async (profileId) => ({ status: "ok", state: { profileId, status: "idle", generation: 0 } }),
    listStatuses: async () => ({ status: "ok", statuses: [] }),
  };
  const merged = { ...defaultApi, ...api };
  const wgRelay = {};
  for (const method of ["deploy", "connect", "disconnect", "pairingQr", "rotatePhone", "deleteLocal"]) {
    wgRelay[method] = (...args) => {
      calls[method].push(args);
      return merged[method](...args);
    };
  }
  wgRelay.status = (...args) => merged.status(...args);
  wgRelay.listStatuses = (...args) => merged.listStatuses(...args);
  wgRelay.onStatusChanged = (listener) => {
    statusListeners.add(listener);
    return () => { statusListeners.delete(listener); calls.statusUnsubscribed++; };
  };
  wgRelay.onProgress = (listener) => {
    progressListeners.add(listener);
    return () => { progressListeners.delete(listener); calls.progressUnsubscribed++; };
  };

  const state = {
    activeTab: "wg-relay",
    snapshot: { lang: "en", wgRelay: { profiles: profile ? [{ ...profile }] : [] } },
  };
  const core = {
    state,
    helpers: {
      t: (key) => TRANSLATIONS[key] || `translated:${key}`,
      showSettingsConfirmModal: async (options) => {
        calls.confirms.push(options);
        return typeof confirmResult === "function" ? confirmResult(options) : confirmResult;
      },
    },
    ops: {
      requestRender(options) {
        if (options && options.content && state.activeTab === "wg-relay") render();
      },
      showToast(message, options) { calls.toasts.push({ message, options }); },
    },
    tabs: {},
  };
  const context = {
    console,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    document,
    window: runtimeAvailable ? { wgRelay } : {},
    confirm: () => true,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(TAB_SOURCE, context, { filename: "settings-tab-wg-relay.js" });
  context.ClawdSettingsTabWgRelay.init(core);

  function render() {
    calls.renders++;
    content.innerHTML = "";
    core.tabs["wg-relay"].render(content, core);
  }
  render();

  return {
    calls, content, core, document, wgRelay,
    emitStatus(value) { for (const listener of [...statusListeners]) listener(value); },
    emitProgress(value) { for (const listener of [...progressListeners]) listener(value); },
    listenerCounts: () => ({ status: statusListeners.size, progress: progressListeners.size }),
    render,
  };
}

function buttons(root) { return root.querySelectorAll("button"); }
function buttonByText(root, text) { return buttons(root).find((button) => button.textContent === text) || null; }
function setInput(input, value) {
  assert.ok(input, "expected input to exist");
  input.value = value;
  input.dispatchEvent({ type: "input", bubbles: false });
}

test("tab registers a render/onExit/dispose lifecycle without top-level DOM access", () => {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TAB_SOURCE, sandbox);
  assert.equal(typeof sandbox.ClawdSettingsTabWgRelay.init, "function");
  assert.match(TAB_SOURCE, /core\.tabs\["wg-relay"\]\s*=\s*\{[^}]*render[^}]*onExit[^}]*dispose/s);
});

test("first-use card renders exactly four labelled required fields with safe defaults", () => {
  const harness = createHarness();
  const card = harness.content.querySelector(".wg-relay-setup-card");
  assert.ok(card, "first use should be one setup card");
  const inputs = card.querySelectorAll("input");
  assert.equal(inputs.length, 4);
  const labels = card.querySelectorAll("label");
  assert.equal(labels.length, 4);
  for (const label of labels) {
    assert.ok(label.getAttribute("for"));
    assert.ok(inputs.some((input) => input.id === label.getAttribute("for")));
  }
  assert.equal(card.querySelector("#wg-relay-ssh-username").value, "root");
  assert.equal(card.querySelector("#wg-relay-ssh-port").value, "22");
  const password = card.querySelector("#wg-relay-password");
  assert.equal(password.type, "password");
  assert.equal(password.getAttribute("autocomplete"), "new-password");
  assert.equal(card.textContent.includes("51820"), false);
  assert.equal(card.textContent.includes("10.8.0.0/24"), false);
  assert.equal(card.textContent.includes("7891"), false);
  assert.deepEqual(buttons(card).map((button) => button.textContent), ["ONE_CLICK_DEPLOY"]);
  assert.ok(buttons(card).every((button) => button.type === "button"));
});

test("one-click deploy sends {profile,password}, clears password immediately, and coalesces double click", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  setInput(harness.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  const deploy = buttonByText(harness.content, "ONE_CLICK_DEPLOY");
  deploy.dispatchEvent({ type: "click", bubbles: false });
  deploy.dispatchEvent({ type: "click", bubbles: false });

  assert.equal(harness.calls.deploy.length, 1);
  const request = harness.calls.deploy[0][0];
  assert.deepEqual(JSON.parse(JSON.stringify(request.profile)), {
    id: "wg-0000000000004",
    label: "relay.example.test",
    host: "relay.example.test",
    sshUsername: "root",
    sshPort: 22,
    authMethod: "password",
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
  });
  assert.equal(request.password, "unit-test-only");
  assert.equal(Object.hasOwn(request.profile, "password"), false);
  assert.equal(JSON.stringify(request.profile).includes("unit-test-only"), false);
  assert.equal(harness.content.querySelector("#wg-relay-password").value, "");
  assert.ok(harness.content.querySelectorAll("input").every((input) => input.disabled));
  assert.ok(buttons(harness.content).every((button) => button.disabled));

  pending.resolve({ status: "error", errorCode: "deploy_failed", message: "server stderr unit-test-only" });
  await flushPromises();
  const error = harness.content.querySelector(".wg-relay-error");
  assert.equal(error.textContent, "SAFE_DEPLOY_ERROR");
  assert.equal(error.textContent.includes("stderr"), false);
  assert.equal(harness.content.querySelector("#wg-relay-password").value, "");
});

test("an existing undeployed profile becomes a status card before its settings broadcast arrives", async () => {
  const undeployed = {
    id: "wg-test", label: "Test relay", host: "relay.example.test",
    sshUsername: "root", sshPort: 22, authMethod: "password",
    wgPort: 51820, wgSubnet: "10.8.0.0/24",
  };
  const harness = createHarness({ profile: undeployed });
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  buttonByText(harness.content, "ONE_CLICK_DEPLOY").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.ok(harness.content.querySelector(".wg-relay-status-card"));
  assert.equal(harness.content.querySelector(".wg-relay-setup-card"), null);
});

test("deploy progress renders ten fixed localized stages and current/completed/failed states", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  setInput(harness.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  buttonByText(harness.content, "ONE_CLICK_DEPLOY").dispatchEvent({ type: "click", bubbles: false });
  harness.emitProgress({ profileId: "wg-0000000000004", step: "connect", status: "ok" });
  harness.emitProgress({ profileId: "wg-0000000000004", step: "host-key", status: "ok" });
  harness.emitProgress({ profileId: "wg-0000000000004", step: "upload", status: "ok" });
  harness.emitProgress({ profileId: "wg-0000000000004", step: "install", status: "fail" });

  const progress = harness.content.querySelector(".wg-relay-progress");
  assert.ok(progress);
  assert.equal(progress.getAttribute("aria-live"), "polite");
  const rows = progress.querySelectorAll(".wg-relay-progress-stage");
  assert.equal(rows.length, 10);
  assert.ok(rows[0].classList.contains("is-complete"));
  assert.ok(rows[1].classList.contains("is-complete"));
  assert.ok(rows[2].classList.contains("is-complete"));
  assert.ok(rows[3].classList.contains("is-failed"));
  assert.equal(rows[9].classList.contains("is-pending"), true);
  pending.resolve({ status: "error", errorCode: "deploy_failed" });
  await flushPromises();
});

test("deployed card localizes all seven states and uses only connect/disconnect as its primary action", async () => {
  const cases = [
    ["idle", "IDLE", "CONNECT"],
    ["starting_tunnel", "STARTING_TUNNEL", "CONNECT"],
    ["verifying_relay", "VERIFYING_RELAY", "CONNECT"],
    ["connecting_relay", "CONNECTING_RELAY", "CONNECT"],
    ["connected", "CONNECTED", "DISCONNECT"],
    ["disconnecting", "DISCONNECTING", "DISCONNECT"],
    ["failed", "FAILED", "CONNECT"],
  ];
  for (const [status, label, primary] of cases) {
    const harness = createHarness({
      profile: DEPLOYED_PROFILE,
      api: { status: async () => ({ status: "ok", state: { profileId: "wg-test", status, generation: 1 } }) },
    });
    await flushPromises();
    const card = harness.content.querySelector(".wg-relay-status-card");
    assert.ok(card, status);
    assert.equal(card.querySelector(".wg-relay-status-badge").textContent, label, status);
    assert.ok(buttonByText(card, primary), `${status} primary action`);
    for (const secondary of ["SHOW_QR", "ROTATE_PHONE", "REPAIR", "DELETE"]) {
      assert.ok(buttonByText(card, secondary), `${status} ${secondary}`);
    }
  }

  const sourceCalls = [".connect(", ".disconnect(", ".pairingQr(", ".rotatePhone(", ".deleteLocal("];
  for (const call of sourceCalls) assert.ok(TAB_SOURCE.includes(call), call);
  for (const legacy of ["tunnelUp", "tunnelDown", "generateQr", "settingsAPI.command"]) {
    assert.equal(TAB_SOURCE.includes(legacy), false, legacy);
  }
});

test("a late initial status response cannot overwrite a newer status event", async () => {
  const pendingStatus = deferred();
  const harness = createHarness({
    profile: DEPLOYED_PROFILE,
    api: { status: () => pendingStatus.promise },
  });
  harness.emitStatus({ profileId: "wg-test", status: "connected", generation: 3 });
  pendingStatus.resolve({
    status: "ok",
    state: { profileId: "wg-test", status: "idle", generation: 2 },
  });
  await flushPromises();
  assert.equal(harness.content.querySelector(".wg-relay-status-badge").textContent, "CONNECTED");
});

test("a late initial status rejection cannot add an error after a newer status event", async () => {
  const pendingStatus = deferred();
  const harness = createHarness({
    profile: DEPLOYED_PROFILE,
    api: { status: () => pendingStatus.promise },
  });
  harness.emitStatus({ profileId: "wg-test", status: "connected", generation: 3 });
  pendingStatus.reject(new Error("unit-test-only transport detail"));
  await flushPromises();
  assert.equal(harness.content.querySelector(".wg-relay-status-badge").textContent, "CONNECTED");
  assert.equal(harness.content.querySelector(".wg-relay-error"), null);
});

test("missing runtime bridge disables every deployed-card action", () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE, runtimeAvailable: false });
  assert.ok(buttons(harness.content).length >= 5);
  assert.ok(buttons(harness.content).every((button) => button.disabled));
});

test("busy state blocks duplicate/destructive actions and connect/disconnect call the Task 6 API", async () => {
  const pending = deferred();
  const harness = createHarness({ profile: DEPLOYED_PROFILE, api: { connect: () => pending.promise } });
  await flushPromises();
  const connect = buttonByText(harness.content, "CONNECT");
  connect.dispatchEvent({ type: "click", bubbles: false });
  connect.dispatchEvent({ type: "click", bubbles: false });
  assert.equal(harness.calls.connect.length, 1);
  assert.deepEqual(harness.calls.connect[0], ["wg-test"]);
  assert.ok(buttons(harness.content).every((button) => button.disabled));
  pending.resolve({ status: "ok", state: { profileId: "wg-test", status: "connected", generation: 1 } });
  await flushPromises();
  buttonByText(harness.content, "DISCONNECT").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.deepEqual(harness.calls.disconnect[0], ["wg-test"]);
});

test("recovery status requires repair and never attempts an automatic connection", async () => {
  const harness = createHarness({
    profile: DEPLOYED_PROFILE,
    api: { status: async () => ({ status: "error", errorCode: "remote_commit_recovery_required" }) },
  });
  await flushPromises();
  assert.equal(harness.content.querySelector(".wg-relay-recovery").textContent.includes("REPAIR_REQUIRED"), true);
  assert.equal(buttonByText(harness.content, "CONNECT").disabled, true);
  assert.equal(harness.calls.connect.length, 0);
  assert.equal(harness.content.querySelector(".wg-relay-error").textContent, "SAFE_RECOVERY_ERROR");
});

test("recovery codes are accepted from status or errorCode and clear after a healthy status", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  harness.emitStatus({ profileId: "wg-test", status: "remote_commit_recovery_required" });
  assert.ok(harness.content.querySelector(".wg-relay-recovery"));
  assert.equal(buttonByText(harness.content, "CONNECT").disabled, true);
  harness.emitStatus({ profileId: "wg-test", status: "idle", generation: 2 });
  assert.equal(harness.content.querySelector(".wg-relay-recovery"), null);
  assert.equal(harness.content.querySelector(".wg-relay-error"), null);
  assert.equal(buttonByText(harness.content, "CONNECT").disabled, false);
});

test("stable connection subcodes map to localized safe categories without raw detail", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  harness.emitStatus({ profileId: "wg-test", status: "failed", errorCode: "health_timeout" });
  const error = harness.content.querySelector(".wg-relay-error");
  assert.equal(error.textContent, "SAFE_HEALTH_ERROR");
  assert.equal(error.textContent.includes("health_timeout"), false);
});

test("repair asks for a new password, exposes advanced defaults, and does not reuse a prior password", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  buttonByText(harness.content, "REPAIR").dispatchEvent({ type: "click", bubbles: false });
  const repair = harness.content.querySelector(".wg-relay-repair-card");
  assert.ok(repair);
  assert.equal(repair.querySelector("#wg-relay-repair-password").value, "");
  assert.equal(repair.querySelector("#wg-relay-repair-wg-port").value, "51820");
  assert.equal(repair.querySelector("#wg-relay-repair-subnet").value, "10.8.0.0/24");
  assert.equal(repair.querySelector("#wg-relay-repair-relay-port").value, "7891");
  setInput(repair.querySelector("#wg-relay-repair-password"), "unit-test-only-new");
  buttonByText(repair, "REPAIR_DEPLOY").dispatchEvent({ type: "click", bubbles: false });
  assert.equal(harness.calls.deploy.length, 1);
  assert.equal(harness.calls.deploy[0][0].password, "unit-test-only-new");
  assert.equal(Object.hasOwn(harness.calls.deploy[0][0].profile, "password"), false);
  assert.equal(repair.querySelector("#wg-relay-repair-password").value, "");
});

test("pairing QR is fetched on demand and closing it scrubs the image source and references", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  assert.equal(harness.calls.pairingQr.length, 0);
  buttonByText(harness.content, "SHOW_QR").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.deepEqual(harness.calls.pairingQr[0], ["wg-test"]);
  const dialog = harness.document.modalRoot.querySelector(".wg-relay-qr-dialog");
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const image = dialog.querySelector("img");
  assert.match(image.src, /^data:image\/png;base64,/);
  assert.ok(image.alt);
  assert.ok(dialog.querySelector(".wg-relay-qr-warning"));
  buttonByText(dialog, "CLOSE_QR").dispatchEvent({ type: "click", bubbles: false });
  assert.equal(image.src, "");
  assert.equal(image.getAttribute("src"), undefined);
  assert.equal(harness.document.modalRoot.children.length, 0);
});

test("rotate and delete require explicit localized confirmations; rotate replaces QR and delete explains VPS stays running", async () => {
  let confirm = null;
  const harness = createHarness({
    profile: DEPLOYED_PROFILE,
    confirmResult: () => confirm,
  });
  await flushPromises();
  buttonByText(harness.content, "ROTATE_PHONE").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.equal(harness.calls.rotatePhone.length, 0);
  confirm = "confirm";
  buttonByText(harness.content, "ROTATE_PHONE").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.deepEqual(harness.calls.rotatePhone[0], ["wg-test"]);
  assert.match(harness.document.modalRoot.querySelector("img").src, /cm90YXRlZA==$/);
  assert.ok(harness.calls.confirms[0].detail.includes("translated:wgRelayRotateConfirmDetail"));

  buttonByText(harness.content, "DELETE").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.deepEqual(harness.calls.deleteLocal[0], ["wg-test"]);
  const deleteConfirm = harness.calls.confirms.at(-1);
  assert.ok(deleteConfirm.detail.includes("translated:wgRelayDeleteConfirmDetail"));
});

test("late deploy completion after tab exit cannot mutate the view", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  setInput(harness.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  buttonByText(harness.content, "ONE_CLICK_DEPLOY").dispatchEvent({ type: "click", bubbles: false });
  const rendersBeforeExit = harness.calls.renders;
  harness.core.state.activeTab = "general";
  harness.core.tabs["wg-relay"].onExit();
  pending.resolve({
    status: "ok", profile: DEPLOYED_PROFILE,
    state: { profileId: "wg-test", status: "connected", generation: 1 },
    qr: { version: 1, dataUrl: "data:image/png;base64,bGF0ZQ==" },
  });
  await flushPromises();
  assert.equal(harness.calls.renders, rendersBeforeExit);
  assert.equal(harness.document.modalRoot.children.length, 0);
  assert.equal(harness.calls.toasts.length, 0);
  harness.core.state.activeTab = "wg-relay";
  harness.render();
  assert.ok(harness.content.querySelector(".wg-relay-setup-card"), "late result must not install a profile override");
});

test("rerender and disposal unsubscribe status/progress listeners without accumulating peers", () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  assert.deepEqual(harness.listenerCounts(), { status: 1, progress: 1 });
  harness.render();
  assert.deepEqual(harness.listenerCounts(), { status: 1, progress: 1 });
  assert.ok(harness.calls.statusUnsubscribed >= 1);
  assert.ok(harness.calls.progressUnsubscribed >= 1);
  harness.core.tabs["wg-relay"].dispose();
  assert.deepEqual(harness.listenerCounts(), { status: 0, progress: 0 });
});

test("all desktop languages contain every Task 7 key and never fall back to a naked key", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8"), context);
  const strings = context.ClawdSettingsI18n.STRINGS;
  const required = [
    "sidebarWgRelay", "wgRelayTitle", "wgRelaySubtitle", "wgRelayDeploy", "wgRelayDeploying",
    "wgRelayFieldHost", "wgRelayFieldSshUsername", "wgRelayFieldSshPort", "wgRelayFieldPassword",
    "wgRelayStatus_idle", "wgRelayStatus_starting_tunnel", "wgRelayStatus_verifying_relay",
    "wgRelayStatus_connecting_relay", "wgRelayStatus_connected", "wgRelayStatus_disconnecting",
    "wgRelayStatus_failed", "wgRelayConnect", "wgRelayDisconnect", "wgRelayShowQr",
    "wgRelayRotatePhone", "wgRelayRepair", "wgRelayDelete", "wgRelayRecoveryRequired",
    "wgRelayStep_connect", "wgRelayStep_fingerprint", "wgRelayStep_upload", "wgRelayStep_dependencies",
    "wgRelayStep_wireguard", "wgRelayStep_relay", "wgRelayStep_verify", "wgRelayStep_save",
    "wgRelayStep_pcConnect", "wgRelayStep_qr", "wgRelayProgress_pending", "wgRelayProgress_current",
    "wgRelayProgress_completed", "wgRelayProgress_failed", "wgRelayQrTitle", "wgRelayQrAlt",
    "wgRelayQrWarning", "wgRelayQrClose", "wgRelayRotateConfirmTitle", "wgRelayRotateConfirmDetail",
    "wgRelayDeleteConfirmTitle", "wgRelayDeleteConfirmDetail", "wgRelayRepairTitle",
    "wgRelayRepairDeploy", "wgRelayFieldWgPort", "wgRelayFieldSubnet", "wgRelayFieldRelayPort",
    "wgRelayError_deploy_failed", "wgRelayError_remote_commit_recovery_required",
    "wgRelayError_profile_conflict_recovery_required", "wgRelayError_unknown",
  ];
  assert.deepEqual(Object.keys(strings).sort(), [...SUPPORTED_LANGS].sort());
  for (const lang of SUPPORTED_LANGS) {
    for (const key of required) {
      assert.equal(typeof strings[lang][key], "string", `${lang}.${key}`);
      assert.notEqual(strings[lang][key], key, `${lang}.${key} naked fallback`);
      assert.ok(strings[lang][key].trim(), `${lang}.${key} nonempty`);
    }
  }
  assert.equal(strings.en.sidebarWgRelay, "Remote Connection");
  assert.equal(strings.zh.sidebarWgRelay, "远程连接");
  assert.equal(strings.en.wgRelayDeploy, "One-click deploy");
  assert.equal(strings.zh.wgRelayDeploy, "一键部署");
});

test("source and CSS include password/a11y/responsive/reduced-motion security hooks", () => {
  const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
  assert.match(TAB_SOURCE, /autocomplete[\s\S]*new-password/);
  assert.match(TAB_SOURCE, /aria-live/);
  assert.match(TAB_SOURCE, /aria-modal/);
  assert.match(TAB_SOURCE, /Escape/);
  assert.doesNotMatch(TAB_SOURCE, /dataset\.[A-Za-z]*password/i);
  assert.doesNotMatch(TAB_SOURCE, /manualUrl|manualToken|relayToken/);
  assert.match(css, /@media\s*\(max-width:\s*420px\)[\s\S]*\.wg-relay-/);
  assert.match(css, /\.wg-relay-[^{]*:focus-visible/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

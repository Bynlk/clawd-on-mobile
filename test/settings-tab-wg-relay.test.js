"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const VIEW_MODEL_SOURCE = fs.readFileSync(path.join(SRC_DIR, "settings-wg-relay-view-model.js"), "utf8");
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

function parseCssColor(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return {
      red: Number.parseInt(text.slice(1, 3), 16),
      green: Number.parseInt(text.slice(3, 5), 16),
      blue: Number.parseInt(text.slice(5, 7), 16),
      alpha: 1,
    };
  }
  const rgba = text.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i);
  if (!rgba) throw new Error(`Unsupported CSS color: ${text}`);
  return {
    red: Number(rgba[1]), green: Number(rgba[2]), blue: Number(rgba[3]), alpha: Number(rgba[4]),
  };
}

function compositeCssColor(foreground, background) {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  const channel = (key) => (
    foreground[key] * foreground.alpha
      + background[key] * background.alpha * (1 - foreground.alpha)
  ) / alpha;
  return { red: channel("red"), green: channel("green"), blue: channel("blue"), alpha };
}

function contrastRatio(first, second) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color) => (
    0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
  );
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function cssVariables(block) {
  const values = new Map();
  for (const match of String(block).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    values.set(match[1], match[2].trim());
  }
  return values;
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

class FakeNodeList {
  constructor(values) {
    this._values = [...values];
    this.length = this._values.length;
    this._values.forEach((value, index) => { this[index] = value; });
  }
  item(index) { return this._values[index] || null; }
  forEach(callback, thisArg) { this._values.forEach(callback, thisArg); }
  [Symbol.iterator]() { return this._values[Symbol.iterator](); }
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
    this.hidden = false;
    this.inert = false;
    this.open = false;
    this.tabIndex = 0;
    this.src = "";
    this.alt = "";
    this.classList = new FakeClassList(this);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    child.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
  get isConnected() { return Boolean(this.ownerDocument && this.ownerDocument.body.contains(this)); }
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
    if (name === "inert") this.inert = true;
    if (name === "open") this.open = true;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
      this.dataset[key] = text;
    }
  }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "src") this.src = "";
    if (name === "inert") this.inert = false;
    if (name === "open") this.open = false;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
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
    let current = this;
    while (current) {
      if (current.inert || current.disabled || current.hidden) return;
      current = current.parentNode;
    }
    if (this.ownerDocument && this.isConnected) this.ownerDocument.activeElement = this;
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
    return new FakeNodeList(result);
  }
  querySelector(selector) { return this.querySelectorAll(selector).item(0); }
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
  getElementById(id) {
    if (id === "modalRoot") return this.modalRoot;
    return this.body.querySelector(`#${id}`);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) {
    const value = {
      type,
      ...event,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.cancelBubble = true; },
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(value);
    return value;
  }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }
}

const TRANSLATIONS = {
  wgRelayDeploy: "ONE_CLICK_DEPLOY",
  wgRelayDeploying: "DEPLOYING",
  wgRelayTryDeployAgain: "TRY_DEPLOY_AGAIN",
  wgRelayConnect: "CONNECT",
  wgRelayConnecting: "CONNECTING",
  wgRelayDisconnect: "DISCONNECT",
  wgRelayDisconnecting: "DISCONNECTING_ACTION",
  wgRelayShowQr: "SHOW_QR",
  wgRelayRotatePhone: "ROTATE_PHONE",
  wgRelayRepair: "REPAIR",
  wgRelayDelete: "DELETE",
  wgRelayRepairDeploy: "REPAIR_DEPLOY",
  wgRelayCancel: "CANCEL",
  wgRelayQrClose: "CLOSE_QR",
  wgRelayRotateConfirmAction: "CONFIRM_ROTATE",
  wgRelayDeleteConfirmAction: "CONFIRM_DELETE",
  wgRelayVpsRow: "VPS_RELAY",
  wgRelayComputerRow: "THIS_COMPUTER",
  wgRelayAndroidRow: "ANDROID",
  wgRelayVpsConfigured: "VPS_CONFIGURED",
  wgRelayAndroidPairingAvailable: "ANDROID_READY",
  wgRelayAndroidUnavailable: "ANDROID_UNAVAILABLE",
  wgRelayAdvancedManagement: "ADVANCED_MANAGEMENT",
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
  wgRelayError_secure_storage_unavailable: "SAFE_STORAGE_ERROR",
  wgRelayError_secret_store_read_failed: "SAFE_STORAGE_READ_ERROR",
  wgRelayError_secrets_not_found: "SAFE_SECRETS_MISSING_ERROR",
  wgRelayError_profile_not_found: "SAFE_PROFILE_MISSING_ERROR",
  wgRelayError_health_failed: "SAFE_HEALTH_ERROR",
  wgRelayError_unknown: "SAFE_UNKNOWN_ERROR",
  wgRelayProgressLabel: "DEPLOY_PROGRESS",
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

function createHarness({ profile = null, api = {}, runtimeAvailable = true } = {}) {
  const document = new FakeDocument();
  const content = new FakeElement("main", document);
  document.body.appendChild(content);
  const calls = {
    deploy: [], connect: [], disconnect: [], pairingQr: [], rotatePhone: [], deleteLocal: [], status: [],
    toasts: [], renders: 0, statusUnsubscribed: 0, progressUnsubscribed: 0,
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
  wgRelay.status = (...args) => {
    calls.status.push(args);
    return merged.status(...args);
  };
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
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      context.timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
    timers: [],
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(VIEW_MODEL_SOURCE, context, { filename: "settings-wg-relay-view-model.js" });
  assert.equal(
    typeof context.ClawdSettingsWgRelayViewModel.deriveWgRelayPageModel,
    "function",
  );
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
    runTimers() {
      const pending = context.timers.splice(0);
      for (const timer of pending) if (!timer.cancelled) timer.callback();
    },
    render,
  };
}

function buttons(root) { return Array.from(root.querySelectorAll("button")); }
function buttonByText(root, text) { return buttons(root).find((button) => button.textContent === text) || null; }
function computerStatusText(root) {
  const row = Array.from(root.querySelectorAll(".wg-relay-domain-row"))
    .find((item) => item.dataset.domain === "computer");
  return row && row.querySelector(".wg-relay-domain-status")
    ? row.querySelector(".wg-relay-domain-status").textContent
    : null;
}
function setInput(input, value) {
  assert.ok(input, "expected input to exist");
  input.value = value;
  input.dispatchEvent({ type: "input", bubbles: false });
}

test("tab registers a render/onExit/dispose lifecycle without top-level DOM access", () => {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_MODEL_SOURCE, sandbox);
  vm.runInContext(TAB_SOURCE, sandbox);
  assert.equal(typeof sandbox.ClawdSettingsTabWgRelay.init, "function");
  assert.match(TAB_SOURCE, /core\.tabs\["wg-relay"\]\s*=\s*\{[^}]*render[^}]*onExit[^}]*dispose/s);
});

test("renderer treats querySelectorAll as NodeList and normalizes before Array-only methods", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  const list = harness.content.querySelectorAll("button");
  assert.equal(typeof list[Symbol.iterator], "function");
  assert.equal(typeof list.forEach, "function");
  assert.equal(list.item(0), list[0]);
  assert.equal(list.filter, undefined);
  assert.equal(list.find, undefined);
  assert.equal(list.every, undefined);
  let visited = 0;
  list.forEach(() => { visited++; });
  assert.equal(visited, list.length);
  assert.doesNotMatch(
    TAB_SOURCE,
    /querySelectorAll\([^)]*\)\s*\.(?:filter|find)\(/s,
  );
  for (const line of TAB_SOURCE.split("\n").filter((sourceLine) => sourceLine.includes("querySelectorAll("))) {
    assert.ok(line.includes("Array.from("), `querySelectorAll must be normalized: ${line.trim()}`);
  }

  const showQr = buttonByText(harness.content, "SHOW_QR");
  showQr.focus();
  showQr.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  harness.document.emit("keydown", { key: "Tab" });
  harness.document.emit("keydown", { key: "Escape" });
  harness.core.tabs["wg-relay"].onExit();
  assert.equal(harness.document.listenerCount("keydown"), 0);
  assert.equal(harness.document.modalRoot.children.length, 0);
});

test("first-use form renders exactly four labelled required fields with safe defaults", () => {
  const harness = createHarness();
  const form = harness.content.querySelector(".wg-relay-setup-form");
  assert.ok(form, "first use should be one setup form");
  const inputs = Array.from(form.querySelectorAll("input"));
  assert.equal(inputs.length, 4);
  const labels = Array.from(form.querySelectorAll("label"));
  assert.equal(labels.length, 4);
  for (const label of labels) {
    assert.ok(label.getAttribute("for"));
    assert.ok(inputs.some((input) => input.id === label.getAttribute("for")));
  }
  assert.equal(form.querySelector("#wg-relay-ssh-username").value, "root");
  assert.equal(form.querySelector("#wg-relay-ssh-port").value, "22");
  const password = form.querySelector("#wg-relay-password");
  assert.equal(password.type, "password");
  assert.equal(password.getAttribute("autocomplete"), "new-password");
  assert.equal(password.getAttribute("aria-describedby"), "wg-relay-password-hint");
  assert.equal(form.textContent.includes("51820"), false);
  assert.equal(form.textContent.includes("10.8.0.0/24"), false);
  assert.equal(form.textContent.includes("7891"), false);
  assert.deepEqual(buttons(form).map((button) => button.textContent), ["ONE_CLICK_DEPLOY"]);
  assert.equal(buttons(form)[0].type, "submit");
  assert.equal(form.querySelectorAll(".accent").length, 1);
});

test("one-click deploy submits on Enter, clears password immediately, and coalesces repeats", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  const form = harness.content.querySelector(".wg-relay-setup-form");
  setInput(form.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(form.querySelector("#wg-relay-password"), "unit-test-only");
  form.dispatchEvent({ type: "submit", bubbles: false });
  form.dispatchEvent({ type: "submit", bubbles: false });

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
  assert.equal(form.querySelector("#wg-relay-password").value, "");
  assert.equal(harness.content.querySelector(".wg-relay-setup-form"), null);
  const surface = harness.content.querySelector(".wg-relay-deployment-surface");
  assert.ok(surface);
  assert.equal(surface.querySelectorAll("input").length, 0);
  assert.equal(surface.querySelectorAll(".accent").length, 1);
  assert.equal(surface.querySelector(".accent").disabled, true);

  pending.resolve({ status: "error", errorCode: "deploy_failed", message: "server stderr unit-test-only" });
  await flushPromises();
  const error = harness.content.querySelector(".wg-relay-action-callout");
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(error.textContent, "SAFE_DEPLOY_ERROR");
  assert.equal(error.textContent.includes("stderr"), false);
  assert.equal(harness.content.querySelector("#wg-relay-password"), null);
});

test("first-use validation keeps non-password draft and exposes one adjacent alert", () => {
  const harness = createHarness();
  const form = harness.content.querySelector(".wg-relay-setup-form");
  setInput(form.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(form.querySelector("#wg-relay-password"), "");
  form.dispatchEvent({ type: "submit", bubbles: false });

  const nextForm = harness.content.querySelector(".wg-relay-setup-form");
  assert.equal(harness.calls.deploy.length, 0);
  assert.equal(nextForm.querySelector("#wg-relay-host").value, "relay.example.test");
  assert.equal(nextForm.querySelector("#wg-relay-ssh-username").value, "root");
  assert.equal(nextForm.querySelector("#wg-relay-ssh-port").value, "22");
  assert.equal(nextForm.querySelector("#wg-relay-password").value, "");
  assert.equal(
    Array.from(nextForm.querySelectorAll("div"))
      .filter((node) => node.getAttribute("role") === "alert").length,
    1,
  );
  assert.equal(JSON.stringify(harness.core.state.snapshot).includes("unit-test-only"), false);
});

test("an existing undeployed profile becomes a status card before its settings broadcast arrives", async () => {
  const undeployed = {
    id: "wg-test", label: "Test relay", host: "relay.example.test",
    sshUsername: "root", sshPort: 22, authMethod: "password",
    wgPort: 51820, wgSubnet: "10.8.0.0/24",
  };
  const harness = createHarness({ profile: undeployed });
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  harness.content.querySelector(".wg-relay-setup-form").dispatchEvent({ type: "submit", bubbles: false });
  await flushPromises();
  assert.ok(harness.content.querySelector(".wg-relay-status-card"));
  assert.equal(harness.content.querySelector(".wg-relay-setup-card"), null);
});

test("deploy progress renders ten fixed localized stages and current/completed/failed states", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  setInput(harness.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  harness.content.querySelector(".wg-relay-setup-form").dispatchEvent({ type: "submit", bubbles: false });
  assert.equal(harness.content.querySelector(".wg-relay-setup-form"), null);
  const surface = harness.content.querySelector(".wg-relay-deployment-surface");
  assert.ok(surface);
  assert.equal(surface.querySelectorAll("input").length, 0);
  assert.ok(surface.querySelector(".wg-relay-current-step"));
  assert.ok(surface.querySelector("progress"));
  const details = surface.querySelector("details");
  assert.ok(details);
  assert.equal(details.open, false);
  assert.equal(details.querySelectorAll(".wg-relay-progress-stage").length, 10);
  assert.equal(surface.querySelectorAll(".accent").length, 1);
  assert.equal(surface.querySelector(".accent").disabled, true);
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
  const failure = harness.content.querySelector(".wg-relay-deployment-failure");
  assert.ok(failure);
  assert.equal(failure.querySelectorAll(".wg-relay-action-callout").length, 1);
  assert.equal(failure.querySelector(".wg-relay-action-callout").getAttribute("role"), "alert");
  assert.equal(
    Array.from(failure.querySelectorAll(".wg-relay-progress-stage"))
      .filter((row) => row.classList.contains("is-pending")).length,
    0,
  );
  assert.equal(failure.querySelectorAll(".accent").length, 1);
  buttonByText(failure, "TRY_DEPLOY_AGAIN").dispatchEvent({ type: "click", bubbles: false });
  assert.equal(harness.content.querySelector("#wg-relay-host").value, "relay.example.test");
  assert.equal(harness.content.querySelector("#wg-relay-password").value, "");
  assert.equal(harness.content.querySelector(".wg-relay-progress"), null);

  const successfulDeploy = deferred();
  const successful = createHarness({ api: { deploy: () => successfulDeploy.promise } });
  setInput(successful.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(successful.content.querySelector("#wg-relay-password"), "unit-test-only");
  successful.content.querySelector(".wg-relay-setup-form").dispatchEvent({ type: "submit", bubbles: false });
  successful.emitProgress({ profileId: "wg-0000000000004", step: "validate", status: "ok" });
  let successfulRows = successful.content.querySelectorAll(".wg-relay-progress-stage");
  assert.equal(successfulRows[6].classList.contains("is-complete"), true);
  assert.equal(successfulRows[7].classList.contains("is-current"), true, "validated remote state starts local save");

  successful.emitStatus({ profileId: "wg-0000000000004", status: "disconnecting", generation: 1 });
  successfulRows = successful.content.querySelectorAll(".wg-relay-progress-stage");
  assert.equal(successfulRows[7].classList.contains("is-current"), true, "old connection release does not advance local save");
  assert.equal(successfulRows[8].classList.contains("is-pending"), true);

  successful.emitStatus({ profileId: "wg-0000000000004", status: "starting_tunnel", generation: 1 });
  successfulRows = successful.content.querySelectorAll(".wg-relay-progress-stage");
  assert.equal(successfulRows[7].classList.contains("is-complete"), true);
  assert.equal(successfulRows[8].classList.contains("is-current"), true);
  assert.equal(successfulRows[9].classList.contains("is-pending"), true);

  successful.emitStatus({ profileId: "wg-0000000000004", status: "connected", generation: 2 });
  successfulRows = successful.content.querySelectorAll(".wg-relay-progress-stage");
  assert.equal(successfulRows[8].classList.contains("is-complete"), true);
  assert.equal(successfulRows[9].classList.contains("is-current"), true);

  successfulDeploy.resolve({
    status: "ok",
    profile: DEPLOYED_PROFILE,
    state: { profileId: "wg-test", status: "connected", generation: 2 },
    qr: { version: 1, dataUrl: "data:image/png;base64,ZGVwbG95" },
  });
  await flushPromises();
  assert.ok(successful.content.querySelector(".wg-relay-status-card"));
  assert.equal(successful.content.querySelector(".wg-relay-deployment-surface"), null);
});

test("deployment failure without progress never renders ten pending rows", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  setInput(harness.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  harness.content.querySelector(".wg-relay-setup-form").dispatchEvent({ type: "submit", bubbles: false });
  pending.resolve({ status: "error", errorCode: "deploy_failed" });
  await flushPromises();

  const failure = harness.content.querySelector(".wg-relay-deployment-failure");
  assert.ok(failure);
  const rows = Array.from(failure.querySelectorAll(".wg-relay-progress-stage"));
  assert.equal(rows.length, 1);
  assert.equal(rows.filter((row) => row.classList.contains("is-pending")).length, 0);
});

test("deployed daily card renders three domain rows, one primary action, and advanced management", async () => {
  const cases = [
    ["idle", "IDLE", "CONNECT"],
    ["starting_tunnel", "STARTING_TUNNEL", "CONNECTING"],
    ["verifying_relay", "VERIFYING_RELAY", "CONNECTING"],
    ["connecting_relay", "CONNECTING_RELAY", "CONNECTING"],
    ["connected", "CONNECTED", "DISCONNECT"],
    ["disconnecting", "DISCONNECTING", "DISCONNECTING_ACTION"],
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
    const rows = Array.from(card.querySelectorAll(".wg-relay-domain-row"));
    assert.deepEqual(rows.map((row) => row.dataset.domain), ["vps", "computer", "android"]);
    assert.equal(rows[0].querySelector(".wg-relay-domain-name").textContent, "VPS_RELAY");
    assert.equal(rows[0].querySelector(".wg-relay-domain-status").textContent, "VPS_CONFIGURED");
    assert.equal(rows[0].querySelector(".wg-relay-domain-supporting").textContent, "relay.example.test");
    assert.equal(rows[1].querySelector(".wg-relay-domain-name").textContent, "THIS_COMPUTER");
    assert.equal(rows[1].querySelector(".wg-relay-domain-status").textContent, label, status);
    assert.equal(rows[2].querySelector(".wg-relay-domain-name").textContent, "ANDROID");
    const primaryButton = buttonByText(card, primary);
    assert.ok(primaryButton, `${status} primary action`);
    assert.ok(primaryButton.classList.contains("accent"));
    assert.equal(card.querySelectorAll(".accent").length, 1);
    const qr = buttonByText(rows[2], "SHOW_QR");
    assert.ok(qr, `${status} android QR action`);
    assert.equal(qr.classList.contains("accent"), false);
    const advanced = card.querySelector(".wg-relay-advanced-management");
    assert.ok(advanced);
    assert.equal(advanced.open, false);
    assert.deepEqual(buttons(advanced).map((button) => button.textContent), [
      "ROTATE_PHONE", "REPAIR", "DELETE",
    ]);
    assert.equal(card.querySelector(".wg-relay-progress"), null);
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
  assert.equal(computerStatusText(harness.content), "CONNECTED");
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
  assert.equal(computerStatusText(harness.content), "CONNECTED");
  assert.equal(harness.content.querySelector(".wg-relay-error"), null);

  let attempts = 0;
  const transient = createHarness({
    profile: DEPLOYED_PROFILE,
    api: {
      status: (profileId) => {
        attempts++;
        if (attempts === 1) throw new Error("unit-test-only transient status failure");
        return Promise.resolve({ status: "ok", state: { profileId, status: "connected", generation: 2 } });
      },
    },
  });
  await flushPromises();
  assert.equal(transient.calls.status.length, 1);
  transient.runTimers();
  await flushPromises();
  assert.equal(transient.calls.status.length, 2);
  assert.equal(computerStatusText(transient.content), "CONNECTED");
  transient.render();
  assert.equal(transient.calls.status.length, 2, "a settled successful identity is not duplicated");

  let malformedAttempts = 0;
  const malformed = createHarness({
    profile: DEPLOYED_PROFILE,
    api: {
      status: async (profileId) => {
        malformedAttempts++;
        return malformedAttempts === 1
          ? null
          : { status: "ok", state: { profileId, status: "connected", generation: 2 } };
      },
    },
  });
  await flushPromises();
  malformed.runTimers();
  await flushPromises();
  assert.equal(malformed.calls.status.length, 2);
  assert.equal(computerStatusText(malformed.content), "CONNECTED");

  const bounded = createHarness({
    profile: DEPLOYED_PROFILE,
    api: { status: async () => { throw new Error("unit-test-only persistent status failure"); } },
  });
  await flushPromises();
  bounded.runTimers();
  await flushPromises();
  bounded.runTimers();
  await flushPromises();
  bounded.runTimers();
  await flushPromises();
  assert.equal(bounded.calls.status.length, 3, "status backoff must stop after its bounded attempts");

  const cancelled = createHarness({
    profile: DEPLOYED_PROFILE,
    api: { status: async () => { throw new Error("unit-test-only transient status failure"); } },
  });
  await flushPromises();
  cancelled.core.state.activeTab = "general";
  cancelled.core.tabs["wg-relay"].onExit();
  cancelled.runTimers();
  await flushPromises();
  assert.equal(cancelled.calls.status.length, 1, "epoch changes must cancel a scheduled retry");
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
  for (const [errorCode, errorText] of [
    ["remote_commit_recovery_required", "SAFE_RECOVERY_ERROR"],
    ["profile_conflict_recovery_required", "SAFE_CONFLICT_ERROR"],
    ["secure_storage_unavailable", "SAFE_STORAGE_ERROR"],
    ["secret_store_read_failed", "SAFE_STORAGE_READ_ERROR"],
    ["secret_store_preflight_failed", "SAFE_STORAGE_ERROR"],
    ["secret_store_verification_failed", "SAFE_STORAGE_ERROR"],
    ["secrets_not_found", "SAFE_SECRETS_MISSING_ERROR"],
    ["profile_not_found", "SAFE_PROFILE_MISSING_ERROR"],
  ]) {
    const harness = createHarness({
      profile: DEPLOYED_PROFILE,
      api: { status: async () => ({ status: "error", errorCode }) },
    });
    await flushPromises();
    const card = harness.content.querySelector(".wg-relay-status-card");
    assert.equal(card.querySelectorAll(".wg-relay-action-callout").length, 1, errorCode);
    const callout = card.querySelector(".wg-relay-action-callout");
    assert.equal(callout.getAttribute("role"), "alert", errorCode);
    assert.equal(callout.textContent, errorText, errorCode);
    assert.equal(card.querySelectorAll(".wg-relay-error").length, 0, errorCode);
    assert.equal(card.querySelectorAll(".wg-relay-recovery").length, 0, errorCode);
    assert.ok(buttonByText(harness.content, "CONNECT") === null, errorCode);
    const primary = harness.content.querySelector(".wg-relay-primary-action");
    assert.equal(primary.textContent, "REPAIR", errorCode);
    assert.equal(primary.classList.contains("accent"), true, errorCode);
    assert.equal(primary.disabled, false, errorCode);
    assert.equal(card.querySelectorAll(".accent").length, 1, errorCode);
    assert.equal(buttonByText(card, "SHOW_QR"), null, errorCode);
    assert.equal(buttonByText(card, "ROTATE_PHONE"), null, errorCode);
    assert.ok(buttonByText(card, "DELETE"), errorCode);
    assert.equal(harness.calls.connect.length, 0, errorCode);
  }
});

test("recovery codes are accepted from status or errorCode and clear after a healthy status", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  harness.emitStatus({ profileId: "wg-test", status: "remote_commit_recovery_required" });
  assert.ok(harness.content.querySelector(".wg-relay-action-callout"));
  assert.equal(harness.content.querySelector(".wg-relay-primary-action").textContent, "REPAIR");
  assert.equal(buttonByText(harness.content, "CONNECT"), null);
  harness.emitStatus({ profileId: "wg-test", status: "idle", generation: 2 });
  assert.equal(harness.content.querySelector(".wg-relay-action-callout"), null);
  assert.equal(buttonByText(harness.content, "CONNECT").disabled, false);
});

test("stable connection subcodes map to localized safe categories without raw detail", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  harness.emitStatus({ profileId: "wg-test", status: "failed", errorCode: "health_timeout" });
  const error = harness.content.querySelector(".wg-relay-action-callout");
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
  const host = repair.querySelector("#wg-relay-repair-host");
  const sshPort = repair.querySelector("#wg-relay-repair-ssh-port");
  const subnet = repair.querySelector("#wg-relay-repair-subnet");
  const password = repair.querySelector("#wg-relay-repair-password");
  setInput(host, "draft-relay.example.test");
  setInput(sshPort, "2222");
  setInput(subnet, "10.27.0.0/24");
  setInput(password, "unit-test-only-new");
  password.focus();

  harness.emitStatus({ profileId: "wg-test", status: "connected", generation: 3 });
  const patchedRepair = harness.content.querySelector(".wg-relay-repair-card");
  assert.ok(patchedRepair === repair, "status updates must patch without replacing the active repair form");
  assert.ok(patchedRepair.querySelector("#wg-relay-repair-host") === host);
  assert.ok(patchedRepair.querySelector("#wg-relay-repair-password") === password);
  assert.equal(host.value, "draft-relay.example.test");
  assert.equal(sshPort.value, "2222");
  assert.equal(subnet.value, "10.27.0.0/24");
  assert.equal(password.value, "unit-test-only-new");
  assert.equal(harness.document.activeElement, password);

  buttonByText(repair, "REPAIR_DEPLOY").dispatchEvent({ type: "click", bubbles: false });
  assert.equal(harness.calls.deploy.length, 1);
  assert.equal(harness.calls.deploy[0][0].password, "unit-test-only-new");
  assert.equal(harness.calls.deploy[0][0].profile.host, "draft-relay.example.test");
  assert.equal(harness.calls.deploy[0][0].profile.sshPort, 2222);
  assert.equal(harness.calls.deploy[0][0].profile.wgSubnet, "10.27.0.0/24");
  assert.equal(Object.hasOwn(harness.calls.deploy[0][0].profile, "password"), false);
  assert.equal(password.value, "");
});

test("pairing QR is fetched on demand and closing it scrubs the image source and references", async () => {
  const harness = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  assert.equal(harness.calls.pairingQr.length, 0);
  const trigger = buttonByText(harness.content, "SHOW_QR");
  trigger.focus();
  trigger.dispatchEvent({ type: "click", bubbles: false });
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
  const close = buttonByText(dialog, "CLOSE_QR");
  assert.equal(harness.document.activeElement, close);
  assert.equal(harness.content.inert, true);
  assert.equal(harness.content.getAttribute("aria-hidden"), "true");
  assert.equal(harness.document.listenerCount("keydown"), 1);
  const tab = harness.document.emit("keydown", { key: "Tab", shiftKey: false });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(harness.document.activeElement, close, "Tab wraps within the QR dialog");
  const shiftTab = harness.document.emit("keydown", { key: "Tab", shiftKey: true });
  assert.equal(shiftTab.defaultPrevented, true);
  assert.equal(harness.document.activeElement, close, "Shift+Tab wraps within the QR dialog");
  harness.document.emit("keydown", { key: "Escape" });
  assert.equal(image.src, "");
  assert.equal(image.getAttribute("src"), undefined);
  assert.equal(harness.document.modalRoot.children.length, 0);
  assert.equal(harness.content.inert, false);
  assert.equal(harness.content.getAttribute("aria-hidden"), undefined);
  assert.equal(harness.document.listenerCount("keydown"), 0);
  assert.equal(harness.document.activeElement, trigger);

  trigger.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  const rerenderImage = harness.document.modalRoot.querySelector("img");
  assert.ok(rerenderImage);
  harness.render();
  assert.equal(rerenderImage.src, "");
  assert.equal(harness.document.modalRoot.children.length, 0);
  assert.equal(harness.document.listenerCount("keydown"), 0);
  assert.equal(harness.content.inert, false);
  assert.ok(harness.document.activeElement === buttonByText(harness.content, "SHOW_QR"));

  const disposed = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  const disposedTrigger = buttonByText(disposed.content, "SHOW_QR");
  disposedTrigger.focus();
  disposedTrigger.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  const disposedImage = disposed.document.modalRoot.querySelector("img");
  disposed.core.tabs["wg-relay"].dispose();
  assert.equal(disposedImage.src, "");
  assert.equal(disposed.document.modalRoot.children.length, 0);
  assert.equal(disposed.document.listenerCount("keydown"), 0);
  assert.equal(disposed.content.inert, false);
  assert.equal(disposed.document.activeElement, disposedTrigger);
});

test("rotate and delete require explicit localized confirmations; rotate replaces QR and delete explains VPS stays running", async () => {
  const rotateResult = deferred();
  const harness = createHarness({
    profile: DEPLOYED_PROFILE,
    api: {
      rotatePhone: () => rotateResult.promise,
    },
  });
  await flushPromises();
  let rotate = buttonByText(harness.content, "ROTATE_PHONE");
  rotate.focus();
  rotate.dispatchEvent({ type: "click", bubbles: false });
  rotate.dispatchEvent({ type: "click", bubbles: false });
  let confirmDialog = harness.document.modalRoot.querySelector(".settings-confirm-modal");
  assert.ok(confirmDialog);
  assert.equal(confirmDialog.getAttribute("role"), "dialog");
  assert.equal(confirmDialog.getAttribute("aria-modal"), "true");
  assert.equal(confirmDialog.getAttribute("aria-labelledby"), "wg-relay-confirm-title");
  assert.equal(harness.document.getElementById("wg-relay-confirm-title").tagName, "H2");
  assert.equal(harness.content.inert, true);
  assert.equal(harness.content.getAttribute("aria-hidden"), "true");
  assert.equal(harness.document.modalRoot.children.length, 1, "double click owns one confirm modal");
  assert.equal(harness.calls.rotatePhone.length, 0);
  assert.equal(Array.from(harness.content.querySelectorAll("button")).every((button) => button.disabled), true);
  assert.equal(harness.document.activeElement, buttonByText(confirmDialog, "CANCEL"));
  const confirmTab = harness.document.emit("keydown", { key: "Tab", shiftKey: false });
  assert.equal(confirmTab.defaultPrevented, true);
  assert.equal(harness.document.activeElement, buttonByText(confirmDialog, "CONFIRM_ROTATE"));
  harness.document.emit("keydown", { key: "Tab", shiftKey: false });
  assert.equal(harness.document.activeElement, buttonByText(confirmDialog, "CANCEL"));
  harness.document.emit("keydown", { key: "Tab", shiftKey: true });
  assert.equal(harness.document.activeElement, buttonByText(confirmDialog, "CONFIRM_ROTATE"));

  const cancelledConfirm = buttonByText(confirmDialog, "CONFIRM_ROTATE");
  harness.render();
  await flushPromises();
  cancelledConfirm.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.equal(harness.calls.rotatePhone.length, 0);
  assert.equal(harness.document.modalRoot.children.length, 0);
  assert.equal(harness.document.listenerCount("keydown"), 0);

  rotate = buttonByText(harness.content, "ROTATE_PHONE");
  rotate.dispatchEvent({ type: "click", bubbles: false });
  confirmDialog = harness.document.modalRoot.querySelector(".settings-confirm-modal");
  const staleConfirm = buttonByText(confirmDialog, "CONFIRM_ROTATE");
  harness.emitStatus({ profileId: "wg-test", status: "connected", generation: 4 });
  staleConfirm.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.equal(harness.calls.rotatePhone.length, 0, "a changed status revision invalidates the confirmation owner");

  rotate = buttonByText(harness.content, "ROTATE_PHONE");
  rotate.dispatchEvent({ type: "click", bubbles: false });
  confirmDialog = harness.document.modalRoot.querySelector(".settings-confirm-modal");
  buttonByText(confirmDialog, "CONFIRM_ROTATE").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.deepEqual(harness.calls.rotatePhone[0], ["wg-test"]);
  rotateResult.resolve({
    status: "ok",
    state: { profileId: "wg-test", status: "connected", generation: 5 },
    qr: { version: 1, dataUrl: "data:image/png;base64,cm90YXRlZA==" },
  });
  await flushPromises();
  assert.match(harness.document.modalRoot.querySelector("img").src, /cm90YXRlZA==$/);
  const oldQrImage = harness.document.modalRoot.querySelector("img");
  const oldQrClose = buttonByText(harness.document.modalRoot, "CLOSE_QR");

  let deleteButton = buttonByText(harness.content, "DELETE");
  deleteButton.dispatchEvent({ type: "click", bubbles: false });
  confirmDialog = harness.document.modalRoot.querySelector(".settings-confirm-modal");
  assert.ok(confirmDialog);
  assert.equal(oldQrImage.src, "", "a new confirm owner scrubs the replaced QR");
  oldQrClose.dispatchEvent({ type: "click", bubbles: false });
  assert.equal(harness.document.modalRoot.querySelector(".settings-confirm-modal"), confirmDialog, "stale QR close cannot clear a newer owner");
  assert.equal(harness.document.activeElement, buttonByText(confirmDialog, "CANCEL"));
  buttonByText(confirmDialog, "CANCEL").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();

  deleteButton = buttonByText(harness.content, "DELETE");
  deleteButton.dispatchEvent({ type: "click", bubbles: false });
  const exitedConfirm = buttonByText(harness.document.modalRoot, "CONFIRM_DELETE");
  harness.core.state.activeTab = "general";
  harness.core.tabs["wg-relay"].onExit();
  exitedConfirm.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.equal(harness.calls.deleteLocal.length, 0);
  assert.equal(harness.document.modalRoot.children.length, 0);
  assert.equal(harness.document.listenerCount("keydown"), 0);
  harness.core.state.activeTab = "wg-relay";
  harness.render();

  deleteButton = buttonByText(harness.content, "DELETE");
  deleteButton.dispatchEvent({ type: "click", bubbles: false });
  deleteButton.dispatchEvent({ type: "click", bubbles: false });
  confirmDialog = harness.document.modalRoot.querySelector(".settings-confirm-modal");
  assert.equal(confirmDialog.querySelector("p").textContent, "translated:wgRelayDeleteConfirmDetail");
  buttonByText(confirmDialog, "CONFIRM_DELETE").dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.deepEqual(harness.calls.deleteLocal[0], ["wg-test"]);
  assert.equal(harness.calls.deleteLocal.length, 1);

  const disposed = createHarness({ profile: DEPLOYED_PROFILE });
  await flushPromises();
  buttonByText(disposed.content, "DELETE").dispatchEvent({ type: "click", bubbles: false });
  const disposedConfirm = buttonByText(disposed.document.modalRoot, "CONFIRM_DELETE");
  disposed.core.tabs["wg-relay"].dispose();
  disposedConfirm.dispatchEvent({ type: "click", bubbles: false });
  await flushPromises();
  assert.equal(disposed.calls.deleteLocal.length, 0);
  assert.equal(disposed.document.listenerCount("keydown"), 0);
});

test("late deploy completion after tab exit cannot mutate the view", async () => {
  const pending = deferred();
  const harness = createHarness({ api: { deploy: () => pending.promise } });
  setInput(harness.content.querySelector("#wg-relay-host"), "relay.example.test");
  setInput(harness.content.querySelector("#wg-relay-password"), "unit-test-only");
  harness.content.querySelector(".wg-relay-setup-form").dispatchEvent({ type: "submit", bubbles: false });
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
  assert.match(css, /\.wg-relay-progress-state\s*\{[^}]*opacity:\s*1;/);

  const lightRoot = css.match(/:root\s*\{([^}]*)\}/);
  const darkRoot = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/);
  assert.ok(lightRoot && darkRoot, "light and dark theme roots must be explicit");
  const light = cssVariables(lightRoot[1]);
  const dark = new Map([...light, ...cssVariables(darkRoot[1])]);
  for (const [themeName, tokens] of [["light", light], ["dark", dark]]) {
    const panel = parseCssColor(tokens.get("--panel-bg"));
    for (const semantic of ["neutral", "warning", "success", "danger"]) {
      const textToken = tokens.get(`--wg-relay-${semantic}-text`);
      const backgroundToken = tokens.get(`--wg-relay-${semantic}-bg`);
      assert.equal(typeof textToken, "string", `${themeName} ${semantic} text token`);
      assert.equal(typeof backgroundToken, "string", `${themeName} ${semantic} background token`);
      const foreground = parseCssColor(textToken);
      const background = compositeCssColor(
        parseCssColor(backgroundToken),
        panel,
      );
      assert.ok(
        contrastRatio(foreground, background) >= 4.5,
        `${themeName} ${semantic} small text must meet WCAG AA`,
      );
    }
    const progressBackground = compositeCssColor(
      parseCssColor(tokens.get("--wg-relay-progress-bg")),
      panel,
    );
    for (const [stateName, tokenName] of [
      ["pending", "--text-secondary"],
      ["current", "--wg-relay-current-text"],
      ["complete", "--wg-relay-success-text"],
      ["failed", "--wg-relay-danger-text"],
    ]) {
      assert.ok(
        contrastRatio(parseCssColor(tokens.get(tokenName)), progressBackground) >= 4.5,
        `${themeName} ${stateName} progress text must meet WCAG AA`,
      );
    }
  }
  for (const token of [
    "--wg-relay-warning-text", "--wg-relay-warning-bg",
    "--wg-relay-success-text", "--wg-relay-success-bg",
    "--wg-relay-danger-text", "--wg-relay-danger-bg",
  ]) {
    assert.ok(css.includes(`var(${token})`), `${token} must style the actual WG Relay UI`);
  }
});

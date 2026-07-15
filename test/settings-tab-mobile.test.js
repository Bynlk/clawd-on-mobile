"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const TAB_SOURCE = fs.readFileSync(path.join(SRC_DIR, "settings-tab-mobile.js"), "utf8");
const MOBILE_CSS = fs.readFileSync(path.join(SRC_DIR, "mobile-settings.css"), "utf8");
const SETTINGS_I18N_SOURCE = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
const MOBILE_I18N_SOURCE = fs.readFileSync(path.join(SRC_DIR, "mobile-i18n.js"), "utf8");
const prefs = require("../src/prefs");
const { SUPPORTED_LANGS } = require("../src/i18n");

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.type = "";
    this.value = "";
    this.placeholder = "";
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  set innerHTML(_value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get innerHTML() { return ""; }
  get childElementCount() { return this.children.length; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  _matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) {
      return String(this.className).split(/\s+/).filter(Boolean).includes(selector.slice(1));
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child._matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function createHarness(snapshot, { translations = {}, fetchImpl } = {}) {
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  const content = new FakeElement("main");
  const core = {
    runtime: {},
    state: { activeTab: "mobile", snapshot: { ...snapshot } },
    helpers: {
      t: (key) => translations[key] || key,
      escapeHtml: (value) => String(value),
    },
    tabs: {},
  };
  const context = {
    console,
    document,
    navigator: {},
    setTimeout: () => 1,
    setInterval: () => 1,
    fetch: fetchImpl,
    window: {
      settingsAPI: {
        getMobileConnectionInfo: async () => null,
        update: async () => ({ status: "ok" }),
      },
    },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(TAB_SOURCE, context, { filename: "settings-tab-mobile.js" });
  context.ClawdSettingsTabMobile.init(core);
  core.tabs.mobile.render(content, core);
  return { content, context };
}

test("fresh defaults start with no VPS profile and omit the obsolete manual Relay form", () => {
  const fresh = prefs.getDefaults();
  assert.deepEqual(fresh.wgRelay.profiles, []);
  assert.equal(fresh.relayEnabled, false);
  assert.equal(fresh.relayUrl, "");
  assert.equal(fresh.relayToken, "");

  const harness = createHarness(fresh);

  assert.equal(harness.content.querySelector("#mobile-relay-section"), null);
});

test("each legacy Relay preference independently preserves the compatibility editor", () => {
  const cases = [
    { relayEnabled: true, relayUrl: "", relayToken: "" },
    { relayEnabled: false, relayUrl: "wss://legacy-relay.example.test:7891", relayToken: "" },
    { relayEnabled: false, relayUrl: "", relayToken: "legacy-token" },
  ];

  for (const legacy of cases) {
    const harness = createHarness({ ...prefs.getDefaults(), ...legacy });
    assert.ok(harness.content.querySelector("#mobile-relay-section"), JSON.stringify(legacy));
  }
});

test("an existing legacy Relay remains visible with labelled themed settings controls", () => {
  const harness = createHarness({
    ...prefs.getDefaults(),
    relayEnabled: true,
    relayUrl: "wss://legacy-relay.example.test:7891",
    relayToken: "legacy-token",
  });
  const section = harness.content.querySelector("#mobile-relay-section");
  assert.ok(section);
  const inputs = section.querySelectorAll("input");
  const labels = section.querySelectorAll("label");
  assert.equal(inputs.length, 2);
  assert.equal(labels.length, 2);
  assert.equal(inputs[0].value, "wss://legacy-relay.example.test:7891");
  assert.equal(inputs[1].type, "password");
  assert.equal(inputs[1].value, "legacy-token");
  for (let index = 0; index < inputs.length; index++) {
    assert.ok(inputs[index].id, `input ${index} must have an id`);
    assert.equal(labels[index].htmlFor, inputs[index].id, `label ${index} must name its input`);
  }
  assert.ok(inputs.every((input) => input.parentNode.className.includes("wg-relay-field")));
  const buttons = section.querySelectorAll("button");
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => button.className.split(/\s+/).includes("soft-btn")));
  assert.doesNotMatch(section.querySelector("input").className, /settings-input/);
});

test("all desktop languages include complete legacy Relay copy without admin-token wording", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SETTINGS_I18N_SOURCE, context, { filename: "settings-i18n.js" });
  vm.runInContext(MOBILE_I18N_SOURCE, context, { filename: "mobile-i18n.js" });
  const strings = context.ClawdSettingsI18n.STRINGS;
  const required = [
    "relayTitle", "relayDesc", "relayUrl", "relayToken", "relayTokenPlaceholder",
    "relayEnable", "relayDisable", "relayCheckStatus", "relayStatusConnected",
    "relayStatusDisconnected", "relayStatusOnline", "relayStatusUnavailable",
  ];

  for (const lang of SUPPORTED_LANGS) {
    for (const key of required) {
      assert.equal(typeof strings[lang][key], "string", `${lang}.${key}`);
      assert.ok(strings[lang][key].trim(), `${lang}.${key} nonempty`);
      assert.notEqual(strings[lang][key], key, `${lang}.${key} naked fallback`);
    }
    assert.doesNotMatch(strings[lang].relayToken, /admin|管理/i, `${lang} uses a connection token`);
    assert.match(strings[lang].relayStatusOnline, /\{pc\}/, `${lang} online PC placeholder`);
    assert.match(strings[lang].relayStatusOnline, /\{phone\}/, `${lang} online phone placeholder`);
  }
  assert.equal(strings.en.relayToken, "Connection Token");
  assert.equal(strings.zh.relayToken, "连接 Token");
});

test("legacy Relay dynamic status and token placeholder are localized", async () => {
  const translations = {
    relayCheckStatus: "CHECK_RELAY",
    relayStatusDisconnected: "DISCONNECTED",
    relayStatusOnline: "ONLINE {pc} PC / {phone} PHONE",
    relayStatusUnavailable: "UNAVAILABLE",
    relayTokenPlaceholder: "CONNECTION_TOKEN_PLACEHOLDER",
  };
  const snapshot = {
    ...prefs.getDefaults(),
    relayUrl: "wss://legacy-relay.example.test:7891",
  };
  const success = createHarness(snapshot, {
    translations,
    fetchImpl: async () => ({
      json: async () => ({ connections: { pc: 2, phone: 3 } }),
    }),
  });
  const successSection = success.content.querySelector("#mobile-relay-section");
  assert.equal(successSection.querySelectorAll("input")[1].placeholder, "CONNECTION_TOKEN_PLACEHOLDER");
  assert.equal(successSection.querySelector(".relay-status").getAttribute("role"), "status");
  assert.equal(successSection.querySelector(".relay-status").getAttribute("aria-live"), "polite");
  const successButton = successSection.querySelectorAll("button")
    .find((button) => button.textContent === "CHECK_RELAY");
  successButton.onclick();
  await flushPromises();
  assert.equal(successSection.querySelector(".relay-status").textContent, "ONLINE 2 PC / 3 PHONE");

  const failure = createHarness(snapshot, {
    translations,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const failureSection = failure.content.querySelector("#mobile-relay-section");
  const failureButton = failureSection.querySelectorAll("button")
    .find((button) => button.textContent === "CHECK_RELAY");
  failureButton.onclick();
  await flushPromises();
  assert.equal(failureSection.querySelector(".relay-status").textContent, "UNAVAILABLE");
  assert.doesNotMatch(TAB_SOURCE, /输入 Admin Token|运行中\s*\|\s*在线|无法连接/);
});

test("mobile settings CSS does not reference the undefined red token", () => {
  assert.doesNotMatch(MOBILE_CSS, /var\(--red\)/);
  assert.match(
    MOBILE_CSS,
    /\.mobile-info-error\s*\{[^}]*color:\s*var\(--wg-relay-danger-text\);/s,
  );
  assert.match(MOBILE_CSS, /\.mobile-relay-actions\s*\{/);
  assert.match(MOBILE_CSS, /\.relay-status\s*\{/);
});

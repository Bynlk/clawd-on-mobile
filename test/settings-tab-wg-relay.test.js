"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const { SUPPORTED_LANGS } = require("../src/i18n");

// ── settings-tab-wg-relay.js script integrity ──

test("settings-tab-wg-relay.js loads in a sandbox via the same IIFE pattern as siblings", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
  assert.match(code, /root\.ClawdSettingsTabWgRelay\s*=\s*\{\s*init\s*\}/);
  assert.match(code, /core\.tabs\["wg-relay"\]\s*=\s*\{\s*render\s*\}/);
});

test("settings-tab-wg-relay.js is registered in settings.html before settings-renderer.js", () => {
  const html = fs.readFileSync(path.join(SRC_DIR, "settings.html"), "utf8");
  const tabIdx = html.indexOf("settings-tab-wg-relay.js");
  const rendererIdx = html.indexOf("settings-renderer.js");
  assert.ok(tabIdx > 0, "settings-tab-wg-relay.js must appear in settings.html");
  assert.ok(rendererIdx > tabIdx, "settings-renderer.js must come after settings-tab-wg-relay.js");
});

test("settings-renderer.js SIDEBAR_TABS includes wg-relay entry and inits the tab", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-renderer.js"), "utf8");
  assert.match(code, /id:\s*"wg-relay"/);
  assert.match(code, /labelKey:\s*"sidebarWgRelay"/);
  assert.match(code, /ClawdSettingsTabWgRelay\.init\(core\)/);
});

// ── wgRelay.* actions are wired into the command registry ──

test("settings-actions.js registers the wgRelay command actions", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-actions.js"), "utf8");
  assert.match(code, /require\("\.\/settings-actions-wg-relay"\)/);
  for (const action of ["wgRelay.add", "wgRelay.update", "wgRelay.remove", "wgRelay.applyReadback"]) {
    assert.match(code, new RegExp(`"${action.replace(".", "\\.")}"`),
      `commandRegistry must register ${action}`);
  }
});

// ── i18n: all language packs include the new keys ──

test("settings-i18n.js: all language packs include wg-relay keys", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const REQUIRED_KEYS = [
    "sidebarWgRelay",
    "wgRelayTitle",
    "wgRelaySubtitle",
    "wgRelayAddProfile",
    "wgRelayDeploy",
    "wgRelayFieldHost",
    "wgRelayFieldAuthMethod",
    "wgRelayFieldPassword",
    "wgRelayStatus_idle",
    "wgRelayStatus_connecting",
    "wgRelayStatus_connected",
    "wgRelayStatus_failed",
    "wgRelayStep_install-wg",
    "wgRelayQrTitle",
    "wgRelayReadbackTitle",
  ];
  for (const key of REQUIRED_KEYS) {
    const matches = code.match(new RegExp(`\\b${key}\\b`, "g")) || [];
    assert.ok(
      matches.length >= SUPPORTED_LANGS.length,
      `key ${key} should appear >=${SUPPORTED_LANGS.length} times (${SUPPORTED_LANGS.length} langs); found ${matches.length}`
    );
  }
});

test("settings-i18n.js: sidebarWgRelay defined in every supported language", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const matches = code.match(/sidebarWgRelay:\s*"[^"]+"/g) || [];
  assert.equal(
    matches.length,
    SUPPORTED_LANGS.length,
    `expected ${SUPPORTED_LANGS.length} sidebarWgRelay defs; got ${matches.length}`
  );
  const values = matches.map((m) => m.match(/"([^"]+)"/)[1]);
  assert.equal(new Set(values).size, SUPPORTED_LANGS.length,
    `expected ${SUPPORTED_LANGS.length} distinct translations; got ${[...new Set(values)]}`);
});

// ── CSS class wiring ──

test("settings-tab-wg-relay.js uses only CSS classes that exist in settings.css", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
  const usedClasses = new Set();
  const re = /className\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const tok of m[1].split(/\s+/)) {
      if (tok) usedClasses.add(tok);
    }
  }
  const FORBIDDEN = ["btn", "btn-primary", "btn-danger"];
  for (const bad of FORBIDDEN) {
    assert.equal(usedClasses.has(bad), false,
      `WireGuard relay tab must not use bare .${bad} (does not exist in settings.css)`);
  }
  const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
  for (const cls of usedClasses) {
    if (cls.startsWith("wg-relay-")) continue;
    assert.match(css, new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      `settings.css must define .${cls} (used by WireGuard relay tab)`);
  }
});

test("settings.css defines wg-relay-* layout rules used by the tab", () => {
  const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
  const required = [
    "wg-relay-section-header",
    "wg-relay-empty",
    "wg-relay-card",
    "wg-relay-card-meta",
    "wg-relay-card-label",
    "wg-relay-card-host",
    "wg-relay-card-actions",
    "wg-relay-status-row",
    "wg-relay-status-message",
    "wg-relay-status-badge",
    "wg-relay-status-idle",
    "wg-relay-status-connecting",
    "wg-relay-status-connected",
    "wg-relay-status-failed",
    "wg-relay-status-deploying",
    "wg-relay-actions",
    "wg-relay-btn-danger",
    "wg-relay-progress-log",
    "wg-relay-progress-line",
    "wg-relay-edit",
    "wg-relay-field",
    "wg-relay-field-label",
    "wg-relay-field-hint",
    "wg-relay-form-actions",
    "wg-relay-password-field",
    "wg-relay-password-warn",
    "wg-relay-readback",
    "wg-relay-readback-row",
    "wg-relay-readback-key",
    "wg-relay-readback-val",
    "wg-relay-qr",
    "wg-relay-qr-img",
    "wg-relay-qr-hint",
    "wg-relay-runtime-warn",
    "wg-relay-auth-toggle",
  ];
  for (const cls of required) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), `settings.css must define .${cls}`);
  }
});

test("settings-tab-wg-relay.js translates runtime status hints before raw messages", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
  assert.match(code, /function\s+statusMessageText\s*\(\s*status\s*\)/);
  assert.match(code, /status\.hint/);
  assert.match(code, /translated\s*!==\s*status\.hint/);
});

// SEC-1 / SEC-3 regression: the tab must never put the SSH password into a
// saved profile, and must persist only the whitelisted public readback fields.
test("settings-tab-wg-relay.js keeps the SSH password out of the saved payload (SEC-1)", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
  // The password lives in an in-memory Map, never in profile CRUD payloads.
  assert.match(code, /view\.passwords/);
  // The save payload builds an object without a `password:` field.
  const saveSection = code.slice(code.indexOf("const payload = {"), code.indexOf("const action = isNew"));
  assert.ok(saveSection.length > 0, "save payload block must exist");
  assert.equal(/password\s*:/.test(saveSection), false,
    "the saved profile payload must not contain a password field");
});

test("settings-tab-wg-relay.js persists only public readback fields via applyReadback (SEC-3)", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
  assert.match(code, /wgRelay\.applyReadback/);
  // The QR is generated from the transient phoneConf, held in view.readbacks.
  assert.match(code, /view\.readbacks/);
  assert.match(code, /generateQr/);
});

test("settings-tab-wg-relay.js can be evaluated without DOM (no top-level DOM access)", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-wg-relay.js"), "utf8");
  const sandbox = { globalThis: undefined };
  sandbox.globalThis = sandbox;
  // eslint-disable-next-line no-new-func
  const fn = new Function("globalThis", "crypto", "window", code);
  fn(sandbox.globalThis, undefined, undefined);
  assert.ok(sandbox.globalThis.ClawdSettingsTabWgRelay, "tab module must register on globalThis");
  assert.equal(typeof sandbox.globalThis.ClawdSettingsTabWgRelay.init, "function");
});

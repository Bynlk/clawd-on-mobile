"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const SETTINGS_ICONS = path.join(SRC_DIR, "settings-icons.js");
const SETTINGS_RENDERER = path.join(SRC_DIR, "settings-renderer.js");
const SETTINGS_RENDERER_SOURCE = fs.readFileSync(SETTINGS_RENDERER, "utf8");

function loadIcons() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SETTINGS_ICONS, "utf8"), context);
  return context.ClawdSettingsIcons;
}

function readSidebarTabIds() {
  const declaration = SETTINGS_RENDERER_SOURCE.match(
    /const SIDEBAR_TABS = \[([\s\S]*?)\n\];/,
  );
  assert.ok(declaration, "settings-renderer.js should declare SIDEBAR_TABS");
  return Array.from(declaration[1].matchAll(/\bid:\s*"([^"]+)"/g), (match) => match[1]);
}

// Every top-level tab declared by the renderer must resolve to a real icon,
// so adding a tab cannot silently reuse the placeholder.
const SIDEBAR_TAB_IDS = readSidebarTabIds();

describe("settings-icons", () => {
  it("exposes a getIcon helper on globalThis", () => {
    const icons = loadIcons();
    assert.ok(icons, "ClawdSettingsIcons should be defined");
    assert.strictEqual(typeof icons.getIcon, "function");
  });

  it("returns a currentColor inline SVG for every sidebar tab", () => {
    const icons = loadIcons();
    for (const id of SIDEBAR_TAB_IDS) {
      const svg = icons.getIcon(id);
      assert.ok(svg.startsWith("<svg"), `${id} should be an inline SVG`);
      assert.ok(
        svg.includes('stroke="currentColor"') || svg.includes('fill="currentColor"'),
        `${id} icon should use currentColor so it follows light/dark text color`
      );
      // No raw emoji/unicode glyphs left behind.
      assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), `${id} should not contain emoji`);
    }
  });

  it("does not fall back to placeholder for known tabs", () => {
    const icons = loadIcons();
    const placeholder = icons.getIcon("placeholder");
    for (const id of SIDEBAR_TAB_IDS) {
      assert.notStrictEqual(icons.getIcon(id), placeholder, `${id} should have its own icon`);
    }
  });

  it("uses distinct icons for Remote Connection and Mobile", () => {
    const icons = loadIcons();
    assert.notStrictEqual(
      icons.getIcon("wg-relay"),
      icons.getIcon("mobile"),
      "Remote Connection and Mobile should not share the same sidebar icon",
    );
  });

  it("falls back to placeholder for unknown ids", () => {
    const icons = loadIcons();
    assert.strictEqual(icons.getIcon("no-such-tab-xyz"), icons.getIcon("placeholder"));
  });

  it("covers every tab id used by the settings renderer", () => {
    const icons = loadIcons();
    assert.ok(SIDEBAR_TAB_IDS.length > 0, "the renderer should expose sidebar tabs");
    for (const id of SIDEBAR_TAB_IDS) {
      assert.ok(icons.ICONS[id], `settings-icons.js should define an icon for "${id}"`);
    }
  });
});

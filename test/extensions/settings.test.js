"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const { registerBuiltInSettingsExtensions } = require("../../src/extensions/settings");

it("registers built-in settings extensions through a single registry", () => {
  const calls = [];
  registerBuiltInSettingsExtensions({ marker: "settings" }, [
    { registerSettingsIpc: (options) => calls.push(options.marker) },
  ]);
  assert.deepEqual(calls, ["settings"]);
});

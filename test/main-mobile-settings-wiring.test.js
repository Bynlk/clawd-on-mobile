"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "main.js"),
  "utf8",
);

function settingsRegistrationSource() {
  const start = MAIN_SOURCE.indexOf("registerSettingsIpc({");
  assert.notEqual(start, -1, "main.js should register the Settings IPC surface");
  const end = MAIN_SOURCE.indexOf("\n});", start);
  assert.notEqual(end, -1, "registerSettingsIpc call should have a closing delimiter");
  return MAIN_SOURCE.slice(start, end);
}

test("main wires the live Mobile Server into Settings connection info", () => {
  const registration = settingsRegistrationSource();

  assert.match(
    registration,
    /getMobileWS:\s*\(\)\s*=>\s*mobileIntegration\s*\?\s*mobileIntegration\.getMobileWS\(\)\s*:\s*null/,
  );
  assert.match(
    registration,
    /getMobileToken:\s*\(\)\s*=>\s*mobileIntegration\s*\?\s*mobileIntegration\.getMobileToken\(\)\s*:\s*null/,
  );
});

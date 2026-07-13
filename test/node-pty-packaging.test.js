"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

test("node-pty is rebuilt and unpacked for Electron packages", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.dependencies["node-pty"]);
  assert.equal(pkg.scripts["rebuild:native"], "electron-builder install-app-deps");
  assert.equal(pkg.build.npmRebuild, true);
  assert.ok(pkg.build.asarUnpack.includes("node_modules/node-pty/**/*"));

  const workflow = fs.readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
  assert.equal((workflow.match(/npm run rebuild:native/g) || []).length, 3);
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ManagedTerminalNormalizer } = require("../src/managed-terminal-normalizer");

describe("ManagedTerminalNormalizer", () => {
  it("keeps raw ANSI content while exposing clean text", () => {
    const [event] = new ManagedTerminalNormalizer().push("\u001b[32mhello\u001b[0m\n");
    assert.equal(event.kind, "terminal_delta");
    assert.equal(event.text, "hello\n");
    assert.match(event.raw, /\u001b\[32m/);
  });

  it("classifies terminal-visible thinking", () => {
    const [event] = new ManagedTerminalNormalizer().push("Thinking: checking the project\n");
    assert.equal(event.kind, "thinking");
    assert.equal(event.text, "checking the project");
  });

  it("classifies fenced code", () => {
    const [event] = new ManagedTerminalNormalizer().push("```js\nconst ok = true;\n```\n");
    assert.equal(event.kind, "code");
    assert.equal(event.language, "js");
    assert.match(event.text, /const ok/);
  });

  it("classifies unified diffs with file statistics", () => {
    const [event] = new ManagedTerminalNormalizer().push(
      "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n-old\n+new\n",
    );
    assert.equal(event.kind, "diff");
    assert.equal(event.additions, 1);
    assert.equal(event.deletions, 1);
    assert.equal(event.file, "a.js");
  });

  it("collapses carriage-return progress to the latest visible line", () => {
    const [event] = new ManagedTerminalNormalizer().push("Progress 10%\rProgress 80%\rProgress 100%\n");
    assert.equal(event.text, "Progress 100%\n");
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RelayPairRegistry } = require("../relay/pair-registry");

function socket(name) {
  return {
    name,
    OPEN: 1,
    readyState: 1,
    sent: [],
    closed: false,
    send(data) { this.sent.push(data); },
    close() { this.closed = true; this.readyState = 3; },
  };
}

describe("RelayPairRegistry", () => {
  it("forwards PC frames to every phone and each phone frame to the PC", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phoneA = socket("phone-a");
    const phoneB = socket("phone-b");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phoneA);
    pairs.add("token", "phone", phoneB);

    pairs.forward("token", "pc", "from-pc");
    assert.deepEqual(phoneA.sent, ["from-pc"]);
    assert.deepEqual(phoneB.sent, ["from-pc"]);
    pairs.forward("token", "phone", "from-phone");
    assert.deepEqual(pc.sent, ["from-phone"]);
  });

  it("disconnects one phone without replacing or closing the other", () => {
    const pairs = new RelayPairRegistry();
    const pc = socket("pc");
    const phoneA = socket("phone-a");
    const phoneB = socket("phone-b");
    pairs.add("token", "pc", pc);
    pairs.add("token", "phone", phoneA);
    pairs.add("token", "phone", phoneB);
    pairs.remove("token", "phone", phoneA);

    pairs.forward("token", "pc", "next");
    assert.deepEqual(phoneA.sent, []);
    assert.deepEqual(phoneB.sent, ["next"]);
    assert.equal(phoneB.closed, false);
    assert.deepEqual(pairs.countConnections(), { pc: 1, phone: 1 });
  });

  it("replaces only the single PC and never retains message payloads", () => {
    const pairs = new RelayPairRegistry();
    const first = socket("first");
    const second = socket("second");
    pairs.add("token", "pc", first);
    pairs.add("token", "pc", second);
    pairs.forward("token", "pc", "secret-payload");

    assert.equal(first.closed, true);
    assert.equal(pairs.get("token").pc, second);
    assert.equal(Object.prototype.hasOwnProperty.call(pairs.get("token"), "messages"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pairs.get("token"), "history"), false);
  });
});

it("both relay entry points use the multi-phone registry", () => {
  for (const relative of ["relay/relay-server.js", "relay-server.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(source, /RelayPairRegistry/);
    assert.doesNotMatch(source, /pair\.phone\b/);
  }
});

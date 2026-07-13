"use strict";

const { EventEmitter } = require("node:events");
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { RelayBridge } = require("../src/relay-bridge-integration");

it("authenticates the Relay bridge to the active local mobile endpoint", () => {
  const connections = [];
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    constructor(url, options) {
      super();
      this.readyState = 0;
      connections.push({ url, options });
    }
  }

  const bridge = new RelayBridge({
    WebSocketImpl: FakeWebSocket,
    localToken: "local secret",
    getLocalPort: () => 23335,
  });
  bridge.running = true;
  bridge.connectToLocal();

  assert.equal(connections[0].url, "ws://127.0.0.1:23335/mobile/ws?role=pc");
  assert.deepEqual(connections[0].options.headers, {
    Authorization: "Bearer local secret",
  });
  bridge.stop();
});

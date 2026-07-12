"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const initServer = require("../src/server");

it("owns and disposes the managed session runtime", () => {
  let disposed = 0;
  const managedSessionRuntime = { dispose() { disposed++; } };
  const server = initServer({
    mobileCompanionEnabled: false,
    managedSessionRuntime,
    clearRuntimeConfig: () => {},
  });

  assert.equal(server.managedSessionRuntime, managedSessionRuntime);
  server.cleanup();
  assert.equal(disposed, 1);
});

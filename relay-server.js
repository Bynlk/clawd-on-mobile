#!/usr/bin/env node
"use strict";

const canonicalRelay = require("./relay/relay-server");

module.exports = canonicalRelay;

if (require.main === module) {
  canonicalRelay.runCli();
}

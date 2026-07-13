"use strict";

const nodeFs = require("node:fs");
const path = require("node:path");

const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
let temporarySequence = 0;

function normalizeToken(name, value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error(`${name} must be 64 hexadecimal characters`);
  }
  return value;
}

function parseEnvironment(contents) {
  const entries = [];
  const values = Object.create(null);
  for (const line of String(contents).split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) {
      entries.push({ raw: line });
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("relay.env contains an invalid line");
    const [, key, value] = match;
    if (Object.hasOwn(values, key)) throw new Error(`relay.env contains duplicate ${key}`);
    if (/\0|\r|\n/.test(value)) throw new Error(`relay.env contains invalid ${key}`);
    values[key] = value;
    entries.push({ key, value });
  }
  return { entries, values };
}

function renderEnvironment(parsed, relayToken) {
  let replaced = false;
  const lines = parsed.entries.map((entry) => {
    if (entry.key !== "RELAY_TOKEN") return entry.raw === undefined ? `${entry.key}=${entry.value}` : entry.raw;
    replaced = true;
    return `RELAY_TOKEN=${relayToken}`;
  });
  if (!replaced) lines.push(`RELAY_TOKEN=${relayToken}`);
  while (lines.length > 1 && lines.at(-1) === "" && lines.at(-2) === "") lines.pop();
  if (lines.at(-1) !== "") lines.push("");
  return lines.join("\n");
}

function atomicWrite(fs, destination, contents) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}-${temporarySequence++}`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    if (typeof fs.fchmodSync === "function") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createRelayTokenStore({
  envPath = "/etc/clawd-relay/relay.env",
  fs = nodeFs,
  initialRelayToken,
  initialManagementToken,
  initialEnvironment = {},
} = {}) {
  let contents;
  try {
    contents = fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if (!initialRelayToken || !initialManagementToken || (error && error.code !== "ENOENT")) throw error;
    const seed = { ...initialEnvironment, RELAY_TOKEN: initialRelayToken, MANAGEMENT_TOKEN: initialManagementToken };
    contents = Object.entries(seed).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  }

  let parsed = parseEnvironment(contents);
  let relayToken = normalizeToken("RELAY_TOKEN", parsed.values.RELAY_TOKEN || initialRelayToken);
  const managementToken = normalizeToken(
    "MANAGEMENT_TOKEN",
    parsed.values.MANAGEMENT_TOKEN || initialManagementToken
  );
  if (relayToken.toLowerCase() === managementToken.toLowerCase()) {
    throw new Error("Relay and management tokens must be distinct");
  }

  function rotate(nextToken) {
    const normalized = normalizeToken("RELAY_TOKEN", nextToken);
    if (normalized.toLowerCase() === managementToken.toLowerCase()) {
      throw new Error("Relay and management tokens must be distinct");
    }
    const nextContents = renderEnvironment(parsed, normalized);
    atomicWrite(fs, envPath, nextContents);
    parsed = parseEnvironment(nextContents);
    relayToken = normalized;
    return relayToken;
  }

  return Object.freeze({
    current: () => relayToken,
    managementToken: () => managementToken,
    rotate,
    restore: rotate,
  });
}

module.exports = {
  createRelayTokenStore,
  normalizeToken,
  parseEnvironment,
};

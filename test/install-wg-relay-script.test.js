"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INSTALLER_PATH = path.join(__dirname, "..", "relay", "install-wg-relay.sh");
const SOURCE = fs.readFileSync(INSTALLER_PATH, "utf8");

function linesMatching(pattern) {
  return SOURCE.split("\n").filter((line) => pattern.test(line));
}

describe("persistent WireGuard Relay installer source fixture", () => {
  it("is executable as an uploaded installer", () => {
    assert.notEqual(fs.statSync(INSTALLER_PATH).mode & 0o111, 0);
  });

  it("requires a running systemd and has no silent non-systemd fallback", () => {
    assert.match(SOURCE, /command -v systemctl[^\n]*\|\|[^\n]*die/);
    assert.match(SOURCE, /\/run\/systemd\/system/);
    assert.doesNotMatch(SOURCE, /relay unit skipped|tunnel still up|直接 wg-quick/);
  });

  it("supports apt, dnf and yum and installs wireguard-tools", () => {
    assert.match(SOURCE, /apt-get[\s\S]*install[^\n]*wireguard-tools/);
    assert.match(SOURCE, /dnf[\s\S]*install[^\n]*wireguard-tools/);
    assert.match(SOURCE, /yum[\s\S]*install[^\n]*wireguard-tools/);
  });

  it("installs the cryptographic runtime used to generate 256-bit tokens", () => {
    assert.match(SOURCE, /apt-get install[^\n]*openssl/);
    assert.match(SOURCE, /dnf install[^\n]*openssl/);
    assert.match(SOURCE, /yum install[^\n]*openssl/);
    assert.match(SOURCE, /openssl rand -hex 32/);
  });

  it("installs and checksum-verifies Node >=18 when the system runtime is missing or old", () => {
    assert.match(SOURCE, /NODE_MIN_MAJOR=["']?18/);
    assert.match(SOURCE, /node[^\n]*--version/);
    assert.match(SOURCE, /nodejs\.org\/dist/);
    assert.match(SOURCE, /sha256sum[^\n]*-c/);
    assert.doesNotMatch(SOURCE, /command -v (?:docker|npm|git)\b/);
  });

  it("copies the uploaded application and bundled ws runtime into /opt/clawd-relay/app", () => {
    assert.match(SOURCE, /SCRIPT_DIR=.*dirname/);
    assert.match(SOURCE, /\/opt\/clawd-relay\/app/);
    assert.match(SOURCE, /node_modules\/ws/);
    assert.match(SOURCE, /cp[^\n]*SCRIPT_DIR[^\n]*app/);
  });

  it("writes Relay environment, WireGuard config and every key file as 0600", () => {
    assert.match(SOURCE, /RELAY_ENV=["']?\/etc\/clawd-relay\/relay\.env/);
    assert.match(SOURCE, /chmod 600[^\n]*RELAY_ENV/);
    assert.match(SOURCE, /chmod 600[^\n]*WG_CONF/);
    assert.match(SOURCE, /find[^\n]*WG_KEY_DIR[^\n]*-exec chmod 600/);
  });

  it("generates a single-port systemd fixture with all private-network management paths", () => {
    assert.match(SOURCE, /EnvironmentFile=\/etc\/clawd-relay\/relay\.env/);
    for (const key of [
      "BIND_ADDR", "PC_IP", "PHONE_IP", "WG_SUBNET", "WG_ENDPOINT",
      "WG_INTERFACE", "WG_CONFIG_PATH", "WG_KEY_DIR", "PHONE_PRIVATE_KEY_PATH",
      "PHONE_PUBLIC_KEY_PATH", "SERVER_PUBLIC_KEY_PATH", "RELAY_ENV_PATH",
    ]) {
      assert.match(SOURCE, new RegExp(`^${key}=`, "m"));
    }
    assert.match(SOURCE, /BIND_ADDR=\$\{SERVER_IP\}/);
  });

  it("enables and verifies both services without best-effort success", () => {
    assert.match(SOURCE, /systemctl enable[^\n]*wg-quick@\$\{IFACE\}/);
    assert.match(SOURCE, /systemctl is-enabled[^\n]*wg-quick@\$\{IFACE\}/);
    assert.match(SOURCE, /systemctl is-active[^\n]*wg-quick@\$\{IFACE\}/);
    assert.match(SOURCE, /systemctl enable[^\n]*clawd-relay/);
    assert.match(SOURCE, /systemctl is-enabled[^\n]*clawd-relay/);
    assert.match(SOURCE, /systemctl is-active[^\n]*clawd-relay/);
    assert.deepEqual(linesMatching(/systemctl.*\|\|\s*true/), []);
  });

  it("opens only WireGuard UDP and never Relay TCP", () => {
    assert.match(SOURCE, /ufw allow[^\n]*WG_PORT[^\n]*udp/);
    assert.match(SOURCE, /firewall-cmd[^\n]*WG_PORT[^\n]*udp/);
    assert.doesNotMatch(SOURCE, /(?:ufw|firewall-cmd|iptables)[^\n]*(?:RELAY_PORT|7891)[^\n]*(?:tcp|TCP)/);
  });

  it("uses same-directory temp-file renames and emits strict schemaVersion 1 readback", () => {
    assert.match(SOURCE, /mktemp[^\n]*\/etc\/clawd-relay/);
    assert.match(SOURCE, /mv[^\n]*RELAY_ENV/);
    assert.match(SOURCE, /mktemp[^\n]*\/etc\/wireguard/);
    assert.match(SOURCE, /mv[^\n]*WG_CONF/);
    assert.match(SOURCE, /<<<CLAWD_JSON>>>/);
    assert.match(SOURCE, /"schemaVersion":1/);
    for (const field of [
      "endpoint", "subnet", "relayUrl", "pcConfig", "phoneConfig", "relayToken", "managementToken",
    ]) {
      assert.match(SOURCE, new RegExp(`"${field}"`));
    }
  });

  it("marks the install committed only after the complete readback JSON is constructed", () => {
    const readbackIndex = SOURCE.indexOf("READBACK_JSON=");
    const committedIndex = SOURCE.indexOf("COMMITTED=1");
    assert.ok(readbackIndex > 0);
    assert.ok(committedIndex > readbackIndex);
    assert.match(SOURCE, /printf '%s' "\$\{READBACK_JSON\}"/);
  });
});

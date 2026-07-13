"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildPairingDeepLink,
  createPairingQr,
} = require("../src/wg-relay-pairing-qr");

const PHONE_PRIVATE_KEY = Buffer.alloc(32, 7).toString("base64");
const SERVER_PUBLIC_KEY = Buffer.alloc(32, 8).toString("base64");
const RELAY_TOKEN = "ab".repeat(32);

function phoneConfig(overrides = {}) {
  return [
    "[Interface]",
    `PrivateKey = ${overrides.privateKey || PHONE_PRIVATE_KEY}`,
    `Address = ${overrides.address || "10.8.0.3/32"}`,
    "",
    "[Peer]",
    `PublicKey = ${overrides.publicKey || SERVER_PUBLIC_KEY}`,
    `Endpoint = ${overrides.endpoint || "203.0.113.10:51820"}`,
    `AllowedIPs = ${overrides.allowedIps || "10.8.0.0/24"}`,
    `PersistentKeepalive = ${overrides.keepalive || "25"}`,
    "",
  ].join("\n");
}

test("buildPairingDeepLink emits the approved version 1 base64url payload", () => {
  const deepLink = buildPairingDeepLink({
    profile: { label: "My VPS" },
    secrets: {
      phoneConfig: phoneConfig(),
      relayUrl: "ws://10.8.0.1:7891",
      relayToken: RELAY_TOKEN,
    },
    issuedAt: 1_783_900_800_000,
  });

  assert.match(deepLink, /^clawd:\/\/relay-pair\?v=1&data=[A-Za-z0-9_-]+$/);
  const encoded = new URL(deepLink).searchParams.get("data");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(payload, {
    version: 1,
    name: "My VPS",
    wireGuard: {
      privateKey: PHONE_PRIVATE_KEY,
      address: "10.8.0.3/32",
      serverPublicKey: SERVER_PUBLIC_KEY,
      endpoint: "203.0.113.10:51820",
      allowedIps: ["10.8.0.0/24"],
      persistentKeepalive: 25,
    },
    relay: { url: "ws://10.8.0.1:7891", token: RELAY_TOKEN },
    issuedAt: 1_783_900_800_000,
  });
});

test("pairing payload rejects malformed configs, public relay URLs, and oversize names", () => {
  const base = {
    profile: { label: "My VPS" },
    secrets: {
      phoneConfig: phoneConfig(),
      relayUrl: "ws://10.8.0.1:7891",
      relayToken: RELAY_TOKEN,
    },
    issuedAt: 1,
  };
  assert.throws(
    () => buildPairingDeepLink({
      ...base,
      secrets: { ...base.secrets, phoneConfig: phoneConfig({ keepalive: "24" }) },
    }),
    /pairing data invalid/i,
  );
  assert.throws(
    () => buildPairingDeepLink({
      ...base,
      secrets: { ...base.secrets, relayUrl: "ws://203.0.113.10:7891" },
    }),
    /pairing data invalid/i,
  );
  assert.throws(
    () => buildPairingDeepLink({ ...base, profile: { label: "x".repeat(101) } }),
    /pairing data invalid/i,
  );
});

test("createPairingQr uses the existing encoder and returns no raw payload", async () => {
  let encodedText = null;
  const result = await createPairingQr({
    profile: { label: "My VPS" },
    secrets: {
      phoneConfig: phoneConfig(),
      relayUrl: "ws://10.8.0.1:7891",
      relayToken: RELAY_TOKEN,
    },
    issuedAt: 42,
    QRCode: {
      async toDataURL(text, options) {
        encodedText = text;
        assert.deepEqual(options, { errorCorrectionLevel: "M", margin: 2, width: 320 });
        return "data:image/png;base64,QR";
      },
    },
  });

  assert.match(encodedText, /^clawd:\/\/relay-pair\?v=1&data=/);
  assert.deepEqual(result, { version: 1, dataUrl: "data:image/png;base64,QR" });
  assert.equal(Object.hasOwn(result, "payload"), false);
  assert.equal(Object.hasOwn(result, "deepLink"), false);
});

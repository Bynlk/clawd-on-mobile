"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PNG } = require("pngjs");
const QRCode = require("qrcode");

const {
  buildPairingDeepLink,
  createPairingQr,
} = require("../src/wg-relay-pairing-qr");

const PHONE_PRIVATE_KEY = Buffer.alloc(32, 7).toString("base64");
const SERVER_PUBLIC_KEY = Buffer.alloc(32, 8).toString("base64");
const RELAY_TOKEN = "ab".repeat(32);
const PROFILE = {
  label: "My VPS",
  wgSubnet: "10.8.0.0/24",
  endpoint: "203.0.113.10:51820",
};

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
    profile: PROFILE,
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
    profile: PROFILE,
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
    () => buildPairingDeepLink({ ...base, profile: { ...PROFILE, label: "x".repeat(101) } }),
    /pairing data invalid/i,
  );
});

test("pairing model rejects wrong phone topology, duplicate/unknown fields, and endpoint mismatch", () => {
  const base = {
    profile: PROFILE,
    secrets: {
      phoneConfig: phoneConfig(), relayUrl: "ws://10.8.0.1:7891", relayToken: RELAY_TOKEN,
    },
    issuedAt: 1,
  };
  const invalidConfigs = [
    phoneConfig({ address: "10.8.0.4/32" }),
    phoneConfig({ allowedIps: "10.8.1.0/24" }),
    phoneConfig({ endpoint: "203.0.113.11:51820" }),
    phoneConfig().replace("Address = 10.8.0.3/32", "Address = 10.8.0.3/32\nAddress = 10.8.0.3/32"),
    phoneConfig().replace("Address = 10.8.0.3/32", "Address = 10.8.0.3/32\nDNS = 10.8.0.1"),
    phoneConfig({ endpoint: "[not::ipv6]:51820" }),
    phoneConfig({ endpoint: "2606:4700:4700::1111:51820" }),
  ];
  for (const config of invalidConfigs) {
    assert.throws(
      () => buildPairingDeepLink({ ...base, secrets: { ...base.secrets, phoneConfig: config } }),
      /pairing data invalid/i,
    );
  }
  for (const relayUrl of ["ws://10.8.0.2:7891", "ws://10.8.0.1:7892", "ws://10.9.0.1:7891"]) {
    assert.throws(
      () => buildPairingDeepLink({ ...base, secrets: { ...base.secrets, relayUrl } }),
      /pairing data invalid/i,
    );
  }
});

test("pairing model accepts a genuinely parsed bracketed IPv6 endpoint matching the profile", () => {
  const endpoint = "[2606:4700:4700::1111]:51820";
  const deepLink = buildPairingDeepLink({
    profile: { ...PROFILE, endpoint },
    secrets: {
      phoneConfig: phoneConfig({ endpoint }),
      relayUrl: "ws://10.8.0.1:7891",
      relayToken: RELAY_TOKEN,
    },
    issuedAt: 2,
  });
  const payload = JSON.parse(Buffer.from(
    new URL(deepLink).searchParams.get("data"), "base64url",
  ).toString("utf8"));
  assert.equal(payload.wireGuard.endpoint, endpoint);
});

test("phone INI accepts full-line comments but rejects inline comment pollution", () => {
  const base = {
    profile: PROFILE,
    secrets: {
      relayUrl: "ws://10.8.0.1:7891",
      relayToken: RELAY_TOKEN,
    },
    issuedAt: 3,
  };
  const withComments = phoneConfig()
    .replace("[Interface]", "# generated phone profile\n[Interface]\n; keep this key private")
    .replace("[Peer]", "; relay peer\n[Peer]\n# exact topology follows");
  assert.doesNotThrow(() => buildPairingDeepLink({
    ...base, secrets: { ...base.secrets, phoneConfig: withComments },
  }));

  for (const polluted of [
    phoneConfig().replace("Address = 10.8.0.3/32", "Address = 10.8.0.3/32 # phone"),
    phoneConfig().replace(`PrivateKey = ${PHONE_PRIVATE_KEY}`, `PrivateKey = ${PHONE_PRIVATE_KEY} ; secret`),
  ]) {
    assert.throws(
      () => buildPairingDeepLink({
        ...base, secrets: { ...base.secrets, phoneConfig: polluted },
      }),
      /pairing data invalid/i,
    );
  }
});

test("createPairingQr uses the existing encoder and returns no raw payload", async () => {
  let encodedText = null;
  const result = await createPairingQr({
    profile: PROFILE,
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

test("real PNG data URL decodes to the exact standards-generated QR module matrix", async () => {
  const options = {
    profile: PROFILE,
    secrets: {
      phoneConfig: phoneConfig(),
      relayUrl: "ws://10.8.0.1:7891",
      relayToken: RELAY_TOKEN,
    },
    issuedAt: 42,
  };
  const deepLink = buildPairingDeepLink(options);
  const result = await createPairingQr(options);
  const png = PNG.sync.read(Buffer.from(result.dataUrl.split(",", 2)[1], "base64"));
  const expected = QRCode.create(deepLink, { errorCorrectionLevel: "M" }).modules;
  const margin = 2;
  const scale = png.width / (expected.size + margin * 2);

  assert.equal(png.width, 320);
  assert.equal(png.height, 320);
  for (let row = 0; row < expected.size; row += 1) {
    for (let column = 0; column < expected.size; column += 1) {
      const x = Math.floor((margin + column + 0.5) * scale);
      const y = Math.floor((margin + row + 0.5) * scale);
      const offset = (y * png.width + x) * 4;
      const actualDark = png.data[offset] < 128
        && png.data[offset + 1] < 128
        && png.data[offset + 2] < 128
        && png.data[offset + 3] > 0;
      assert.equal(actualDark, Boolean(expected.get(row, column)), `module ${row},${column}`);
    }
  }
});

"use strict";

const net = require("node:net");

const MAX_DEEP_LINK_BYTES = 8 * 1024;
const MAX_QR_DATA_URL_BYTES = 512 * 1024;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const TOKEN_RE = /^[0-9a-fA-F]{64}$/;
const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function invalid() {
  const error = new Error("Pairing data invalid");
  error.code = "pairing_data_invalid";
  return error;
}

function canonicalKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.equals(Buffer.alloc(32))) return null;
  return decoded.toString("base64") === value ? value : null;
}

function privateIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parsePrivateCidr(value, prefix) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!match || Number(match[2]) !== prefix || !privateIpv4(match[1])) return null;
  return match[1];
}

function parseEndpoint(value) {
  if (typeof value !== "string" || value.length > 255 || CONTROL_RE.test(value)) return null;
  let host;
  let portText;
  let ipv6 = false;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 2 || value[close + 1] !== ":") return null;
    host = value.slice(1, close);
    portText = value.slice(close + 2);
    if (net.isIP(host) !== 6) return null;
    ipv6 = true;
  } else {
    const separator = value.lastIndexOf(":");
    if (separator < 1 || value.indexOf(":") !== separator) return null;
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
    const ipVersion = net.isIP(host);
    if (ipVersion === 6) return null;
    if (ipVersion !== 4) {
      if (host.length > 253 || host.split(".").some((label) => !DOMAIN_LABEL_RE.test(label))) return null;
      host = host.toLowerCase();
    }
  }
  if (!/^[1-9]\d{0,4}$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65535) return null;
  if (ipv6) {
    try { host = new URL(`http://[${host}]:${port}`).hostname.toLowerCase(); }
    catch (_) { return null; }
  }
  return { canonical: `${host}:${port}`, port };
}

function profileTopology(profile) {
  const subnetHost = parsePrivateCidr(profile && profile.wgSubnet, 24);
  if (!subnetHost) throw invalid();
  const octets = subnetHost.split(".").map(Number);
  if (octets[3] !== 0) throw invalid();
  const endpoint = parseEndpoint(profile.endpoint);
  if (!endpoint) throw invalid();
  const prefix = octets.slice(0, 3).join(".");
  return {
    endpoint,
    phoneAddress: `${prefix}.3/32`,
    relayUrl: `ws://${prefix}.1:7891`,
    subnet: `${prefix}.0/24`,
  };
}

function parsePhoneConfig(config, profile) {
  if (typeof config !== "string" || config.length === 0 || config.length > 16 * 1024) throw invalid();
  const topology = profileTopology(profile);
  const sections = { Interface: Object.create(null), Peer: Object.create(null) };
  const seenSections = new Set();
  let active = null;
  for (const sourceLine of config.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      active = heading[1];
      if (!Object.hasOwn(sections, active) || seenSections.has(active)) throw invalid();
      seenSections.add(active);
      continue;
    }
    const field = /^([^=]+)=(.*)$/.exec(line);
    if (!active || !field) throw invalid();
    const key = field[1].trim();
    const value = field[2].trim();
    if (!key || !value || Object.hasOwn(sections[active], key)) throw invalid();
    sections[active][key] = value;
  }
  if (seenSections.size !== 2
      || Object.keys(sections.Interface).sort().join(",") !== "Address,PrivateKey"
      || Object.keys(sections.Peer).sort().join(",") !== "AllowedIPs,Endpoint,PersistentKeepalive,PublicKey") {
    throw invalid();
  }
  const privateKey = canonicalKey(sections.Interface.PrivateKey);
  const serverPublicKey = canonicalKey(sections.Peer.PublicKey);
  const address = sections.Interface.Address;
  const allowedIp = sections.Peer.AllowedIPs;
  const endpoint = parseEndpoint(sections.Peer.Endpoint);
  if (!privateKey || !serverPublicKey || privateKey === serverPublicKey
      || address !== topology.phoneAddress
      || allowedIp !== topology.subnet
      || sections.Peer.PersistentKeepalive !== "25"
      || !endpoint || endpoint.canonical !== topology.endpoint.canonical) {
    throw invalid();
  }
  return {
    privateKey,
    address,
    serverPublicKey,
    endpoint: sections.Peer.Endpoint,
    allowedIps: [allowedIp],
    persistentKeepalive: 25,
  };
}

function parseRelay(secrets, profile) {
  const topology = profileTopology(profile);
  let url;
  try { url = new URL(secrets.relayUrl); } catch (_) { throw invalid(); }
  if (url.protocol !== "ws:" || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash
      || url.href.replace(/\/$/, "") !== topology.relayUrl
      || typeof secrets.relayToken !== "string" || !TOKEN_RE.test(secrets.relayToken)) {
    throw invalid();
  }
  return { url: url.href.replace(/\/$/, ""), token: secrets.relayToken };
}

function validatePairingSecrets(profile, secrets) {
  return {
    wireGuard: parsePhoneConfig(secrets && secrets.phoneConfig, profile),
    relay: parseRelay(secrets || {}, profile),
  };
}

function buildPairingDeepLink(options = {}) {
  const profile = options.profile;
  const secrets = options.secrets;
  const issuedAt = options.issuedAt === undefined ? Date.now() : options.issuedAt;
  if (!profile || !secrets || typeof profile.label !== "string"
      || profile.label.length < 1 || profile.label.length > 100 || CONTROL_RE.test(profile.label)
      || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw invalid();
  }
  const validated = validatePairingSecrets(profile, secrets);
  const payload = {
    version: 1,
    name: profile.label,
    wireGuard: validated.wireGuard,
    relay: validated.relay,
    issuedAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const deepLink = `clawd://relay-pair?v=1&data=${encoded}`;
  if (Buffer.byteLength(deepLink, "utf8") > MAX_DEEP_LINK_BYTES) throw invalid();
  return deepLink;
}

async function createPairingQr(options = {}) {
  const QRCode = options.QRCode || require("qrcode");
  const deepLink = buildPairingDeepLink(options);
  let dataUrl;
  try {
    dataUrl = await QRCode.toDataURL(deepLink, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    });
  } catch (_) {
    const error = new Error("Pairing QR generation failed");
    error.code = "pairing_qr_failed";
    throw error;
  }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")
      || Buffer.byteLength(dataUrl, "utf8") > MAX_QR_DATA_URL_BYTES) {
    const error = new Error("Pairing QR generation failed");
    error.code = "pairing_qr_failed";
    throw error;
  }
  return { version: 1, dataUrl };
}

module.exports = {
  buildPairingDeepLink,
  createPairingQr,
  MAX_DEEP_LINK_BYTES,
  parsePhoneConfig,
  validatePairingSecrets,
};

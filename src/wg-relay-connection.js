"use strict";

const http = require("node:http");
const { WgRelaySidecar } = require("./wg-relay-sidecar");
const { RelayBridge } = require("./relay-bridge-integration");

const STABLE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

function codedError(code) {
  const stable = typeof code === "string" && STABLE_CODE_RE.test(code) ? code : "connection_failed";
  const error = new Error(stable);
  error.code = stable;
  return error;
}

function parseIniValue(config, section, name) {
  let active = "";
  for (const rawLine of String(config || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { active = heading[1]; continue; }
    if (active !== section) continue;
    const field = /^([^=]+)=(.*)$/.exec(line);
    if (field && field[1].trim() === name) return field[2].trim();
  }
  return "";
}

function sidecarConfigFromSecrets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw codedError("secret_invalid");
  const pcConfig = value.pcConfig || value.pcConf;
  let relay;
  try { relay = new URL(value.relayUrl || value.relayAddr); } catch (_) { throw codedError("secret_invalid"); }
  const config = {
    PrivateKey: parseIniValue(pcConfig, "Interface", "PrivateKey"),
    Address: parseIniValue(pcConfig, "Interface", "Address"),
    ServerPublicKey: parseIniValue(pcConfig, "Peer", "PublicKey"),
    Endpoint: parseIniValue(pcConfig, "Peer", "Endpoint"),
    AllowedIP: parseIniValue(pcConfig, "Peer", "AllowedIPs"),
    ForwardAddress: relay.host,
    KeepaliveSeconds: Number(parseIniValue(pcConfig, "Peer", "PersistentKeepalive")),
  };
  if (relay.protocol !== "ws:" || relay.username || relay.password
      || relay.pathname !== "/" || relay.search || relay.hash
      || Object.entries(config).some(([key, item]) => (
        key === "KeepaliveSeconds" ? !Number.isInteger(item) : typeof item !== "string" || item.length === 0
      ))) {
    throw codedError("secret_invalid");
  }
  if (typeof value.relayToken !== "string" || value.relayToken.length === 0) {
    throw codedError("secret_invalid");
  }
  return config;
}

function loopbackHealthUrl(listen, pathName = "/health") {
  const match = typeof listen === "string"
    ? /^(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(listen)
    : null;
  if (!match || Number(match[1]) > 65535) {
    throw codedError("health_non_loopback");
  }
  let url;
  try { url = new URL(`http://${listen}${pathName}`); }
  catch (_) { throw codedError("health_non_loopback"); }
  if (!(url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw codedError("health_non_loopback");
  }
  return url;
}

function validHealthBody(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.version === 1
    && value.status === "ok"
    && Number.isFinite(value.uptimeSeconds)
    && value.uptimeSeconds >= 0;
}

function probeRelayHealth(options = {}) {
  let url;
  try { url = loopbackHealthUrl(options.listen, options.path || "/health"); }
  catch (error) { return Promise.reject(error); }
  const timeoutMs = options.timeoutMs || 5_000;
  const maxBytes = options.maxBytes || 16 * 1024;
  const requestImpl = options.request || http.request;

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(codedError("health_timeout"));
      if (request && typeof request.destroy === "function") request.destroy();
    }, timeoutMs);
    try {
      request = requestImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      }, (response) => {
        const statusCode = Number(response.statusCode);
        if (statusCode >= 300 && statusCode < 400) {
          response.resume();
          finish(codedError("health_redirect_rejected"));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(codedError("health_http_status"));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > maxBytes) {
            finish(codedError("health_response_too_large"));
            if (typeof response.destroy === "function") response.destroy();
            return;
          }
          chunks.push(data);
        });
        response.on("end", () => {
          if (settled) return;
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch (_) { finish(codedError("health_invalid_response")); return; }
          if (!validHealthBody(body)) { finish(codedError("health_invalid_response")); return; }
          finish(null, body);
        });
        response.on("error", () => finish(codedError("health_request_failed")));
        response.on("aborted", () => finish(codedError("health_request_failed")));
      });
      request.on("error", () => finish(codedError("health_request_failed")));
      request.end();
    } catch (_) {
      finish(codedError("health_request_failed"));
    }
  });
}

function createWgRelayConnection(options = {}) {
  const runtime = options.runtime;
  const secretStore = options.secretStore;
  if (!runtime || typeof runtime.setStatus !== "function") throw new TypeError("runtime is required");
  if (!secretStore || typeof secretStore.read !== "function") throw new TypeError("secretStore is required");

  const sidecarFactory = options.sidecarFactory || (() => new WgRelaySidecar(options.sidecarOptions));
  const bridgeFactory = options.bridgeFactory || (() => new RelayBridge(options.bridgeOptions));
  const healthProbe = options.healthProbe || probeRelayHealth;
  const healthTimeoutMs = options.healthTimeoutMs || 5_000;
  const healthMaxBytes = options.healthMaxBytes || 16 * 1024;
  const bridgeTimeoutMs = options.bridgeTimeoutMs || 15_000;
  const log = typeof options.log === "function" ? options.log : () => {};
  const active = new Map();
  const generations = new Map();
  const allSidecars = new Set();
  const allBridges = new Set();
  let disposed = false;

  function nextGeneration(profileId) {
    const generation = (generations.get(profileId) || 0) + 1;
    generations.set(profileId, generation);
    return generation;
  }

  function isCurrent(record) {
    return active.get(record.profileId) === record && !record.cancelled;
  }

  function assertCurrent(record) {
    if (!isCurrent(record)) throw codedError("connection_cancelled");
  }

  function setState(record, status, errorCode) {
    if (!isCurrent(record)) return runtime.getProfileStatus(record.profileId);
    return runtime.setStatus(record.profileId, {
      status,
      attempt: record.generation,
      errorCode: errorCode || null,
      message: null,
      hint: null,
    });
  }

  function detach(record) {
    if (record.sidecar && record.onSidecarFailure) record.sidecar.off("failure", record.onSidecarFailure);
    if (record.bridge && record.onBridgeFailure) record.bridge.off("failure", record.onBridgeFailure);
  }

  async function rollback(record) {
    detach(record);
    try { await record.bridge.stop(); } catch (_) {}
    try { await record.sidecar.stop(); } catch (_) {}
  }

  async function unexpectedFailure(record, failure, fallback) {
    if (!isCurrent(record) || record.failureInProgress) return;
    record.failureInProgress = true;
    const code = failure && STABLE_CODE_RE.test(failure.errorCode || "")
      ? failure.errorCode : fallback;
    await rollback(record);
    if (isCurrent(record)) setState(record, "failed", code);
    log("wg-relay connection failed", record.profileId, code);
  }

  function connect(profileId) {
    if (disposed) return Promise.reject(codedError("connection_disposed"));
    const existing = active.get(profileId);
    if (existing && existing.connectPromise) return existing.connectPromise;
    if (existing && runtime.getProfileStatus(profileId).status === "connected") {
      return Promise.resolve(runtime.getProfileStatus(profileId));
    }

    const generation = nextGeneration(profileId);
    const sidecar = sidecarFactory(profileId);
    const bridge = bridgeFactory(profileId);
    allSidecars.add(sidecar);
    allBridges.add(bridge);
    const record = {
      profileId, generation, sidecar, bridge,
      cancelled: false,
      failureInProgress: false,
      connectPromise: null,
      sidecarGeneration: null,
      onSidecarFailure: null,
      onBridgeFailure: null,
    };
    active.set(profileId, record);
    record.onSidecarFailure = (failure) => {
      if (record.sidecarGeneration !== null
          && failure && failure.generation !== undefined
          && failure.generation !== record.sidecarGeneration) return;
      void unexpectedFailure(record, failure, "sidecar_unexpected_exit");
    };
    record.onBridgeFailure = (failure) => {
      if (runtime.getProfileStatus(profileId).status === "connected") {
        void unexpectedFailure(record, failure, "relay_connect_failed");
      }
    };
    sidecar.on("failure", record.onSidecarFailure);
    bridge.on("failure", record.onBridgeFailure);

    const operation = (async () => {
      try {
        const stored = await secretStore.read(profileId);
        assertCurrent(record);
        const sidecarConfig = sidecarConfigFromSecrets(stored);
        setState(record, "starting_tunnel");
        const ready = await sidecar.start(sidecarConfig);
        record.sidecarGeneration = ready.generation;
        assertCurrent(record);
        setState(record, "verifying_relay");
        await healthProbe({
          profileId,
          listen: ready.listen,
          path: "/health",
          timeoutMs: healthTimeoutMs,
          maxBytes: healthMaxBytes,
        });
        assertCurrent(record);
        setState(record, "connecting_relay");
        bridge.configure({ url: `ws://${ready.listen}`, token: stored.relayToken });
        bridge.start();
        await bridge.waitUntilConnected(bridgeTimeoutMs);
        assertCurrent(record);
        return setState(record, "connected");
      } catch (error) {
        const code = error && STABLE_CODE_RE.test(error.code || "") ? error.code : "connection_failed";
        if (isCurrent(record)) {
          await rollback(record);
          setState(record, "failed", code);
          record.connectPromise = null;
          log("wg-relay connect failed", profileId, code);
        }
        throw codedError(isCurrent(record) ? code : "connection_cancelled");
      }
    })();
    record.connectPromise = operation;
    return operation;
  }

  function disconnect(profileId) {
    const record = active.get(profileId);
    const generation = nextGeneration(profileId);
    if (!record) {
      return Promise.resolve(runtime.setStatus(profileId, {
        status: "idle", attempt: generation, errorCode: null, message: null, hint: null,
      }));
    }
    record.cancelled = true;
    active.delete(profileId);
    runtime.setStatus(profileId, {
      status: "disconnecting", attempt: generation, errorCode: null, message: null, hint: null,
    });
    return rollback(record).then(() => runtime.setStatus(profileId, {
      status: "idle", attempt: generation, errorCode: null, message: null, hint: null,
    }));
  }

  function status(profileId) {
    return runtime.getProfileStatus(profileId);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const profileId of Array.from(active.keys())) await disconnect(profileId);
    for (const bridge of allBridges) {
      try { if (typeof bridge.destroy === "function") bridge.destroy(); } catch (_) {}
    }
    for (const sidecar of allSidecars) {
      try { if (typeof sidecar.dispose === "function") await sidecar.dispose(); } catch (_) {}
    }
    active.clear();
    allBridges.clear();
    allSidecars.clear();
  }

  return { connect, disconnect, status, dispose };
}

module.exports = {
  createWgRelayConnection,
  probeRelayHealth,
  sidecarConfigFromSecrets,
};

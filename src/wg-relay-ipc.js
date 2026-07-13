"use strict";

const childProcess = require("node:child_process");
const http = require("node:http");
const { isDeepStrictEqual } = require("node:util");

const { deploy: defaultDeploy } = require("./wg-relay-deploy");
const { createWgRelayConnection } = require("./wg-relay-connection");
const { normalizeConnectionErrorCode } = require("./wg-relay-error-codes");
const { createPairingQr } = require("./wg-relay-pairing-qr");
const { sanitizeProfile } = require("./wg-relay-profile");
const { createWgRelayRuntime } = require("./wg-relay-runtime");
const { createWgRelaySecretStore } = require("./wg-relay-secret-store");
const { WgRelaySidecar } = require("./wg-relay-sidecar");
const {
  bringUp: defaultBringUp,
  bringDown: defaultBringDown,
  status: defaultTunnelStatus,
} = require("./wg-pc-tunnel");

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TEXT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TOKEN_RE = /^[0-9a-fA-F]{64}$/;
const PUBLIC_STATE_FIELDS = new Set([
  "profileId", "status", "hint", "ifName", "address",
  "errorCode", "generation", "updatedAt",
]);

function requireDependency(value, name) {
  if (!value) throw new Error(`registerWgRelayIpc requires ${name}`);
  return value;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function profileIdFrom(payload) {
  if (typeof payload === "string" && PROFILE_ID_RE.test(payload)) return payload;
  if (payload && typeof payload === "object") {
    const value = payload.profileId || payload.id;
    if (typeof value === "string" && PROFILE_ID_RE.test(value)) return value;
  }
  return null;
}

function findProfile(settingsController, profileId) {
  const snapshot = settingsController.getSnapshot();
  const profiles = snapshot && snapshot.wgRelay && Array.isArray(snapshot.wgRelay.profiles)
    ? snapshot.wgRelay.profiles
    : [];
  const found = profiles.find((profile) => profile && profile.id === profileId);
  return found ? sanitizeProfile(found) : null;
}

function redactState(value, fallbackId) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const state = {};
  for (const [key, item] of Object.entries(source)) {
    if (PUBLIC_STATE_FIELDS.has(key)) state[key] = item;
  }
  if (!PROFILE_ID_RE.test(state.profileId || "") && PROFILE_ID_RE.test(fallbackId || "")) {
    state.profileId = fallbackId;
  }
  if (typeof state.status !== "string") state.status = "idle";
  if (!Number.isSafeInteger(state.generation) || state.generation < 0) state.generation = 0;
  return state;
}

function redactProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!PROFILE_ID_RE.test(value.profileId || "")
      || !SAFE_TEXT_RE.test(value.step || "")
      || !["start", "ok", "fail"].includes(value.status)) return null;
  const result = { profileId: value.profileId, step: value.step, status: value.status };
  if (SAFE_TEXT_RE.test(value.hint || "")) result.hint = value.hint;
  return result;
}

function broadcast(BrowserWindow, channel, payload) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  } catch (_) {
    // A renderer disappearing during shutdown must not affect the owner state.
  }
}

function stableDeployFailure(result) {
  const response = { status: "error", errorCode: "deploy_failed" };
  for (const key of ["step", "reason", "hint"]) {
    if (result && SAFE_TEXT_RE.test(result[key] || "")) response[key] = result[key];
  }
  return response;
}

function normalizeQr(value) {
  const dataUrl = typeof value === "string" ? value : value && value.dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")
      || Buffer.byteLength(dataUrl, "utf8") > 512 * 1024) {
    throw codedError("pairing_qr_failed");
  }
  return { version: 1, dataUrl };
}

function validateRotationResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "phoneConfig,relayToken,version"
      || value.version !== 1
      || typeof value.phoneConfig !== "string" || value.phoneConfig.length < 1
      || Buffer.byteLength(value.phoneConfig, "utf8") > 16 * 1024
      || !TOKEN_RE.test(value.relayToken || "")) {
    throw codedError("management_invalid_response");
  }
  return value;
}

function loopbackManagementUrl(listen, pathName) {
  const match = typeof listen === "string"
    ? /^(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(listen)
    : null;
  if (!match || Number(match[2]) > 65535) throw codedError("management_non_loopback");
  let url;
  try { url = new URL(`http://${listen}${pathName}`); }
  catch (_) { throw codedError("management_non_loopback"); }
  if (!(url.hostname === "127.0.0.1" || url.hostname === "[::1]")) {
    throw codedError("management_non_loopback");
  }
  return url;
}

function requestPhoneRotation(options = {}) {
  let url;
  try { url = loopbackManagementUrl(options.listen, options.path || "/api/manage/phone/rotate"); }
  catch (error) { return Promise.reject(error); }
  if (!TOKEN_RE.test(options.managementToken || "")) {
    return Promise.reject(codedError("management_auth_invalid"));
  }
  const body = Buffer.from(JSON.stringify({ version: 1 }), "utf8");
  const timeoutMs = options.timeoutMs || 10_000;
  const maxBytes = options.maxBytes || 32 * 1024;
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
      finish(codedError("management_timeout"));
      if (request && typeof request.destroy === "function") request.destroy();
    }, timeoutMs);
    try {
      request = requestImpl(url, {
        method: "POST",
        agent: false,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.managementToken}`,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
          Connection: "close",
        },
      }, (response) => {
        const statusCode = Number(response.statusCode);
        if (statusCode >= 300 && statusCode < 400) {
          response.resume();
          finish(codedError("management_redirect_rejected"));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(codedError("management_http_status"));
          return;
        }
        const contentType = String(response.headers && response.headers["content-type"] || "")
          .split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          response.resume();
          finish(codedError("management_invalid_response"));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > maxBytes) {
            finish(codedError("management_response_too_large"));
            if (typeof response.destroy === "function") response.destroy();
            return;
          }
          chunks.push(data);
        });
        response.on("end", () => {
          if (settled) return;
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch (_) { finish(codedError("management_invalid_response")); return; }
          try { finish(null, validateRotationResult(parsed)); }
          catch (error) { finish(error); }
        });
        response.on("error", () => finish(codedError("management_request_failed")));
        response.on("aborted", () => finish(codedError("management_request_failed")));
      });
      request.on("error", () => finish(codedError("management_request_failed")));
      request.end(body);
    } catch (_) {
      finish(codedError("management_request_failed"));
    }
  });
}

function registerWgRelayIpc(options = {}) {
  const ipcMain = requireDependency(options.ipcMain, "ipcMain");
  const settingsController = requireDependency(options.settingsController, "settingsController");
  const wgRelayRuntime = requireDependency(options.wgRelayRuntime, "wgRelayRuntime");
  const BrowserWindow = requireDependency(options.BrowserWindow, "BrowserWindow");
  const secretStore = requireDependency(options.secretStore, "secretStore");
  const connection = requireDependency(options.connection, "connection");
  const dialog = options.dialog || null;
  const spawn = options.spawn || childProcess.spawn;
  const deployFn = options.deployFn || defaultDeploy;
  const rotatePhoneFn = options.rotatePhoneFn || requestPhoneRotation;
  const getForwardEndpoint = options.getForwardEndpoint || (() => null);
  const qrEncoder = options.qrEncoder || ((args) => createPairingQr(args));
  const now = options.now || Date.now;
  const log = typeof options.log === "function" ? options.log : () => {};
  const bringUpFn = options.bringUpFn || defaultBringUp;
  const bringDownFn = options.bringDownFn || defaultBringDown;
  const tunnelStatusFn = options.tunnelStatusFn || defaultTunnelStatus;
  const privilegeEscalator = options.privilegeEscalator;
  const ifNameFor = options.ifNameFor || ((profile) => profile.ifName || "clawd0");

  const disposers = [];
  const operationTails = new Map();
  const deployInflight = new Map();
  const qrCache = new Map();
  const deletedProfiles = new Set();
  let disposed = false;
  let disposePromise = null;

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => {
      try { ipcMain.removeHandler(channel); } catch (_) {}
    });
  }

  function enqueue(profileId, operation) {
    const prior = operationTails.get(profileId) || Promise.resolve();
    const current = prior.catch(() => {}).then(() => {
      if (disposed) throw codedError("ipc_disposed");
      return operation();
    });
    operationTails.set(profileId, current);
    const clear = () => {
      if (operationTails.get(profileId) === current) operationTails.delete(profileId);
    };
    current.then(clear, clear);
    return current;
  }

  function secretStoreAvailable() {
    try { return typeof secretStore.isAvailable !== "function" || secretStore.isAvailable(); }
    catch (_) { return false; }
  }

  function confirmHostKey(info) {
    if (!dialog || typeof dialog.showMessageBox !== "function") return Promise.resolve(false);
    return Promise.resolve(dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Trust this host"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: "Confirm the SSH host key before deploying",
      detail: `${info.host}:${info.port}\n${info.fingerprint}`,
    })).then((result) => !!result && result.response === 1, () => false);
  }

  async function writeAndVerifySecrets(profileId, secrets) {
    secretStore.write(profileId, secrets);
    const verified = secretStore.read(profileId);
    if (!isDeepStrictEqual(verified, secrets)) throw codedError("secret_store_verification_failed");
  }

  async function restoreSecrets(profileId, previousSecrets) {
    if (previousSecrets) await writeAndVerifySecrets(profileId, previousSecrets);
    else secretStore.remove(profileId);
  }

  async function writePublicProfile(previousProfile, profile) {
    const result = await settingsController.applyCommand(
      previousProfile ? "wgRelay.update" : "wgRelay.add",
      profile,
    );
    if (!result || result.status !== "ok") throw codedError("public_profile_write_failed");
  }

  async function restorePublicProfile(previousProfile, profileId) {
    const result = previousProfile
      ? await settingsController.applyCommand("wgRelay.update", previousProfile)
      : await settingsController.applyCommand("wgRelay.remove", { id: profileId });
    if (!result || result.status !== "ok") throw codedError("public_profile_rollback_failed");
  }

  async function encodeQr(profile, secrets) {
    return normalizeQr(await qrEncoder({ profile, secrets, issuedAt: now() }));
  }

  const onStatusChanged = (state) => {
    if (disposed || deletedProfiles.has(state && state.profileId)) return;
    broadcast(BrowserWindow, "wgRelay:status-changed", redactState(state));
  };
  const onProgress = (progress) => {
    if (disposed || deletedProfiles.has(progress && progress.profileId)) return;
    const safe = redactProgress(progress);
    if (safe) broadcast(BrowserWindow, "wgRelay:progress", safe);
  };
  wgRelayRuntime.on("status-changed", onStatusChanged);
  wgRelayRuntime.on("progress", onProgress);
  disposers.push(() => {
    wgRelayRuntime.off("status-changed", onStatusChanged);
    wgRelayRuntime.off("progress", onProgress);
  });

  handle("wgRelay:status", (_event, payload) => {
    const profileId = profileIdFrom(payload);
    if (!profileId) return { status: "error", errorCode: "invalid_profile_id" };
    if (deletedProfiles.has(profileId) || !findProfile(settingsController, profileId)) {
      return { status: "error", errorCode: "profile_not_found" };
    }
    return { status: "ok", state: redactState(connection.status(profileId), profileId) };
  });

  handle("wgRelay:list-statuses", () => {
    const snapshot = settingsController.getSnapshot();
    const profiles = snapshot && snapshot.wgRelay && Array.isArray(snapshot.wgRelay.profiles)
      ? snapshot.wgRelay.profiles
      : [];
    const allowed = new Set(profiles.map((profile) => profile && profile.id).filter(Boolean));
    const statuses = wgRelayRuntime.listStatuses()
      .filter((state) => allowed.has(state.profileId) && !deletedProfiles.has(state.profileId))
      .map((state) => redactState(state));
    return { status: "ok", statuses };
  });

  handle("wgRelay:connect", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    if (!profileId || !findProfile(settingsController, profileId)) {
      return { status: "error", errorCode: "profile_not_found" };
    }
    try {
      return await enqueue(profileId, async () => {
        deletedProfiles.delete(profileId);
        const state = await connection.connect(profileId);
        return { status: "ok", state: redactState(state, profileId) };
      });
    } catch (error) {
      return { status: "error", errorCode: normalizeConnectionErrorCode(error && error.code) };
    }
  });

  handle("wgRelay:disconnect", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    if (!profileId) return { status: "error", errorCode: "invalid_profile_id" };
    try {
      return await enqueue(profileId, async () => ({
        status: "ok",
        state: redactState(await connection.disconnect(profileId), profileId),
      }));
    } catch (error) {
      return { status: "error", errorCode: normalizeConnectionErrorCode(error && error.code) };
    }
  });

  async function deployTransaction(profile, previousProfile, password) {
    if (!secretStoreAvailable()) return { status: "error", errorCode: "secure_storage_unavailable" };
    let previousSecrets = null;
    try { previousSecrets = secretStore.read(profile.id); }
    catch (_) { return { status: "error", errorCode: "secret_store_read_failed" }; }
    const previousState = redactState(connection.status(profile.id), profile.id);
    const wasConnected = previousState.status === "connected";
    const previousQr = qrCache.get(profile.id);
    let secretWritten = false;
    let publicWritten = false;
    let connectionTouched = false;
    try {
      const result = await deployFn({
        profile,
        password,
        runtime: { forcePhoneKey: false },
        deps: { spawn, runtime: wgRelayRuntime, confirmHostKey },
      });
      if (!result || !result.ok || !result.readback) return stableDeployFailure(result);
      if (disposed) throw codedError("ipc_disposed");
      const readback = result.readback;
      const secrets = {
        pcConfig: readback.pcConfig,
        phoneConfig: readback.phoneConfig,
        relayToken: readback.relayToken,
        managementToken: readback.managementToken,
        relayUrl: readback.relayUrl,
      };
      secretWritten = true;
      await writeAndVerifySecrets(profile.id, secrets);
      const publicProfile = sanitizeProfile({
        ...profile,
        ...(result.acceptedFingerprint ? { sshHostFingerprint: result.acceptedFingerprint } : {}),
        endpoint: readback.endpoint,
        relayAddr: readback.relayUrl,
        lastDeployedAt: now(),
        deployVersion: readback.schemaVersion,
      });
      if (!publicProfile) throw codedError("public_profile_invalid");
      publicWritten = true;
      await writePublicProfile(previousProfile, publicProfile);
      deletedProfiles.delete(profile.id);
      if (wasConnected) {
        connectionTouched = true;
        await connection.disconnect(profile.id);
      }
      connectionTouched = true;
      const connected = await connection.connect(profile.id);
      if (!connected || connected.status !== "connected") throw codedError("connection_failed");
      const qr = await encodeQr(publicProfile, secrets);
      if (disposed) throw codedError("ipc_disposed");
      qrCache.set(profile.id, qr);
      return {
        status: "ok",
        profile: publicProfile,
        state: redactState(connected, profile.id),
        qr,
      };
    } catch (_) {
      if (connectionTouched) {
        try { await connection.disconnect(profile.id); } catch (_) {}
      }
      if (secretWritten) {
        try { await restoreSecrets(profile.id, previousSecrets); }
        catch (_) { log("wg-relay deploy rollback failed", profile.id, "secret_store"); }
      } else if (!previousSecrets) {
        try { secretStore.remove(profile.id); } catch (_) {}
      }
      if (publicWritten) {
        try { await restorePublicProfile(previousProfile, profile.id); }
        catch (_) { log("wg-relay deploy rollback failed", profile.id, "public_profile"); }
      }
      if (previousQr) qrCache.set(profile.id, previousQr); else qrCache.delete(profile.id);
      if (wasConnected && previousSecrets) {
        try { await connection.connect(profile.id); } catch (_) {}
      }
      return { status: "error", errorCode: "deploy_failed" };
    }
  }

  handle("wgRelay:deploy", async (_event, payload) => {
    let password = payload && typeof payload === "object" && typeof payload.password === "string"
      ? payload.password
      : undefined;
    try {
      const supplied = payload && typeof payload === "object" ? sanitizeProfile(payload.profile) : null;
      const profileId = supplied ? supplied.id : profileIdFrom(payload);
      const previousProfile = profileId ? findProfile(settingsController, profileId) : null;
      const profile = supplied || previousProfile;
      if (!profile) return { status: "error", errorCode: "invalid_profile" };
      if (deployInflight.has(profile.id)) return await deployInflight.get(profile.id);
      const operation = enqueue(profile.id, () => deployTransaction(profile, previousProfile, password));
      deployInflight.set(profile.id, operation);
      const clear = () => {
        if (deployInflight.get(profile.id) === operation) deployInflight.delete(profile.id);
      };
      operation.then(clear, clear);
      return await operation;
    } catch (_) {
      return { status: "error", errorCode: "deploy_failed" };
    } finally {
      password = undefined;
      if (payload && typeof payload === "object") {
        try { delete payload.password; } catch (_) { payload.password = undefined; }
      }
    }
  });

  handle("wgRelay:pairing-qr", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    const profile = profileId ? findProfile(settingsController, profileId) : null;
    if (!profile) return { status: "error", errorCode: "profile_not_found" };
    try {
      return await enqueue(profileId, async () => {
        if (qrCache.has(profileId)) return { status: "ok", qr: qrCache.get(profileId) };
        const secrets = secretStore.read(profileId);
        if (!secrets) return { status: "error", errorCode: "secrets_not_found" };
        const qr = await encodeQr(profile, secrets);
        if (disposed) throw codedError("ipc_disposed");
        qrCache.set(profileId, qr);
        return { status: "ok", qr };
      });
    } catch (_) {
      return { status: "error", errorCode: "pairing_qr_failed" };
    }
  });

  handle("wgRelay:rotate-phone", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    const profile = profileId ? findProfile(settingsController, profileId) : null;
    if (!profile) return { status: "error", errorCode: "profile_not_found" };
    try {
      return await enqueue(profileId, async () => {
        if (!secretStoreAvailable()) return { status: "error", errorCode: "secure_storage_unavailable" };
        const oldSecrets = secretStore.read(profileId);
        if (!oldSecrets) return { status: "error", errorCode: "secrets_not_found" };
        const oldState = redactState(connection.status(profileId), profileId);
        const wasConnected = oldState.status === "connected";
        const oldQr = qrCache.get(profileId);
        let ensuredConnection = false;
        let secretWritten = false;
        let connectionTouched = false;
        try {
          if (!wasConnected) {
            const state = await connection.connect(profileId);
            if (!state || state.status !== "connected") throw codedError("connection_failed");
            ensuredConnection = true;
          }
          const rotated = validateRotationResult(await rotatePhoneFn({
            listen: getForwardEndpoint(profileId),
            managementToken: oldSecrets.managementToken,
            profileId,
          }));
          const newSecrets = {
            ...oldSecrets,
            phoneConfig: rotated.phoneConfig,
            relayToken: rotated.relayToken,
          };
          secretWritten = true;
          await writeAndVerifySecrets(profileId, newSecrets);
          connectionTouched = true;
          await connection.disconnect(profileId);
          const connected = await connection.connect(profileId);
          if (!connected || connected.status !== "connected") throw codedError("connection_failed");
          const qr = await encodeQr(profile, newSecrets);
          if (disposed) throw codedError("ipc_disposed");
          qrCache.set(profileId, qr);
          return { status: "ok", state: redactState(connected, profileId), qr };
        } catch (_) {
          if (connectionTouched || ensuredConnection) {
            try { await connection.disconnect(profileId); } catch (_) {}
          }
          if (secretWritten) {
            try { await writeAndVerifySecrets(profileId, oldSecrets); }
            catch (_) { log("wg-relay rotate rollback failed", profileId, "secret_store"); }
          }
          if (oldQr) qrCache.set(profileId, oldQr); else qrCache.delete(profileId);
          if (wasConnected) {
            try { await connection.connect(profileId); } catch (_) {}
          }
          return { status: "error", errorCode: "rotate_failed" };
        }
      });
    } catch (_) {
      return { status: "error", errorCode: "rotate_failed" };
    }
  });

  handle("wgRelay:delete-local", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    if (!profileId) return { status: "error", errorCode: "invalid_profile_id" };
    try {
      return await enqueue(profileId, async () => {
        const previousProfile = findProfile(settingsController, profileId);
        const errors = [];
        try { await connection.disconnect(profileId); }
        catch (_) { errors.push("disconnect_failed"); }
        let secretsRemoved = false;
        try { secretsRemoved = secretStore.remove(profileId) === true; }
        catch (_) { errors.push("secret_remove_failed"); }
        let publicProfileRemoved = false;
        if (previousProfile) {
          try {
            const result = await settingsController.applyCommand("wgRelay.remove", { id: profileId });
            if (!result || result.status !== "ok") errors.push("public_profile_remove_failed");
            else publicProfileRemoved = true;
          } catch (_) { errors.push("public_profile_remove_failed"); }
        }
        qrCache.delete(profileId);
        if (!previousProfile || publicProfileRemoved) deletedProfiles.add(profileId);
        else deletedProfiles.delete(profileId);
        if (typeof wgRelayRuntime.forgetPcConf === "function") wgRelayRuntime.forgetPcConf(profileId);
        const removed = { publicProfile: publicProfileRemoved, secrets: secretsRemoved };
        return errors.length
          ? { status: "partial", removed, errors }
          : { status: "ok", removed };
      });
    } catch (_) {
      return { status: "error", errorCode: "delete_failed" };
    }
  });

  // Compatibility only: Task 7 and newer callers use connect/disconnect.
  handle("wgRelay:tunnel-up", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    const profile = profileId ? findProfile(settingsController, profileId) : null;
    const pcConf = profile && wgRelayRuntime.getPcConf(profileId);
    if (!profile || !pcConf) return { status: "error", errorCode: "legacy_tunnel_unavailable" };
    try {
      const result = await bringUpFn({
        pcConf,
        ifName: ifNameFor(profile),
        privilegeEscalator,
        deps: { spawn },
      });
      return result && result.ok ? { status: "ok" } : { status: "error", errorCode: "legacy_tunnel_failed" };
    } catch (_) { return { status: "error", errorCode: "legacy_tunnel_failed" }; }
  });
  handle("wgRelay:tunnel-down", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    const profile = profileId ? findProfile(settingsController, profileId) : null;
    try {
      const result = await bringDownFn({
        ifName: profile ? ifNameFor(profile) : "clawd0",
        privilegeEscalator,
        deps: { spawn },
      });
      return result && result.ok ? { status: "ok" } : { status: "error", errorCode: "legacy_tunnel_failed" };
    } catch (_) { return { status: "error", errorCode: "legacy_tunnel_failed" }; }
  });
  handle("wgRelay:tunnel-status", async (_event, payload) => {
    const profileId = profileIdFrom(payload);
    const profile = profileId ? findProfile(settingsController, profileId) : null;
    try {
      const tunnel = await tunnelStatusFn({ ifName: profile ? ifNameFor(profile) : "clawd0", deps: { spawn } });
      return { status: "ok", tunnel };
    } catch (_) { return { status: "error", errorCode: "legacy_tunnel_failed" }; }
  });

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    while (disposers.length) {
      const disposer = disposers.pop();
      try { disposer(); } catch (_) {}
    }
    qrCache.clear();
    const pending = Array.from(new Set(operationTails.values()));
    disposePromise = Promise.allSettled(pending).then(() => {
      qrCache.clear();
    });
    return disposePromise;
  }

  return { dispose };
}

function createWgRelayQuitBarrier(options = {}) {
  const dispose = requireDependency(options.dispose, "dispose");
  const quit = requireDependency(options.quit, "quit");
  const schedule = options.schedule || setImmediate;
  let ready = false;
  let pending = null;

  function beforeQuit(event) {
    if (ready) return false;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (!pending) {
      let disposal;
      try { disposal = dispose(); }
      catch (_) { disposal = undefined; }
      pending = Promise.resolve(disposal)
        .catch(() => {})
        .then(() => {
          ready = true;
          schedule(quit);
        });
    }
    return true;
  }

  return {
    beforeQuit,
    wait: () => pending || Promise.resolve(),
  };
}

function createWgRelayMainIntegration(options = {}) {
  const ipcMain = requireDependency(options.ipcMain, "ipcMain");
  const BrowserWindow = requireDependency(options.BrowserWindow, "BrowserWindow");
  const settingsController = requireDependency(options.settingsController, "settingsController");
  const userDataPath = requireDependency(options.userDataPath, "userDataPath");
  const sidecarOptions = {
    appRoot: options.appRoot,
    resourcesPath: options.resourcesPath,
    isPackaged: Boolean(options.isPackaged),
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
  };
  const secretStore = (options.secretStoreFactory || createWgRelaySecretStore)({
    safeStorage: options.safeStorage,
    userDataPath,
    fs: options.fs,
    platform: sidecarOptions.platform,
  });
  const runtime = (options.runtimeFactory || createWgRelayRuntime)({ log: options.log });
  const forwardEndpoints = new Map();
  let closed = false;
  let disposePromise = null;

  function makeSidecar(profileId) {
    const sidecar = options.sidecarFactory
      ? options.sidecarFactory({ ...sidecarOptions }, profileId)
      : new WgRelaySidecar({ ...sidecarOptions, log: options.log });
    const start = sidecar.start.bind(sidecar);
    const stop = typeof sidecar.stop === "function" ? sidecar.stop.bind(sidecar) : null;
    const disposeSidecar = typeof sidecar.dispose === "function" ? sidecar.dispose.bind(sidecar) : null;
    sidecar.start = async (config) => {
      const ready = await start(config);
      if (!closed) forwardEndpoints.set(profileId, ready.listen);
      return ready;
    };
    if (stop) {
      sidecar.stop = async (...args) => {
        forwardEndpoints.delete(profileId);
        return stop(...args);
      };
    }
    if (disposeSidecar) {
      sidecar.dispose = async (...args) => {
        forwardEndpoints.delete(profileId);
        return disposeSidecar(...args);
      };
    }
    return sidecar;
  }

  const connection = (options.connectionFactory || createWgRelayConnection)({
    runtime,
    secretStore,
    sidecarFactory: makeSidecar,
    bridgeFactory: options.bridgeFactory,
    healthProbe: options.healthProbe,
    healthTimeoutMs: options.healthTimeoutMs,
    healthMaxBytes: options.healthMaxBytes,
    bridgeTimeoutMs: options.bridgeTimeoutMs,
    log: options.log,
  });
  const getForwardEndpoint = (profileId) => closed ? null : (forwardEndpoints.get(profileId) || null);
  const ipc = registerWgRelayIpc({
    ipcMain,
    BrowserWindow,
    settingsController,
    wgRelayRuntime: runtime,
    secretStore,
    connection,
    dialog: options.dialog,
    deployFn: options.deployFn,
    rotatePhoneFn: options.rotatePhoneFn,
    qrEncoder: options.qrEncoder,
    getForwardEndpoint,
    spawn: options.spawn,
    now: options.now,
    log: options.log,
  });

  function dispose() {
    if (disposePromise) return disposePromise;
    closed = true;
    forwardEndpoints.clear();
    const ipcDisposal = ipc.dispose();
    let connectionDisposal;
    try { connectionDisposal = connection.dispose(); }
    catch (_) { connectionDisposal = undefined; }
    disposePromise = Promise.allSettled([ipcDisposal, connectionDisposal])
      .then(() => {
        forwardEndpoints.clear();
        if (typeof runtime.cleanup === "function") runtime.cleanup();
      });
    return disposePromise;
  }

  const available = secretStore.isAvailable();
  return {
    available,
    ...(available ? {} : { errorCode: "secure_storage_unavailable" }),
    secretStore,
    runtime,
    connection,
    getForwardEndpoint,
    dispose,
  };
}

module.exports = {
  createWgRelayMainIntegration,
  createWgRelayQuitBarrier,
  registerWgRelayIpc,
  requestPhoneRotation,
};

"use strict";

const childProcess = require("node:child_process");
const http = require("node:http");
const { isDeepStrictEqual } = require("node:util");

const { deploy: defaultDeploy } = require("./wg-relay-deploy");
const { createWgRelayConnection } = require("./wg-relay-connection");
const { normalizeConnectionErrorCode } = require("./wg-relay-error-codes");
const { createPairingQr, validatePairingSecrets } = require("./wg-relay-pairing-qr");
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
const TOKEN_RE = /^[0-9a-fA-F]{64}$/;
const PUBLIC_STATUSES = new Set([
  "idle", "starting_tunnel", "verifying_relay", "connecting_relay",
  "connected", "disconnecting", "failed",
]);
const PUBLIC_PROGRESS_STEPS = new Set([
  "connect", "host-key", "detect", "upload", "install", "install-wg", "gen-keys",
  "write-conf", "start-service", "firewall", "readback", "validate",
]);
const DEPLOY_FAILURE_REASONS = new Set([
  "host_key", "host_key_changed", "host_key_confirmation_failed", "host_key_unconfirmed",
  "output_limit", "password_disabled",
]);
const DEPLOY_FAILURE_HINTS = new Set([
  "wgErrFirewall", "wgErrHostKey", "wgErrHostKeyChanged", "wgErrHostKeyConfirmationFailed",
  "wgErrHostKeyUnconfirmed", "wgErrKernel", "wgErrNoPkgManager", "wgErrNoSudo",
  "wgErrOutputLimit", "wgErrPasswordDisabled", "wgErrPortInUse",
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

function committedError(code) {
  const error = codedError(code);
  error.remoteCommitted = true;
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
  const state = {
    status: PUBLIC_STATUSES.has(source.status) ? source.status : "idle",
    generation: Number.isSafeInteger(source.generation) && source.generation >= 0
      ? source.generation
      : 0,
  };
  if (PROFILE_ID_RE.test(fallbackId || "")) state.profileId = fallbackId;
  else if (PROFILE_ID_RE.test(source.profileId || "")) state.profileId = source.profileId;
  if (source.errorCode !== undefined && source.errorCode !== null) {
    state.errorCode = normalizeConnectionErrorCode(source.errorCode);
  }
  return state;
}

function redactProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!PROFILE_ID_RE.test(value.profileId || "")
      || !PUBLIC_PROGRESS_STEPS.has(value.step)
      || !["start", "ok", "fail"].includes(value.status)) return null;
  return { profileId: value.profileId, step: value.step, status: value.status };
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
  if (result && PUBLIC_PROGRESS_STEPS.has(result.step)) response.step = result.step;
  if (result && DEPLOY_FAILURE_REASONS.has(result.reason)) response.reason = result.reason;
  if (result && DEPLOY_FAILURE_HINTS.has(result.hint)) response.hint = result.hint;
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
    let remoteCommitted = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(remoteCommitted
        ? committedError("management_timeout")
        : codedError("management_timeout"));
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
        remoteCommitted = true;
        const contentType = String(response.headers && response.headers["content-type"] || "")
          .split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          response.resume();
          finish(committedError("management_invalid_response"));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > maxBytes) {
            finish(committedError("management_response_too_large"));
            if (typeof response.destroy === "function") response.destroy();
            return;
          }
          chunks.push(data);
        });
        response.on("end", () => {
          if (settled) return;
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch (_) { finish(committedError("management_invalid_response")); return; }
          try { finish(null, validateRotationResult(parsed)); }
          catch (_) { finish(committedError("management_invalid_response")); }
        });
        response.on("error", () => finish(committedError("management_request_failed")));
        response.on("aborted", () => finish(committedError("management_request_failed")));
      });
      request.on("error", () => finish(remoteCommitted
        ? committedError("management_request_failed")
        : codedError("management_request_failed")));
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
  const recoveryBundles = new Map();
  const releaseRequiredProfiles = new Set();
  const activeDeployProfiles = new Set();
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

  function preflightSecretStore() {
    if (!secretStoreAvailable()) throw codedError("secure_storage_unavailable");
    if (typeof secretStore.preflight !== "function") throw codedError("secret_store_preflight_failed");
    try { secretStore.preflight(); }
    catch (_) { throw codedError("secret_store_preflight_failed"); }
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

  async function writePublicProfile(previousProfile, profile) {
    const result = await settingsController.applyCommand(
      previousProfile ? "wgRelay.update" : "wgRelay.add",
      profile,
    );
    if (!result || result.status !== "ok") throw codedError("public_profile_write_failed");
  }

  async function encodeQr(profile, secrets) {
    return normalizeQr(await qrEncoder({ profile, secrets, issuedAt: now() }));
  }

  function profileWithRecovery(profileId) {
    if (deletedProfiles.has(profileId)) return null;
    return findProfile(settingsController, profileId)
      || (recoveryBundles.get(profileId) && recoveryBundles.get(profileId).profile)
      || null;
  }

  function partialSuccess(errorCode, profile, state) {
    return {
      status: "partial_success",
      errorCode,
      retryable: true,
      ...(profile ? { profile } : {}),
      ...(state ? { state: redactState(state, profile && profile.id) } : {}),
    };
  }

  async function flushRecovery(profileId) {
    const recovery = recoveryBundles.get(profileId);
    if (!recovery) return { ok: true, profile: findProfile(settingsController, profileId) };
    if (recovery.blocked) {
      return { ok: false, errorCode: recovery.errorCode, profile: recovery.profile };
    }
    try { await writeAndVerifySecrets(profileId, recovery.secrets); }
    catch (_) {
      return { ok: false, errorCode: "local_storage_retry_required", profile: recovery.profile };
    }
    if (recovery.writePublicProfile) {
      try {
        await writePublicProfile(findProfile(settingsController, profileId), recovery.profile);
      } catch (_) {
        return { ok: false, errorCode: "public_profile_retry_required", profile: recovery.profile };
      }
    }
    recoveryBundles.delete(profileId);
    deletedProfiles.delete(profileId);
    return { ok: true, profile: recovery.profile, secrets: recovery.secrets };
  }

  async function releaseCommittedConnection(profileId) {
    if (!releaseRequiredProfiles.has(profileId)) return true;
    try { await connection.disconnect(profileId); }
    catch (_) { return false; }
    releaseRequiredProfiles.delete(profileId);
    return true;
  }

  async function finishCommittedDeploy(profileId) {
    const persisted = await flushRecovery(profileId);
    if (!persisted.ok) return partialSuccess(persisted.errorCode, persisted.profile);
    const profile = persisted.profile || findProfile(settingsController, profileId);
    let secrets = persisted.secrets;
    if (!secrets) {
      try { secrets = secretStore.read(profileId); }
      catch (_) { return partialSuccess("local_storage_retry_required", profile); }
    }
    if (!await releaseCommittedConnection(profileId)) {
      qrCache.delete(profileId);
      return partialSuccess("connection_retry_required", profile);
    }
    let connected;
    try {
      connected = await connection.connect(profileId);
      if (!connected || connected.status !== "connected") throw codedError("connection_failed");
    } catch (_) {
      qrCache.delete(profileId);
      return partialSuccess("connection_retry_required", profile);
    }
    try {
      const qr = await encodeQr(profile, secrets);
      if (disposed) throw codedError("ipc_disposed");
      qrCache.set(profileId, qr);
      return { status: "ok", profile, state: redactState(connected, profileId), qr };
    } catch (_) {
      qrCache.delete(profileId);
      return partialSuccess("pairing_qr_retry_required", profile, connected);
    }
  }

  const onStatusChanged = (state) => {
    if (disposed) return;
    if (deletedProfiles.has(state && state.profileId)) {
      if (typeof wgRelayRuntime.removeStatus === "function") {
        wgRelayRuntime.removeStatus(state.profileId);
      }
      return;
    }
    const profileId = profileIdFrom(state);
    if (!profileId || !profileWithRecovery(profileId)) return;
    broadcast(BrowserWindow, "wgRelay:status-changed", redactState(state, profileId));
  };
  const onProgress = (progress) => {
    if (disposed || deletedProfiles.has(progress && progress.profileId)) return;
    const safe = redactProgress(progress);
    if (safe && (profileWithRecovery(safe.profileId) || activeDeployProfiles.has(safe.profileId))) {
      broadcast(BrowserWindow, "wgRelay:progress", safe);
    }
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
    if (!profileId || !profileWithRecovery(profileId)) {
      return { status: "error", errorCode: "profile_not_found" };
    }
    try {
      return await enqueue(profileId, async () => {
        if (deletedProfiles.has(profileId) || !profileWithRecovery(profileId)) {
          return { status: "error", errorCode: "profile_not_found" };
        }
        const recovered = await flushRecovery(profileId);
        if (!recovered.ok) return { status: "error", errorCode: recovered.errorCode };
        if (!await releaseCommittedConnection(profileId)) {
          return { status: "error", errorCode: "connection_retry_required" };
        }
        const state = await connection.connect(profileId);
        deletedProfiles.delete(profileId);
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
      return await enqueue(profileId, async () => {
        const state = await connection.disconnect(profileId);
        releaseRequiredProfiles.delete(profileId);
        return { status: "ok", state: redactState(state, profileId) };
      });
    } catch (error) {
      return { status: "error", errorCode: normalizeConnectionErrorCode(error && error.code) };
    }
  });

  async function deployTransaction(profile, previousProfile, password) {
    if (!secretStoreAvailable()) return { status: "error", errorCode: "secure_storage_unavailable" };
    try { secretStore.read(profile.id); }
    catch (_) { return { status: "error", errorCode: "secret_store_read_failed" }; }
    try { preflightSecretStore(); }
    catch (error) { return { status: "error", errorCode: error.code }; }
    const previousState = redactState(connection.status(profile.id), profile.id);
    const wasConnected = previousState.status === "connected";
    let result;
    activeDeployProfiles.add(profile.id);
    try {
      result = await deployFn({
        profile,
        password,
        runtime: { forcePhoneKey: false },
        deps: { spawn, runtime: wgRelayRuntime, confirmHostKey },
      });
    } catch (_) {
      return { status: "error", errorCode: "deploy_failed" };
    } finally {
      activeDeployProfiles.delete(profile.id);
    }
    if (!result || !result.ok || !result.readback) return stableDeployFailure(result);

    const readback = result.readback;
    const secrets = {
      pcConfig: readback.pcConfig,
      phoneConfig: readback.phoneConfig,
      relayToken: readback.relayToken,
      managementToken: readback.managementToken,
      relayUrl: readback.relayUrl,
    };
    const publicProfile = sanitizeProfile({
      ...profile,
      ...(result.acceptedFingerprint ? { sshHostFingerprint: result.acceptedFingerprint } : {}),
      endpoint: readback.endpoint,
      relayAddr: readback.relayUrl,
      lastDeployedAt: now(),
      deployVersion: readback.schemaVersion,
    });
    if (!publicProfile) {
      qrCache.delete(profile.id);
      recoveryBundles.set(profile.id, {
        blocked: true,
        errorCode: "remote_committed_invalid_response",
        profile,
      });
      if (wasConnected) {
        try { await connection.disconnect(profile.id); } catch (_) {}
      }
      return partialSuccess("remote_committed_invalid_response", profile);
    }

    qrCache.delete(profile.id);
    try { validatePairingSecrets(publicProfile, secrets); }
    catch (_) {
      recoveryBundles.set(profile.id, {
        blocked: true,
        errorCode: "remote_committed_invalid_response",
        profile: publicProfile,
      });
      if (wasConnected) {
        try { await connection.disconnect(profile.id); } catch (_) {}
      }
      return partialSuccess("remote_committed_invalid_response", publicProfile);
    }
    recoveryBundles.set(profile.id, {
      profile: publicProfile,
      secrets,
      writePublicProfile: true,
    });
    if (wasConnected) releaseRequiredProfiles.add(profile.id);
    const persisted = await flushRecovery(profile.id);
    if (!persisted.ok) {
      await releaseCommittedConnection(profile.id);
      return partialSuccess(persisted.errorCode, publicProfile);
    }
    if (!await releaseCommittedConnection(profile.id)) {
      return partialSuccess("connection_retry_required", publicProfile);
    }
    return finishCommittedDeploy(profile.id);
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
      const operation = enqueue(profile.id, () => recoveryBundles.has(profile.id)
        ? finishCommittedDeploy(profile.id)
        : deployTransaction(profile, previousProfile, password));
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
    const profile = profileId ? profileWithRecovery(profileId) : null;
    if (!profile) return { status: "error", errorCode: "profile_not_found" };
    try {
      return await enqueue(profileId, async () => {
        if (deletedProfiles.has(profileId)) {
          return { status: "error", errorCode: "profile_not_found" };
        }
        const recovered = await flushRecovery(profileId);
        if (!recovered.ok) return { status: "error", errorCode: recovered.errorCode };
        const currentProfile = recovered.profile || findProfile(settingsController, profileId);
        if (!currentProfile || deletedProfiles.has(profileId)) {
          return { status: "error", errorCode: "profile_not_found" };
        }
        if (qrCache.has(profileId)) return { status: "ok", qr: qrCache.get(profileId) };
        const secrets = secretStore.read(profileId);
        if (!secrets) return { status: "error", errorCode: "secrets_not_found" };
        const qr = await encodeQr(currentProfile, secrets);
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
    const requestedProfile = profileId ? findProfile(settingsController, profileId) : null;
    if (!requestedProfile) return { status: "error", errorCode: "profile_not_found" };
    try {
      return await enqueue(profileId, async () => {
        if (deletedProfiles.has(profileId)) {
          return { status: "error", errorCode: "profile_not_found" };
        }
        if (!secretStoreAvailable()) return { status: "error", errorCode: "secure_storage_unavailable" };
        const pending = await flushRecovery(profileId);
        if (!pending.ok) return { status: "error", errorCode: pending.errorCode };
        const profile = pending.profile || findProfile(settingsController, profileId);
        if (!profile || deletedProfiles.has(profileId)) {
          return { status: "error", errorCode: "profile_not_found" };
        }
        const oldSecrets = secretStore.read(profileId);
        if (!oldSecrets) return { status: "error", errorCode: "secrets_not_found" };
        const oldState = redactState(connection.status(profileId), profileId);
        const wasConnected = oldState.status === "connected";
        let ensuredConnection = false;
        try {
          if (!wasConnected) {
            const state = await connection.connect(profileId);
            if (!state || state.status !== "connected") throw codedError("connection_failed");
            ensuredConnection = true;
          }
          try { preflightSecretStore(); }
          catch (error) {
            if (ensuredConnection) {
              try { await connection.disconnect(profileId); } catch (_) {}
            }
            return { status: "error", errorCode: error.code };
          }
          let rawRotation;
          try {
            rawRotation = await rotatePhoneFn({
              listen: getForwardEndpoint(profileId),
              managementToken: oldSecrets.managementToken,
              profileId,
            });
          } catch (error) {
            if (error && error.remoteCommitted === true) {
              qrCache.delete(profileId);
              recoveryBundles.set(profileId, {
                blocked: true,
                errorCode: "remote_committed_invalid_response",
                profile,
              });
              try { await connection.disconnect(profileId); } catch (_) {}
              return partialSuccess("remote_committed_invalid_response", profile);
            }
            if (ensuredConnection) {
              try { await connection.disconnect(profileId); } catch (_) {}
            }
            return { status: "error", errorCode: "rotate_failed" };
          }
          let rotated;
          try { rotated = validateRotationResult(rawRotation); }
          catch (_) {
            qrCache.delete(profileId);
            recoveryBundles.set(profileId, {
              blocked: true,
              errorCode: "remote_committed_invalid_response",
              profile,
            });
            try { await connection.disconnect(profileId); } catch (_) {}
            return partialSuccess("remote_committed_invalid_response", profile);
          }
          const newSecrets = {
            ...oldSecrets,
            phoneConfig: rotated.phoneConfig,
            relayToken: rotated.relayToken,
          };
          qrCache.delete(profileId);
          try { validatePairingSecrets(profile, newSecrets); }
          catch (_) {
            recoveryBundles.set(profileId, {
              blocked: true,
              errorCode: "remote_committed_invalid_response",
              profile,
            });
            try { await connection.disconnect(profileId); } catch (_) {}
            return partialSuccess("remote_committed_invalid_response", profile);
          }
          recoveryBundles.set(profileId, {
            profile,
            secrets: newSecrets,
            writePublicProfile: false,
          });
          releaseRequiredProfiles.add(profileId);
          const persisted = await flushRecovery(profileId);
          if (!persisted.ok) {
            await releaseCommittedConnection(profileId);
            return partialSuccess(persisted.errorCode, profile);
          }
          if (!await releaseCommittedConnection(profileId)) {
            return partialSuccess("connection_retry_required", profile);
          }
          let connected;
          try {
            connected = await connection.connect(profileId);
            if (!connected || connected.status !== "connected") throw codedError("connection_failed");
          } catch (_) {
            return partialSuccess("connection_retry_required", profile);
          }
          try {
            const qr = await encodeQr(profile, newSecrets);
            if (disposed) throw codedError("ipc_disposed");
            qrCache.set(profileId, qr);
            return { status: "ok", state: redactState(connected, profileId), qr };
          } catch (_) {
            qrCache.delete(profileId);
            return partialSuccess("pairing_qr_retry_required", profile, connected);
          }
        } catch (_) {
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
        let secretCleanupSucceeded = false;
        try {
          secretsRemoved = secretStore.remove(profileId) === true;
          secretCleanupSucceeded = true;
        }
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
        if (secretCleanupSucceeded) recoveryBundles.delete(profileId);
        releaseRequiredProfiles.delete(profileId);
        deletedProfiles.add(profileId);
        if (typeof wgRelayRuntime.removeStatus === "function") wgRelayRuntime.removeStatus(profileId);
        else if (typeof wgRelayRuntime.forgetPcConf === "function") wgRelayRuntime.forgetPcConf(profileId);
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
    const pending = Array.from(new Set(operationTails.values()));
    const attempt = Promise.allSettled(pending).then(async () => {
      for (const profileId of Array.from(recoveryBundles.keys())) {
        const recovered = await flushRecovery(profileId);
        if (!recovered.ok) throw codedError("recovery_persistence_required");
      }
      while (disposers.length) {
        const disposer = disposers.pop();
        try { disposer(); } catch (_) {}
      }
      qrCache.clear();
      recoveryBundles.clear();
      releaseRequiredProfiles.clear();
      activeDeployProfiles.clear();
    });
    disposePromise = attempt.catch((error) => {
      disposed = false;
      disposePromise = null;
      throw error;
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
      catch (error) { disposal = Promise.reject(error); }
      const attempt = Promise.resolve(disposal)
        .then(() => {
          ready = true;
          schedule(quit);
        }, (error) => {
          pending = null;
          throw error;
        });
      pending = attempt;
      void attempt.catch(() => {});
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
  const mobileIntegration = options.mobileIntegration;
  const bridgeOptions = {
    ...(options.bridgeOptions || {}),
    ...(mobileIntegration ? {
      getLocalToken: () => mobileIntegration.getMobileToken(),
      getLocalPort: () => mobileIntegration.getMobileServerPort(),
    } : {}),
  };
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
    bridgeOptions,
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
    const attempt = Promise.allSettled([ipcDisposal, connectionDisposal])
      .then((results) => {
        if (results[0].status === "rejected") throw results[0].reason;
        forwardEndpoints.clear();
        if (typeof runtime.cleanup === "function") runtime.cleanup();
      });
    disposePromise = attempt.catch((error) => {
      disposePromise = null;
      throw error;
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

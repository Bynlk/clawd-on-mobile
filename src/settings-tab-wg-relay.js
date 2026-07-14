"use strict";

// Minimal desktop flow for one-click WireGuard Relay deployment and daily use.
// SSH passwords exist only in the active input and a short-lived deploy call.
(function initSettingsTabWgRelay(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const DEFAULTS = Object.freeze({
    sshUsername: "root",
    sshPort: 22,
    wgPort: 51820,
    wgSubnet: "10.8.0.0/24",
    relayPort: 7891,
  });
  const STATUSES = new Set([
    "idle",
    "starting_tunnel",
    "verifying_relay",
    "connecting_relay",
    "connected",
    "disconnecting",
    "failed",
  ]);
  const RUNTIME_BUSY_STATUSES = new Set([
    "starting_tunnel", "verifying_relay", "connecting_relay", "disconnecting",
  ]);
  const PC_CONNECT_PROGRESS_STATUSES = new Set([
    "starting_tunnel", "verifying_relay", "connecting_relay",
  ]);
  const RECOVERY_CODES = new Set([
    "remote_commit_recovery_required",
    "profile_conflict_recovery_required",
  ]);
  const REPAIR_REQUIRED_CODES = new Set([
    ...RECOVERY_CODES,
    "secure_storage_unavailable",
    "secret_store_read_failed",
    "secret_store_preflight_failed",
    "secret_store_verification_failed",
    "secrets_not_found",
    "profile_not_found",
  ]);
  const STATUS_RETRY_DELAYS_MS = Object.freeze([80, 240]);
  const DIRECT_ERROR_CODES = new Set([
    "invalid_profile", "password_required", "runtime_unavailable", "deploy_failed",
    "deploy_aborted", "remote_commit_recovery_required",
    "profile_conflict_recovery_required", "secure_storage_unavailable",
    "secret_store_read_failed", "local_storage_retry_required",
    "public_profile_retry_required", "connection_retry_required",
    "pairing_qr_retry_required", "invalid_profile_id", "profile_not_found",
    "secrets_not_found", "pairing_qr_failed", "rotate_failed", "rotate_aborted",
    "delete_prepare_failed", "delete_failed", "connection_failed", "sidecar_failed",
    "health_failed", "relay_failed", "unknown",
  ]);
  const PROGRESS_STAGES = Object.freeze([
    "connect", "fingerprint", "upload", "dependencies", "wireguard",
    "relay", "verify", "save", "pcConnect", "qr",
  ]);
  const RAW_PROGRESS_STAGE = Object.freeze({
    connect: 0,
    "host-key": 1,
    upload: 2,
    install: 3,
    detect: 3,
    "install-wg": 4,
    "gen-keys": 4,
    "write-conf": 4,
    "start-service": 5,
    firewall: 5,
    readback: 6,
    validate: 6,
    save: 7,
    persist: 7,
    "pc-connect": 8,
    pc_connect: 8,
    qr: 9,
  });

  const view = {
    epoch: 0,
    setupDraft: null,
    repairDraftByProfile: new Map(),
    profileOverride: null,
    hiddenProfileIds: new Set(),
    statusByProfile: new Map(),
    statusRevisionByProfile: new Map(),
    statusRequest: null,
    statusLoadedByProfile: new Set(),
    statusAttemptsByProfile: new Map(),
    statusRetryTimer: null,
    progressProfileId: null,
    progressVisible: false,
    progressStates: PROGRESS_STAGES.map(() => "pending"),
    errorCode: null,
    repairOpen: false,
    busy: null,
    listenerDisposers: [],
    renderRoot: null,
    statusMount: null,
    overlay: null,
    pendingFocusLabel: null,
    confirmInFlight: null,
    qrDialog: null,
  };

  function t(key) {
    return helpers.t(key);
  }

  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return "wg-" + crypto.randomUUID().replace(/-/g, "").slice(0, 13);
    }
    return "wg-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function profiles() {
    const snapshot = state.snapshot || {};
    const relay = snapshot.wgRelay || {};
    return Array.isArray(relay.profiles) ? relay.profiles : [];
  }

  function currentProfile() {
    const persisted = profiles().find((profile) => profile
      && !view.hiddenProfileIds.has(profile.id));
    if (persisted) {
      if (view.profileOverride && view.profileOverride.id === persisted.id) {
        if (isDeployed(view.profileOverride) && !isDeployed(persisted)) {
          return view.profileOverride;
        }
        view.profileOverride = null;
      }
      return persisted;
    }
    if (view.profileOverride && !view.hiddenProfileIds.has(view.profileOverride.id)) {
      return view.profileOverride;
    }
    return null;
  }

  function isDeployed(profile) {
    return Boolean(profile && (
      profile.deployVersion || profile.lastDeployedAt || profile.endpoint || profile.relayAddr
    ));
  }

  function ensureSetupDraft(profile) {
    if (view.setupDraft && (!profile || view.setupDraft.id === profile.id)) return view.setupDraft;
    view.setupDraft = {
      id: profile && profile.id ? profile.id : uuid(),
      label: profile && profile.label ? profile.label : "",
      host: profile && profile.host ? profile.host : "",
      sshUsername: profile && profile.sshUsername ? profile.sshUsername : DEFAULTS.sshUsername,
      sshPort: profile && Number.isInteger(profile.sshPort) ? profile.sshPort : DEFAULTS.sshPort,
      wgPort: profile && Number.isInteger(profile.wgPort) ? profile.wgPort : DEFAULTS.wgPort,
      wgSubnet: profile && profile.wgSubnet ? profile.wgSubnet : DEFAULTS.wgSubnet,
    };
    return view.setupDraft;
  }

  function ensureRepairDraft(profile) {
    const existing = view.repairDraftByProfile.get(profile.id);
    if (existing) return existing;
    const draft = {
      id: profile.id,
      label: profile.label,
      host: profile.host,
      sshUsername: profile.sshUsername || DEFAULTS.sshUsername,
      sshPort: Number.isInteger(profile.sshPort) ? profile.sshPort : DEFAULTS.sshPort,
      wgPort: Number.isInteger(profile.wgPort) ? profile.wgPort : DEFAULTS.wgPort,
      wgSubnet: profile.wgSubnet || DEFAULTS.wgSubnet,
    };
    view.repairDraftByProfile.set(profile.id, draft);
    return draft;
  }

  function safeStatus(value, profileId) {
    const source = value && typeof value === "object" ? value : {};
    const status = STATUSES.has(source.status) ? source.status : "idle";
    const result = { profileId, status };
    if (typeof source.errorCode === "string") result.errorCode = source.errorCode;
    else if (typeof source.status === "string"
        && (REPAIR_REQUIRED_CODES.has(source.status) || source.status.endsWith("_recovery_required"))) {
      result.errorCode = source.status;
    }
    return result;
  }

  function statusFor(profile) {
    return view.statusByProfile.get(profile.id) || { profileId: profile.id, status: "idle" };
  }

  function repairRequiredCode(status) {
    if (!status) return null;
    if (REPAIR_REQUIRED_CODES.has(status.status)) return status.status;
    if (typeof status.errorCode === "string"
        && (REPAIR_REQUIRED_CODES.has(status.errorCode)
          || status.errorCode.endsWith("_recovery_required"))) {
      return status.errorCode;
    }
    return null;
  }

  function localizedError(code) {
    const safeCode = typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code)
      ? code
      : "unknown";
    let displayCode = DIRECT_ERROR_CODES.has(safeCode) ? safeCode : "unknown";
    if (!DIRECT_ERROR_CODES.has(safeCode)) {
      if (safeCode === "secret_store_preflight_failed"
          || safeCode === "secret_store_verification_failed") {
        displayCode = "secure_storage_unavailable";
      } else if (safeCode.startsWith("health_")) displayCode = "health_failed";
      else if (safeCode.startsWith("relay_") || safeCode === "local_connect_failed") {
        displayCode = "relay_failed";
      } else if (safeCode.startsWith("connection_") || safeCode === "secret_invalid") {
        displayCode = "connection_failed";
      } else if (safeCode.startsWith("sidecar_") || safeCode.startsWith("device_")
          || safeCode.startsWith("endpoint_") || safeCode.startsWith("listener_")
          || safeCode === "listen_failed" || safeCode === "stdin_failed"
          || safeCode === "trailing_data" || safeCode === "duplicate_ready"
          || safeCode.startsWith("invalid_")) {
        displayCode = "sidecar_failed";
      }
    }
    return t("wgRelayError_" + displayCode);
  }

  function requestContentRender() {
    if (state.activeTab === "wg-relay") ops.requestRender({ content: true });
  }

  function cancelStatusRetry() {
    const timer = view.statusRetryTimer;
    if (!timer) return;
    view.statusRetryTimer = null;
    try { clearTimeout(timer.id); } catch (_) {}
  }

  function unsubscribeListeners() {
    for (const dispose of view.listenerDisposers.splice(0)) {
      try { dispose(); } catch (_) {}
    }
  }

  function subscribeListeners() {
    unsubscribeListeners();
    if (!window.wgRelay) return;
    const listenerEpoch = view.epoch;
    if (typeof window.wgRelay.onStatusChanged === "function") {
      const dispose = window.wgRelay.onStatusChanged((payload) => {
        if (listenerEpoch !== view.epoch || state.activeTab !== "wg-relay") return;
        applyConnectionProgress(payload);
        const profile = currentProfile();
        if (!profile || !payload || payload.profileId !== profile.id) {
          if (payload && payload.profileId === view.progressProfileId) requestContentRender();
          return;
        }
        const next = safeStatus(payload, profile.id);
        view.statusByProfile.set(profile.id, next);
        view.statusRevisionByProfile.set(
          profile.id,
          (view.statusRevisionByProfile.get(profile.id) || 0) + 1,
        );
        view.statusLoadedByProfile.add(profile.id);
        view.statusAttemptsByProfile.delete(profile.id);
        cancelStatusRetry();
        view.errorCode = next.errorCode || null;
        updateStatusView(profile);
      });
      if (typeof dispose === "function") view.listenerDisposers.push(dispose);
    }
    if (typeof window.wgRelay.onProgress === "function") {
      const dispose = window.wgRelay.onProgress((payload) => {
        if (listenerEpoch !== view.epoch || state.activeTab !== "wg-relay") return;
        if (!payload || payload.profileId !== view.progressProfileId) return;
        applyProgress(payload);
        requestContentRender();
      });
      if (typeof dispose === "function") view.listenerDisposers.push(dispose);
    }
  }

  function refreshStatus(profile) {
    if (!window.wgRelay || typeof window.wgRelay.status !== "function") return;
    if (view.statusLoadedByProfile.has(profile.id)) return;
    if (view.statusRequest
        && view.statusRequest.profileId === profile.id
        && view.statusRequest.epoch === view.epoch) return;
    if (view.statusRetryTimer
        && view.statusRetryTimer.profileId === profile.id
        && view.statusRetryTimer.epoch === view.epoch) return;
    const attempt = (view.statusAttemptsByProfile.get(profile.id) || 0) + 1;
    view.statusAttemptsByProfile.set(profile.id, attempt);
    const request = {
      profileId: profile.id,
      epoch: view.epoch,
      statusRevision: view.statusRevisionByProfile.get(profile.id) || 0,
      attempt,
    };
    view.statusRequest = request;
    let shouldUpdate = false;
    let shouldRetry = false;
    let statusPromise;
    try { statusPromise = Promise.resolve(window.wgRelay.status(profile.id)); }
    catch (_) { statusPromise = Promise.reject(new Error("status_request_failed")); }
    statusPromise.then((result) => {
      if (view.statusRequest !== request || request.epoch !== view.epoch
          || state.activeTab !== "wg-relay"
          || (view.statusRevisionByProfile.get(profile.id) || 0) !== request.statusRevision) return;
      let definitive = false;
      if (result && result.status === "ok" && result.state) {
        const next = safeStatus(result.state, profile.id);
        view.statusByProfile.set(profile.id, next);
        view.errorCode = next.errorCode || null;
        definitive = true;
      } else if (result && typeof result.errorCode === "string") {
        const existing = statusFor(profile);
        view.statusByProfile.set(profile.id, { ...existing, errorCode: result.errorCode });
        view.errorCode = result.errorCode;
        definitive = true;
      }
      if (definitive) {
        view.statusLoadedByProfile.add(profile.id);
        view.statusAttemptsByProfile.delete(profile.id);
        shouldUpdate = true;
      } else {
        shouldRetry = request.attempt <= STATUS_RETRY_DELAYS_MS.length;
        if (!shouldRetry) {
          view.errorCode = "unknown";
          shouldUpdate = true;
        }
      }
    }).catch(() => {
      if (view.statusRequest === request && request.epoch === view.epoch
          && state.activeTab === "wg-relay"
          && (view.statusRevisionByProfile.get(profile.id) || 0) === request.statusRevision) {
        shouldRetry = request.attempt <= STATUS_RETRY_DELAYS_MS.length;
        if (!shouldRetry) {
          view.errorCode = "unknown";
          shouldUpdate = true;
        }
      }
    }).finally(() => {
      if (view.statusRequest !== request) return;
      view.statusRequest = null;
      if (request.epoch !== view.epoch || state.activeTab !== "wg-relay") return;
      if ((view.statusRevisionByProfile.get(profile.id) || 0) !== request.statusRevision) return;
      if (shouldRetry) {
        const timer = {
          profileId: profile.id,
          epoch: request.epoch,
          statusRevision: request.statusRevision,
          id: null,
        };
        timer.id = setTimeout(() => {
          if (view.statusRetryTimer !== timer) return;
          view.statusRetryTimer = null;
          if (timer.epoch !== view.epoch || state.activeTab !== "wg-relay") return;
          if ((view.statusRevisionByProfile.get(profile.id) || 0) !== timer.statusRevision) return;
          refreshStatus(profile);
        }, STATUS_RETRY_DELAYS_MS[request.attempt - 1]);
        view.statusRetryTimer = timer;
      } else if (shouldUpdate) {
        updateStatusView(profile);
      }
    });
  }

  function resetProgress(profileId) {
    view.progressProfileId = profileId;
    view.progressVisible = true;
    view.progressStates = PROGRESS_STAGES.map(() => "pending");
  }

  function applyProgress(payload) {
    const index = RAW_PROGRESS_STAGE[payload.step];
    if (!Number.isInteger(index)) return;
    for (let i = 0; i < index; i++) {
      if (view.progressStates[i] !== "failed") view.progressStates[i] = "complete";
    }
    if (payload.status === "fail") view.progressStates[index] = "failed";
    else if (payload.status === "ok") view.progressStates[index] = "complete";
    else view.progressStates[index] = "current";
  }

  function applyConnectionProgress(payload) {
    if (!payload || payload.profileId !== view.progressProfileId) return;
    if (!view.busy || view.busy.kind !== "deploy") return;
    if (PC_CONNECT_PROGRESS_STATUSES.has(payload.status)) {
      applyProgress({ step: "pc-connect", status: "start" });
    } else if (payload.status === "connected") {
      applyProgress({ step: "pc-connect", status: "ok" });
      view.progressStates[9] = "current";
    }
  }

  function finishProgress() {
    view.progressStates = PROGRESS_STAGES.map(() => "complete");
  }

  function setResultError(result, fallback) {
    view.errorCode = result && typeof result.errorCode === "string"
      ? result.errorCode
      : fallback;
  }

  function beginOperation(kind, operation, applyResult) {
    if (view.busy) return view.busy.promise;
    const record = { kind, epoch: view.epoch, promise: null };
    view.busy = record;
    view.errorCode = null;
    updateBusyControls();
    let promise;
    let needsRender = false;
    try {
      promise = Promise.resolve(operation());
    } catch (_) {
      promise = Promise.resolve({ status: "error", errorCode: "unknown" });
    }
    record.promise = promise.then((result) => {
      if (record.epoch === view.epoch && state.activeTab === "wg-relay") {
        needsRender = applyResult(result || { status: "error", errorCode: "unknown" }) === true;
      }
      return result;
    }).catch(() => {
      if (record.epoch === view.epoch && state.activeTab === "wg-relay") {
        view.errorCode = "unknown";
      }
      return { status: "error", errorCode: "unknown" };
    }).finally(() => {
      if (view.busy === record) view.busy = null;
      if (needsRender) requestContentRender();
      else {
        updateBusyControls();
        const profile = currentProfile();
        if (profile && isDeployed(profile)) updateStatusView(profile);
      }
    });
    return record.promise;
  }

  function createButton(textKey, className, onClick, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "soft-btn";
    button.textContent = t(textKey);
    button.disabled = Boolean(disabled);
    button.addEventListener("click", onClick);
    return button;
  }

  function createField({ id, labelKey, type = "text", value = "", required = false,
    autocomplete, disabled = false, readOnly = false, onInput }) {
    const wrap = document.createElement("div");
    wrap.className = "wg-relay-field";
    const label = document.createElement("label");
    label.className = "wg-relay-field-label";
    label.setAttribute("for", id);
    label.textContent = t(labelKey);
    const input = document.createElement("input");
    input.id = id;
    input.setAttribute("id", id);
    input.type = type;
    input.value = String(value == null ? "" : value);
    input.required = required;
    input.disabled = disabled;
    input.readOnly = readOnly;
    if (autocomplete) input.setAttribute("autocomplete", autocomplete);
    if (required) input.setAttribute("aria-required", "true");
    if (typeof onInput === "function") input.addEventListener("input", () => onInput(input.value));
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap, input };
  }

  function renderError(parent) {
    if (!view.errorCode) return;
    const error = document.createElement("div");
    error.className = "wg-relay-error";
    error.setAttribute("role", "alert");
    error.setAttribute("aria-live", "assertive");
    error.textContent = localizedError(view.errorCode);
    parent.appendChild(error);
  }

  function renderProgress(parent) {
    if (!view.progressVisible) return;
    const progress = document.createElement("div");
    progress.className = "wg-relay-progress";
    progress.setAttribute("aria-live", "polite");
    progress.setAttribute("aria-label", t("wgRelayProgressLabel"));
    PROGRESS_STAGES.forEach((stage, index) => {
      const stageState = view.progressStates[index] || "pending";
      const row = document.createElement("div");
      row.className = "wg-relay-progress-stage is-" + stageState;
      const marker = document.createElement("span");
      marker.className = "wg-relay-progress-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = stageState === "complete" ? "✓" : (stageState === "failed" ? "!" : String(index + 1));
      const label = document.createElement("span");
      label.className = "wg-relay-progress-name";
      label.textContent = t("wgRelayStep_" + stage);
      const stateText = document.createElement("span");
      stateText.className = "wg-relay-progress-state";
      stateText.textContent = t("wgRelayProgress_" + (stageState === "complete" ? "completed" : stageState));
      row.appendChild(marker);
      row.appendChild(label);
      row.appendChild(stateText);
      progress.appendChild(row);
    });
    parent.appendChild(progress);
  }

  function buildProfile(draft, advanced) {
    const host = String(draft.host || "").trim();
    const username = String(draft.sshUsername || "").trim();
    const sshPort = Number.parseInt(draft.sshPort, 10);
    const profile = {
      id: draft.id,
      label: String(draft.label || host).trim() || host,
      host,
      sshUsername: username,
      sshPort,
      authMethod: "password",
      wgPort: advanced && Number.isInteger(advanced.wgPort) ? advanced.wgPort : DEFAULTS.wgPort,
      wgSubnet: advanced && advanced.wgSubnet ? advanced.wgSubnet : DEFAULTS.wgSubnet,
    };
    return profile;
  }

  function validDeployFields(profile, password) {
    return Boolean(profile.host && profile.sshUsername && Number.isInteger(profile.sshPort)
      && profile.sshPort >= 1 && profile.sshPort <= 65535 && password);
  }

  function runDeploy(profile, passwordInput) {
    if (view.busy) return view.busy.promise;
    let password = passwordInput.value;
    if (!validDeployFields(profile, password)) {
      passwordInput.value = "";
      password = "";
      view.errorCode = profile.host && profile.sshUsername ? "password_required" : "invalid_profile";
      requestContentRender();
      return Promise.resolve({ status: "error" });
    }
    resetProgress(profile.id);
    const record = { kind: "deploy", epoch: view.epoch, promise: null };
    view.busy = record;
    view.errorCode = null;
    let invoke;
    try {
      invoke = Promise.resolve(window.wgRelay.deploy({ profile, password }));
    } catch (_) {
      invoke = Promise.resolve({ status: "error", errorCode: "deploy_failed" });
    } finally {
      passwordInput.value = "";
      password = "";
    }
    record.promise = invoke.then((result) => {
      if (record.epoch !== view.epoch || state.activeTab !== "wg-relay") return result;
      if (result && result.status === "ok" && result.profile) {
        view.profileOverride = result.profile;
        view.setupDraft = null;
        view.repairDraftByProfile.delete(result.profile.id);
        view.repairOpen = false;
        view.errorCode = null;
        if (result.state) {
          view.statusByProfile.set(result.profile.id, safeStatus(result.state, result.profile.id));
        }
        finishProgress();
      } else {
        setResultError(result, "deploy_failed");
      }
      return result;
    }).catch(() => {
      if (record.epoch === view.epoch && state.activeTab === "wg-relay") {
        view.errorCode = "deploy_failed";
      }
      return { status: "error", errorCode: "deploy_failed" };
    }).finally(() => {
      if (view.busy === record) view.busy = null;
      requestContentRender();
    });
    requestContentRender();
    return record.promise;
  }

  function renderSetup(parent, existingProfile) {
    const draft = ensureSetupDraft(existingProfile);
    const card = document.createElement("section");
    card.className = "section wg-relay-setup-card";
    const heading = document.createElement("h2");
    heading.textContent = t("wgRelaySetupTitle");
    card.appendChild(heading);
    const description = document.createElement("p");
    description.className = "wg-relay-card-description";
    description.textContent = t("wgRelaySetupDescription");
    card.appendChild(description);
    const disabled = Boolean(view.busy) || !window.wgRelay;
    const host = createField({
      id: "wg-relay-host", labelKey: "wgRelayFieldHost", value: draft.host,
      required: true, disabled, onInput: (value) => { draft.host = value; },
    });
    const username = createField({
      id: "wg-relay-ssh-username", labelKey: "wgRelayFieldSshUsername", value: draft.sshUsername,
      required: true, disabled, onInput: (value) => { draft.sshUsername = value; },
    });
    const port = createField({
      id: "wg-relay-ssh-port", labelKey: "wgRelayFieldSshPort", type: "number", value: draft.sshPort,
      required: true, disabled, onInput: (value) => { draft.sshPort = value; },
    });
    const password = createField({
      id: "wg-relay-password", labelKey: "wgRelayFieldPassword", type: "password", value: "",
      required: true, autocomplete: "new-password", disabled,
    });
    card.appendChild(host.wrap);
    card.appendChild(username.wrap);
    card.appendChild(port.wrap);
    card.appendChild(password.wrap);
    const passwordHint = document.createElement("p");
    passwordHint.className = "wg-relay-password-hint";
    passwordHint.textContent = t("wgRelayPasswordOneTimeHint");
    card.appendChild(passwordHint);
    renderError(card);
    renderProgress(card);
    const deploy = createButton(view.busy ? "wgRelayDeploying" : "wgRelayDeploy", "soft-btn accent wg-relay-primary-action", () => {
      runDeploy(buildProfile(draft), password.input);
    }, disabled);
    card.appendChild(deploy);
    parent.appendChild(card);
  }

  function statusClass(status) {
    if (status === "connected") return "connected";
    if (status === "failed") return "failed";
    if (RUNTIME_BUSY_STATUSES.has(status)) return "connecting";
    return "idle";
  }

  function applyConnectionResult(profile, result, fallback) {
    if (result && result.status === "ok" && result.state) {
      view.statusByProfile.set(profile.id, safeStatus(result.state, profile.id));
      view.errorCode = null;
    } else {
      setResultError(result, fallback);
      const previous = statusFor(profile);
      view.statusByProfile.set(profile.id, { ...previous, status: "failed", errorCode: view.errorCode });
    }
  }

  function overlayButtons(record) {
    if (!record || !record.dialog) return [];
    return record.dialog.querySelectorAll("button")
      .filter((button) => !button.disabled && !button.hidden);
  }

  function returnOverlayFocus(record) {
    let target = record && record.trigger;
    if (!target || !target.isConnected) {
      const label = record && record.triggerLabel;
      target = label && view.renderRoot
        ? view.renderRoot.querySelectorAll("button").find((button) => button.textContent === label)
        : null;
    }
    if (target && typeof target.focus === "function") {
      target.focus();
      return true;
    }
    return false;
  }

  function restorePendingFocus() {
    const label = view.pendingFocusLabel;
    view.pendingFocusLabel = null;
    if (!label || !view.renderRoot) return;
    const target = view.renderRoot.querySelectorAll("button")
      .find((button) => button.textContent === label && !button.disabled && !button.hidden);
    if (target && typeof target.focus === "function") target.focus();
  }

  function restoreOverlayBackground(record) {
    const background = record && record.background;
    if (!background) return;
    background.inert = Boolean(record.previousInert);
    if (record.previousAriaHidden == null) background.removeAttribute("aria-hidden");
    else background.setAttribute("aria-hidden", record.previousAriaHidden);
  }

  function cleanupOverlay(record, restoreFocus = true) {
    if (!record || record.cleaned) return;
    record.cleaned = true;
    try { document.removeEventListener("keydown", record.onKeyDown, true); } catch (_) {}
    const ownsOverlay = view.overlay === record;
    if (ownsOverlay) {
      view.overlay = null;
      restoreOverlayBackground(record);
    }
    if (record.backdrop && typeof record.backdrop.remove === "function") record.backdrop.remove();
    if (restoreFocus && ownsOverlay && !returnOverlayFocus(record)) {
      view.pendingFocusLabel = record.triggerLabel || null;
    }
  }

  function settleConfirm(record, choice, restoreFocus = true) {
    if (!record || record.settled) return;
    record.resolvedOwnerToken = view.overlay === record ? record.token : null;
    record.settled = true;
    cleanupOverlay(record, restoreFocus);
    record.resolve(choice);
  }

  function releaseConfirm(record) {
    if (view.confirmInFlight === record) view.confirmInFlight = null;
    if (view.busy === record) view.busy = null;
    updateBusyControls();
  }

  function cancelPendingConfirm(restoreFocus = true) {
    const record = view.confirmInFlight;
    if (!record) return;
    settleConfirm(record, false, restoreFocus);
    releaseConfirm(record);
  }

  function closeQrDialog(ownerToken, restoreFocus = true) {
    const record = view.qrDialog;
    if (!record || (ownerToken && record.token !== ownerToken)) return;
    record.image.src = "";
    record.image.removeAttribute("src");
    record.dataUrl = "";
    cleanupOverlay(record, restoreFocus);
    if (view.qrDialog === record) view.qrDialog = null;
  }

  function cancelActiveOverlay(restoreFocus = false) {
    const record = view.overlay;
    if (!record) return;
    if (record.kind === "confirm") cancelPendingConfirm(restoreFocus);
    else closeQrDialog(record.token, restoreFocus);
  }

  function installOverlay(record, backdrop, dialog) {
    cancelActiveOverlay(false);
    const modalRoot = document.getElementById("modalRoot");
    if (!modalRoot) return false;
    record.backdrop = backdrop;
    record.dialog = dialog;
    record.background = view.renderRoot;
    record.previousInert = Boolean(record.background && record.background.inert);
    record.previousAriaHidden = record.background
      ? record.background.getAttribute("aria-hidden")
      : null;
    if (record.background) {
      record.background.inert = true;
      record.background.setAttribute("aria-hidden", "true");
    }
    record.onKeyDown = (event) => {
      if (view.overlay !== record) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (record.kind === "confirm") settleConfirm(record, false);
        else closeQrDialog(record.token);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = overlayButtons(record);
      if (!focusable.length) return;
      event.preventDefault();
      const currentIndex = focusable.indexOf(document.activeElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
      focusable[nextIndex].focus();
    };
    document.addEventListener("keydown", record.onKeyDown, true);
    view.overlay = record;
    modalRoot.appendChild(backdrop);
    return true;
  }

  function createConfirmRecord(actionKind, profile, trigger, titleKey, detailKey, confirmKey) {
    const record = {
      kind: "confirm",
      actionKind,
      token: {},
      epoch: view.epoch,
      profileId: profile.id,
      statusRevision: view.statusRevisionByProfile.get(profile.id) || 0,
      trigger,
      triggerLabel: trigger && trigger.textContent,
      settled: false,
      promise: null,
      resolve: null,
    };
    record.promise = new Promise((resolve) => { record.resolve = resolve; });
    view.confirmInFlight = record;
    view.busy = record;
    view.errorCode = null;
    updateBusyControls();

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop settings-confirm-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "settings-confirm-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "wg-relay-confirm-title");
    const icon = document.createElement("div");
    icon.className = "settings-confirm-icon";
    icon.textContent = "!";
    const title = document.createElement("h2");
    title.id = "wg-relay-confirm-title";
    title.setAttribute("id", title.id);
    title.textContent = t(titleKey);
    const detail = document.createElement("p");
    detail.textContent = t(detailKey);
    const actions = document.createElement("div");
    actions.className = "settings-confirm-actions";
    const cancel = createButton("wgRelayCancel", "soft-btn", () => settleConfirm(record, false), false);
    const confirmButton = createButton(confirmKey, "soft-btn settings-confirm-danger", () => {
      settleConfirm(record, "confirm");
    }, false);
    actions.appendChild(cancel);
    actions.appendChild(confirmButton);
    dialog.appendChild(icon);
    dialog.appendChild(title);
    dialog.appendChild(detail);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) settleConfirm(record, false);
    });
    if (!installOverlay(record, backdrop, dialog)) settleConfirm(record, false, false);
    else cancel.focus();
    return record;
  }

  function runConfirmedAction({ actionKind, profile, trigger, titleKey, detailKey, confirmKey,
    operation, applyResult }) {
    if (view.confirmInFlight) return view.confirmInFlight.resultPromise;
    if (view.busy) return view.busy.promise;
    const record = createConfirmRecord(
      actionKind, profile, trigger, titleKey, detailKey, confirmKey,
    );
    record.resultPromise = record.promise.then((choice) => {
      const valid = view.confirmInFlight === record
        && view.busy === record
        && record.resolvedOwnerToken === record.token
        && record.epoch === view.epoch
        && state.activeTab === "wg-relay"
        && currentProfile()
        && currentProfile().id === record.profileId
        && (view.statusRevisionByProfile.get(record.profileId) || 0) === record.statusRevision;
      releaseConfirm(record);
      if (choice !== "confirm" || !valid) return null;
      return beginOperation(actionKind, operation, applyResult);
    });
    return record.resultPromise;
  }

  function openQrDialog(dataUrl, trigger) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      view.errorCode = "pairing_qr_failed";
      return;
    }
    const modalRoot = document.getElementById("modalRoot");
    if (!modalRoot) {
      view.errorCode = "pairing_qr_failed";
      return;
    }
    let sensitiveUrl = dataUrl;
    const record = {
      kind: "qr",
      token: {},
      trigger,
      triggerLabel: trigger && trigger.textContent,
    };
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop wg-relay-qr-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "wg-relay-qr-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "wg-relay-qr-title");
    const title = document.createElement("h2");
    title.id = "wg-relay-qr-title";
    title.setAttribute("id", title.id);
    title.textContent = t("wgRelayQrTitle");
    const image = document.createElement("img");
    image.className = "wg-relay-qr-img";
    image.src = sensitiveUrl;
    image.setAttribute("src", sensitiveUrl);
    image.alt = t("wgRelayQrAlt");
    const warning = document.createElement("p");
    warning.className = "wg-relay-qr-warning";
    warning.textContent = t("wgRelayQrWarning");
    const close = createButton("wgRelayQrClose", "soft-btn", () => closeQrDialog(record.token), false);
    dialog.appendChild(title);
    dialog.appendChild(image);
    dialog.appendChild(warning);
    dialog.appendChild(close);
    backdrop.appendChild(dialog);
    record.image = image;
    record.dataUrl = sensitiveUrl;
    if (!installOverlay(record, backdrop, dialog)) {
      image.src = "";
      image.removeAttribute("src");
      sensitiveUrl = "";
      view.errorCode = "pairing_qr_failed";
      return;
    }
    view.qrDialog = record;
    sensitiveUrl = "";
    if (typeof close.focus === "function") close.focus();
  }

  function showPairingQr(profile, trigger) {
    return beginOperation("pairing-qr", () => window.wgRelay.pairingQr(profile.id), (result) => {
      if (result && result.status === "ok" && result.qr) {
        view.errorCode = null;
        openQrDialog(result.qr.dataUrl, trigger);
      } else setResultError(result, "pairing_qr_failed");
    });
  }

  function rotatePhone(profile, trigger) {
    return runConfirmedAction({
      actionKind: "rotate",
      profile,
      trigger,
      titleKey: "wgRelayRotateConfirmTitle",
      detailKey: "wgRelayRotateConfirmDetail",
      confirmKey: "wgRelayRotateConfirmAction",
      operation: () => window.wgRelay.rotatePhone(profile.id),
      applyResult: (result) => {
        applyConnectionResult(profile, result, "rotate_failed");
        if (result && result.status === "ok" && result.qr) openQrDialog(result.qr.dataUrl, trigger);
      },
    });
  }

  function deleteProfile(profile, trigger) {
    return runConfirmedAction({
      actionKind: "delete",
      profile,
      trigger,
      titleKey: "wgRelayDeleteConfirmTitle",
      detailKey: "wgRelayDeleteConfirmDetail",
      confirmKey: "wgRelayDeleteConfirmAction",
      operation: () => window.wgRelay.deleteLocal(profile.id),
      applyResult: (result) => {
        if (result && result.status === "ok") {
          closeQrDialog();
          view.hiddenProfileIds.add(profile.id);
          view.profileOverride = null;
          view.setupDraft = null;
          view.statusByProfile.delete(profile.id);
          view.statusRevisionByProfile.delete(profile.id);
          view.statusRequest = null;
          view.progressVisible = false;
          view.repairOpen = false;
          view.repairDraftByProfile.delete(profile.id);
          view.errorCode = null;
          return true;
        }
        setResultError(result, "delete_failed");
        return false;
      },
    });
  }

  function renderRepair(parent, profile) {
    const card = document.createElement("section");
    card.className = "section wg-relay-repair-card";
    const title = document.createElement("h2");
    title.textContent = t("wgRelayRepairTitle");
    card.appendChild(title);
    const hint = document.createElement("p");
    hint.className = "wg-relay-card-description";
    hint.textContent = t("wgRelayRepairDescription");
    card.appendChild(hint);
    const draft = ensureRepairDraft(profile);
    const disabled = Boolean(view.busy);
    const fieldSpecs = [
      ["wg-relay-repair-host", "wgRelayFieldHost", "text", "host"],
      ["wg-relay-repair-username", "wgRelayFieldSshUsername", "text", "sshUsername"],
      ["wg-relay-repair-ssh-port", "wgRelayFieldSshPort", "number", "sshPort"],
      ["wg-relay-repair-wg-port", "wgRelayFieldWgPort", "number", "wgPort"],
      ["wg-relay-repair-subnet", "wgRelayFieldSubnet", "text", "wgSubnet"],
    ];
    for (const [id, labelKey, type, key] of fieldSpecs) {
      const field = createField({
        id, labelKey, type, value: draft[key], required: true, disabled,
        onInput: (value) => { draft[key] = type === "number" ? Number.parseInt(value, 10) : value; },
      });
      card.appendChild(field.wrap);
    }
    const relayPort = createField({
      id: "wg-relay-repair-relay-port", labelKey: "wgRelayFieldRelayPort", type: "number",
      value: DEFAULTS.relayPort, disabled, readOnly: true,
    });
    card.appendChild(relayPort.wrap);
    const password = createField({
      id: "wg-relay-repair-password", labelKey: "wgRelayFieldPassword", type: "password", value: "",
      required: true, autocomplete: "new-password", disabled,
    });
    card.appendChild(password.wrap);
    const passwordHint = document.createElement("p");
    passwordHint.className = "wg-relay-password-hint";
    passwordHint.textContent = t("wgRelayRepairPasswordHint");
    card.appendChild(passwordHint);
    const actions = document.createElement("div");
    actions.className = "wg-relay-actions";
    actions.appendChild(createButton("wgRelayCancel", "soft-btn", () => {
      password.input.value = "";
      view.repairDraftByProfile.delete(profile.id);
      view.repairOpen = false;
      requestContentRender();
    }, disabled));
    actions.appendChild(createButton(view.busy ? "wgRelayDeploying" : "wgRelayRepairDeploy", "soft-btn accent", () => {
      const next = buildProfile(draft, {
        wgPort: Number.isInteger(draft.wgPort) ? draft.wgPort : DEFAULTS.wgPort,
        wgSubnet: String(draft.wgSubnet || DEFAULTS.wgSubnet).trim(),
      });
      runDeploy({ ...profile, ...next, identityFile: undefined }, password.input);
    }, disabled));
    card.appendChild(actions);
    parent.appendChild(card);
  }

  function openRepair(profile) {
    closeQrDialog();
    ensureRepairDraft(profile);
    view.repairOpen = true;
    requestContentRender();
  }

  function updateStatusMount(profile) {
    const mount = view.statusMount;
    if (!mount || mount.profileId !== profile.id || !mount.card.isConnected) return false;
    const status = statusFor(profile);
    const repairCode = repairRequiredCode(status);
    const runtimeUnavailable = !window.wgRelay;
    const busy = runtimeUnavailable || Boolean(view.busy) || RUNTIME_BUSY_STATUSES.has(status.status);
    mount.badge.className = "wg-relay-status-badge wg-relay-status-" + statusClass(status.status);
    mount.badge.textContent = t("wgRelayStatus_" + status.status);
    mount.messages.innerHTML = "";
    if (repairCode) {
      const recoveryNode = document.createElement("div");
      recoveryNode.className = "wg-relay-recovery";
      recoveryNode.setAttribute("role", "status");
      recoveryNode.textContent = t("wgRelayRecoveryRequired");
      mount.messages.appendChild(recoveryNode);
      view.errorCode = repairCode;
    }
    renderError(mount.messages);
    mount.primary.textContent = repairCode
      ? t("wgRelayRepair")
      : t(status.status === "connected" || status.status === "disconnecting"
        ? "wgRelayDisconnect"
        : "wgRelayConnect");
    mount.primary.disabled = busy;
    for (const button of mount.secondaryButtons) button.disabled = busy;
    mount.repairButton.hidden = Boolean(repairCode);
    return true;
  }

  function updateStatusView(profile) {
    if (!updateStatusMount(profile)) requestContentRender();
  }

  function updateBusyControls() {
    const disabled = Boolean(view.busy);
    const profile = currentProfile();
    if (profile && isDeployed(profile)) updateStatusMount(profile);
    const rootNode = view.renderRoot;
    if (!rootNode) return;
    const repair = rootNode.querySelector(".wg-relay-repair-card");
    if (repair) {
      for (const input of repair.querySelectorAll("input")) input.disabled = disabled;
      for (const button of repair.querySelectorAll("button")) button.disabled = disabled;
    }
    const setup = rootNode.querySelector(".wg-relay-setup-card");
    if (setup) {
      for (const input of setup.querySelectorAll("input")) input.disabled = disabled || !window.wgRelay;
      for (const button of setup.querySelectorAll("button")) button.disabled = disabled || !window.wgRelay;
    }
  }

  function runPrimaryAction(profile) {
    const status = statusFor(profile);
    if (repairRequiredCode(status)) {
      openRepair(profile);
      return;
    }
    if (status.status === "connected" || status.status === "disconnecting") {
      beginOperation("disconnect", () => window.wgRelay.disconnect(profile.id), (result) => {
        applyConnectionResult(profile, result, "connection_failed");
      });
    } else {
      beginOperation("connect", () => window.wgRelay.connect(profile.id), (result) => {
        applyConnectionResult(profile, result, "connection_failed");
      });
    }
  }

  function renderStatusCard(parent, profile) {
    const card = document.createElement("section");
    card.className = "section wg-relay-status-card";
    const header = document.createElement("div");
    header.className = "wg-relay-status-header";
    const identity = document.createElement("div");
    identity.className = "wg-relay-server-identity";
    const name = document.createElement("h2");
    name.className = "wg-relay-server-name";
    name.textContent = profile.label;
    const host = document.createElement("div");
    host.className = "wg-relay-server-host";
    host.textContent = profile.host;
    identity.appendChild(name);
    identity.appendChild(host);
    const badge = document.createElement("span");
    header.appendChild(identity);
    header.appendChild(badge);
    card.appendChild(header);
    const messages = document.createElement("div");
    messages.className = "wg-relay-status-messages";
    card.appendChild(messages);
    renderProgress(card);
    const primary = createButton("wgRelayConnect", "soft-btn accent wg-relay-primary-action", () => {
      runPrimaryAction(profile);
    }, false);
    card.appendChild(primary);
    const secondary = document.createElement("div");
    secondary.className = "wg-relay-secondary-actions";
    const showQr = createButton("wgRelayShowQr", "soft-btn", (event) => {
      showPairingQr(profile, event.currentTarget);
    }, false);
    const rotate = createButton("wgRelayRotatePhone", "soft-btn", (event) => {
      rotatePhone(profile, event.currentTarget);
    }, false);
    const repair = createButton("wgRelayRepair", "soft-btn", () => openRepair(profile), false);
    const remove = createButton("wgRelayDelete", "soft-btn wg-relay-danger-action", (event) => {
      deleteProfile(profile, event.currentTarget);
    }, false);
    const secondaryButtons = [showQr, rotate, repair, remove];
    for (const button of secondaryButtons) secondary.appendChild(button);
    card.appendChild(secondary);
    parent.appendChild(card);
    view.statusMount = {
      profileId: profile.id,
      card,
      badge,
      messages,
      primary,
      secondaryButtons,
      repairButton: repair,
    };
    updateStatusMount(profile);
    if (view.repairOpen) renderRepair(parent, profile);
    refreshStatus(profile);
  }

  function render(parent) {
    cancelPendingConfirm();
    closeQrDialog();
    view.renderRoot = parent;
    view.statusMount = null;
    subscribeListeners();
    const title = document.createElement("h1");
    title.textContent = t("wgRelayTitle");
    parent.appendChild(title);
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("wgRelaySubtitle");
    parent.appendChild(subtitle);
    if (!window.wgRelay) {
      view.errorCode = "runtime_unavailable";
    }
    const profile = currentProfile();
    if (!isDeployed(profile)) renderSetup(parent, profile);
    else renderStatusCard(parent, profile);
    restorePendingFocus();
  }

  function onExit() {
    cancelPendingConfirm();
    closeQrDialog();
    cancelStatusRetry();
    if (view.renderRoot) {
      for (const input of view.renderRoot.querySelectorAll("input").filter((item) => item.type === "password")) {
        input.value = "";
      }
    }
    view.epoch++;
    view.statusRequest = null;
    view.statusLoadedByProfile.clear();
    view.statusAttemptsByProfile.clear();
    view.repairOpen = false;
    view.repairDraftByProfile.clear();
    view.statusMount = null;
    view.pendingFocusLabel = null;
    unsubscribeListeners();
  }

  function dispose() {
    onExit();
    view.setupDraft = null;
    view.profileOverride = null;
    view.repairDraftByProfile.clear();
    view.statusByProfile.clear();
    view.statusRevisionByProfile.clear();
    view.progressVisible = false;
    view.errorCode = null;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["wg-relay"] = { render, onExit, dispose };
  }

  root.ClawdSettingsTabWgRelay = { init };
})(globalThis);

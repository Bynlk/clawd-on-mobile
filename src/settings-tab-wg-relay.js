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
  const RECOVERY_CODES = new Set([
    "remote_commit_recovery_required",
    "profile_conflict_recovery_required",
  ]);
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
  });

  const view = {
    epoch: 0,
    setupDraft: null,
    profileOverride: null,
    hiddenProfileIds: new Set(),
    statusByProfile: new Map(),
    statusRevisionByProfile: new Map(),
    statusRequest: null,
    progressProfileId: null,
    progressVisible: false,
    progressStates: PROGRESS_STAGES.map(() => "pending"),
    errorCode: null,
    repairOpen: false,
    busy: null,
    listenerDisposers: [],
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

  function safeStatus(value, profileId) {
    const source = value && typeof value === "object" ? value : {};
    const status = STATUSES.has(source.status) ? source.status : "idle";
    const result = { profileId, status };
    if (typeof source.errorCode === "string") result.errorCode = source.errorCode;
    else if (typeof source.status === "string"
        && (RECOVERY_CODES.has(source.status) || source.status.endsWith("_recovery_required"))) {
      result.errorCode = source.status;
    }
    return result;
  }

  function statusFor(profile) {
    return view.statusByProfile.get(profile.id) || { profileId: profile.id, status: "idle" };
  }

  function recoveryCode(status) {
    if (!status) return null;
    if (RECOVERY_CODES.has(status.status)) return status.status;
    if (typeof status.errorCode === "string"
        && (RECOVERY_CODES.has(status.errorCode) || status.errorCode.endsWith("_recovery_required"))) {
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
      if (safeCode.startsWith("health_")) displayCode = "health_failed";
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
        const profile = currentProfile();
        if (!profile || !payload || payload.profileId !== profile.id) return;
        const next = safeStatus(payload, profile.id);
        view.statusByProfile.set(profile.id, next);
        view.statusRevisionByProfile.set(
          profile.id,
          (view.statusRevisionByProfile.get(profile.id) || 0) + 1,
        );
        view.errorCode = next.errorCode || null;
        requestContentRender();
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
    if (view.statusRequest
        && view.statusRequest.profileId === profile.id
        && view.statusRequest.epoch === view.epoch) return;
    const request = {
      profileId: profile.id,
      epoch: view.epoch,
      statusRevision: view.statusRevisionByProfile.get(profile.id) || 0,
    };
    view.statusRequest = request;
    window.wgRelay.status(profile.id).then((result) => {
      if (view.statusRequest !== request || request.epoch !== view.epoch
          || state.activeTab !== "wg-relay") return;
      if ((view.statusRevisionByProfile.get(profile.id) || 0) !== request.statusRevision) return;
      if (result && result.status === "ok" && result.state) {
        const next = safeStatus(result.state, profile.id);
        view.statusByProfile.set(profile.id, next);
        view.errorCode = next.errorCode || null;
      } else if (result && typeof result.errorCode === "string") {
        const existing = statusFor(profile);
        view.statusByProfile.set(profile.id, { ...existing, errorCode: result.errorCode });
        view.errorCode = result.errorCode;
      }
      requestContentRender();
    }).catch(() => {
      if (view.statusRequest === request && request.epoch === view.epoch
          && state.activeTab === "wg-relay"
          && (view.statusRevisionByProfile.get(profile.id) || 0) === request.statusRevision) {
        view.errorCode = "unknown";
        requestContentRender();
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
    let promise;
    try {
      promise = Promise.resolve(operation());
    } catch (_) {
      promise = Promise.resolve({ status: "error", errorCode: "unknown" });
    }
    record.promise = promise.then((result) => {
      if (record.epoch === view.epoch && state.activeTab === "wg-relay") {
        applyResult(result || { status: "error", errorCode: "unknown" });
      }
      return result;
    }).catch(() => {
      if (record.epoch === view.epoch && state.activeTab === "wg-relay") {
        view.errorCode = "unknown";
      }
      return { status: "error", errorCode: "unknown" };
    }).finally(() => {
      if (view.busy === record) view.busy = null;
      requestContentRender();
    });
    requestContentRender();
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

  function confirmAction({ titleKey, detailKey, confirmKey }) {
    if (helpers && typeof helpers.showSettingsConfirmModal === "function") {
      return helpers.showSettingsConfirmModal({
        title: t(titleKey),
        detail: t(detailKey),
        actions: [
          { id: "cancel", label: t("wgRelayCancel") },
          { id: "confirm", label: t(confirmKey), tone: "danger", defaultFocus: true },
        ],
      });
    }
    return Promise.resolve(typeof confirm === "function" && confirm(t(detailKey)) ? "confirm" : null);
  }

  function closeQrDialog() {
    const record = view.qrDialog;
    if (!record) return;
    try { document.removeEventListener("keydown", record.onKeyDown, true); } catch (_) {}
    record.image.src = "";
    record.image.removeAttribute("src");
    record.dataUrl = "";
    const modalRoot = document.getElementById("modalRoot");
    if (modalRoot) modalRoot.innerHTML = "";
    view.qrDialog = null;
  }

  function openQrDialog(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      view.errorCode = "pairing_qr_failed";
      return;
    }
    const modalRoot = document.getElementById("modalRoot");
    if (!modalRoot) {
      view.errorCode = "pairing_qr_failed";
      return;
    }
    closeQrDialog();
    let sensitiveUrl = dataUrl;
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
    const close = createButton("wgRelayQrClose", "soft-btn", closeQrDialog, false);
    function onKeyDown(event) {
      if (event.key === "Escape") closeQrDialog();
    }
    document.addEventListener("keydown", onKeyDown, true);
    dialog.appendChild(title);
    dialog.appendChild(image);
    dialog.appendChild(warning);
    dialog.appendChild(close);
    backdrop.appendChild(dialog);
    modalRoot.innerHTML = "";
    modalRoot.appendChild(backdrop);
    view.qrDialog = { image, dataUrl: sensitiveUrl, onKeyDown };
    sensitiveUrl = "";
    if (typeof close.focus === "function") close.focus();
  }

  function showPairingQr(profile) {
    return beginOperation("pairing-qr", () => window.wgRelay.pairingQr(profile.id), (result) => {
      if (result && result.status === "ok" && result.qr) {
        view.errorCode = null;
        openQrDialog(result.qr.dataUrl);
      } else setResultError(result, "pairing_qr_failed");
    });
  }

  function rotatePhone(profile) {
    return confirmAction({
      titleKey: "wgRelayRotateConfirmTitle",
      detailKey: "wgRelayRotateConfirmDetail",
      confirmKey: "wgRelayRotateConfirmAction",
    }).then((choice) => {
      if (choice !== "confirm") return null;
      return beginOperation("rotate", () => window.wgRelay.rotatePhone(profile.id), (result) => {
        applyConnectionResult(profile, result, "rotate_failed");
        if (result && result.status === "ok" && result.qr) openQrDialog(result.qr.dataUrl);
      });
    });
  }

  function deleteProfile(profile) {
    return confirmAction({
      titleKey: "wgRelayDeleteConfirmTitle",
      detailKey: "wgRelayDeleteConfirmDetail",
      confirmKey: "wgRelayDeleteConfirmAction",
    }).then((choice) => {
      if (choice !== "confirm") return null;
      return beginOperation("delete", () => window.wgRelay.deleteLocal(profile.id), (result) => {
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
          view.errorCode = null;
        } else setResultError(result, "delete_failed");
      });
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
    const draft = {
      id: profile.id,
      label: profile.label,
      host: profile.host,
      sshUsername: profile.sshUsername || DEFAULTS.sshUsername,
      sshPort: Number.isInteger(profile.sshPort) ? profile.sshPort : DEFAULTS.sshPort,
      wgPort: Number.isInteger(profile.wgPort) ? profile.wgPort : DEFAULTS.wgPort,
      wgSubnet: profile.wgSubnet || DEFAULTS.wgSubnet,
    };
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

  function renderStatusCard(parent, profile) {
    refreshStatus(profile);
    const status = statusFor(profile);
    const recovery = recoveryCode(status);
    const runtimeUnavailable = !window.wgRelay;
    const busy = runtimeUnavailable || Boolean(view.busy) || RUNTIME_BUSY_STATUSES.has(status.status);
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
    badge.className = "wg-relay-status-badge wg-relay-status-" + statusClass(status.status);
    badge.textContent = t("wgRelayStatus_" + status.status);
    header.appendChild(identity);
    header.appendChild(badge);
    card.appendChild(header);
    if (recovery) {
      const recoveryNode = document.createElement("div");
      recoveryNode.className = "wg-relay-recovery";
      recoveryNode.setAttribute("role", "status");
      recoveryNode.textContent = t("wgRelayRecoveryRequired");
      card.appendChild(recoveryNode);
      view.errorCode = recovery;
    }
    renderError(card);
    const primaryKey = status.status === "connected" || status.status === "disconnecting"
      ? "wgRelayDisconnect"
      : "wgRelayConnect";
    const primary = createButton(primaryKey, "soft-btn accent wg-relay-primary-action", () => {
      if (status.status === "connected" || status.status === "disconnecting") {
        beginOperation("disconnect", () => window.wgRelay.disconnect(profile.id), (result) => {
          applyConnectionResult(profile, result, "connection_failed");
        });
      } else {
        beginOperation("connect", () => window.wgRelay.connect(profile.id), (result) => {
          applyConnectionResult(profile, result, "connection_failed");
        });
      }
    }, busy || Boolean(recovery) || !window.wgRelay);
    card.appendChild(primary);
    const secondary = document.createElement("div");
    secondary.className = "wg-relay-secondary-actions";
    secondary.appendChild(createButton("wgRelayShowQr", "soft-btn", () => showPairingQr(profile), busy));
    secondary.appendChild(createButton("wgRelayRotatePhone", "soft-btn", () => rotatePhone(profile), busy));
    secondary.appendChild(createButton("wgRelayRepair", "soft-btn", () => {
      closeQrDialog();
      view.repairOpen = true;
      requestContentRender();
    }, busy));
    secondary.appendChild(createButton("wgRelayDelete", "soft-btn wg-relay-danger-action", () => deleteProfile(profile), busy));
    card.appendChild(secondary);
    parent.appendChild(card);
    if (view.repairOpen) renderRepair(parent, profile);
  }

  function render(parent) {
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
  }

  function onExit() {
    view.epoch++;
    view.statusRequest = null;
    view.repairOpen = false;
    unsubscribeListeners();
    closeQrDialog();
  }

  function dispose() {
    onExit();
    view.setupDraft = null;
    view.profileOverride = null;
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

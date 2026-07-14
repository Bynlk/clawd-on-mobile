"use strict";

function buildSettingsWgRelayViewModelExports() {
  const PAGE_MODES = Object.freeze({
    SETUP: "setup",
    DEPLOYING: "deploying",
    READY: "ready",
    CONNECTED: "connected",
    REPAIR_REQUIRED: "repair-required",
    DEPLOYMENT_FAILURE: "deployment-failure",
  });

  const PROGRESS_STAGES = Object.freeze([
    "connect",
    "fingerprint",
    "upload",
    "dependencies",
    "wireguard",
    "relay",
    "verify",
    "save",
    "pcConnect",
    "qr",
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

  const PROGRESS_STATES = new Set(["pending", "current", "complete", "failed"]);
  const RUNTIME_STATUSES = new Set([
    "idle",
    "starting_tunnel",
    "verifying_relay",
    "connecting_relay",
    "connected",
    "disconnecting",
    "failed",
  ]);
  const RUNTIME_BUSY_STATUSES = new Set([
    "starting_tunnel",
    "verifying_relay",
    "connecting_relay",
    "disconnecting",
  ]);

  const ERROR_DEFINITIONS = Object.freeze({
    invalid_profile: ["deployment", "invalid_profile", false],
    password_required: ["deployment", "password_required", false],
    runtime_unavailable: ["deployment", "runtime_unavailable", false],
    deploy_failed: ["deployment", "deploy_failed", false],
    deploy_aborted: ["deployment", "deploy_aborted", false],
    remote_commit_recovery_required: [
      "deployment",
      "remote_commit_recovery_required",
      true,
    ],
    profile_conflict_recovery_required: [
      "deployment",
      "profile_conflict_recovery_required",
      true,
    ],
    secure_storage_unavailable: ["secure-storage", "secure_storage_unavailable", true],
    secret_store_read_failed: ["secure-storage", "secret_store_read_failed", true],
    secret_store_preflight_failed: ["secure-storage", "secure_storage_unavailable", true],
    secret_store_verification_failed: ["secure-storage", "secure_storage_unavailable", true],
    secrets_not_found: ["secure-storage", "secrets_not_found", true],
    profile_not_found: ["secure-storage", "profile_not_found", true],
    local_storage_retry_required: ["secure-storage", "local_storage_retry_required", false],
    public_profile_retry_required: ["deployment", "public_profile_retry_required", false],
    connection_retry_required: ["pc-tunnel", "connection_retry_required", false],
    connection_failed: ["pc-tunnel", "connection_failed", false],
    sidecar_failed: ["pc-tunnel", "sidecar_failed", false],
    health_failed: ["relay-health", "health_failed", false],
    relay_failed: ["relay-health", "relay_failed", false],
    pairing_qr_retry_required: ["pairing", "pairing_qr_retry_required", false],
    pairing_qr_failed: ["pairing", "pairing_qr_failed", false],
    rotate_failed: ["pairing", "rotate_failed", false],
    rotate_aborted: ["pairing", "rotate_aborted", false],
    invalid_profile_id: ["secure-storage", "invalid_profile_id", false],
    delete_prepare_failed: ["secure-storage", "delete_prepare_failed", false],
    delete_failed: ["secure-storage", "delete_failed", false],
    unknown: ["unknown", "unknown", false],
  });

  function normalizeProgress(states) {
    return PROGRESS_STAGES.map((_stage, index) => (
      PROGRESS_STATES.has(states && states[index]) ? states[index] : "pending"
    ));
  }

  function createDeploymentProgress() {
    return PROGRESS_STAGES.map((_stage, index) => (index === 0 ? "current" : "pending"));
  }

  function applyDeploymentProgress(states, payload) {
    const next = normalizeProgress(states);
    const step = payload && payload.step;
    const index = typeof step === "string" && Object.hasOwn(RAW_PROGRESS_STAGE, step)
      ? RAW_PROGRESS_STAGE[step]
      : null;
    if (!Number.isInteger(index)) return next;

    for (let cursor = 0; cursor < index; cursor += 1) {
      if (next[cursor] !== "failed") next[cursor] = "complete";
    }
    if (payload.status === "fail") next[index] = "failed";
    else if (payload.status === "ok") next[index] = "complete";
    else next[index] = "current";

    if (step === "validate" && payload.status === "ok" && next[7] === "pending") {
      next[7] = "current";
    }
    return next;
  }

  function classifyWgRelayError(code) {
    const normalized = typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code)
      ? code
      : "unknown";
    let definition = Object.hasOwn(ERROR_DEFINITIONS, normalized)
      ? ERROR_DEFINITIONS[normalized]
      : null;

    if (!definition && normalized.startsWith("health_")) {
      definition = ["relay-health", "health_failed", false];
    } else if (!definition
        && (normalized.startsWith("relay_") || normalized === "local_connect_failed")) {
      definition = ["relay-health", "relay_failed", false];
    } else if (!definition
        && (normalized.startsWith("connection_") || normalized === "secret_invalid")) {
      definition = ["pc-tunnel", "connection_failed", false];
    } else if (!definition && (
      normalized.startsWith("sidecar_")
      || normalized.startsWith("device_")
      || normalized.startsWith("endpoint_")
      || normalized.startsWith("listener_")
      || normalized === "listen_failed"
      || normalized === "stdin_failed"
      || normalized === "trailing_data"
      || normalized === "duplicate_ready"
      || normalized.startsWith("invalid_")
    )) {
      definition = ["pc-tunnel", "sidecar_failed", false];
    }

    if (!definition) definition = ERROR_DEFINITIONS.unknown;
    return {
      domain: definition[0],
      safeCode: definition[1],
      requiresRepair: definition[2],
      secretsAvailable: !definition[2],
    };
  }

  function deploymentProgressModel(states, mode) {
    const normalized = normalizeProgress(states);
    let currentIndex = normalized.findIndex((state) => state === "failed");
    if (currentIndex < 0) currentIndex = normalized.findIndex((state) => state === "current");
    if (currentIndex < 0) currentIndex = Math.max(0, normalized.lastIndexOf("complete"));

    const completedCount = normalized.filter((state) => state === "complete").length;
    const allStages = PROGRESS_STAGES.map((key, index) => ({
      key,
      state: normalized[index],
    }));
    return {
      currentStage: PROGRESS_STAGES[currentIndex],
      currentState: normalized[currentIndex],
      completedCount,
      total: PROGRESS_STAGES.length,
      percent: Math.round((completedCount / PROGRESS_STAGES.length) * 100),
      detailStages: mode === PAGE_MODES.DEPLOYMENT_FAILURE
        ? allStages.filter((stage) => stage.state !== "pending")
        : allStages,
    };
  }

  function deriveWgRelayPageModel(input = {}) {
    const status = input.status && typeof input.status === "object"
      ? input.status
      : { status: "idle" };
    const rawStatusName = typeof status.status === "string" ? status.status : "idle";
    const statusName = RUNTIME_STATUSES.has(rawStatusName) ? rawStatusName : "idle";
    const operation = typeof input.operation === "string" ? input.operation : null;

    const deploymentError = input.deploymentFailure
      && typeof input.deploymentFailure === "object"
      && input.deploymentFailure.errorCode
      ? input.deploymentFailure.errorCode
      : null;
    const statusNameError = classifyWgRelayError(rawStatusName);
    const repairError = [status.errorCode, rawStatusName, input.errorCode].find((candidate) => (
      candidate && classifyWgRelayError(candidate).requiresRepair
    ));
    const sourceError = deploymentError
      || repairError
      || status.errorCode
      || (statusNameError.requiresRepair ? rawStatusName : null)
      || input.errorCode
      || null;
    const error = sourceError ? classifyWgRelayError(sourceError) : null;

    const activeOperation = Boolean(operation);
    const runtimeBusy = RUNTIME_BUSY_STATUSES.has(statusName);
    const actionsDisabled = activeOperation || runtimeBusy || !input.runtimeAvailable;

    let mode;
    if (operation === "deploy") {
      mode = PAGE_MODES.DEPLOYING;
    } else if (input.deploymentFailure) {
      mode = PAGE_MODES.DEPLOYMENT_FAILURE;
    } else if (!input.hasDeployedProfile) {
      mode = PAGE_MODES.SETUP;
    } else if (error && error.requiresRepair) {
      mode = PAGE_MODES.REPAIR_REQUIRED;
    } else if (statusName === "connected"
        || statusName === "disconnecting"
        || operation === "disconnect") {
      mode = PAGE_MODES.CONNECTED;
    } else {
      mode = PAGE_MODES.READY;
    }

    let primaryAction = null;
    if (mode === PAGE_MODES.SETUP) {
      primaryAction = {
        kind: "deploy",
        labelKey: "wgRelayDeploy",
        disabled: actionsDisabled,
      };
    } else if (mode === PAGE_MODES.DEPLOYING) {
      primaryAction = {
        kind: "deploying",
        labelKey: "wgRelayDeploying",
        disabled: true,
      };
    } else if (mode === PAGE_MODES.DEPLOYMENT_FAILURE) {
      primaryAction = {
        kind: "retry-deploy",
        labelKey: "wgRelayTryDeployAgain",
        disabled: actionsDisabled,
      };
    } else if (!input.repairFormOpen && mode === PAGE_MODES.REPAIR_REQUIRED) {
      primaryAction = {
        kind: "repair",
        labelKey: "wgRelayRepair",
        disabled: actionsDisabled,
      };
    } else if (!input.repairFormOpen && mode === PAGE_MODES.CONNECTED) {
      primaryAction = {
        kind: "disconnect",
        labelKey: operation === "disconnect" || statusName === "disconnecting"
          ? "wgRelayDisconnecting"
          : "wgRelayDisconnect",
        disabled: actionsDisabled,
      };
    } else if (!input.repairFormOpen && mode === PAGE_MODES.READY) {
      primaryAction = {
        kind: "connect",
        labelKey: operation === "connect" || runtimeBusy
          ? "wgRelayConnecting"
          : "wgRelayConnect",
        disabled: actionsDisabled,
      };
    }

    const secretsAvailable = !(error && error.requiresRepair);
    const dailyMode = mode === PAGE_MODES.READY
      || mode === PAGE_MODES.CONNECTED
      || mode === PAGE_MODES.REPAIR_REQUIRED;
    const rows = input.hasDeployedProfile && dailyMode ? [
      {
        kind: "vps",
        state: mode === PAGE_MODES.REPAIR_REQUIRED ? "repair-required" : "configured",
        labelKey: "wgRelayVpsRow",
        statusKey: mode === PAGE_MODES.REPAIR_REQUIRED
          ? "wgRelayRepairRequiredTitle"
          : "wgRelayVpsConfigured",
        supportingText: typeof input.host === "string" ? input.host : "",
      },
      {
        kind: "computer",
        state: statusName,
        labelKey: "wgRelayComputerRow",
        statusKey: `wgRelayStatus_${statusName}`,
      },
      {
        kind: "android",
        state: secretsAvailable ? "pairing-available" : "unavailable",
        labelKey: "wgRelayAndroidRow",
        statusKey: secretsAvailable
          ? "wgRelayAndroidPairingAvailable"
          : "wgRelayAndroidUnavailable",
        action: secretsAvailable && mode !== PAGE_MODES.REPAIR_REQUIRED ? {
          kind: "show-pairing-qr",
          labelKey: "wgRelayShowQr",
          disabled: actionsDisabled,
        } : null,
      },
    ] : [];

    let secondaryActions = [];
    if (input.hasDeployedProfile && dailyMode && !input.repairFormOpen) {
      secondaryActions = mode === PAGE_MODES.REPAIR_REQUIRED
        ? [{ kind: "delete-local", labelKey: "wgRelayDelete", disabled: actionsDisabled }]
        : [
          {
            kind: "rotate-phone",
            labelKey: "wgRelayRotatePhone",
            disabled: actionsDisabled,
          },
          { kind: "repair", labelKey: "wgRelayRepair", disabled: actionsDisabled },
          { kind: "delete-local", labelKey: "wgRelayDelete", disabled: actionsDisabled },
        ];
    }

    return {
      mode,
      rows,
      primaryAction,
      secondaryActions,
      error,
      progress: mode === PAGE_MODES.DEPLOYING
        ? deploymentProgressModel(input.progressStates, mode)
        : null,
    };
  }

  return {
    PAGE_MODES,
    PROGRESS_STAGES,
    createDeploymentProgress,
    applyDeploymentProgress,
    classifyWgRelayError,
    deriveWgRelayPageModel,
  };
}

const settingsWgRelayViewModelExports = buildSettingsWgRelayViewModelExports();

if (typeof module !== "undefined" && module.exports) {
  module.exports = settingsWgRelayViewModelExports;
}
if (typeof globalThis !== "undefined") {
  globalThis.ClawdSettingsWgRelayViewModel = settingsWgRelayViewModelExports;
}

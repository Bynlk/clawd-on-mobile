"use strict";

function activateMobileExtension({ runtimeEvents, mobileIntegration, resolvePermissionEntry }) {
  if (!runtimeEvents || !mobileIntegration) return () => {};

  const bridge = {};
  mobileIntegration.setupPermissionHooks(bridge, resolvePermissionEntry);
  mobileIntegration.setupStateChangeHooks(bridge);

  const unsubscribers = [
    runtimeEvents.on("permission-added", ({ entry, id }) => {
      if (entry) entry._mobileApprovalId = id;
      bridge.onPermissionAdded?.(entry, id);
    }),
    runtimeEvents.on("permission-removed", ({ entry }) => bridge.onPermissionRemoved?.(entry)),
    runtimeEvents.on("permission-resolved", ({ entry, outcome }) => bridge.onPermissionResolved?.(entry, outcome)),
    runtimeEvents.on("session-updated", ({ sessionId, data }) => bridge.onMobileStateChange?.(sessionId, "state", data)),
    runtimeEvents.on("tool-output", ({ sessionId, data }) => bridge.onMobileToolOutput?.(sessionId, data)),
    runtimeEvents.on("session-snapshot", ({ snapshot }) => bridge.onMobileSessionSnapshot?.(snapshot)),
    runtimeEvents.on("session-removed", ({ sessionId }) => bridge.onMobileSessionRemoved?.(sessionId)),
    runtimeEvents.on("mobile-max-clients-changed", ({ maxClients }) => bridge.onMobileMaxClientsChange?.(maxClients)),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

module.exports = { activateMobileExtension };

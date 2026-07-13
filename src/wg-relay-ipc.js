"use strict";

// ── WireGuard relay IPC ──
//
// Wires `window.wgRelay.*` invokes to the deploy orchestrator (wg-relay-deploy)
// and the desktop userspace tunnel (wg-pc-tunnel), and pushes runtime status /
// deploy progress back to every renderer window.
//
// Profile CRUD is NOT here — that flows through `settings:command`
// (wgRelay.add / .update / .remove / .applyReadback) so settings-controller
// stays the single writer. This module only handles runtime state
// (Deploy / Tunnel Up / Tunnel Down / status) plus event push. Same split and
// broadcast pattern as remote-ssh-ipc.js — pure-additive, touches nothing in
// the remote-ssh modules.
//
// SECURITY:
//   SEC-1  the SSH password arrives ONLY in the deploy IPC payload (from the
//          renderer's in-memory view.passwords). It is passed straight to
//          deploy() and never persisted, logged, or echoed.
//   SEC-3  the deploy readback's pcConf carries the pc private key. It is held
//          ONLY in the runtime's in-memory cache (rememberPcConf) so tunnelUp
//          can bring the interface up; it is never written to disk. The full
//          readback (incl. phoneConf) is returned to the renderer transiently
//          for the QR, but only the PUBLIC fields are persisted by the
//          renderer via wgRelay.applyReadback.

const childProcess = require("child_process");
const { deploy: defaultDeploy } = require("./wg-relay-deploy");
const {
  bringUp: defaultBringUp,
  bringDown: defaultBringDown,
  status: defaultTunnelStatus,
} = require("./wg-pc-tunnel");

function requireDep(value, name) {
  if (!value) throw new Error(`registerWgRelayIpc requires ${name}`);
  return value;
}

function findProfile(settingsController, profileId) {
  const snap = settingsController.getSnapshot();
  const list = (snap.wgRelay && Array.isArray(snap.wgRelay.profiles)) ? snap.wgRelay.profiles : [];
  return list.find((p) => p.id === profileId) || null;
}

function broadcast(BrowserWindow, channel, payload) {
  try {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed() && bw.webContents && !bw.webContents.isDestroyed()) {
        bw.webContents.send(channel, payload);
      }
    }
  } catch {
    // Best-effort — a broadcast failure must never crash the runtime.
  }
}

function profileIdFrom(payload) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") return payload.profileId || payload.id || null;
  return null;
}

function registerWgRelayIpc(options = {}) {
  const ipcMain = requireDep(options.ipcMain, "ipcMain");
  const settingsController = requireDep(options.settingsController, "settingsController");
  const wgRelayRuntime = requireDep(options.wgRelayRuntime, "wgRelayRuntime");
  const BrowserWindow = requireDep(options.BrowserWindow, "BrowserWindow");
  const spawn = options.spawn || childProcess.spawn;
  const log = options.log || (() => {});
  // Test-only injection points. Production main.js never overrides these.
  const deployFn = options.deployFn || defaultDeploy;
  const bringUpFn = options.bringUpFn || defaultBringUp;
  const bringDownFn = options.bringDownFn || defaultBringDown;
  const tunnelStatusFn = options.tunnelStatusFn || defaultTunnelStatus;
  // Native OS privilege dialog for TUN creation — the sole allowed D-UX
  // system interaction. Injected so main.js can supply a platform escalator
  // and tests can stub it. When absent, wg-pc-tunnel treats privilege as
  // pre-granted (dev / already-elevated environments).
  const privilegeEscalator = options.privilegeEscalator;
  // Tunnel interface name generator (per profile so concurrent tunnels don't
  // clash). Deterministic + short: "clawd0" for the first, then hashed.
  const ifNameFor = options.ifNameFor || ((profile) => profile.ifName || "clawd0");

  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => {
      try { ipcMain.removeHandler(channel); } catch {}
    });
  }

  // Bridge runtime emitter → IPC broadcasts (same shape as remote-ssh).
  const onStatusChanged = (snap) => broadcast(BrowserWindow, "wgRelay:status-changed", snap);
  const onProgress = (payload) => broadcast(BrowserWindow, "wgRelay:progress", payload);
  wgRelayRuntime.on("status-changed", onStatusChanged);
  wgRelayRuntime.on("progress", onProgress);
  disposers.push(() => {
    wgRelayRuntime.off("status-changed", onStatusChanged);
    wgRelayRuntime.off("progress", onProgress);
  });

  // ── Status / list ──

  handle("wgRelay:list-statuses", () => {
    return { status: "ok", statuses: wgRelayRuntime.listStatuses() };
  });

  handle("wgRelay:status", (_event, payload) => {
    const id = profileIdFrom(payload);
    if (!id) return { status: "error", message: "wgRelay:status requires { profileId }" };
    return { status: "ok", state: wgRelayRuntime.getProfileStatus(id) };
  });

  // ── Deploy ──
  //
  // Runs the full over-SSH deploy (or a phone-key-only regen when
  // regenPhoneOnly is set). Progress events flow through the runtime emitter
  // → wgRelay:progress broadcast. On success we cache the pcConf in memory for
  // a later tunnelUp (SEC-3), stamp deployedAt, and return the FULL readback
  // to the renderer (the renderer persists only public fields + draws the QR).
  handle("wgRelay:deploy", async (_event, payload) => {
    const id = profileIdFrom(payload);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };

    const password = (payload && typeof payload === "object" && typeof payload.password === "string")
      ? payload.password
      : undefined;
    const regenPhoneOnly = !!(payload && typeof payload === "object" && payload.regenPhoneOnly);

    try {
      const result = await deployFn({
        profile,
        password,
        // runtime.forcePhoneKey drives the phone-only regen preamble; the
        // emitter is passed via deps.runtime so progress broadcasts.
        runtime: { forcePhoneKey: regenPhoneOnly },
        deps: { spawn, runtime: wgRelayRuntime },
      });
      if (result && result.ok && result.readback) {
        const readback = { ...result.readback, deployedAt: Date.now() };
        // Cache pcConf in memory only (SEC-3) for tunnelUp.
        wgRelayRuntime.rememberPcConf(profile.id, readback.pcConf);
        // Deploy done; tunnel is not up yet → back to idle (public readback
        // now available, so the UI shows the endpoint + Tunnel Up).
        wgRelayRuntime.setStatus(profile.id, { status: "idle", message: null });
        return { status: "ok", readback };
      }
      // Failure path — surface step/hint/message the renderer can localize.
      const message = (result && result.message) || "deploy failed";
      wgRelayRuntime.setStatus(profile.id, { status: "failed", message });
      return {
        status: "error",
        message,
        step: (result && result.step) || null,
        reason: (result && result.reason) || null,
        hint: (result && result.hint) || null,
      };
    } catch (err) {
      const message = (err && err.message) || "deploy threw";
      wgRelayRuntime.setStatus(profile.id, { status: "failed", message });
      return { status: "error", message };
    }
  });

  // ── Tunnel Up ──
  //
  // Bring up the desktop (PC) side using the in-memory pcConf from the last
  // deploy. The only user-visible system interaction is the native privilege
  // dialog (D-UX). No conf import, no external app.
  handle("wgRelay:tunnel-up", async (_event, payload) => {
    const id = profileIdFrom(payload);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };

    const pcConf = wgRelayRuntime.getPcConf(profile.id);
    if (!pcConf) {
      // No cached conf → the user must (re)deploy first this session (SEC-3:
      // the conf is memory-only and gone after an app restart).
      const message = "No tunnel configuration in memory. Deploy first.";
      wgRelayRuntime.setStatus(profile.id, { status: "failed", message, hint: "wgPcErrNoConf" });
      return { status: "error", message, hint: "wgPcErrNoConf" };
    }

    const ifName = ifNameFor(profile);
    wgRelayRuntime.setStatus(profile.id, { status: "starting_tunnel", message: null });
    try {
      const r = await bringUpFn({
        pcConf,
        ifName,
        privilegeEscalator,
        onProgress: (line) => wgRelayRuntime.emitProgress({
          profileId: profile.id, step: "tunnel", status: "start", message: line,
        }),
        deps: { spawn },
      });
      if (r && r.ok) {
        wgRelayRuntime.setStatus(profile.id, {
          status: "connected", ifName: r.ifName, address: r.address, message: null,
        });
        return { status: "ok", ifName: r.ifName, address: r.address };
      }
      const message = (r && r.message) || "tunnel up failed";
      wgRelayRuntime.setStatus(profile.id, { status: "failed", message, hint: r && r.hint });
      return { status: "error", message, hint: (r && r.hint) || null, reason: (r && r.reason) || null };
    } catch (err) {
      const message = (err && err.message) || "tunnel up threw";
      wgRelayRuntime.setStatus(profile.id, { status: "failed", message });
      return { status: "error", message };
    }
  });

  // ── Tunnel Down ──

  handle("wgRelay:tunnel-down", async (_event, payload) => {
    const id = profileIdFrom(payload);
    const profile = id ? findProfile(settingsController, id) : null;
    // Even if the profile was deleted we still try to tear down by id/ifName.
    const ifName = profile ? ifNameFor(profile) : "clawd0";
    try {
      const r = await bringDownFn({ ifName, privilegeEscalator, deps: { spawn } });
      if (id) {
        wgRelayRuntime.setStatus(id, { status: "idle", ifName: null, address: null, message: null });
      }
      return { status: r && r.ok ? "ok" : "error", message: r && r.ok ? undefined : "tunnel down failed" };
    } catch (err) {
      const message = (err && err.message) || "tunnel down threw";
      if (id) wgRelayRuntime.setStatus(id, { status: "failed", message });
      return { status: "error", message };
    }
  });

  // ── Live tunnel probe (handshake / peers) ──

  handle("wgRelay:tunnel-status", async (_event, payload) => {
    const id = profileIdFrom(payload);
    const profile = id ? findProfile(settingsController, id) : null;
    const ifName = profile ? ifNameFor(profile) : "clawd0";
    try {
      const r = await tunnelStatusFn({ ifName, deps: { spawn } });
      return { status: "ok", tunnel: r };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "tunnel status threw" };
    }
  });

  function dispose() {
    while (disposers.length) {
      const d = disposers.pop();
      try { d(); } catch {}
    }
  }

  return {
    dispose,
    _internal: { findProfile, profileIdFrom },
  };
}

module.exports = { registerWgRelayIpc };

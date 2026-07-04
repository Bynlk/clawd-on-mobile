"use strict";

// WireGuard relay tab — plan-wg-relay §3.6
//
// One-click cross-network relay: the user supplies ONLY a VPS IP + password
// (or an SSH key) and this tab drives the whole deploy over SSH — install
// wireguard, generate keys, write configs, start the service, open the
// firewall, read back the public endpoint, bring up the PC tunnel and render
// a phone-join QR. No jumping to external apps (D-UX).
//
// Profile CRUD goes through window.settingsAPI.command using the
// wgRelay.add / .update / .remove / .applyReadback actions registered on
// settings-actions.js. Runtime ops (deploy / tunnelUp / tunnelDown /
// regenPhone / status) go through window.wgRelay.* — that preload bridge is
// added separately; every call site guards for its absence so the tab still
// renders (read-only) when the bridge is missing.
//
// SECURITY:
//   SEC-1  the SSH password lives ONLY in the in-memory view.passwords Map.
//          It is never put in a saved profile payload, never persisted, and is
//          re-entered every app launch. The edit form only stores authMethod.
//   SEC-3  the phone private key / phoneConf comes back from a deploy inside
//          view.readbacks (transient, memory-only). Only the PUBLIC readback
//          fields are persisted (via wgRelay.applyReadback). The QR is drawn
//          from the transient conf and is gone on reload.

(function initSettingsTabWgRelay(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  // Local view state (tab-scoped — not persisted in core.state).
  //
  // passwords / readbacks are memory-only by design (SEC-1 / SEC-3). progressLog
  // and deployingProfileIds are keyed by profileId so concurrent deploys on
  // multiple profiles don't clobber each other's button/log.
  const view = {
    selectedProfileId: null,
    editing: null,               // profile snapshot for edit form, or null
    runtimeStatuses: new Map(),  // profileId → status snapshot
    progressLog: new Map(),      // profileId → Array<event>
    passwords: new Map(),        // profileId → SSH password (MEMORY ONLY, SEC-1)
    readbacks: new Map(),        // profileId → transient deploy readback (SEC-3)
    qrDataUrls: new Map(),       // profileId → phone-join QR data URL (transient)
    listenerInstalled: false,
    deployingProfileIds: new Set(),
  };

  const PROGRESS_LOG_MAX = 50;
  // Deploy pipeline steps — labels come from wgRelayStep_<step> i18n keys.
  const DEPLOY_STEPS = [
    "connect", "detect", "install-wg", "gen-keys",
    "write-conf", "start-service", "firewall", "readback",
  ];

  function t(key) {
    return helpers.t(key);
  }

  function listProfiles() {
    const snap = state.snapshot || {};
    const wgRelay = snap.wgRelay || {};
    return Array.isArray(wgRelay.profiles) ? wgRelay.profiles : [];
  }

  function findProfile(id) {
    return listProfiles().find((p) => p.id === id) || null;
  }

  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return "wg-" + crypto.randomUUID().replace(/-/g, "").slice(0, 13);
    }
    return "wg-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function ensureRuntimeListeners() {
    if (view.listenerInstalled) return;
    if (!window.wgRelay) return;
    view.listenerInstalled = true;
    if (typeof window.wgRelay.onStatusChanged === "function") {
      window.wgRelay.onStatusChanged((s) => {
        if (s && typeof s.profileId === "string") {
          view.runtimeStatuses.set(s.profileId, s);
        }
        if (state.activeTab === "wg-relay") ops.requestRender({ content: true });
      });
    }
    if (typeof window.wgRelay.onProgress === "function") {
      window.wgRelay.onProgress((p) => {
        if (!p || typeof p.profileId !== "string") return;
        let log = view.progressLog.get(p.profileId);
        if (!log) {
          log = [];
          view.progressLog.set(p.profileId, log);
        }
        log.push({ ...p, ts: Date.now() });
        if (log.length > PROGRESS_LOG_MAX) {
          log.splice(0, log.length - PROGRESS_LOG_MAX);
        }
        if (state.activeTab === "wg-relay") ops.requestRender({ content: true });
      });
    }
    if (typeof window.wgRelay.listStatuses === "function") {
      window.wgRelay.listStatuses().then((res) => {
        if (res && res.status === "ok" && Array.isArray(res.statuses)) {
          for (const s of res.statuses) view.runtimeStatuses.set(s.profileId, s);
          if (state.activeTab === "wg-relay") ops.requestRender({ content: true });
        }
      }).catch(() => {});
    }
  }

  function statusForProfile(id) {
    const s = view.runtimeStatuses.get(id);
    return s || { profileId: id, status: "idle" };
  }

  function statusBadgeClass(status) {
    switch (status) {
      case "connected": return "wg-relay-status-connected";
      case "connecting":
      case "reconnecting": return "wg-relay-status-connecting";
      case "deploying": return "wg-relay-status-deploying";
      case "failed": return "wg-relay-status-failed";
      default: return "wg-relay-status-idle";
    }
  }

  function statusLabel(status) {
    return t("wgRelayStatus_" + status) || status;
  }

  function statusMessageText(status) {
    if (!status) return "";
    if (status.hint) {
      const translated = t(status.hint);
      if (translated && translated !== status.hint) return translated;
    }
    return status.message || "";
  }

  function callCommand(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error" });
    }
    return window.settingsAPI.command(action, payload).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || (t("toastSaveFailed") + "unknown error"), { error: true });
      }
      return result;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return { status: "error", message: err && err.message };
    });
  }

  // ── Render ──

  function render(parent) {
    ensureRuntimeListeners();

    const h1 = document.createElement("h1");
    h1.textContent = t("wgRelayTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("wgRelaySubtitle");
    parent.appendChild(subtitle);

    // Surface a single non-blocking notice when the runtime bridge is missing:
    // CRUD still works (profiles persist) but deploy/tunnel ops are disabled.
    if (!window.wgRelay) {
      const warn = document.createElement("div");
      warn.className = "wg-relay-runtime-warn";
      warn.textContent = t("wgRelayRuntimeUnavailable");
      parent.appendChild(warn);
    }

    if (view.editing) {
      renderEditForm(parent);
      return;
    }

    parent.appendChild(renderProfilesList());

    if (view.selectedProfileId) {
      const p = findProfile(view.selectedProfileId);
      if (p) parent.appendChild(renderProfileDetail(p));
    }
  }

  function renderProfilesList() {
    const section = document.createElement("section");
    section.className = "section wg-relay-list";

    const header = document.createElement("div");
    header.className = "wg-relay-section-header";
    const headTitle = document.createElement("h2");
    headTitle.textContent = t("wgRelaySectionProfiles");
    header.appendChild(headTitle);

    const addBtn = document.createElement("button");
    addBtn.className = "soft-btn accent";
    addBtn.textContent = t("wgRelayAddProfile");
    addBtn.addEventListener("click", () => {
      view.editing = {
        id: uuid(),
        label: "",
        host: "",
        port: 22,
        authMethod: "key",
        identityFile: "",
        wgPort: 51820,
        wgSubnet: "10.8.0.0/24",
        _isNew: true,
      };
      ops.requestRender({ content: true });
    });
    header.appendChild(addBtn);
    section.appendChild(header);

    const profiles = listProfiles();
    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wg-relay-empty";
      empty.textContent = t("wgRelayEmpty");
      section.appendChild(empty);
      return section;
    }

    for (const p of profiles) {
      section.appendChild(renderProfileCard(p));
    }
    return section;
  }

  function renderProfileCard(profile) {
    const card = document.createElement("div");
    card.className = "wg-relay-card";
    if (view.selectedProfileId === profile.id) card.classList.add("selected");

    const meta = document.createElement("div");
    meta.className = "wg-relay-card-meta";
    const label = document.createElement("div");
    label.className = "wg-relay-card-label";
    label.textContent = profile.label;
    const hostRow = document.createElement("div");
    hostRow.className = "wg-relay-card-host";
    hostRow.textContent = profile.host + (profile.port && profile.port !== 22 ? `:${profile.port}` : "");
    meta.appendChild(label);
    meta.appendChild(hostRow);

    const status = statusForProfile(profile.id);
    const badge = document.createElement("span");
    badge.className = "wg-relay-status-badge " + statusBadgeClass(status.status);
    badge.textContent = statusLabel(status.status);

    const actions = document.createElement("div");
    actions.className = "wg-relay-card-actions";
    actions.appendChild(badge);

    card.appendChild(meta);
    card.appendChild(actions);
    card.addEventListener("click", () => {
      view.selectedProfileId = view.selectedProfileId === profile.id ? null : profile.id;
      ops.requestRender({ content: true });
    });
    return card;
  }

  function renderProfileDetail(profile) {
    const section = document.createElement("section");
    section.className = "section wg-relay-detail";

    const header = document.createElement("div");
    header.className = "wg-relay-section-header";
    const headTitle = document.createElement("h2");
    headTitle.textContent = profile.label;
    header.appendChild(headTitle);

    const editBtn = document.createElement("button");
    editBtn.className = "soft-btn";
    editBtn.textContent = t("wgRelayEdit");
    editBtn.addEventListener("click", () => {
      view.editing = { ...profile };
      ops.requestRender({ content: true });
    });
    header.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "soft-btn wg-relay-btn-danger";
    deleteBtn.textContent = t("wgRelayDelete");
    deleteBtn.addEventListener("click", () => {
      if (!confirm(t("wgRelayDeleteConfirm").replace("{label}", profile.label))) return;
      if (window.wgRelay && typeof window.wgRelay.tunnelDown === "function") {
        window.wgRelay.tunnelDown(profile.id);
      }
      callCommand("wgRelay.remove", profile.id).then((r) => {
        if (r && r.status === "ok") {
          if (view.selectedProfileId === profile.id) view.selectedProfileId = null;
          // Drop the deleted profile's memory-only buckets so a reused id
          // never inherits a stale password / readback / QR / log.
          view.passwords.delete(profile.id);
          view.readbacks.delete(profile.id);
          view.qrDataUrls.delete(profile.id);
          view.progressLog.delete(profile.id);
          view.deployingProfileIds.delete(profile.id);
          ops.requestRender({ content: true });
        }
      });
    });
    header.appendChild(deleteBtn);
    section.appendChild(header);

    // Status row
    const status = statusForProfile(profile.id);
    const statusRow = document.createElement("div");
    statusRow.className = "wg-relay-status-row";
    const statusBadge = document.createElement("span");
    statusBadge.className = "wg-relay-status-badge " + statusBadgeClass(status.status);
    statusBadge.textContent = statusLabel(status.status);
    statusRow.appendChild(statusBadge);
    const messageText = statusMessageText(status);
    if (messageText) {
      const msg = document.createElement("span");
      msg.className = "wg-relay-status-message";
      msg.textContent = messageText;
      if (status.message && status.message !== messageText) msg.title = status.message;
      statusRow.appendChild(msg);
    }
    section.appendChild(statusRow);

    // Password field — password auth only, held in memory (SEC-1). The value is
    // re-entered every launch; it is NEVER part of a saved profile.
    if (profile.authMethod === "password") {
      const pwField = document.createElement("div");
      pwField.className = "wg-relay-password-field";
      const pwLabel = document.createElement("label");
      pwLabel.className = "wg-relay-field-label";
      pwLabel.textContent = t("wgRelayFieldPassword");
      const pwInput = document.createElement("input");
      pwInput.type = "password";
      pwInput.autocomplete = "off";
      pwInput.placeholder = t("wgRelayFieldPasswordPlaceholder");
      pwInput.value = view.passwords.get(profile.id) || "";
      pwInput.addEventListener("input", () => {
        if (pwInput.value) view.passwords.set(profile.id, pwInput.value);
        else view.passwords.delete(profile.id);
      });
      pwField.appendChild(pwLabel);
      pwField.appendChild(pwInput);
      const pwWarn = document.createElement("div");
      pwWarn.className = "wg-relay-password-warn";
      pwWarn.textContent = t("wgRelayFieldPasswordHint");
      pwField.appendChild(pwWarn);
      section.appendChild(pwField);
    }

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "wg-relay-actions";

    const isDeploying = view.deployingProfileIds.has(profile.id);
    const deployBtn = document.createElement("button");
    deployBtn.className = "soft-btn accent";
    deployBtn.textContent = isDeploying ? t("wgRelayDeploying") : t("wgRelayDeploy");
    deployBtn.disabled = isDeploying || !window.wgRelay;
    deployBtn.addEventListener("click", () => runDeploy(profile, {}));
    actions.appendChild(deployBtn);

    // Tunnel up/down toggles the local (PC) side once a deploy readback exists.
    const tunnelUp = status.status === "connected" || status.status === "connecting" || status.status === "reconnecting";
    const tunnelBtn = document.createElement("button");
    tunnelBtn.className = "soft-btn";
    tunnelBtn.disabled = !window.wgRelay;
    if (tunnelUp) {
      tunnelBtn.textContent = t("wgRelayTunnelDown");
      tunnelBtn.addEventListener("click", () => {
        if (window.wgRelay && typeof window.wgRelay.tunnelDown === "function") {
          window.wgRelay.tunnelDown(profile.id);
        }
      });
    } else {
      tunnelBtn.textContent = t("wgRelayTunnelUp");
      tunnelBtn.addEventListener("click", () => {
        if (window.wgRelay && typeof window.wgRelay.tunnelUp === "function") {
          window.wgRelay.tunnelUp(profile.id);
        }
      });
    }
    actions.appendChild(tunnelBtn);

    // Regenerate the phone peer (new key + QR) without redeploying the server.
    const regenBtn = document.createElement("button");
    regenBtn.className = "soft-btn";
    regenBtn.textContent = t("wgRelayRegenPhone");
    regenBtn.disabled = !window.wgRelay;
    regenBtn.addEventListener("click", () => runDeploy(profile, { regenPhoneOnly: true }));
    actions.appendChild(regenBtn);

    section.appendChild(actions);

    // Progress log slice for this profile.
    const profileLog = view.progressLog.get(profile.id) || [];
    if (profileLog.length > 0) {
      const log = document.createElement("div");
      log.className = "wg-relay-progress-log";
      for (const ev of profileLog) {
        const line = document.createElement("div");
        line.className = "wg-relay-progress-line wg-relay-progress-" + ev.status;
        const stepLabel = t("wgRelayStep_" + ev.step) || ev.step;
        let detail = "";
        if (ev.hint) {
          const hintText = t(ev.hint);
          if (hintText && hintText !== ev.hint) detail = hintText;
        }
        if (!detail && ev.message) detail = ev.message;
        line.textContent = `[${ev.status}] ${stepLabel}` + (detail ? ` — ${detail}` : "");
        if (ev.message && detail !== ev.message) line.title = ev.message;
        log.appendChild(line);
      }
      section.appendChild(log);
    }

    // Readback (public endpoint + keys) and phone-join QR, if present.
    const readback = view.readbacks.get(profile.id);
    if (readback || profile.endpoint || profile.serverPubKey) {
      section.appendChild(renderReadback(profile, readback));
    }

    return section;
  }

  function renderReadback(profile, readback) {
    // Prefer the transient readback (freshest, includes phoneConf for the QR)
    // and fall back to the persisted public fields on the profile.
    const src = readback || {};
    const wrap = document.createElement("div");
    wrap.className = "wg-relay-readback";

    const title = document.createElement("div");
    title.className = "wg-relay-readback-title";
    title.textContent = t("wgRelayReadbackTitle");
    wrap.appendChild(title);

    const rows = [
      ["wgRelayEndpoint", src.endpoint || profile.endpoint],
      ["wgRelayServerPubKey", src.serverPubKey || profile.serverPubKey],
      ["wgRelayPcAddress", src.pcAddress || profile.pcAddress],
      ["wgRelayRelayAddr", src.relayAddr || profile.relayAddr],
    ];
    for (const [labelKey, value] of rows) {
      if (!value) continue;
      const row = document.createElement("div");
      row.className = "wg-relay-readback-row";
      const k = document.createElement("span");
      k.className = "wg-relay-readback-key";
      k.textContent = t(labelKey);
      const v = document.createElement("span");
      v.className = "wg-relay-readback-val";
      v.textContent = value;
      row.appendChild(k);
      row.appendChild(v);
      wrap.appendChild(row);
    }

    // Phone-join QR — drawn from the transient conf only (SEC-3). It is never
    // persisted, so it disappears on reload; the user re-deploys / regenerates
    // to get a fresh one.
    const qr = view.qrDataUrls.get(profile.id);
    if (qr) {
      const qrWrap = document.createElement("div");
      qrWrap.className = "wg-relay-qr";
      const qrTitle = document.createElement("div");
      qrTitle.className = "wg-relay-qr-title";
      qrTitle.textContent = t("wgRelayQrTitle");
      qrWrap.appendChild(qrTitle);
      const img = document.createElement("img");
      img.className = "wg-relay-qr-img";
      img.src = qr;
      img.alt = t("wgRelayQrTitle");
      qrWrap.appendChild(img);
      const hint = document.createElement("div");
      hint.className = "wg-relay-qr-hint";
      hint.textContent = t("wgRelayScanToJoin");
      qrWrap.appendChild(hint);
      wrap.appendChild(qrWrap);
    }

    return wrap;
  }

  // Drive a full deploy (or phone-only regen) over the runtime bridge, persist
  // ONLY the public readback fields, keep the phone conf transient, and render
  // a phone-join QR from that transient conf.
  function runDeploy(profile, opts) {
    if (!window.wgRelay || typeof window.wgRelay.deploy !== "function") {
      ops.showToast(t("wgRelayRuntimeUnavailable"), { error: true });
      return;
    }
    // Password auth requires the in-memory password (SEC-1) — never persisted,
    // so it must be present in this session before a deploy can run.
    const password = view.passwords.get(profile.id) || "";
    if (profile.authMethod === "password" && !password) {
      ops.showToast(t("wgRelayPasswordRequired"), { error: true });
      return;
    }

    view.deployingProfileIds.add(profile.id);
    view.progressLog.set(profile.id, []);
    ops.requestRender({ content: true });

    const req = {
      profileId: profile.id,
      regenPhoneOnly: !!(opts && opts.regenPhoneOnly),
    };
    // Password travels only in the IPC request payload, in memory — it is not
    // written to the profile or to disk.
    if (profile.authMethod === "password") req.password = password;

    window.wgRelay.deploy(req)
      .then((r) => {
        if (r && r.status === "ok" && r.readback) {
          // Hold the full readback (incl. phoneConf) transiently for QR/tunnel.
          view.readbacks.set(profile.id, r.readback);
          // Persist ONLY public fields via the whitelisted action (SEC-1/SEC-3).
          const persist = {
            serverPubKey: r.readback.serverPubKey,
            endpoint: r.readback.endpoint,
            pcAddress: r.readback.pcAddress,
            relayAddr: r.readback.relayAddr,
            deployedAt: r.readback.deployedAt || Date.now(),
          };
          callCommand("wgRelay.applyReadback", { profileId: profile.id, readback: persist });
          // Draw the phone-join QR from the transient conf only.
          const confText = r.readback.phoneConf || r.readback.phoneConfig || "";
          if (confText && window.settingsAPI && typeof window.settingsAPI.generateQr === "function") {
            window.settingsAPI.generateQr(confText).then((qr) => {
              if (qr && qr.dataUrl) {
                view.qrDataUrls.set(profile.id, qr.dataUrl);
                if (state.activeTab === "wg-relay") ops.requestRender({ content: true });
              }
            }).catch(() => {});
          }
          ops.showToast(t("wgRelayDeploySuccess"), { ttl: 8000 });
        } else {
          let toastMsg = null;
          if (r && r.hint) {
            const hintText = t(r.hint);
            if (hintText && hintText !== r.hint) toastMsg = hintText;
          }
          if (!toastMsg) toastMsg = (r && r.message) || t("wgRelayDeployFailed");
          ops.showToast(toastMsg, { error: true, ttl: 10000 });
        }
      })
      .catch((err) => {
        ops.showToast((err && err.message) || t("wgRelayDeployFailed"), { error: true });
      })
      .finally(() => {
        view.deployingProfileIds.delete(profile.id);
        ops.requestRender({ content: true });
      });
  }

  function renderEditForm(parent) {
    const section = document.createElement("section");
    section.className = "section wg-relay-edit";

    const isNew = view.editing._isNew === true;

    const headTitle = document.createElement("h2");
    headTitle.textContent = isNew ? t("wgRelayAddTitle") : t("wgRelayEditTitle");
    section.appendChild(headTitle);

    const formData = view.editing;

    function input(labelKey, key, attrs = {}) {
      const wrap = document.createElement("div");
      wrap.className = "wg-relay-field";
      const label = document.createElement("label");
      label.className = "wg-relay-field-label";
      label.textContent = t(labelKey);
      const inputEl = document.createElement("input");
      inputEl.type = attrs.type || "text";
      if (attrs.placeholder) inputEl.placeholder = attrs.placeholder;
      inputEl.value = formData[key] != null ? String(formData[key]) : "";
      inputEl.addEventListener("input", () => {
        if (attrs.type === "number") {
          const n = parseInt(inputEl.value, 10);
          formData[key] = Number.isFinite(n) ? n : null;
        } else {
          formData[key] = inputEl.value;
        }
      });
      wrap.appendChild(label);
      wrap.appendChild(inputEl);
      if (attrs.hint) {
        const hint = document.createElement("div");
        hint.className = "wg-relay-field-hint";
        hint.textContent = attrs.hint;
        wrap.appendChild(hint);
      }
      return wrap;
    }

    // Auth method toggle (key | password). Only the METHOD is stored; the
    // password itself is entered later in the detail panel and kept in memory
    // (SEC-1) — it is never part of the saved profile.
    function authToggle() {
      const wrap = document.createElement("div");
      wrap.className = "wg-relay-field wg-relay-auth-toggle";
      const label = document.createElement("label");
      label.className = "wg-relay-field-label";
      label.textContent = t("wgRelayFieldAuthMethod");
      const select = document.createElement("select");
      for (const [val, key] of [["key", "wgRelayAuthKey"], ["password", "wgRelayAuthPassword"]]) {
        const optEl = document.createElement("option");
        optEl.value = val;
        optEl.textContent = t(key);
        if ((formData.authMethod || "key") === val) optEl.selected = true;
        select.appendChild(optEl);
      }
      select.addEventListener("change", () => {
        formData.authMethod = select.value;
        ops.requestRender({ content: true });
      });
      wrap.appendChild(label);
      wrap.appendChild(select);
      return wrap;
    }

    section.appendChild(input("wgRelayFieldLabel", "label", { placeholder: "My VPS" }));
    section.appendChild(input("wgRelayFieldHost", "host", { placeholder: "root@203.0.113.10" }));
    section.appendChild(input("wgRelayFieldPort", "port", { type: "number", placeholder: "22" }));
    section.appendChild(authToggle());
    if ((formData.authMethod || "key") === "key") {
      section.appendChild(input("wgRelayFieldIdentityFile", "identityFile", {
        placeholder: "/home/me/.ssh/id_rsa",
        hint: t("wgRelayFieldIdentityFileHint"),
      }));
    }
    section.appendChild(input("wgRelayFieldWgPort", "wgPort", { type: "number", placeholder: "51820" }));
    section.appendChild(input("wgRelayFieldWgSubnet", "wgSubnet", {
      placeholder: "10.8.0.0/24",
      hint: t("wgRelayFieldWgSubnetHint"),
    }));

    // Submit / cancel
    const formActions = document.createElement("div");
    formActions.className = "wg-relay-form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "soft-btn";
    cancelBtn.textContent = t("wgRelayCancel");
    cancelBtn.addEventListener("click", () => {
      view.editing = null;
      ops.requestRender({ content: true });
    });
    formActions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = t("wgRelaySave");
    saveBtn.addEventListener("click", () => {
      const authMethod = formData.authMethod === "password" ? "password" : "key";
      // SEC-1: the payload NEVER carries a password — only authMethod is saved.
      const payload = {
        id: formData.id,
        label: (formData.label || "").trim(),
        host: (formData.host || "").trim(),
        authMethod,
        wgPort: Number.isFinite(formData.wgPort) ? formData.wgPort : 51820,
        wgSubnet: (formData.wgSubnet || "10.8.0.0/24").trim(),
        createdAt: formData.createdAt,
      };
      if (formData.port && formData.port !== 22) payload.port = formData.port;
      if (authMethod === "key" && formData.identityFile && formData.identityFile.trim()) {
        payload.identityFile = formData.identityFile.trim();
      }
      const action = isNew ? "wgRelay.add" : "wgRelay.update";
      callCommand(action, payload).then((r) => {
        if (r && r.status === "ok") {
          ops.showToast(t(isNew ? "wgRelayAddSuccess" : "wgRelayUpdateSuccess"));
          view.editing = null;
          if (isNew) view.selectedProfileId = payload.id;
          ops.requestRender({ content: true });
        }
      });
    });
    formActions.appendChild(saveBtn);

    section.appendChild(formActions);
    parent.appendChild(section);
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["wg-relay"] = { render };
  }

  root.ClawdSettingsTabWgRelay = { init };
})(globalThis);

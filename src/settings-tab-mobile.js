(function initSettingsTabMobile(root) {
  "use strict";

  var helpers, state, runtime, ops;
  var qrDataUrl = null;

  function t(key) { return helpers.t(key); }

  function init(core) {
    helpers = core.helpers;
    state = core.state;
    runtime = core.runtime;
    ops = core.ops;
    core.tabs["mobile"] = { render: render, patchInPlace: patchInPlace, onExit: onExit };
  }

  function render(parent) {
    // 标题
    var title = document.createElement("h1");
    title.textContent = t("mobileTitle");
    parent.appendChild(title);

    // Section 1: QR 码
    parent.appendChild(buildQrSection());

    // Section 2: 连接状态
    parent.appendChild(buildStatusSection());

    // Section 3: 设置
    parent.appendChild(buildSettingsSection());

    // 加载 QR 码和状态
    loadQrCode();
    loadStatus();
  }

  function buildQrSection() {
    var rows = [];

    // QR 码容器
    var qrRow = document.createElement("div");
    qrRow.className = "row";
    qrRow.style.flexDirection = "column";
    qrRow.style.alignItems = "center";
    qrRow.style.padding = "24px 16px";

    var qrContainer = document.createElement("div");
    qrContainer.id = "mobile-qr-container";
    qrContainer.style.cssText = "background:#fff;border-radius:12px;padding:16px;display:inline-block;margin-bottom:16px;";

    var qrImg = document.createElement("img");
    qrImg.id = "mobile-qr-image";
    qrImg.style.cssText = "display:block;width:200px;height:200px;";
    qrImg.alt = "QR Code";
    qrContainer.appendChild(qrImg);

    var info = document.createElement("div");
    info.id = "mobile-connection-info";
    info.style.cssText = "font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--text-secondary);text-align:center;word-break:break-all;max-width:280px;";
    info.textContent = t("mobileLoading");

    qrRow.appendChild(qrContainer);
    qrRow.appendChild(info);
    rows.push(qrRow);

    return helpers.buildSection(t("mobileQrSection"), rows);
  }

  function buildStatusSection() {
    var rows = [];

    // 状态行
    var statusRow = document.createElement("div");
    statusRow.className = "row";
    var statusText = document.createElement("div");
    statusText.className = "row-text";
    statusText.innerHTML = '<div class="row-label">' + helpers.escapeHtml(t("mobileWsStatus")) + '</div><div class="row-desc" id="mobile-ws-status">--</div>';
    statusRow.appendChild(statusText);
    rows.push(statusRow);

    // 设备数行
    var countRow = document.createElement("div");
    countRow.className = "row";
    var countText = document.createElement("div");
    countText.className = "row-text";
    countText.innerHTML = '<div class="row-label">' + helpers.escapeHtml(t("mobileConnectedDevices")) + '</div><div class="row-desc" id="mobile-device-count">0</div>';
    countRow.appendChild(countText);
    rows.push(countRow);

    // 设备列表
    var listRow = document.createElement("div");
    listRow.className = "row";
    listRow.style.flexDirection = "column";
    listRow.style.padding = "0";
    var deviceList = document.createElement("div");
    deviceList.id = "mobile-device-list";
    deviceList.style.cssText = "width:100%;max-height:200px;overflow-y:auto;";
    listRow.appendChild(deviceList);
    rows.push(listRow);

    // 连接历史
    var historyRow = document.createElement("div");
    historyRow.className = "row";
    historyRow.style.flexDirection = "column";
    historyRow.style.padding = "0";
    var historyList = document.createElement("div");
    historyList.id = "mobile-history-list";
    historyList.style.cssText = "width:100%;max-height:200px;overflow-y:auto;";
    historyRow.appendChild(historyList);
    rows.push(historyRow);

    return helpers.buildSection(t("mobileStatusSection"), rows);
  }

  function buildSettingsSection() {
    var rows = [];

    // 最大连接数
    var maxRow = document.createElement("div");
    maxRow.className = "row";
    var maxText = document.createElement("div");
    maxText.className = "row-text";
    maxText.innerHTML = '<div class="row-label">' + helpers.escapeHtml(t("mobileMaxClients")) + '</div><div class="row-desc">' + helpers.escapeHtml(t("mobileMaxClientsDesc")) + '</div>';
    var maxControl = document.createElement("div");
    maxControl.className = "row-control";
    var maxSlider = document.createElement("input");
    maxSlider.type = "range";
    maxSlider.min = "1";
    maxSlider.max = "10";
    maxSlider.value = String(state.mobileMaxClients || 10);
    maxSlider.style.width = "100px";
    var maxVal = document.createElement("span");
    maxVal.style.cssText = "font-size:12px;color:var(--text-secondary);margin-left:8px;min-width:20px;text-align:center;";
    maxVal.textContent = maxSlider.value;
    maxSlider.addEventListener("input", function() { maxVal.textContent = maxSlider.value; });
    maxSlider.addEventListener("change", function() { ops.update("mobileMaxClients", parseInt(maxSlider.value, 10)); });
    maxControl.appendChild(maxSlider);
    maxControl.appendChild(maxVal);
    maxRow.appendChild(maxText);
    maxRow.appendChild(maxControl);
    rows.push(maxRow);

    return helpers.buildSection(t("mobileSettingsSection"), rows);
  }

  // === QR 码加载 ===

  function loadQrCode() {
    if (!window.settingsAPI) return;
    var qrPromise = window.settingsAPI.mobileGetQrDataUrl ? window.settingsAPI.mobileGetQrDataUrl() : Promise.resolve(null);

    qrPromise.then(function(result) {
      var img = document.getElementById("mobile-qr-image");
      if (!img) return;
      if (result && result.dataUrl) {
        img.src = result.dataUrl;
      } else {
        showQrFallback();
      }
    }).catch(function() {
      showQrFallback();
    });
  }

  // === 状态加载 ===

  function loadStatus() {
    if (!window.settingsAPI || !window.settingsAPI.mobileGetStatus) return;
    window.settingsAPI.mobileGetStatus().then(function(status) {
      if (!status) return;

      // 更新连接信息
      var info = document.getElementById("mobile-connection-info");
      if (info && status.ip && status.port) {
        info.innerHTML = helpers.escapeHtml(status.ip) + ":" + helpers.escapeHtml(String(status.port));
      }

      // 更新状态
      updateStatusDisplay(status);
    }).catch(function() {});
  }

  function updateStatusDisplay(status) {
    var statusEl = document.getElementById("mobile-ws-status");
    if (statusEl) {
      statusEl.textContent = status.enabled ? (status.clients && status.clients.length > 0 ? "Connected" : "Listening") : "Disabled";
    }

    var countEl = document.getElementById("mobile-device-count");
    if (countEl) {
      countEl.textContent = status.clients ? status.clients.length : 0;
    }

    var listEl = document.getElementById("mobile-device-list");
    if (listEl && status.clients) {
      renderDeviceList(listEl, status.clients);
    }

    var historyEl = document.getElementById("mobile-history-list");
    if (historyEl && status.connectionHistory && status.connectionHistory.length > 0) {
      renderHistoryList(historyEl, status.connectionHistory);
    }
  }

  function renderDeviceList(listEl, clients) {
    if (clients.length === 0) {
      listEl.innerHTML = '<div style="padding:12px 16px;color:var(--text-tertiary);font-size:12px;text-align:center;">No devices connected</div>';
      return;
    }
    listEl.innerHTML = clients.map(function(c) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid var(--row-border);font-size:12px;">' +
        '<span>' + helpers.escapeHtml(c.ip || "--") + '</span>' +
        '<span style="color:var(--text-tertiary)">' + formatTime(c.connectedAt) + '</span>' +
        '<button class="soft-btn" onclick="window.settingsAPI.mobileDisconnectClient(\'' + helpers.escapeHtml(c.id) + '\')">' + helpers.escapeHtml(t("mobileDisconnect")) + '</button>' +
        '</div>';
    }).join("");
  }

  function renderHistoryList(historyEl, history) {
    // Show last 10 unique devices
    var seen = {};
    var unique = [];
    for (var i = history.length - 1; i >= 0 && unique.length < 10; i--) {
      var h = history[i];
      var key = h.ip;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(h);
      }
    }
    if (unique.length === 0) return;

    var header = '<div style="padding:8px 16px;font-size:11px;color:var(--text-tertiary);border-bottom:1px solid var(--row-border);">Recent devices</div>';
    historyEl.innerHTML = header + unique.map(function(h) {
      return '<div style="display:flex;justify-content:space-between;padding:6px 16px;font-size:11px;color:var(--text-tertiary);">' +
        '<span>' + helpers.escapeHtml(h.ip || "--") + '</span>' +
        '<span>' + formatTime(h.connectedAt) + '</span>' +
        '</div>';
    }).join("");
  }

  function showQrFallback() {
    var img = document.getElementById("mobile-qr-image");
    if (img) img.style.display = "none";
    var container = document.getElementById("mobile-qr-container");
    if (container) {
      container.style.cssText = "background:var(--bg);border-radius:12px;padding:24px;text-align:center;font-family:monospace;font-size:11px;word-break:break-all;max-width:240px;";
      container.textContent = "QR code unavailable";
    }
  }

  // === 状态更新 (from settings-changed broadcast) ===

  function patchInPlace(changes) {
    // 更新连接状态
    var statusEl = document.getElementById("mobile-ws-status");
    if (statusEl && changes.mobileStatus) {
      statusEl.textContent = changes.mobileStatus;
    }
    // 更新设备列表
    var countEl = document.getElementById("mobile-device-count");
    var listEl = document.getElementById("mobile-device-list");
    if (changes.mobileClients && countEl && listEl) {
      var clients = changes.mobileClients;
      countEl.textContent = clients.length;
      renderDeviceList(listEl, clients);
    }
    return false;
  }

  function onExit() {}

  function formatTime(ts) {
    if (!ts) return "--";
    var d = new Date(ts);
    return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  }

  root.ClawdSettingsTabMobile = { init: init };
})(globalThis);

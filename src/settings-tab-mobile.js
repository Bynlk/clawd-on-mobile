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

    // 加载 QR 码
    loadQrCode();
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

    // 按钮行
    var btnRow = document.createElement("div");
    btnRow.className = "row";
    btnRow.style.justifyContent = "center";
    btnRow.style.gap = "12px";
    btnRow.style.padding = "12px 16px";

    var copyBtn = document.createElement("button");
    copyBtn.className = "soft-btn";
    copyBtn.textContent = t("mobileCopyInfo");
    copyBtn.addEventListener("click", copyConnectionInfo);

    var refreshBtn = document.createElement("button");
    refreshBtn.className = "soft-btn accent";
    refreshBtn.textContent = t("mobileRefreshToken");
    refreshBtn.addEventListener("click", refreshToken);

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(refreshBtn);
    rows.push(btnRow);

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

    return helpers.buildSection(t("mobileStatusSection"), rows);
  }

  function buildSettingsSection() {
    var rows = [];

    // 移动端连接开关
    rows.push(helpers.buildSwitchRow(
      t("mobileEnabled"),
      t("mobileEnabledDesc"),
      function() { return state.mobileEnabled !== false; },
      function(val) { ops.update("mobileEnabled", val); }
    ));

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

    // 远程审批开关（已移除 — permission.js 自动根据移动端连接状态路由）

    return helpers.buildSection(t("mobileSettingsSection"), rows);
  }

  // === QR 码加载 ===

  function loadQrCode() {
    // 通过 IPC 获取配对信息
    if (window.settingsAPI && window.settingsAPI.mobileGetStatus) {
      window.settingsAPI.mobileGetStatus().then(function(status) {
        if (!status) return;
        var info = document.getElementById("mobile-connection-info");
        if (info && status.ip && status.port) {
          info.innerHTML = helpers.escapeHtml(status.ip) + ":" + helpers.escapeHtml(String(status.port)) + '<br>Token: <span style="color:var(--accent)">' + helpers.escapeHtml(status.token || "") + "</span>";
        }
        // 生成 QR 码（用服务端已有的 /mobile/pair 页面的 QR 图片）
        generateQrDataUrl("clawd://" + (status.ip || "") + ":" + (status.port || "") + "/" + (status.token || ""), status.port);
      }).catch(function() {});
    }
  }

  function generateQrDataUrl(text, port) {
    // 简单 QR 生成（如果 qrcode 库可用）或显示占位
    var img = document.getElementById("mobile-qr-image");
    if (!img) return;
    // Electron 用 file:// 协议加载设置页，必须用完整 HTTP URL
    img.src = "http://127.0.0.1:" + (port || 23333) + "/mobile/qr?v=" + Date.now();
    img.onerror = function() {
      // 降级：显示文字
      img.style.display = "none";
      var container = document.getElementById("mobile-qr-container");
      if (container) {
        container.style.cssText = "background:var(--bg);border-radius:12px;padding:24px;text-align:center;font-family:monospace;font-size:11px;word-break:break-all;max-width:240px;";
        container.textContent = text;
      }
    };
  }

  function copyConnectionInfo() {
    if (window.settingsAPI && window.settingsAPI.mobileGetStatus) {
      window.settingsAPI.mobileGetStatus().then(function(status) {
        if (!status) return;
        var text = "clawd://" + (status.ip || "") + ":" + (status.port || "") + "/" + (status.token || "");
        navigator.clipboard.writeText(text).then(function() {
          showToast(t("mobileCopied"));
        });
      });
    }
  }

  function refreshToken() {
    if (window.settingsAPI && window.settingsAPI.mobileRefreshToken) {
      window.settingsAPI.mobileRefreshToken().then(function() {
        loadQrCode();
        showToast(t("mobileTokenRefreshed"));
      });
    }
  }

  // === 状态更新 ===

  function patchInPlace(changes, ctx) {
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
      listEl.innerHTML = clients.map(function(c) {
        return '<div style="display:flex;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--row-border);font-size:12px;">' +
          '<span>' + helpers.escapeHtml(c.ip || "--") + '</span>' +
          '<span style="color:var(--text-tertiary)">' + formatTime(c.connectedAt) + '</span>' +
          '<button class="soft-btn" onclick="window.settingsAPI.mobileDisconnectClient(\'' + helpers.escapeHtml(c.id) + '\')">' + helpers.escapeHtml(t("mobileDisconnect")) + '</button>' +
          '</div>';
      }).join("");
    }
    return false; // 不阻止默认渲染
  }

  function onExit() {}

  function formatTime(ts) {
    if (!ts) return "--";
    var d = new Date(ts);
    return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  }

  function showToast(msg) {
    if (helpers.showToast) helpers.showToast(msg);
  }

  root.ClawdSettingsTabMobile = { init: init };
})(globalThis);

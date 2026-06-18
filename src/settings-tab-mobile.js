"use strict";

(function initSettingsTabMobile(root) {
  const RETRY_MS = 500;
  const MAX_RETRIES = 20;

  let runtime = null;
  let helpers = null;
  let state = null;
  let infoContainer = null;
  let qrImg = null;
  let pwaSection = null;

  function t(key) { return helpers.t(key); }
  function esc(str) { return helpers.escapeHtml(str); }

  function fetchInfo() {
    if (!window.settingsAPI || typeof window.settingsAPI.getMobileConnectionInfo !== "function") return Promise.resolve(null);
    return window.settingsAPI.getMobileConnectionInfo().catch(() => null);
  }

  function isReady(info) {
    return !!(info && info.status === "ok" && Number.isInteger(info.port) && info.port > 0 && typeof info.token === "string" && info.token && typeof info.lanIp === "string" && info.lanIp);
  }

  function formatTime(ts) {
    if (!ts) return "--";
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return "刚刚";
    if (sec < 60) return sec + "秒前";
    if (sec < 3600) return Math.floor(sec / 60) + "分钟前";
    return Math.floor(sec / 3600) + "小时前";
  }

  // ── Section 1: Android QR Code ──

  function renderQrSection(container, info) {
    container.innerHTML = "";
    if (!info) return;

    const box = document.createElement("div");
    box.className = "mobile-section mobile-qr-section";

    const label = document.createElement("div");
    label.className = "mobile-section-label";
    label.textContent = t("mobileQrTitle") || "Android 扫码连接";
    box.appendChild(label);

    // QR image (hidden until data URL is ready)
    const qrWrap = document.createElement("div");
    qrWrap.className = "mobile-qr-wrap";
    qrImg = document.createElement("img");
    qrImg.className = "mobile-qr-img";
    qrImg.alt = "QR Code";
    qrImg.style.display = "none";
    qrWrap.appendChild(qrImg);
    box.appendChild(qrWrap);

    // clawd:// URL
    const urlRow = document.createElement("div");
    urlRow.className = "mobile-conn-row";
    const urlValue = document.createElement("span");
    urlValue.className = "mobile-conn-value mobile-mono";
    urlValue.textContent = info.pairUrl || "";
    urlRow.appendChild(urlValue);
    const copyBtn = document.createElement("button");
    copyBtn.className = "mobile-copy-btn";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", () => copyText(info.pairUrl, copyBtn));
    urlRow.appendChild(copyBtn);
    box.appendChild(urlRow);

    container.appendChild(box);

    // Generate QR code via IPC
    generateQr(info.pairUrl);
  }

  function generateQr(text) {
    if (!qrImg || !text) return;
    if (!window.settingsAPI || typeof window.settingsAPI.generateQr !== "function") {
      console.error("[QR] settingsAPI.generateQr not available");
      return;
    }
    window.settingsAPI.generateQr(text).then((res) => {
      if (res && res.dataUrl && qrImg) {
        qrImg.src = res.dataUrl;
        qrImg.style.display = "";
      } else {
        console.error("[QR] generateQr failed:", res && res.error ? res.error : JSON.stringify(res));
      }
    }).catch((err) => {
      console.error("[QR] generateQr exception:", err);
    });
  }

  // ── Section 2: PWA Toggle ──

  function renderPwaSection(container, info) {
    container.innerHTML = "";
    const box = document.createElement("div");
    box.className = "mobile-section";

    const label = document.createElement("div");
    label.className = "mobile-section-label";
    label.textContent = t("mobilePwaToggle") || "PWA 网页版";
    box.appendChild(label);

    const desc = document.createElement("div");
    desc.className = "mobile-section-desc";
    desc.textContent = t("mobilePwaToggleDesc") || "启用后可在浏览器中打开移动端界面（iPhone / 非 Android 设备）";
    box.appendChild(desc);

    // PWA link (always show if info available)
    if (info && info.pwaUrl) {
      const linkRow = document.createElement("div");
      linkRow.className = "mobile-conn-row";
      const linkLabel = document.createElement("span");
      linkLabel.className = "mobile-conn-label";
      linkLabel.textContent = "链接";
      linkRow.appendChild(linkLabel);
      const linkValue = document.createElement("span");
      linkValue.className = "mobile-conn-value mobile-mono mobile-pwa-url";
      linkValue.textContent = info.pwaUrl;
      linkRow.appendChild(linkValue);
      const copyBtn = document.createElement("button");
      copyBtn.className = "mobile-copy-btn";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", () => copyText(info.pwaUrl, copyBtn));
      linkRow.appendChild(copyBtn);
      box.appendChild(linkRow);
    }

    container.appendChild(box);
  }

  // ── Section 3: Connection Info + Device List ──

  function renderInfoSection(container, info, attempt) {
    container.innerHTML = "";
    if (!info) {
      container.innerHTML = '<p class="mobile-info-loading">' + esc(t("mobileLoading") || "加载中…") + '</p>';
      return;
    }
    if (!isReady(info)) {
      if (attempt < MAX_RETRIES && info && (info.status === "starting" || info.status === "ok")) {
        setTimeout(() => { if (container.parentNode) renderInfoSection(container, null, attempt + 1); }, RETRY_MS);
        return;
      }
      container.innerHTML = '<p class="mobile-info-error">' + esc(t("mobileError") || "无法加载连接信息。") + '</p>';
      return;
    }

    const box = document.createElement("div");
    box.className = "mobile-section";

    const label = document.createElement("div");
    label.className = "mobile-section-label";
    label.textContent = t("mobileConnInfo") || "连接信息";
    box.appendChild(label);

    // Address row
    box.appendChild(makeConnRow("地址", info.lanIp + ":" + info.port, info.lanIp + ":" + info.port));

    // Token row
    box.appendChild(makeConnRow("Token", info.token, info.token));

    // Status row
    const statusRow = document.createElement("div");
    statusRow.className = "mobile-conn-row";
    const statusLabel = document.createElement("span");
    statusLabel.className = "mobile-conn-label";
    statusLabel.textContent = "状态";
    statusRow.appendChild(statusLabel);
    const statusDot = document.createElement("span");
    statusDot.className = "mobile-status-dot";
    const clientCount = (info.clients && info.clients.length) || 0;
    statusDot.style.background = clientCount > 0 ? "#22c55e" : "#52525b";
    statusRow.appendChild(statusDot);
    const statusText = document.createElement("span");
    statusText.className = "mobile-conn-value";
    statusText.textContent = clientCount > 0
      ? "已连接 (" + clientCount + " 台设备)"
      : "等待连接";
    statusRow.appendChild(statusText);
    box.appendChild(statusRow);

    // Device list
    if (info.clients && info.clients.length > 0) {
      const devLabel = document.createElement("div");
      devLabel.className = "mobile-section-label mobile-devices-label";
      devLabel.textContent = t("mobileDevices") || "已连接设备";
      box.appendChild(devLabel);

      for (const c of info.clients) {
        const devRow = document.createElement("div");
        devRow.className = "mobile-device-row";
        const icon = document.createElement("span");
        icon.className = "mobile-device-icon";
        icon.textContent = "📱";
        devRow.appendChild(icon);
        const name = document.createElement("span");
        name.className = "mobile-device-name";
        name.textContent = c.id ? c.id.slice(0, 8) : "unknown";
        devRow.appendChild(name);
        const ip = document.createElement("span");
        ip.className = "mobile-device-ip";
        ip.textContent = c.ip || "--";
        devRow.appendChild(ip);
        const time = document.createElement("span");
        time.className = "mobile-device-time";
        time.textContent = formatTime(c.connectedAt);
        devRow.appendChild(time);
        box.appendChild(devRow);
      }
    }

    container.appendChild(box);
  }

  function makeConnRow(label, displayValue, copyValue) {
    const row = document.createElement("div");
    row.className = "mobile-conn-row";
    const lbl = document.createElement("span");
    lbl.className = "mobile-conn-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    const val = document.createElement("span");
    val.className = "mobile-conn-value mobile-mono";
    val.textContent = displayValue;
    row.appendChild(val);
    const btn = document.createElement("button");
    btn.className = "mobile-copy-btn";
    btn.textContent = "复制";
    btn.addEventListener("click", () => copyText(copyValue, btn));
    row.appendChild(btn);
    return row;
  }

  function copyText(text, btn) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    }
  }

  // ── Main render ──

  // ── Section 4: Remote Relay ──

  function renderRelaySection(container, core) {
    const box = document.createElement("div");
    box.className = "mobile-section mobile-relay-section";

    const label = document.createElement("div");
    label.className = "mobile-section-label";
    label.textContent = t("relayTitle") || "Remote Relay（远程中继）";
    box.appendChild(label);

    const desc = document.createElement("div");
    desc.className = "mobile-section-desc";
    desc.textContent = t("relayDesc") || "通过远程服务器中继连接，支持非局域网环境。";
    box.appendChild(desc);

    // 从 snapshot 读取当前值
    const snapshot = core.state?.snapshot || {};
    const currentUrl = snapshot.relayUrl || "";
    const currentToken = snapshot.relayToken || "";
    const isEnabled = snapshot.relayEnabled || false;

    // Relay URL input
    const urlRow = document.createElement("div");
    urlRow.className = "settings-row";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = t("relayUrl") || "Relay URL";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "wss://your-vps-ip:7891";
    urlInput.value = currentUrl;
    urlInput.className = "settings-input";
    urlRow.appendChild(urlLabel);
    urlRow.appendChild(urlInput);
    box.appendChild(urlRow);

    // Admin Token input
    const tokenRow = document.createElement("div");
    tokenRow.className = "settings-row";
    const tokenLabel = document.createElement("label");
    tokenLabel.textContent = t("relayToken") || "Connection Token";
    const tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.placeholder = "输入 Admin Token";
    tokenInput.value = currentToken;
    tokenInput.className = "settings-input";
    tokenRow.appendChild(tokenLabel);
    tokenRow.appendChild(tokenInput);
    box.appendChild(tokenRow);

    // Enable toggle + status
    const actionRow = document.createElement("div");
    actionRow.className = "settings-row";

    const enableBtn = document.createElement("button");
    enableBtn.className = "settings-btn";
    enableBtn.textContent = isEnabled
      ? (t("relayDisable") || "断开 Relay")
      : (t("relayEnable") || "连接 Relay");
    enableBtn.onclick = () => {
      const currentlyEnabled = state?.snapshot?.relayEnabled || false;
      if (!currentlyEnabled) {
        // 保存配置并启用
        window.settingsAPI.update("relayUrl", urlInput.value.trim());
        window.settingsAPI.update("relayToken", tokenInput.value.trim());
        window.settingsAPI.update("relayEnabled", true);
        enableBtn.textContent = t("relayDisable") || "断开 Relay";
      } else {
        window.settingsAPI.update("relayEnabled", false);
        enableBtn.textContent = t("relayEnable") || "连接 Relay";
      }
    };
    actionRow.appendChild(enableBtn);

    // Status indicator
    const statusSpan = document.createElement("span");
    statusSpan.className = "relay-status";
    statusSpan.textContent = isEnabled
      ? (t("relayStatusConnected") || "已启用")
      : (t("relayStatusDisconnected") || "未连接");
    actionRow.appendChild(statusSpan);

    box.appendChild(actionRow);

    // API status button
    const apiRow = document.createElement("div");
    apiRow.className = "settings-row";
    const apiBtn = document.createElement("button");
    apiBtn.className = "settings-btn settings-btn-secondary";
    apiBtn.textContent = t("relayCheckStatus") || "检查 Relay 状态";
    apiBtn.onclick = () => {
      const url = urlInput.value.trim();
      const token = tokenInput.value.trim();
      if (!url) return;
      fetch(`${url}/api/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then((r) => r.json())
        .then((data) => {
          statusSpan.textContent = `运行中 | 在线: ${data.connections?.pc || 0} PC, ${data.connections?.phone || 0} Phone`;
          statusSpan.style.color = "#4CAF50";
        })
        .catch(() => {
          statusSpan.textContent = "无法连接";
          statusSpan.style.color = "#F44336";
        });
    };
    apiRow.appendChild(apiBtn);
    box.appendChild(apiRow);

    container.appendChild(box);
  }

  function renderMobileTab(container, core) {
    runtime = core.runtime;
    helpers = core.helpers;
    state = core.state;

    const section = document.createElement("div");
    section.className = "settings-tab-section";

    // Title
    const title = document.createElement("h3");
    title.textContent = t("mobileTitle") || "移动端";
    section.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "settings-tab-desc";
    desc.textContent = t("mobileDesc") || "连接手机监控会话状态，支持远程审批。";
    section.appendChild(desc);

    // Section 1: QR
    const qrContainer = document.createElement("div");
    qrContainer.id = "mobile-qr-section";
    section.appendChild(qrContainer);

    // Section 2: PWA
    pwaSection = document.createElement("div");
    pwaSection.id = "mobile-pwa-section";
    section.appendChild(pwaSection);

    // Section 3: Connection info
    infoContainer = document.createElement("div");
    infoContainer.id = "mobile-connection-info";
    section.appendChild(infoContainer);

    // Section 4: Remote Relay
    const relayContainer = document.createElement("div");
    relayContainer.id = "mobile-relay-section";
    section.appendChild(relayContainer);
    renderRelaySection(relayContainer, core);

    container.appendChild(section);

    // Load info and render all sections
    loadAndRender(qrContainer, pwaSection, infoContainer);

    // Periodically refresh device list and QR code (if not yet rendered)
    setInterval(() => {
      if (!infoContainer || !infoContainer.parentNode) return;
      fetchInfo().then((info) => {
        renderInfoSection(infoContainer, info, 0);
        // Re-render QR if it was cleared (server started late)
        if (isReady(info) && qrContainer.childElementCount === 0) {
          renderQrSection(qrContainer, info);
        }
      });
    }, 5000);
  }

  function loadAndRender(qrContainer, pwaContainer, infoContainer, attempt) {
    attempt = attempt || 0;
    fetchInfo().then((info) => {
      if (isReady(info)) {
        renderQrSection(qrContainer, info);
        renderPwaSection(pwaContainer, info);
        renderInfoSection(infoContainer, info, 0);
      } else if (attempt < MAX_RETRIES) {
        setTimeout(() => loadAndRender(qrContainer, pwaContainer, infoContainer, attempt + 1), RETRY_MS);
      } else {
        qrContainer.innerHTML = "";
        renderPwaSection(pwaContainer, null);
        renderInfoSection(infoContainer, null, 0);
      }
    });
  }

  function init(core) {
    runtime = core.runtime;
    helpers = core.helpers;
    core.tabs["mobile"] = { render: renderMobileTab };
  }

  root.ClawdSettingsTabMobile = { init };
})(globalThis);

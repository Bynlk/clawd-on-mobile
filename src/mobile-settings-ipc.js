"use strict";

const os = require("os");

function getLanIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) candidates.push({ name, address: addr.address });
    }
  }
  const isLan = c =>
    /^192\.168\./.test(c.address) ||
    /^10\./.test(c.address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(c.address);
  const isVirtual = c =>
    /vmware|vmnet|vethernet|wsl|docker|loopback/i.test(c.name);
  const physical = candidates.filter(c => !isVirtual(c) && isLan(c));
  if (physical.length > 0) return physical[0].address;
  const lan = candidates.find(c => isLan(c));
  return lan ? lan.address : (candidates[0] ? candidates[0].address : "127.0.0.1");
}

function registerMobileSettingsIpc(options = {}) {
  const ipcMain = options.ipcMain;
  const getMobileWS = options.getMobileWS || (() => null);
  const getMobileToken = options.getMobileToken || (() => null);
  const sendToRenderer = options.sendToRenderer || (() => {});
  const QRCode = options.QRCode || null;
  const disposers = options._disposers || [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  handle("settings:mobile-status", () => {
    const mobileWS = getMobileWS();
    if (!mobileWS) return { enabled: false, token: null, ip: null, port: null, clients: [] };
    return {
      enabled: true,
      token: getMobileToken() || null,
      ip: getLanIP(),
      port: 23334,
      clients: mobileWS.getClientInfoList ? mobileWS.getClientInfoList() : [],
      connectionHistory: mobileWS.getConnectionHistory ? mobileWS.getConnectionHistory() : [],
    };
  });

  handle("settings:mobile-refresh-token", () => {
    return { token: getMobileToken() };
  });

  handle("settings:mobile-qr-data-url", async () => {
    if (!QRCode) return { dataUrl: null, error: "QRCode library unavailable" };
    const port = 23334;
    const token = getMobileToken();
    if (!port || !token) return { dataUrl: null, error: "mobile server not ready" };
    const ip = getLanIP();
    const pairUrl = `clawd://${ip}:${port}/${token}`;
    try {
      const dataUrl = await QRCode.toDataURL(pairUrl, {
        width: 300,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      return { dataUrl };
    } catch (err) {
      return { dataUrl: null, error: err && err.message };
    }
  });

  handle("settings:mobile-disconnect-client", (_event, payload) => {
    const mobileWS = getMobileWS();
    if (mobileWS && payload && payload.clientId) {
      mobileWS.disconnectClient(payload.clientId);
    }
    return { ok: true };
  });

  // Auto-refresh: notify settings window when mobile clients change
  const mobileWSRef = getMobileWS();
  if (mobileWSRef && typeof mobileWSRef.on === "function") {
    const onClientChange = () => {
      const clients = mobileWSRef.getClientInfoList ? mobileWSRef.getClientInfoList() : [];
      sendToRenderer("mobile:clients-updated", clients);
    };
    mobileWSRef.on("client-connected", onClientChange);
    mobileWSRef.on("client-disconnected", onClientChange);
    disposers.push(() => {
      mobileWSRef.off("client-connected", onClientChange);
      mobileWSRef.off("client-disconnected", onClientChange);
    });
  }

  // Mobile connection info — uses hardcoded port + getLanIP to avoid async init race
  handle("settings:mobile-connection-info", async () => {
    try {
      const port = 23334;
      const tok = getMobileToken();
      if (!tok) return { status: "error", message: "Mobile token not available" };
      const lanIp = getLanIP();
      const pairUrl = `clawd://${lanIp}:${port}/${tok}`;
      const pwaUrl = `http://${lanIp}:${port}/mobile/?token=${tok}`;
      const mobileWS = getMobileWS();
      const clients = mobileWS && mobileWS.getClientInfoList ? mobileWS.getClientInfoList() : [];
      return { status: "ok", port, token: tok, lanIp, pairUrl, pwaUrl, clients };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  // QR code generation
  handle("settings:generate-qr", async (_event, text) => {
    try {
      if (typeof text !== "string" || !text) return { error: "text is " + typeof text };
      const qr = QRCode || require("qrcode");
      if (!qr) return { error: "QRCode library not loaded" };
      const result = await qr.toDataURL(text, { width: 200, margin: 2, color: { dark: "#000000", light: "#ffffff" } });
      return { dataUrl: result };
    } catch (err) {
      return { error: err && err.message };
    }
  });
}

module.exports = {
  registerMobileSettingsIpc,
};

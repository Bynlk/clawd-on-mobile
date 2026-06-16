"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { registerMobileSettingsIpc } = require("../src/mobile-settings-ipc");

// ── Helpers ──

function makeMockIpcMain() {
  const handlers = {};
  return {
    handle(channel, listener) { handlers[channel] = listener; },
    removeHandler(channel) { delete handlers[channel]; },
    handlers,
  };
}

function makeMockMobileWS(opts = {}) {
  return {
    getClientInfoList: () => opts.clients || [],
    getConnectionHistory: () => opts.history || [],
    disconnectClient: opts.disconnectClient || (() => {}),
    on: opts.on || (() => {}),
    off: opts.off || (() => {}),
  };
}

// ── Tests ──

describe("mobile-settings-ipc", () => {

  describe("registerMobileSettingsIpc", () => {
    it("registers all expected IPC handlers", () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain });
      const expected = [
        "settings:mobile-status",
        "settings:mobile-refresh-token",
        "settings:mobile-qr-data-url",
        "settings:mobile-disconnect-client",
        "settings:mobile-connection-info",
        "settings:generate-qr",
      ];
      for (const ch of expected) {
        assert.ok(ipcMain.handlers[ch], `missing handler for ${ch}`);
      }
    });
  });

  describe("settings:mobile-status", () => {
    it("returns disabled when no mobileWS", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain, getMobileWS: () => null });
      const result = await ipcMain.handlers["settings:mobile-status"]();
      assert.equal(result.enabled, false);
      assert.equal(result.token, null);
      assert.deepEqual(result.clients, []);
    });

    it("returns enabled with client info", async () => {
      const ipcMain = makeMockIpcMain();
      const clients = [{ id: "c1", ip: "1.1.1.1", connectedAt: 100 }];
      registerMobileSettingsIpc({
        ipcMain,
        getMobileWS: () => makeMockMobileWS({ clients }),
        getMobileToken: () => "abc123",
      });
      const result = await ipcMain.handlers["settings:mobile-status"]();
      assert.equal(result.enabled, true);
      assert.equal(result.token, "abc123");
      assert.equal(result.port, 23334);
      assert.deepEqual(result.clients, clients);
    });
  });

  describe("settings:mobile-refresh-token", () => {
    it("returns token", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain, getMobileToken: () => "mytoken" });
      const result = await ipcMain.handlers["settings:mobile-refresh-token"]();
      assert.equal(result.token, "mytoken");
    });
  });

  describe("settings:mobile-qr-data-url", () => {
    it("returns error when QRCode unavailable", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain, QRCode: null });
      const result = await ipcMain.handlers["settings:mobile-qr-data-url"]();
      assert.equal(result.dataUrl, null);
      assert.ok(result.error);
    });

    it("returns error when token missing", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain, getMobileToken: () => null, QRCode: {} });
      const result = await ipcMain.handlers["settings:mobile-qr-data-url"]();
      assert.equal(result.dataUrl, null);
      assert.ok(result.error);
    });

    it("generates QR code", async () => {
      const ipcMain = makeMockIpcMain();
      const QRCode = {
        toDataURL: async () => "data:image/png;base64,abc",
      };
      registerMobileSettingsIpc({ ipcMain, getMobileToken: () => "tok123", QRCode });
      const result = await ipcMain.handlers["settings:mobile-qr-data-url"]();
      assert.equal(result.dataUrl, "data:image/png;base64,abc");
    });

    it("handles QRCode error", async () => {
      const ipcMain = makeMockIpcMain();
      const QRCode = {
        toDataURL: async () => { throw new Error("qr fail"); },
      };
      registerMobileSettingsIpc({ ipcMain, getMobileToken: () => "tok123", QRCode });
      const result = await ipcMain.handlers["settings:mobile-qr-data-url"]();
      assert.equal(result.dataUrl, null);
      assert.ok(result.error.includes("qr fail"));
    });
  });

  describe("settings:mobile-disconnect-client", () => {
    it("disconnects client", async () => {
      const ipcMain = makeMockIpcMain();
      let disconnectedId = null;
      registerMobileSettingsIpc({
        ipcMain,
        getMobileWS: () => makeMockMobileWS({ disconnectClient: (id) => { disconnectedId = id; } }),
      });
      const result = await ipcMain.handlers["settings:mobile-disconnect-client"](null, { clientId: "c1" });
      assert.deepEqual(result, { ok: true });
      assert.equal(disconnectedId, "c1");
    });

    it("returns ok when no mobileWS", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain, getMobileWS: () => null });
      const result = await ipcMain.handlers["settings:mobile-disconnect-client"](null, { clientId: "c1" });
      assert.deepEqual(result, { ok: true });
    });
  });

  describe("settings:mobile-connection-info", () => {
    it("returns error when no token", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain, getMobileToken: () => null });
      const result = await ipcMain.handlers["settings:mobile-connection-info"]();
      assert.equal(result.status, "error");
    });

    it("returns connection info", async () => {
      const ipcMain = makeMockIpcMain();
      const clients = [{ id: "c1" }];
      registerMobileSettingsIpc({
        ipcMain,
        getMobileToken: () => "tok",
        getMobileWS: () => makeMockMobileWS({ clients }),
      });
      const result = await ipcMain.handlers["settings:mobile-connection-info"]();
      assert.equal(result.status, "ok");
      assert.equal(result.token, "tok");
      assert.equal(result.port, 23334);
      assert.ok(result.pairUrl.startsWith("clawd://"));
      assert.ok(result.pwaUrl.includes("/mobile/?token=tok"));
      assert.deepEqual(result.clients, clients);
    });
  });

  describe("settings:generate-qr", () => {
    it("returns error for non-string input", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain });
      const result = await ipcMain.handlers["settings:generate-qr"](null, 123);
      assert.ok(result.error);
    });

    it("returns error for empty string", async () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({ ipcMain });
      const result = await ipcMain.handlers["settings:generate-qr"](null, "");
      assert.ok(result.error);
    });

    it("generates QR code", async () => {
      const ipcMain = makeMockIpcMain();
      const QRCode = { toDataURL: async () => "data:image/png,qr" };
      registerMobileSettingsIpc({ ipcMain, QRCode });
      const result = await ipcMain.handlers["settings:generate-qr"](null, "hello");
      assert.equal(result.dataUrl, "data:image/png,qr");
    });

    it("handles QR error", async () => {
      const ipcMain = makeMockIpcMain();
      const QRCode = { toDataURL: async () => { throw new Error("bad"); } };
      registerMobileSettingsIpc({ ipcMain, QRCode });
      const result = await ipcMain.handlers["settings:generate-qr"](null, "hello");
      assert.ok(result.error.includes("bad"));
    });
  });

  describe("auto-refresh event wiring", () => {
    it("wires client-connected/disconnected events when mobileWS has .on", () => {
      const ipcMain = makeMockIpcMain();
      const events = {};
      const mobileWS = makeMockMobileWS({
        on: (event, handler) => { events[event] = handler; },
      });
      const sent = [];
      registerMobileSettingsIpc({
        ipcMain,
        getMobileWS: () => mobileWS,
        sendToRenderer: (ch, data) => sent.push({ ch, data }),
      });
      assert.ok(events["client-connected"]);
      assert.ok(events["client-disconnected"]);
    });

    it("does not wire events when mobileWS has no .on", () => {
      const ipcMain = makeMockIpcMain();
      registerMobileSettingsIpc({
        ipcMain,
        getMobileWS: () => ({ getClientInfoList: () => [] }),
      });
      // Should not throw
      assert.ok(true);
    });
  });

  describe("dispose", () => {
    it("removes all handlers", () => {
      const ipcMain = makeMockIpcMain();
      const disposers = [];
      registerMobileSettingsIpc({ ipcMain, _disposers: disposers });
      assert.ok(Object.keys(ipcMain.handlers).length > 0);
      for (const dispose of disposers) dispose();
      assert.equal(Object.keys(ipcMain.handlers).length, 0);
    });
  });
});

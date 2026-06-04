const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 60000;

class MobileApprovalClient {
  constructor(getMobileWS, options = {}) {
    this.getMobileWS = getMobileWS;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.pending = new Map();
    this._handler = this._handleClientMessage.bind(this);
    this._attachedServer = null;
  }

  requestApproval(payload, options = {}) {
    const mobileWS = typeof this.getMobileWS === "function" ? this.getMobileWS() : null;
    if (!mobileWS || typeof mobileWS.getClientCount !== "function" || mobileWS.getClientCount() <= 0) {
      return Promise.resolve(null);
    }
    if (typeof mobileWS.broadcast !== "function" || typeof mobileWS.onClientMessage !== "function") {
      return Promise.resolve(null);
    }

    this._attach(mobileWS);

    const requestId = "perm_" + crypto.randomBytes(8).toString("hex");
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const request = {
      type: "permission_request",
      requestId,
      data: payload || {},
      timestamp: Date.now(),
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pending.set(requestId, { resolve, timer });
      mobileWS.broadcast(request);
    });
  }

  close() {
    if (this._attachedServer && typeof this._attachedServer.offClientMessage === "function") {
      this._attachedServer.offClientMessage(this._handler);
    }
    this._attachedServer = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pending.clear();
  }

  _attach(mobileWS) {
    if (this._attachedServer === mobileWS) return;
    if (this._attachedServer && typeof this._attachedServer.offClientMessage === "function") {
      this._attachedServer.offClientMessage(this._handler);
    }
    mobileWS.onClientMessage(this._handler);
    this._attachedServer = mobileWS;
  }

  _handleClientMessage(_ws, message) {
    if (!message || message.type !== "permission_response" || !message.requestId) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    // 处理 suggestionIndex: "allow" + suggestionIndex -> "suggestion:N"
    let behavior = message.behavior || null;
    if (behavior === "allow" && Number.isFinite(message.suggestionIndex)) {
      behavior = `suggestion:${message.suggestionIndex}`;
    }
    pending.resolve(behavior);
  }
}

module.exports = { MobileApprovalClient };

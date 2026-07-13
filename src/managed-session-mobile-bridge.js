"use strict";

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

function safeDeviceId(value) {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value) ? value : null;
}

class ManagedSessionMobileBridge {
  constructor(options = {}) {
    if (!options.mobileServer) throw new Error("mobile_server_required");
    if (!options.runtime) throw new Error("runtime_required");
    this.mobileServer = options.mobileServer;
    this.runtime = options.runtime;
    this.maxFrameBytes = Number.isInteger(options.maxFrameBytes)
      ? options.maxFrameBytes
      : 48 * 1024;
    this.leaseTtlMs = Number.isInteger(options.leaseTtlMs) ? options.leaseTtlMs : 60_000;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.enabled = false;
    this.subscriptions = new Map();
    this.attached = false;
    this.leases = new Map();
    this.acknowledgements = new Map();
    this.identitiesByTransport = new Map();
    this._messageHandler = this._handleMessage.bind(this);
    this._disconnectHandler = this._handleDisconnect.bind(this);
    this._deltaHandler = this._handleDelta.bind(this);
    this._sessionsHandler = this._handleSessionsChanged.bind(this);
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.mobileServer.onClientMessage(this._messageHandler);
    this.mobileServer.on("client-disconnected", this._disconnectHandler);
    this.runtime.on("delta", this._deltaHandler);
    this.runtime.on("sessions_changed", this._sessionsHandler);
  }

  dispose() {
    if (!this.attached) return;
    this.attached = false;
    this.mobileServer.offClientMessage(this._messageHandler);
    this.mobileServer.off("client-disconnected", this._disconnectHandler);
    this.runtime.off("delta", this._deltaHandler);
    this.runtime.off("sessions_changed", this._sessionsHandler);
    this.leases.clear();
    this.acknowledgements.clear();
    this.identitiesByTransport.clear();
    this.subscriptions.clear();
  }

  _handleMessage(ws, message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    if (!message.type.startsWith("managed_")) return;
    const identity = this._identity(ws, message);
    const requestId = typeof message.requestId === "string" ? message.requestId : null;
    try {
      switch (message.type) {
        case "managed_content_sync_set":
          {
            const transportId = this.mobileServer.getClientId(ws) || identity;
            const enabled = message.enabled === true;
            if (enabled) {
              this.subscriptions.set(transportId, ws);
            } else {
              this.subscriptions.delete(transportId);
              for (const [sessionId, lease] of this.leases) {
                if (lease.transportId === transportId) {
                  this.leases.delete(sessionId);
                  this._broadcastLease(sessionId, null);
                }
              }
            }
            this.enabled = this.subscriptions.size > 0;
            this._send(ws, { type: "managed_content_sync_state", enabled, requestId });
            if (enabled) {
              this._sendCapabilities(ws);
              this._sendSessions(ws);
            }
          }
          break;
        case "managed_capabilities_request":
          this._requireEnabled(ws);
          this._sendCapabilities(ws, requestId);
          break;
        case "managed_sessions_request":
          this._requireEnabled(ws);
          this._sendSessions(ws, requestId);
          break;
        case "managed_session_create": {
          this._requireEnabled(ws);
          const session = this.runtime.create(message);
          this._send(ws, { type: "managed_session_created", session, requestId });
          break;
        }
        case "managed_session_history_request":
          this._requireEnabled(ws);
          this._sendHistory(ws, message, requestId);
          break;
        case "managed_session_ack":
          this._requireEnabled(ws);
          this._recordAck(identity, message.sessionId, message.sequence);
          break;
        case "managed_session_input_lease_acquire":
          this._requireEnabled(ws);
          this._acquireLease(ws, identity, message.sessionId, requestId);
          break;
        case "managed_session_input_lease_release":
          this._requireEnabled(ws);
          this._releaseLease(identity, message.sessionId);
          break;
        case "managed_session_input":
          this._requireLease(ws, identity, message.sessionId);
          {
            const record = this.runtime.write(message.sessionId, message.data, {
            raw: message.raw === true,
            submit: message.submit !== false,
            });
            this._send(ws, {
              type: "managed_session_command_result",
              command: "input",
              sessionId: message.sessionId,
              sequence: record && Number.isInteger(record.sequence) ? record.sequence : null,
              requestId,
            });
          }
          break;
        case "managed_session_resize":
          this._requireLease(ws, identity, message.sessionId);
          this.runtime.resize(message.sessionId, message.cols, message.rows);
          this._send(ws, {
            type: "managed_session_command_result",
            command: "resize",
            sessionId: message.sessionId,
            requestId,
          });
          break;
        case "managed_session_interrupt":
          this._requireLease(ws, identity, message.sessionId);
          {
            const record = this.runtime.interrupt(message.sessionId);
            this._send(ws, {
              type: "managed_session_command_result",
              command: "interrupt",
              sessionId: message.sessionId,
              sequence: record && Number.isInteger(record.sequence) ? record.sequence : null,
              requestId,
            });
          }
          break;
        default:
          this._error(ws, "unsupported_managed_message", requestId, message.sessionId);
      }
    } catch (error) {
      this._error(ws, error && error.message ? error.message : "managed_command_failed", requestId, message.sessionId);
    }
  }

  _sendCapabilities(ws, requestId = null) {
    this._send(ws, {
      type: "managed_capabilities",
      ...this.runtime.capabilities(),
      requestId,
    });
  }

  _sendSessions(ws, requestId = null) {
    this._send(ws, {
      type: "managed_sessions_snapshot",
      sessions: this.runtime.listSessions(),
      requestId,
    });
  }

  _sendHistory(ws, message, requestId) {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const afterSequence = Number.isInteger(message.afterSequence) ? message.afterSequence : 0;
    const history = this.runtime.historyAfter(sessionId, afterSequence, 500);
    const chunks = this._chunkRecords(history.records, {
      type: "managed_session_history_chunk",
      sessionId,
      requestId,
      resetRequired: history.resetRequired,
      oldestSequence: history.oldestSequence,
      latestSequence: history.latestSequence,
    });
    chunks.forEach((chunk, index) => {
      this._send(ws, {
        ...chunk,
        resetRequired: history.resetRequired && index === 0,
        chunkIndex: index,
        chunkCount: chunks.length,
        hasMore: history.hasMore || index < chunks.length - 1,
      });
    });
  }

  _chunkRecords(records, base) {
    const chunks = [];
    let current = [];
    for (const record of records) {
      const candidate = { ...base, records: [...current, record] };
      if (current.length && Buffer.byteLength(JSON.stringify(candidate), "utf8") >= this.maxFrameBytes) {
        chunks.push({ ...base, records: current });
        current = [record];
      } else {
        current.push(record);
      }
    }
    if (current.length || chunks.length === 0) chunks.push({ ...base, records: current });
    return chunks;
  }

  _acquireLease(ws, identity, sessionId, requestId) {
    this._requireSession(sessionId);
    const current = this._activeLease(sessionId);
    const transportId = this.mobileServer.getClientId(ws) || identity;
    const granted = !current || current.owner === identity;
    if (granted) {
      this.leases.set(sessionId, { owner: identity, transportId, touchedAt: this.now() });
      this._broadcastLease(sessionId, identity);
    }
    this._send(ws, {
      type: "managed_session_input_lease_changed",
      sessionId,
      owner: granted ? identity : current.owner,
      granted,
      requestId,
    });
  }

  _releaseLease(identity, sessionId) {
    const current = this._activeLease(sessionId);
    if (!current || current.owner !== identity) return;
    this.leases.delete(sessionId);
    this._broadcastLease(sessionId, null);
  }

  _requireLease(ws, identity, sessionId) {
    this._requireEnabled(ws);
    const current = this._activeLease(sessionId);
    if (!current || current.owner !== identity) throw new Error("input_lease_required");
    current.touchedAt = this.now();
  }

  _activeLease(sessionId) {
    const lease = this.leases.get(sessionId);
    if (lease && this.now() - lease.touchedAt > this.leaseTtlMs) {
      this.leases.delete(sessionId);
      this._broadcastLease(sessionId, null);
      return null;
    }
    return lease || null;
  }

  _requireSession(sessionId) {
    if (!this.runtime.listSessions().some((session) => session.id === sessionId)) {
      throw new Error("session_not_found");
    }
  }

  _recordAck(identity, sessionId, sequence) {
    if (typeof sessionId !== "string" || !Number.isInteger(sequence) || sequence < 0) return;
    if (!this.acknowledgements.has(identity)) this.acknowledgements.set(identity, new Map());
    const bySession = this.acknowledgements.get(identity);
    bySession.set(sessionId, Math.max(bySession.get(sessionId) || 0, sequence));
  }

  _identity(ws, message) {
    const transportId = this.mobileServer.getClientId(ws) || "unknown-client";
    const identity = safeDeviceId(message.deviceId) || transportId;
    if (!this.identitiesByTransport.has(transportId)) this.identitiesByTransport.set(transportId, new Set());
    this.identitiesByTransport.get(transportId).add(identity);
    return identity;
  }

  _handleDisconnect(event = {}) {
    const transportId = event.clientId;
    const identities = this.identitiesByTransport.get(transportId) || new Set([transportId]);
    for (const [sessionId, lease] of this.leases) {
      if (lease.transportId === transportId) {
        this.leases.delete(sessionId);
        this._broadcastLease(sessionId, null);
      }
    }
    for (const identity of identities) this.acknowledgements.delete(identity);
    this.identitiesByTransport.delete(transportId);
    this.subscriptions.delete(transportId);
    this.enabled = this.subscriptions.size > 0;
  }

  _handleDelta(record) {
    for (const ws of this.subscriptions.values()) {
      this._send(ws, { type: "managed_session_delta", record });
    }
  }

  _handleSessionsChanged(sessions) {
    for (const ws of this.subscriptions.values()) {
      this._send(ws, { type: "managed_sessions_snapshot", sessions });
    }
  }

  _broadcastLease(sessionId, owner) {
    for (const ws of this.subscriptions.values()) {
      this._send(ws, {
        type: "managed_session_input_lease_changed",
        sessionId,
        owner,
        granted: false,
      });
    }
  }

  _requireEnabled(ws) {
    const transportId = this.mobileServer.getClientId(ws);
    if (!transportId || !this.subscriptions.has(transportId)) {
      throw new Error("content_sync_disabled");
    }
  }

  _send(ws, payload) {
    this.mobileServer.send(ws, { ...payload, timestamp: this.now() });
  }

  _error(ws, code, requestId, sessionId) {
    this._send(ws, { type: "managed_session_error", code, requestId, sessionId });
  }
}

module.exports = { ManagedSessionMobileBridge, safeDeviceId };

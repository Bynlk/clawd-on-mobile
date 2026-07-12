"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { ManagedSessionStore } = require("./managed-session-store");
const { ManagedTerminalNormalizer } = require("./managed-terminal-normalizer");

function createProductionPtyProvider() {
  return {
    spawn(command, args, options) {
      const pty = require("node-pty");
      return pty.spawn(command, args, options);
    },
  };
}

class ManagedSessionRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.catalog) throw new Error("catalog_required");
    this.catalog = options.catalog;
    this.ptyProvider = options.ptyProvider || createProductionPtyProvider();
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.createId = typeof options.createId === "function"
      ? options.createId
      : () => crypto.randomUUID();
    this.store = options.store || new ManagedSessionStore({ now: this.now });
    this.processes = new Map();
    this.normalizers = new Map();
  }

  capabilities() {
    return {
      agents: this.catalog.listAgents(),
      directories: this.catalog.listDirectories(),
    };
  }

  create(request) {
    const resolved = this.catalog.resolveCreateRequest(request);
    const id = this.createId();
    const cols = Number.isInteger(request && request.cols) ? request.cols : 100;
    const rows = Number.isInteger(request && request.rows) ? request.rows : 30;
    const session = this.store.createSession({
      id,
      agentId: resolved.agentId,
      cwd: resolved.cwd,
      title: request && request.title ? String(request.title) : resolved.agentId,
      status: "running",
    });
    const terminal = this.ptyProvider.spawn(resolved.command, resolved.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: resolved.cwd,
      env: { ...process.env, TERM: "xterm-256color", CLAWD_MANAGED_SESSION_ID: id },
    });
    const normalizer = new ManagedTerminalNormalizer();
    this.processes.set(id, terminal);
    this.normalizers.set(id, normalizer);
    terminal.onData((data) => {
      for (const event of normalizer.push(data)) this._append(id, event);
    });
    terminal.onExit((result = {}) => {
      this.processes.delete(id);
      this.normalizers.delete(id);
      const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
      const signal = Number.isInteger(result.signal) ? result.signal : null;
      this.store.updateSession(id, { status: "exited", exitCode, signal, updatedAt: this.now() });
      this._append(id, { kind: "exit", exitCode, signal });
      this.emit("sessions_changed", this.listSessions());
    });
    this.emit("sessions_changed", this.listSessions());
    return session;
  }

  write(sessionId, data, options = {}) {
    const terminal = this._runningProcess(sessionId);
    const value = String(data ?? "");
    const submit = options.submit !== false && options.raw !== true;
    terminal.write(submit ? `${value}\r` : value);
    return this._append(sessionId, {
      kind: "user_input",
      text: options.raw ? null : value,
      raw: options.raw ? value : null,
      submitted: submit,
    });
  }

  resize(sessionId, cols, rows) {
    const terminal = this._runningProcess(sessionId);
    if (!Number.isInteger(cols) || cols < 20 || !Number.isInteger(rows) || rows < 5) {
      throw new Error("invalid_terminal_size");
    }
    terminal.resize(cols, rows);
  }

  interrupt(sessionId) {
    const terminal = this._runningProcess(sessionId);
    terminal.write("\u0003");
    return this._append(sessionId, { kind: "control", control: "interrupt" });
  }

  listSessions() {
    return this.store.listSessions();
  }

  historyAfter(sessionId, sequence, limit) {
    return this.store.historyAfter(sessionId, sequence, limit);
  }

  dispose() {
    for (const terminal of this.processes.values()) {
      try { terminal.kill(); } catch {}
    }
    this.processes.clear();
    this.normalizers.clear();
    this.store.clear();
    this.removeAllListeners();
  }

  _runningProcess(sessionId) {
    const terminal = this.processes.get(sessionId);
    if (terminal) return terminal;
    if (this.store.sessions && this.store.sessions.has(sessionId)) throw new Error("session_not_running");
    throw new Error("session_not_found");
  }

  _append(sessionId, event) {
    const record = this.store.append(sessionId, { ...event, timestamp: this.now() });
    this.emit("delta", record);
    return record;
  }
}

module.exports = { ManagedSessionRuntime, createProductionPtyProvider };

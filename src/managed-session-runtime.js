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

function splitUtf8(value, maxBytes) {
  if (typeof value !== "string") return null;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return [value];
  const parts = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + bytes > maxBytes) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current || parts.length === 0) parts.push(current);
  return parts;
}

function splitManagedEvent(event, maxFieldBytes = 8 * 1024) {
  const textParts = splitUtf8(event && event.text, maxFieldBytes);
  const rawParts = splitUtf8(event && event.raw, maxFieldBytes);
  const count = Math.max(textParts?.length || 1, rawParts?.length || 1);
  if (count === 1) return [event];
  return Array.from({ length: count }, (_, index) => ({
    ...event,
    ...(textParts ? { text: textParts[index] || "" } : {}),
    ...(rawParts ? { raw: rawParts[index] || "" } : {}),
    partIndex: index,
    partCount: count,
  }));
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
    this.hookSessionLinks = new Map();
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
    let terminal;
    try {
      terminal = this.ptyProvider.spawn(resolved.command, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: resolved.cwd,
        env: { ...process.env, TERM: "xterm-256color", CLAWD_MANAGED_SESSION_ID: id },
      });
    } catch (error) {
      this.store.removeSession(id);
      throw error;
    }
    const normalizer = new ManagedTerminalNormalizer();
    this.processes.set(id, terminal);
    this.normalizers.set(id, normalizer);
    terminal.onData((data) => {
      for (const event of normalizer.push(data)) this._append(id, event);
    });
    terminal.onExit((result = {}) => {
      this.processes.delete(id);
      this.normalizers.delete(id);
      this._unlinkManagedSession(id);
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

  linkHookSession(hookSessionId, metadata = {}) {
    if (typeof hookSessionId !== "string" || !hookSessionId) return null;
    const sessions = this.listSessions();
    const exact = sessions.find((session) => session.id === hookSessionId && session.status === "running");
    const candidates = sessions.filter((session) =>
      session.status === "running" &&
      session.agentId === metadata.agentId &&
      session.cwd === metadata.cwd
    );
    const match = exact?.id || (candidates.length === 1 ? candidates[0].id : null);
    if (match) this.hookSessionLinks.set(hookSessionId, match);
    return match;
  }

  appendHookEvent(hookSessionId, event = {}) {
    let sessionId = this.hookSessionLinks.get(hookSessionId) ||
      this.linkHookSession(hookSessionId, event);
    if (sessionId && !this.processes.has(sessionId)) {
      this.hookSessionLinks.delete(hookSessionId);
      sessionId = null;
    }
    if (!sessionId) return null;
    const record = this._append(sessionId, {
      kind: event.kind || "status",
      text: typeof event.text === "string" ? event.text : null,
      toolName: typeof event.toolName === "string" ? event.toolName : null,
      event: typeof event.event === "string" ? event.event : null,
      permissionId: typeof event.permissionId === "string" ? event.permissionId : null,
      permissionState: typeof event.permissionState === "string" ? event.permissionState : null,
      file: typeof event.file === "string" ? event.file : null,
      additions: Number.isInteger(event.additions) ? event.additions : 0,
      deletions: Number.isInteger(event.deletions) ? event.deletions : 0,
    });
    if (event.event === "SessionEnd") this.hookSessionLinks.delete(hookSessionId);
    return record;
  }

  dispose() {
    for (const terminal of this.processes.values()) {
      try { terminal.kill(); } catch {}
    }
    this.processes.clear();
    this.normalizers.clear();
    this.hookSessionLinks.clear();
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
    let latest = null;
    for (const part of splitManagedEvent(event)) {
      latest = this.store.append(sessionId, { ...part, timestamp: this.now() });
      this.emit("delta", latest);
    }
    return latest;
  }

  _unlinkManagedSession(sessionId) {
    for (const [hookSessionId, managedSessionId] of this.hookSessionLinks) {
      if (managedSessionId === sessionId) this.hookSessionLinks.delete(hookSessionId);
    }
  }
}

module.exports = { ManagedSessionRuntime, createProductionPtyProvider, splitManagedEvent, splitUtf8 };

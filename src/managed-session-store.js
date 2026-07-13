"use strict";

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function encodedSize(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

class ManagedSessionStore {
  constructor(options = {}) {
    this.maxRecords = positiveInteger(options.maxRecords, 10000);
    this.maxBytes = positiveInteger(options.maxBytes, 10 * 1024 * 1024);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.sessions = new Map();
  }

  createSession(metadata) {
    const value = metadata && typeof metadata === "object" ? metadata : {};
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) throw new Error("invalid_session_id");
    if (this.sessions.has(id)) throw new Error("session_exists");

    const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : this.now();
    const session = {
      ...value,
      id,
      status: value.status || "running",
      createdAt,
      updatedAt: createdAt,
      nextSequence: 1,
      historyBytes: 0,
      records: [],
    };
    this.sessions.set(id, session);
    return this._publicSession(session);
  }

  listSessions() {
    return [...this.sessions.values()]
      .map((session) => this._publicSession(session))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  append(sessionId, event) {
    const session = this._requireSession(sessionId);
    const timestamp = Number.isFinite(event && event.timestamp)
      ? event.timestamp
      : this.now();
    const record = {
      ...(event && typeof event === "object" ? event : {}),
      sessionId,
      sequence: session.nextSequence++,
      timestamp,
    };
    const bytes = encodedSize(record);
    session.records.push({ record, bytes });
    session.historyBytes += bytes;
    session.updatedAt = timestamp;

    while (
      session.records.length > 1 &&
      (session.records.length > this.maxRecords || session.historyBytes > this.maxBytes)
    ) {
      const removed = session.records.shift();
      session.historyBytes -= removed.bytes;
    }
    return { ...record };
  }

  historyAfter(sessionId, sequence = 0, limit = 200) {
    const session = this._requireSession(sessionId);
    const afterSequence = Number.isInteger(sequence) && sequence >= 0 ? sequence : 0;
    const pageSize = positiveInteger(limit, 200);
    const oldestSequence = session.records.length
      ? session.records[0].record.sequence
      : session.nextSequence;
    const available = session.records
      .map((entry) => entry.record)
      .filter((record) => record.sequence > afterSequence);
    const records = available.slice(0, pageSize).map((record) => ({ ...record }));
    return {
      sessionId,
      records,
      resetRequired: oldestSequence > 1 && afterSequence < oldestSequence,
      oldestSequence,
      latestSequence: session.nextSequence - 1,
      nextSequence: records.length ? records[records.length - 1].sequence : afterSequence,
      hasMore: available.length > records.length,
    };
  }

  updateSession(sessionId, patch) {
    const session = this._requireSession(sessionId);
    const value = patch && typeof patch === "object" ? patch : {};
    for (const [key, entry] of Object.entries(value)) {
      if (["id", "records", "nextSequence", "historyBytes"].includes(key)) continue;
      session[key] = entry;
    }
    session.updatedAt = Number.isFinite(value.updatedAt) ? value.updatedAt : this.now();
    return this._publicSession(session);
  }

  removeSession(sessionId) {
    return this.sessions.delete(sessionId);
  }

  clear() {
    this.sessions.clear();
  }

  _requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("session_not_found");
    return session;
  }

  _publicSession(session) {
    const { records: _records, nextSequence, historyBytes: _historyBytes, ...metadata } = session;
    return {
      ...metadata,
      latestSequence: nextSequence - 1,
      oldestSequence: session.records.length
        ? session.records[0].record.sequence
        : nextSequence,
    };
  }
}

module.exports = { ManagedSessionStore };

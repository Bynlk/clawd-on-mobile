"use strict";

function isOpen(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

class RelayPairRegistry {
  constructor() {
    this.pairs = new Map();
    this.clientIds = new WeakMap();
    this.nextClientId = 1;
  }

  get(token) {
    return this.pairs.get(token) || null;
  }

  add(token, role, ws) {
    let pair = this.pairs.get(token);
    if (!pair) {
      pair = { pc: null, phones: new Set() };
      this.pairs.set(token, pair);
    }
    if (!this.clientIds.has(ws)) this.clientIds.set(ws, `relay-${this.nextClientId++}`);
    if (role === "pc") {
      const replaced = isOpen(pair.pc) && pair.pc !== ws ? pair.pc : null;
      if (replaced) replaced.close(4001, "被新连接替换");
      pair.pc = ws;
      return { pair, replaced };
    }
    pair.phones.add(ws);
    return { pair, replaced: null };
  }

  remove(token, role, ws) {
    const pair = this.pairs.get(token);
    if (!pair) return null;
    if (role === "pc") {
      if (pair.pc === ws) pair.pc = null;
    } else {
      pair.phones.delete(ws);
    }
    if (!pair.pc && pair.phones.size === 0) this.pairs.delete(token);
    return pair;
  }

  peers(token, role) {
    const pair = this.pairs.get(token);
    if (!pair) return [];
    if (role === "pc") return [...pair.phones].filter(isOpen);
    return isOpen(pair.pc) ? [pair.pc] : [];
  }

  clientIdFor(ws) {
    return ws ? this.clientIds.get(ws) || null : null;
  }

  forward(token, role, data, sender = null) {
    if (role === "phone" && sender) {
      const peer = this.peers(token, role)[0];
      if (!peer) return 0;
      const envelope = JSON.stringify({
        type: "relay_forward",
        sourceClientId: this.clientIdFor(sender),
        payload: Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      });
      try {
        peer.send(envelope);
        return 1;
      } catch {
        return 0;
      }
    }

    if (role === "pc") {
      try {
        const envelope = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        if (envelope.type === "relay_forward" && typeof envelope.targetClientId === "string" &&
            typeof envelope.payload === "string") {
          const pair = this.pairs.get(token);
          const target = pair && [...pair.phones].find((phone) =>
            isOpen(phone) && this.clientIdFor(phone) === envelope.targetClientId
          );
          if (!target) return 0;
          target.send(envelope.payload);
          return 1;
        }
      } catch {}
    }

    let delivered = 0;
    for (const peer of this.peers(token, role)) {
      try {
        peer.send(data);
        delivered++;
      } catch {}
    }
    return delivered;
  }

  countConnections() {
    let pc = 0;
    let phone = 0;
    for (const pair of this.pairs.values()) {
      if (isOpen(pair.pc)) pc++;
      phone += [...pair.phones].filter(isOpen).length;
    }
    return { pc, phone };
  }

  get size() {
    return this.pairs.size;
  }

  closeAll(code, reason) {
    for (const pair of this.pairs.values()) {
      if (pair.pc) pair.pc.close(code, reason);
      for (const phone of pair.phones) phone.close(code, reason);
    }
    this.pairs.clear();
  }
}

module.exports = { RelayPairRegistry, isOpen };

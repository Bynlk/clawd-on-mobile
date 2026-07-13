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
      pair = { pc: null, phone: null };
      this.pairs.set(token, pair);
    }
    if (!this.clientIds.has(ws)) this.clientIds.set(ws, `relay-${this.nextClientId++}`);

    const current = pair[role];
    const replaced = isOpen(current) && current !== ws ? current : null;
    if (replaced) replaced.close(4002, "replaced");
    pair[role] = ws;
    return { pair, replaced };
  }

  remove(token, role, ws) {
    const pair = this.pairs.get(token);
    if (!pair) return null;
    if (pair[role] === ws) pair[role] = null;
    if (!pair.pc && !pair.phone) this.pairs.delete(token);
    return pair;
  }

  peers(token, role) {
    const pair = this.pairs.get(token);
    if (!pair) return [];
    const peer = role === "pc" ? pair.phone : pair.pc;
    return isOpen(peer) ? [peer] : [];
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
          const target = pair && pair.phone;
          if (!isOpen(target) || this.clientIdFor(target) !== envelope.targetClientId) return 0;
          target.send(envelope.payload);
          return 1;
        }
      } catch {}
    }

    const peer = this.peers(token, role)[0];
    if (!peer) return 0;
    try {
      peer.send(data);
      return 1;
    } catch {
      return 0;
    }
  }

  countConnections() {
    let pc = 0;
    let phone = 0;
    for (const pair of this.pairs.values()) {
      if (isOpen(pair.pc)) pc++;
      if (isOpen(pair.phone)) phone++;
    }
    return { pc, phone };
  }

  closeToken(token, code, reason) {
    const pair = this.pairs.get(token);
    if (!pair) return false;
    this.pairs.delete(token);
    if (pair.pc) pair.pc.close(code, reason);
    if (pair.phone) pair.phone.close(code, reason);
    return true;
  }

  closeAll(code, reason) {
    for (const token of [...this.pairs.keys()]) this.closeToken(token, code, reason);
  }

  get size() {
    return this.pairs.size;
  }
}

module.exports = { RelayPairRegistry, isOpen };

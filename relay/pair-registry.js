"use strict";

function isOpen(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

class RelayPairRegistry {
  constructor() {
    this.pairs = new Map();
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

  forward(token, role, data) {
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

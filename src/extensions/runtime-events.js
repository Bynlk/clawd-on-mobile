"use strict";

const { EventEmitter } = require("events");

function snapshot(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(snapshot(item, seen));
    return Object.freeze(copy);
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = snapshot(item, seen);
  return Object.freeze(copy);
}

class RuntimeEvents {
  #emitter = new EventEmitter();

  on(eventName, listener) {
    this.#emitter.on(eventName, listener);
    return () => this.#emitter.off(eventName, listener);
  }

  emit(eventName, payload) {
    this.#emitter.emit(eventName, snapshot(payload));
  }

  emitReference(eventName, payload) {
    this.#emitter.emit(eventName, payload);
  }

  dispose() {
    this.#emitter.removeAllListeners();
  }
}

module.exports = { RuntimeEvents };

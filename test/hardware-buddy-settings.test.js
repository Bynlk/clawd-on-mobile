"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_HARDWARE_BUDDY_SETTINGS,
  HARDWARE_BUDDY_BACKENDS,
  normalizeHardwareBuddySettings,
  validateHardwareBuddySettings,
  hardwareBuddySettingsEqual,
} = require("../src/hardware-buddy-settings.js");

// ---------------------------------------------------------------------------
// DEFAULT_HARDWARE_BUDDY_SETTINGS
// ---------------------------------------------------------------------------
describe("DEFAULT_HARDWARE_BUDDY_SETTINGS", () => {
  it("has the expected shape with six keys", () => {
    const keys = Object.keys(DEFAULT_HARDWARE_BUDDY_SETTINGS);
    assert.deepStrictEqual(keys.sort(), [
      "address",
      "backend",
      "enabled",
      "namePrefix",
      "permissionsEnabled",
      "quickCommandsEnabled",
    ]);
  });

  it("has correct default values", () => {
    assert.equal(DEFAULT_HARDWARE_BUDDY_SETTINGS.enabled, false);
    assert.equal(DEFAULT_HARDWARE_BUDDY_SETTINGS.backend, "bleak");
    assert.equal(DEFAULT_HARDWARE_BUDDY_SETTINGS.address, "");
    assert.equal(DEFAULT_HARDWARE_BUDDY_SETTINGS.namePrefix, "Clawstick");
    assert.equal(DEFAULT_HARDWARE_BUDDY_SETTINGS.permissionsEnabled, false);
    assert.equal(DEFAULT_HARDWARE_BUDDY_SETTINGS.quickCommandsEnabled, false);
  });

  it("is frozen and cannot be mutated", () => {
    assert.ok(Object.isFrozen(DEFAULT_HARDWARE_BUDDY_SETTINGS));
    assert.throws(() => {
      DEFAULT_HARDWARE_BUDDY_SETTINGS.enabled = true;
    });
  });
});

// ---------------------------------------------------------------------------
// HARDWARE_BUDDY_BACKENDS
// ---------------------------------------------------------------------------
describe("HARDWARE_BUDDY_BACKENDS", () => {
  it("contains exactly bleak and fake", () => {
    assert.deepStrictEqual([...HARDWARE_BUDDY_BACKENDS], ["bleak", "fake"]);
  });

  it("is frozen and cannot be mutated", () => {
    assert.ok(Object.isFrozen(HARDWARE_BUDDY_BACKENDS));
    assert.throws(() => {
      HARDWARE_BUDDY_BACKENDS.push("newbackend");
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeHardwareBuddySettings
// ---------------------------------------------------------------------------
describe("normalizeHardwareBuddySettings", () => {
  describe("with a fully valid input", () => {
    it("returns the same values when all fields are valid", () => {
      const input = {
        enabled: true,
        backend: "fake",
        address: "AA:BB:CC:DD:EE:FF",
        namePrefix: "MyDevice",
        permissionsEnabled: true,
        quickCommandsEnabled: true,
      };
      const result = normalizeHardwareBuddySettings(input);
      assert.deepStrictEqual(result, input);
    });
  });

  describe("default values for missing or invalid fields", () => {
    it("defaults enabled to false when missing", () => {
      const result = normalizeHardwareBuddySettings({});
      assert.equal(result.enabled, false);
    });

    it("defaults enabled to false when null", () => {
      const result = normalizeHardwareBuddySettings({ enabled: null });
      assert.equal(result.enabled, false);
    });

    it("defaults enabled to false when truthy but not strict true", () => {
      assert.equal(normalizeHardwareBuddySettings({ enabled: 1 }).enabled, false);
      assert.equal(normalizeHardwareBuddySettings({ enabled: "yes" }).enabled, false);
    });

    it("defaults backend to 'bleak' when missing", () => {
      const result = normalizeHardwareBuddySettings({});
      assert.equal(result.backend, "bleak");
    });

    it("falls back to default backend for an unknown backend value", () => {
      const result = normalizeHardwareBuddySettings({ backend: "unknown" });
      assert.equal(result.backend, "bleak");
    });

    it("falls back to default backend for a non-string backend value", () => {
      assert.equal(normalizeHardwareBuddySettings({ backend: 123 }).backend, "bleak");
      assert.equal(normalizeHardwareBuddySettings({ backend: null }).backend, "bleak");
      assert.equal(normalizeHardwareBuddySettings({ backend: true }).backend, "bleak");
    });

    it("accepts 'bleak' as a valid backend", () => {
      const result = normalizeHardwareBuddySettings({ backend: "bleak" });
      assert.equal(result.backend, "bleak");
    });

    it("accepts 'fake' as a valid backend", () => {
      const result = normalizeHardwareBuddySettings({ backend: "fake" });
      assert.equal(result.backend, "fake");
    });

    it("defaults address to empty string when missing", () => {
      const result = normalizeHardwareBuddySettings({});
      assert.equal(result.address, "");
    });

    it("defaults namePrefix to 'Clawstick' when missing", () => {
      const result = normalizeHardwareBuddySettings({});
      assert.equal(result.namePrefix, "Clawstick");
    });

    it("defaults namePrefix to 'Clawstick' when provided as empty string", () => {
      const result = normalizeHardwareBuddySettings({ namePrefix: "" });
      assert.equal(result.namePrefix, "Clawstick");
    });

    it("defaults permissionsEnabled to false when missing", () => {
      const result = normalizeHardwareBuddySettings({});
      assert.equal(result.permissionsEnabled, false);
    });

    it("defaults quickCommandsEnabled to false when missing", () => {
      const result = normalizeHardwareBuddySettings({});
      assert.equal(result.quickCommandsEnabled, false);
    });
  });

  describe("string sanitization", () => {
    it("strips control characters from address", () => {
      const result = normalizeHardwareBuddySettings({ address: "AA\x00BB\x1fCC" });
      assert.equal(result.address, "AABBCC");
    });

    it("strips control characters from namePrefix", () => {
      const result = normalizeHardwareBuddySettings({ namePrefix: "My\x07Device" });
      assert.equal(result.namePrefix, "MyDevice");
    });

    it("trims whitespace from address", () => {
      const result = normalizeHardwareBuddySettings({ address: "  hello  " });
      assert.equal(result.address, "hello");
    });

    it("trims whitespace from namePrefix", () => {
      const result = normalizeHardwareBuddySettings({ namePrefix: "  pad  " });
      assert.equal(result.namePrefix, "pad");
    });

    it("truncates address to 120 characters", () => {
      const long = "A".repeat(200);
      const result = normalizeHardwareBuddySettings({ address: long });
      assert.equal(result.address.length, 120);
    });

    it("truncates namePrefix to 40 characters", () => {
      const long = "B".repeat(200);
      const result = normalizeHardwareBuddySettings({ namePrefix: long });
      assert.equal(result.namePrefix.length, 40);
    });

    it("defaults address to empty string for non-string input", () => {
      assert.equal(normalizeHardwareBuddySettings({ address: 42 }).address, "");
      assert.equal(normalizeHardwareBuddySettings({ address: null }).address, "");
      assert.equal(normalizeHardwareBuddySettings({ address: undefined }).address, "");
    });

    it("defaults namePrefix to 'Clawstick' for non-string input", () => {
      assert.equal(normalizeHardwareBuddySettings({ namePrefix: 42 }).namePrefix, "Clawstick");
      assert.equal(normalizeHardwareBuddySettings({ namePrefix: null }).namePrefix, "Clawstick");
      assert.equal(normalizeHardwareBuddySettings({ namePrefix: undefined }).namePrefix, "Clawstick");
    });
  });

  describe("edge-case inputs", () => {
    it("returns defaults when passed null", () => {
      const result = normalizeHardwareBuddySettings(null);
      assert.deepStrictEqual(result, DEFAULT_HARDWARE_BUDDY_SETTINGS);
    });

    it("returns defaults when passed undefined", () => {
      const result = normalizeHardwareBuddySettings(undefined);
      assert.deepStrictEqual(result, DEFAULT_HARDWARE_BUDDY_SETTINGS);
    });

    it("returns defaults when passed a string", () => {
      const result = normalizeHardwareBuddySettings("not an object");
      assert.deepStrictEqual(result, DEFAULT_HARDWARE_BUDDY_SETTINGS);
    });

    it("returns defaults when passed a number", () => {
      const result = normalizeHardwareBuddySettings(42);
      assert.deepStrictEqual(result, DEFAULT_HARDWARE_BUDDY_SETTINGS);
    });

    it("returns defaults when passed a boolean", () => {
      const result = normalizeHardwareBuddySettings(true);
      assert.deepStrictEqual(result, DEFAULT_HARDWARE_BUDDY_SETTINGS);
    });

    it("returns defaults when passed an array", () => {
      const result = normalizeHardwareBuddySettings([1, 2, 3]);
      assert.deepStrictEqual(result, DEFAULT_HARDWARE_BUDDY_SETTINGS);
    });

    it("ignores extra fields on the input", () => {
      const input = { enabled: true, extra: "ignored", another: 123 };
      const result = normalizeHardwareBuddySettings(input);
      assert.equal(result.extra, undefined);
      assert.equal(result.another, undefined);
      assert.equal(result.enabled, true);
    });
  });

  describe("custom defaults parameter", () => {
    it("uses custom defaults for backend fallback", () => {
      const custom = { ...DEFAULT_HARDWARE_BUDDY_SETTINGS, backend: "fake" };
      const result = normalizeHardwareBuddySettings({ backend: "unknown" }, custom);
      assert.equal(result.backend, "fake");
    });

    it("uses custom defaults for namePrefix fallback when sanitized result is empty", () => {
      const custom = { ...DEFAULT_HARDWARE_BUDDY_SETTINGS, namePrefix: "CustomPrefix" };
      // non-string yields "", which is falsy -> fallback
      const result = normalizeHardwareBuddySettings({ namePrefix: null }, custom);
      assert.equal(result.namePrefix, "CustomPrefix");
    });
  });
});

// ---------------------------------------------------------------------------
// validateHardwareBuddySettings
// ---------------------------------------------------------------------------
describe("validateHardwareBuddySettings", () => {
  const validSettings = {
    enabled: true,
    backend: "bleak",
    address: "AA:BB:CC",
    namePrefix: "Clawstick",
    permissionsEnabled: false,
    quickCommandsEnabled: false,
  };

  it("returns ok for valid settings", () => {
    assert.deepStrictEqual(validateHardwareBuddySettings(validSettings), { status: "ok" });
  });

  it("returns ok for valid settings with backend 'fake'", () => {
    const settings = { ...validSettings, backend: "fake" };
    assert.deepStrictEqual(validateHardwareBuddySettings(settings), { status: "ok" });
  });

  it("returns ok with empty address", () => {
    const settings = { ...validSettings, address: "" };
    assert.deepStrictEqual(validateHardwareBuddySettings(settings), { status: "ok" });
  });

  describe("error: not a plain object", () => {
    it("rejects null", () => {
      const r = validateHardwareBuddySettings(null);
      assert.equal(r.status, "error");
      assert.match(r.message, /object/i);
    });

    it("rejects undefined", () => {
      const r = validateHardwareBuddySettings(undefined);
      assert.equal(r.status, "error");
    });

    it("rejects an array", () => {
      const r = validateHardwareBuddySettings([1, 2]);
      assert.equal(r.status, "error");
    });

    it("rejects a string", () => {
      const r = validateHardwareBuddySettings("hello");
      assert.equal(r.status, "error");
    });
  });

  describe("error: enabled", () => {
    it("rejects non-boolean enabled", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, enabled: "yes" });
      assert.equal(r.status, "error");
      assert.match(r.message, /enabled.*boolean/i);
    });

    it("rejects numeric enabled", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, enabled: 1 });
      assert.equal(r.status, "error");
    });
  });

  describe("error: backend", () => {
    it("rejects unknown backend string", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, backend: "unknown" });
      assert.equal(r.status, "error");
      assert.match(r.message, /backend.*bleak.*fake/i);
    });

    it("rejects empty backend", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, backend: "" });
      assert.equal(r.status, "error");
    });
  });

  describe("error: address", () => {
    it("rejects non-string address", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, address: 42 });
      assert.equal(r.status, "error");
      assert.match(r.message, /address/i);
    });

    it("rejects address longer than 120 characters", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, address: "A".repeat(121) });
      assert.equal(r.status, "error");
    });

    it("rejects address containing control characters", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, address: "AA\x00BB" });
      assert.equal(r.status, "error");
    });
  });

  describe("error: namePrefix", () => {
    it("rejects non-string namePrefix", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, namePrefix: 123 });
      assert.equal(r.status, "error");
      assert.match(r.message, /namePrefix/i);
    });

    it("rejects empty namePrefix", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, namePrefix: "" });
      assert.equal(r.status, "error");
    });

    it("rejects whitespace-only namePrefix", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, namePrefix: "   " });
      assert.equal(r.status, "error");
    });

    it("rejects namePrefix longer than 40 characters", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, namePrefix: "A".repeat(41) });
      assert.equal(r.status, "error");
    });

    it("rejects namePrefix containing control characters", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, namePrefix: "Claw\x00stick" });
      assert.equal(r.status, "error");
    });
  });

  describe("error: permissionsEnabled", () => {
    it("rejects non-boolean permissionsEnabled", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, permissionsEnabled: "no" });
      assert.equal(r.status, "error");
      assert.match(r.message, /permissionsEnabled.*boolean/i);
    });
  });

  describe("error: quickCommandsEnabled", () => {
    it("rejects non-boolean quickCommandsEnabled", () => {
      const r = validateHardwareBuddySettings({ ...validSettings, quickCommandsEnabled: 0 });
      assert.equal(r.status, "error");
      assert.match(r.message, /quickCommandsEnabled.*boolean/i);
    });
  });

  describe("error: missing required fields", () => {
    it("rejects when enabled is missing", () => {
      const { enabled, ...rest } = validSettings;
      const r = validateHardwareBuddySettings(rest);
      assert.equal(r.status, "error");
    });

    it("rejects when backend is missing", () => {
      const { backend, ...rest } = validSettings;
      const r = validateHardwareBuddySettings(rest);
      assert.equal(r.status, "error");
    });

    it("rejects when namePrefix is missing", () => {
      const { namePrefix, ...rest } = validSettings;
      const r = validateHardwareBuddySettings(rest);
      assert.equal(r.status, "error");
    });
  });
});

// ---------------------------------------------------------------------------
// hardwareBuddySettingsEqual
// ---------------------------------------------------------------------------
describe("hardwareBuddySettingsEqual", () => {
  it("returns true for identical objects", () => {
    const a = { enabled: true, backend: "fake", address: "X", namePrefix: "N", permissionsEnabled: false, quickCommandsEnabled: true };
    assert.equal(hardwareBuddySettingsEqual(a, a), true);
  });

  it("returns true for two default-setting objects", () => {
    assert.equal(hardwareBuddySettingsEqual({}, {}), true);
  });

  it("returns true for normalized equivalents with different raw representations", () => {
    // Both null inputs normalize to defaults
    assert.equal(hardwareBuddySettingsEqual(null, undefined), true);
  });

  it("returns false when enabled differs", () => {
    assert.equal(hardwareBuddySettingsEqual({ enabled: true }, { enabled: false }), false);
  });

  it("returns false when backend differs", () => {
    assert.equal(hardwareBuddySettingsEqual({ backend: "bleak" }, { backend: "fake" }), false);
  });

  it("returns false when address differs", () => {
    assert.equal(hardwareBuddySettingsEqual({ address: "A" }, { address: "B" }), false);
  });

  it("returns false when namePrefix differs", () => {
    assert.equal(hardwareBuddySettingsEqual({ namePrefix: "X" }, { namePrefix: "Y" }), false);
  });

  it("returns false when permissionsEnabled differs", () => {
    assert.equal(hardwareBuddySettingsEqual({ permissionsEnabled: true }, { permissionsEnabled: false }), false);
  });

  it("returns false when quickCommandsEnabled differs", () => {
    assert.equal(hardwareBuddySettingsEqual({ quickCommandsEnabled: true }, { quickCommandsEnabled: false }), false);
  });

  it("handles non-object inputs gracefully (both normalize to defaults)", () => {
    assert.equal(hardwareBuddySettingsEqual(42, "hello"), true);
    assert.equal(hardwareBuddySettingsEqual(null, { enabled: true }), false);
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  __test,
  registerUpdateBubbleIpc,
} = require("../src/update-bubble");

const { estimateHeight, computeAutoCloseRemainingMs, computeUpdateBubbleBounds } = __test;

describe("estimateHeight", () => {
  it("returns default 150 for null payload", () => {
    assert.strictEqual(estimateHeight(null), 150);
  });

  it("returns default 150 for undefined payload", () => {
    assert.strictEqual(estimateHeight(undefined), 150);
  });

  it("returns 220 for error mode", () => {
    assert.strictEqual(estimateHeight({ mode: "error" }), 220);
  });

  it("adds height for multi-line message", () => {
    const h1 = estimateHeight({ message: "line1" });
    const h2 = estimateHeight({ message: "line1\nline2\nline3" });
    assert.strictEqual(h2 - h1, 32); // (3-1)*16
  });

  it("adds height for detail text with wrapping", () => {
    const short = estimateHeight({ detail: "short" });
    const long = estimateHeight({ detail: "A".repeat(200) });
    assert.ok(long > short);
  });

  it("caps detail height contribution at 220", () => {
    const veryLong = estimateHeight({ detail: "B".repeat(5000) });
    const long = estimateHeight({ detail: "B".repeat(500) });
    const noDetail = estimateHeight({});
    // Very long text should not grow unboundedly
    assert.ok(veryLong < noDetail + 400);
    assert.ok(long < noDetail + 400);
  });

  it("adds 44px when actions array is present and non-empty", () => {
    const noActions = estimateHeight({ mode: "available" });
    const withActions = estimateHeight({ mode: "available", actions: [{ id: "ok" }] });
    assert.strictEqual(withActions - noActions, 44);
  });

  it("does not add actions height for empty actions array", () => {
    const noActions = estimateHeight({ mode: "available" });
    const emptyActions = estimateHeight({ mode: "available", actions: [] });
    assert.strictEqual(noActions, emptyActions);
  });

  it("handles detail with newlines and wrapping together", () => {
    const result = estimateHeight({
      detail: "Line one\nLine two\nLine three that is somewhat long and may wrap around the container width boundary",
    });
    assert.ok(result > 150);
  });
});

describe("computeAutoCloseRemainingMs", () => {
  it("returns 0 for non-positive autoCloseMs", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(1000, 0), 0);
    assert.strictEqual(computeAutoCloseRemainingMs(1000, -100), 0);
  });

  it("returns 0 for non-finite autoCloseMs", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(1000, NaN), 0);
    assert.strictEqual(computeAutoCloseRemainingMs(1000, Infinity), 0);
    assert.strictEqual(computeAutoCloseRemainingMs(1000, "abc"), 0);
  });

  it("returns full autoCloseMs when shownAt is not a valid positive number", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(0, 5000), 5000);
    assert.strictEqual(computeAutoCloseRemainingMs(-1, 5000), 5000);
    assert.strictEqual(computeAutoCloseRemainingMs(NaN, 5000), 5000);
    assert.strictEqual(computeAutoCloseRemainingMs("abc", 5000), 5000);
  });

  it("returns full autoCloseMs when shownAt is null or undefined", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(null, 5000), 5000);
    assert.strictEqual(computeAutoCloseRemainingMs(undefined, 5000), 5000);
  });

  it("computes remaining time correctly when partially elapsed", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(1000, 5000, 3000), 3000);
    assert.strictEqual(computeAutoCloseRemainingMs(1000, 5000, 4000), 2000);
  });

  it("returns 0 when fully elapsed", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(1000, 5000, 7000), 0);
    assert.strictEqual(computeAutoCloseRemainingMs(1000, 5000, 6000), 0);
  });

  it("clamps negative remaining to 0", () => {
    assert.strictEqual(computeAutoCloseRemainingMs(100, 50, 200), 0);
  });
});

describe("computeUpdateBubbleBounds", () => {
  it("uses bottom-right corner when not following pet", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: false,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      petBounds: null,
      anchorRect: null,
      hitRect: null,
    });

    assert.strictEqual(bounds.x, 1920 - 340 - 8);
    assert.strictEqual(bounds.y, 1080 - 8 - 150);
    assert.strictEqual(bounds.width, 340);
    assert.strictEqual(bounds.height, 150);
  });

  it("accounts for reservedHeight in bottom-right placement", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: false,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 100,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      petBounds: null,
      anchorRect: null,
      hitRect: null,
    });

    assert.strictEqual(bounds.y, 1080 - 8 - 150 - 100);
  });

  it("clamps y to workArea top edge", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: false,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      workArea: { x: 0, y: 100, width: 800, height: 200 },
      petBounds: null,
      anchorRect: null,
      hitRect: null,
    });

    assert.ok(bounds.y >= 100 + 8);
  });

  it("uses hitRect when anchorRect is not provided and following pet", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      anchorRect: null,
      hitRect: { left: 320, top: 88, right: 400, bottom: 168 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 174, width: 340, height: 150 });
  });

  it("falls back to side placement (right) when no room below or above", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 520,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      petBounds: { x: 100, y: 200, width: 120, height: 120 },
      anchorRect: { left: 100, top: 200, right: 180, bottom: 280 },
    });

    // right side of pet: 180 + gap = 186
    assert.strictEqual(bounds.x, 186);
    assert.strictEqual(bounds.width, 340);
    assert.strictEqual(bounds.height, 520);
  });

  it("falls back to side placement (left) when no room below/above and more space on left", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 520,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      petBounds: { x: 600, y: 200, width: 120, height: 120 },
      anchorRect: { left: 600, top: 200, right: 720, bottom: 280 },
    });

    // left side of pet: 600 - gap(6) - width(340) = 254
    assert.strictEqual(bounds.x, 254);
  });

  it("clamps bubble horizontally to work area bounds", () => {
    const bounds = computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 400, height: 900 },
      petBounds: { x: 0, y: 60, width: 120, height: 120 },
      anchorRect: { left: 0, top: 60, right: 120, bottom: 140 },
    });

    assert.ok(bounds.x >= 0);
    assert.ok(bounds.x + bounds.width <= 400);
  });
});

describe("registerUpdateBubbleIpc", () => {
  it("throws when ipcMain is missing", () => {
    assert.throws(() => {
      registerUpdateBubbleIpc({});
    }, /requires ipcMain/);
  });

  it("throws when updateBubble is missing", () => {
    assert.throws(() => {
      registerUpdateBubbleIpc({ ipcMain: { on() {}, removeListener() {} } });
    }, /requires updateBubble/);
  });

  it("throws when handleUpdateBubbleHeight is missing", () => {
    assert.throws(() => {
      registerUpdateBubbleIpc({
        ipcMain: { on() {}, removeListener() {} },
        updateBubble: { handleUpdateBubbleAction() {} },
      });
    }, /requires updateBubble\.handleUpdateBubbleHeight/);
  });

  it("throws when handleUpdateBubbleAction is missing", () => {
    assert.throws(() => {
      registerUpdateBubbleIpc({
        ipcMain: { on() {}, removeListener() {} },
        updateBubble: { handleUpdateBubbleHeight() {} },
      });
    }, /requires updateBubble\.handleUpdateBubbleAction/);
  });

  it("registers handlers and disposes them correctly", () => {
    const listeners = new Map();
    const ipcMain = {
      on(channel, handler) { listeners.set(channel, handler); },
      removeListener(channel) { listeners.delete(channel); },
    };
    const bubbleApi = {
      handleUpdateBubbleHeight: () => {},
      handleUpdateBubbleAction: () => {},
    };

    const registration = registerUpdateBubbleIpc({ ipcMain, updateBubble: bubbleApi });
    assert.strictEqual(listeners.size, 2);
    assert.ok(listeners.has("update-bubble-height"));
    assert.ok(listeners.has("update-bubble-action"));

    registration.dispose();
    assert.strictEqual(listeners.size, 0);
  });
});

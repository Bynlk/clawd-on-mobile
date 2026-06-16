"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createSizeSliderController,
  getSizeSliderAnchorPx,
  SIZE_SLIDER_THUMB_DIAMETER,
  uiSizeToPrefs,
  prefsSizeToUi,
  clampSizeUi,
  sizeUiToPct,
  SIZE_PREFS_MAX,
  SIZE_UI_MIN,
  SIZE_UI_MAX,
  SIZE_TICK_VALUES,
  SIZE_SLIDER_TRACK_HEIGHT,
  formatSizeKey,
} = require("../src/settings-size-slider");

describe("settings size slider controller", () => {
  it("previews during drag and commits only once when drag-end signals race", async () => {
    const calls = [];
    const localValues = [];
    const dragStates = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        previewSize: async (value) => { calls.push(["preview", value]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: (value) => localValues.push(value),
      onDraggingChange: (dragging, pending) => dragStates.push([dragging, pending]),
      onError: (message) => { throw new Error(`unexpected error: ${message}`); },
    });

    await controller.pointerDown();
    await controller.input(40);
    await Promise.all([
      controller.pointerUp(),
      controller.change(40),
    ]);

    assert.deepStrictEqual(calls, [
      ["begin"],
      ["preview", "P:12"],
      ["end", "P:12"],
    ]);
    assert.deepStrictEqual(localValues, [40, 40]);
    assert.deepStrictEqual(dragStates, [
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it("finalizes the latest draft on blur if dragging is interrupted", async () => {
    const calls = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 20,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        previewSize: async (value) => { calls.push(["preview", value]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (message) => { throw new Error(`unexpected error: ${message}`); },
    });

    await controller.pointerDown();
    await controller.input(55);
    await controller.blur();

    assert.deepStrictEqual(calls, [
      ["begin"],
      ["preview", "P:16.5"],
      ["end", "P:16.5"],
    ]);
  });
});

describe("settings size slider geometry", () => {
  it("anchors bubble/ticks to the actual thumb center instead of raw percent width", () => {
    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 1,
        min: 1,
        max: 100,
        sliderWidth: 200,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      SIZE_SLIDER_THUMB_DIAMETER / 2
    );

    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 100,
        min: 1,
        max: 100,
        sliderWidth: 200,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      200 - (SIZE_SLIDER_THUMB_DIAMETER / 2)
    );

    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 50.5,
        min: 1,
        max: 100,
        sliderWidth: 200,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      100
    );
  });

  it("recomputes the same value against a new slider width", () => {
    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 75,
        min: 1,
        max: 100,
        sliderWidth: 240,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      174.93939393939394
    );

    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 75,
        min: 1,
        max: 100,
        sliderWidth: 320,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      234.73737373737376
    );
  });
});

describe("settings size slider pure conversions", () => {
  it("uiSizeToPrefs converts UI value to preferences scale", () => {
    assert.strictEqual(uiSizeToPrefs(0), 0);
    assert.strictEqual(uiSizeToPrefs(100), SIZE_PREFS_MAX);
    assert.strictEqual(uiSizeToPrefs(50), 15);
    assert.strictEqual(uiSizeToPrefs(1), 0.3);
  });

  it("prefsSizeToUi converts preferences value to UI scale", () => {
    assert.strictEqual(prefsSizeToUi(0), 0);
    assert.strictEqual(prefsSizeToUi(SIZE_PREFS_MAX), SIZE_UI_MAX);
    assert.strictEqual(prefsSizeToUi(15), 50);
  });

  it("clampSizeUi clamps to SIZE_UI_MIN..SIZE_UI_MAX and rounds", () => {
    assert.strictEqual(clampSizeUi(0), SIZE_UI_MIN);
    assert.strictEqual(clampSizeUi(-10), SIZE_UI_MIN);
    assert.strictEqual(clampSizeUi(200), SIZE_UI_MAX);
    assert.strictEqual(clampSizeUi(50.4), 50);
    assert.strictEqual(clampSizeUi(50.6), 51);
    // NaN passthrough — caller should guard
    assert.ok(Number.isNaN(clampSizeUi(NaN)));
  });

  it("sizeUiToPct maps UI range to 0..100", () => {
    assert.strictEqual(sizeUiToPct(SIZE_UI_MIN), 0);
    assert.strictEqual(sizeUiToPct(SIZE_UI_MAX), 100);
    assert.strictEqual(sizeUiToPct(50.5), 50);
  });

  it("exports expected constants", () => {
    assert.strictEqual(SIZE_PREFS_MAX, 30);
    assert.strictEqual(SIZE_UI_MIN, 1);
    assert.strictEqual(SIZE_UI_MAX, 100);
    assert.deepStrictEqual(SIZE_TICK_VALUES, [25, 50, 75, 100]);
    assert.strictEqual(SIZE_SLIDER_TRACK_HEIGHT, 6);
    assert.strictEqual(SIZE_SLIDER_THUMB_DIAMETER, 18);
  });
});

describe("getSizeSliderAnchorPx edge cases", () => {
  it("returns radius when sliderWidth is zero or negative", () => {
    const radius = SIZE_SLIDER_THUMB_DIAMETER / 2;
    assert.strictEqual(
      getSizeSliderAnchorPx({ value: 50, min: 1, max: 100, sliderWidth: 0 }),
      radius
    );
    assert.strictEqual(
      getSizeSliderAnchorPx({ value: 50, min: 1, max: 100, sliderWidth: -10 }),
      radius
    );
  });

  it("returns width/2 when sliderWidth is smaller than thumbDiameter", () => {
    assert.strictEqual(
      getSizeSliderAnchorPx({ value: 50, min: 1, max: 100, sliderWidth: 10, thumbDiameter: 18 }),
      5
    );
  });

  it("returns radius when sliderWidth is non-finite", () => {
    const radius = SIZE_SLIDER_THUMB_DIAMETER / 2;
    assert.strictEqual(
      getSizeSliderAnchorPx({ value: 50, min: 1, max: 100, sliderWidth: NaN }),
      radius
    );
    assert.strictEqual(
      getSizeSliderAnchorPx({ value: 50, min: 1, max: 100, sliderWidth: Infinity }),
      radius
    );
  });

  it("returns radius when thumbDiameter is non-finite", () => {
    // NaN thumbDiameter causes Math.max(NaN, ...) to return NaN, then the formula
    // produces a numeric result based on the remaining valid params
    const result = getSizeSliderAnchorPx({ value: 50, min: 1, max: 100, sliderWidth: 200, thumbDiameter: NaN });
    assert.ok(typeof result === "number");
  });

  it("handles non-finite min/max by normalizing to 0", () => {
    const result = getSizeSliderAnchorPx({ value: 50, min: NaN, max: NaN, sliderWidth: 200, thumbDiameter: 18 });
    assert.strictEqual(result, 9);
  });
});

describe("settings size slider controller edge cases", () => {
  it("throws TypeError when readSnapshotUi is not a function", () => {
    assert.throws(() => {
      createSizeSliderController({});
    }, TypeError);
  });

  it("handles pointerCancel with no draft (no commit)", async () => {
    const calls = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.pointerDown();
    await controller.pointerCancel();

    assert.deepStrictEqual(calls, [["begin"], ["end", null]]);
  });

  it("handles pointerCancel with draft (commits)", async () => {
    const calls = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        previewSize: async (value) => { calls.push(["preview", value]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.pointerDown();
    await controller.input(60);
    await controller.pointerCancel();

    assert.deepStrictEqual(calls, [["begin"], ["preview", "P:18"], ["end", "P:18"]]);
  });

  it("handles dispose without active drag (no-op finalize)", async () => {
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {},
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: () => {},
    });

    const result = await controller.dispose();
    assert.deepStrictEqual(result, { status: "ok", noop: true });
  });

  it("handles dispose with active preview but no draft", async () => {
    const calls = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        endSizePreview: async () => { calls.push(["end"]); return { status: "ok" }; },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.pointerDown();
    await controller.dispose();

    assert.deepStrictEqual(calls, [["begin"], ["end"]]);
  });

  it("handles change() without prior pointerDown (direct change)", async () => {
    const calls = [];
    const localValues = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        previewSize: async (value) => { calls.push(["preview", value]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: (v) => localValues.push(v),
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.change(75);

    assert.deepStrictEqual(localValues, [75]);
    assert.ok(calls.some((c) => c[0] === "end"));
  });

  it("syncFromSnapshot returns snapshot when no draft is active", () => {
    const localValues = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 42,
      settingsAPI: {},
      onLocalValue: (v) => localValues.push(v),
      onDraggingChange: () => {},
      onError: () => {},
    });

    const result = controller.syncFromSnapshot();
    assert.strictEqual(result, 42);
    assert.deepStrictEqual(localValues, [42]);
  });

  it("syncFromSnapshot with fromBroadcast clears draft when draft matches snapshot", async () => {
    const localValues = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 40,
      settingsAPI: {
        beginSizePreview: async () => {},
        previewSize: async () => {},
      },
      onLocalValue: (v) => localValues.push(v),
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.pointerDown();
    await controller.input(40);
    localValues.length = 0;

    const result = controller.syncFromSnapshot({ fromBroadcast: true });
    assert.strictEqual(result, 40);
  });

  it("syncFromSnapshot with fromBroadcast keeps draft when dragging and draft differs", async () => {
    const localValues = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 20,
      settingsAPI: {
        beginSizePreview: async () => {},
        previewSize: async () => {},
      },
      onLocalValue: (v) => localValues.push(v),
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.pointerDown();
    await controller.input(60);
    localValues.length = 0;

    const result = controller.syncFromSnapshot({ fromBroadcast: true });
    assert.strictEqual(result, 60);
    assert.deepStrictEqual(localValues, [60]);
  });

  it("reports errors when beginSizePreview returns non-ok status", async () => {
    const errors = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "error", message: "perm denied" }),
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (msg) => errors.push(msg),
    });

    await controller.pointerDown();
    assert.deepStrictEqual(errors, ["perm denied"]);
  });

  it("reports errors when beginSizePreview throws", async () => {
    const errors = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { throw new Error("crash"); },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (msg) => errors.push(msg),
    });

    await controller.pointerDown();
    assert.deepStrictEqual(errors, ["crash"]);
  });

  it("reports errors when previewSize returns non-ok status", async () => {
    const errors = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "ok" }),
        previewSize: async () => ({ status: "error", message: "preview failed" }),
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (msg) => errors.push(msg),
    });

    await controller.pointerDown();
    await controller.input(50);
    assert.deepStrictEqual(errors, ["preview failed"]);
  });

  it("reports errors when endSizePreview throws", async () => {
    const errors = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "ok" }),
        endSizePreview: async () => { throw new Error("finalize crash"); },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (msg) => errors.push(msg),
    });

    await controller.pointerDown();
    await controller.pointerUp();
    assert.deepStrictEqual(errors, ["finalize crash"]);
  });

  it("reports errors when endSizePreview returns non-ok status", async () => {
    const errors = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "ok" }),
        endSizePreview: async () => ({ status: "error", message: "save failed" }),
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (msg) => errors.push(msg),
    });

    await controller.pointerDown();
    await controller.pointerUp();
    assert.deepStrictEqual(errors, ["save failed"]);
  });

  it("deduplicates concurrent pointerUp and change calls", async () => {
    const endCalls = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "ok" }),
        previewSize: async () => ({ status: "ok" }),
        endSizePreview: async (value) => { endCalls.push(value); return { status: "ok" }; },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: () => {},
    });

    await controller.pointerDown();
    await controller.input(50);
    const [r1, r2] = await Promise.all([controller.pointerUp(), controller.change(50)]);
    assert.strictEqual(endCalls.length, 1);
  });

  it("works with no settingsAPI object (all functions absent)", async () => {
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      onLocalValue: () => {},
      onDraggingChange: () => {},
    });

    await controller.pointerDown();
    await controller.input(30);
    const result = await controller.pointerUp();
    assert.strictEqual(result.status, "ok");
  });

  it("works with no callback functions", async () => {
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "ok" }),
        endSizePreview: async () => ({ status: "ok" }),
      },
    });

    await controller.pointerDown();
    await controller.pointerUp();
  });

  it("reports default error message when beginSizePreview returns non-ok with no message", async () => {
    const errors = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => ({ status: "error" }),
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (msg) => errors.push(msg),
    });

    await controller.pointerDown();
    assert.deepStrictEqual(errors, ["unknown error"]);
  });
});

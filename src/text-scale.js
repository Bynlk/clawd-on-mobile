"use strict";

// Per-window text zoom (settings keys: textScale + textScaleByDisplay).
//
// Mechanism: root CSS zoom injected per document — NOT webContents
// setZoomFactor. Chromium's zoom map is keyed by scheme+host per partition,
// and every loadFile window shares the empty file:// host, so setZoomFactor
// values propagate across all text windows AND the pet windows; that makes
// per-display divergence impossible. Root CSS zoom is per-document: layout
// viewport shrinks exactly like zoomFactor (window DIP / zoom) while
// offsetHeight/scrollHeight keep reporting unzoomed CSS px (verified
// empirically on this Electron version), so all CSS px ↔ DIP conventions in
// the geometry code hold unchanged. See docs/plans/plan-text-scale.md.
const TEXT_SCALE_MIN = 0.8;
const TEXT_SCALE_MAX = 1.6;
const TEXT_SCALE_DEFAULT = 1;
const TEXT_SCALE_STEP = 0.05;

function isValidTextScale(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= TEXT_SCALE_MIN
    && value <= TEXT_SCALE_MAX;
}

function clampTextScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TEXT_SCALE_DEFAULT;
  if (n < TEXT_SCALE_MIN) return TEXT_SCALE_MIN;
  if (n > TEXT_SCALE_MAX) return TEXT_SCALE_MAX;
  return n;
}

// CSS px → DIP. Widths round: bubble base widths are multiples of 20, so every
// 5% step lands on an integer and the CSS viewport width stays exact — cached
// renderer-side heights survive scale changes. Heights ceil so a rounded-down
// window can never clip scaled content.
function scaleWidth(cssPx, scale) {
  return Math.round(cssPx * clampTextScale(scale));
}

function scaleHeight(cssPx, scale) {
  return Math.ceil(cssPx * clampTextScale(scale));
}

function applyZoomToWindow(win, scale) {
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc) return false;
  if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return false;
  const s = clampTextScale(scale);
  // Reposition paths call this every frame during pet drags; re-injecting the
  // same value would spam executeJavaScript, so memoize per webContents.
  if (wc.__clawdAppliedTextZoom === s) return true;
  try {
    // Neutralize any shared HostZoomMap factor first — including values that
    // earlier setZoomFactor-based builds persisted into the partition — so
    // the injected root CSS zoom is the only scaling in effect.
    if (typeof wc.setZoomFactor === "function") wc.setZoomFactor(1);
    if (typeof wc.executeJavaScript !== "function") return false;
    const result = wc.executeJavaScript(
      `document.documentElement.style.zoom = "${s}"`,
      true
    );
    if (result && typeof result.catch === "function") result.catch(() => {});
    wc.__clawdAppliedTextZoom = s;
    return true;
  } catch {
    return false;
  }
}

// Resolve the effective scale for one display key, falling back to the
// legacy/global `textScale` value for displays the user has not tuned.
function resolveTextScaleForKey(byDisplay, fallback, key) {
  const map = byDisplay && typeof byDisplay === "object" && !Array.isArray(byDisplay) ? byDisplay : {};
  const k = typeof key === "string" && key ? key : null;
  if (k && Object.prototype.hasOwnProperty.call(map, k)) return clampTextScale(map[k]);
  return clampTextScale(fallback);
}

// Keep the per-display map bounded and every entry valid. Display ids can
// churn across reconnects/reboots, so stale keys accumulate; 16 displays is
// far beyond any real setup.
const TEXT_SCALE_MAX_DISPLAY_ENTRIES = 16;

function normalizeTextScaleByDisplay(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (!isValidTextScale(raw)) continue;
    out[key] = raw;
    count += 1;
    if (count >= TEXT_SCALE_MAX_DISPLAY_ENTRIES) break;
  }
  return out;
}

// Settings slider mapping (UI works in whole percent: 80–160, step 5).
function textScaleToUiPercent(scale) {
  return Math.round(clampTextScale(scale) * 100);
}

function uiPercentToTextScale(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n)) return TEXT_SCALE_DEFAULT;
  return clampTextScale(n / 100);
}

module.exports = {
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_DEFAULT,
  TEXT_SCALE_STEP,
  TEXT_SCALE_MAX_DISPLAY_ENTRIES,
  isValidTextScale,
  clampTextScale,
  scaleWidth,
  scaleHeight,
  applyZoomToWindow,
  resolveTextScaleForKey,
  normalizeTextScaleByDisplay,
  textScaleToUiPercent,
  uiPercentToTextScale,
};

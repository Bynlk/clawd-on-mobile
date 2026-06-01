#!/usr/bin/env node
// Extract crab face from icon.png and create transparent dock icon.
// Usage: node scripts/extract-dock-icon.js

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const INPUT = path.join(__dirname, "..", "assets", "icon.png");
const OUTPUT = path.join(__dirname, "..", "assets", "dock-icon.png");

const img = PNG.sync.read(fs.readFileSync(INPUT));
const { width, height, data } = img;

// The crab face (eyes > <  and blush) is centered in the pink rounded rect.
// Strategy: find the pink background color at a corner pixel,
// then scan inward to find the actual content bounds.

// Sample the dominant background color from the top-left non-transparent area
function getBackgroundSample() {
  // Top-left corner of the pink area (roughly 5% in from edges)
  const sx = Math.floor(width * 0.05);
  const sy = Math.floor(height * 0.05);
  const idx = (sy * width + sx) * 4;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

const bg = getBackgroundSample();
console.log(`Background color: rgb(${bg.r}, ${bg.g}, ${bg.b})`);

// Find content bounding box (non-background, non-transparent pixels)
// Use a color distance threshold to handle anti-aliased edges
function colorDist(idx, target) {
  const dr = data[idx] - target.r;
  const dg = data[idx + 1] - target.g;
  const db = data[idx + 2] - target.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

const THRESHOLD = 80; // color distance to consider "background"
let minX = width, minY = height, maxX = 0, maxY = 0;
let contentPixels = 0;

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 4;
    const alpha = data[idx + 3];
    if (alpha < 10) continue; // fully transparent
    const dist = colorDist(idx, bg);
    if (dist > THRESHOLD) {
      // This is content (not background)
      contentPixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log(`Content bounds: (${minX},${minY}) to (${maxX},${maxY})`);
console.log(`Content pixels: ${contentPixels}`);

// Add small padding (3% of content size) for safety
const contentW = maxX - minX + 1;
const contentH = maxY - minY + 1;
const pad = Math.max(Math.floor(Math.max(contentW, contentH) * 0.03), 2);

const cropX = Math.max(0, minX - pad);
const cropY = Math.max(0, minY - pad);
const cropW = Math.min(width - cropX, contentW + pad * 2);
const cropH = Math.min(height - cropY, contentH + pad * 2);

console.log(`Crop: (${cropX},${cropY}) ${cropW}x${cropH}`);

// Create output image
const out = new PNG({ width: cropW, height: cropH });

for (let y = 0; y < cropH; y++) {
  for (let x = 0; x < cropW; x++) {
    const srcX = cropX + x;
    const srcY = cropY + y;
    const srcIdx = (srcY * width + srcX) * 4;
    const dstIdx = (y * cropW + x) * 4;

    const alpha = data[srcIdx + 3];
    const dist = colorDist(srcIdx, bg);

    if (alpha < 10 || dist <= THRESHOLD) {
      // Background or transparent → fully transparent
      out.data[dstIdx] = 0;
      out.data[dstIdx + 1] = 0;
      out.data[dstIdx + 2] = 0;
      out.data[dstIdx + 3] = 0;
    } else {
      // Content → keep original pixels
      out.data[dstIdx] = data[srcIdx];
      out.data[dstIdx + 1] = data[srcIdx + 1];
      out.data[dstIdx + 2] = data[srcIdx + 2];
      out.data[dstIdx + 3] = data[srcIdx + 3];
    }
  }
}

// Scale up to 1024x1024 for macOS dock (nearest neighbor to keep crisp)
const TARGET = 1024;
const scaled = new PNG({ width: TARGET, height: TARGET });

// Calculate scale to fit content in TARGET with minimal padding
const scale = Math.min((TARGET - 40) / cropW, (TARGET - 40) / cropH); // 20px safety
const newW = Math.floor(cropW * scale);
const newH = Math.floor(cropH * scale);
const offsetX = Math.floor((TARGET - newW) / 2);
const offsetY = Math.floor((TARGET - newH) / 2);

for (let y = 0; y < TARGET; y++) {
  for (let x = 0; x < TARGET; x++) {
    const dstIdx = (y * TARGET + x) * 4;
    scaled.data[dstIdx] = 0;
    scaled.data[dstIdx + 1] = 0;
    scaled.data[dstIdx + 2] = 0;
    scaled.data[dstIdx + 3] = 0;

    const srcX = Math.floor((x - offsetX) / scale);
    const srcY = Math.floor((y - offsetY) / scale);

    if (srcX >= 0 && srcX < cropW && srcY >= 0 && srcY < cropH) {
      const srcIdx = (srcY * cropW + srcX) * 4;
      scaled.data[dstIdx] = out.data[srcIdx];
      scaled.data[dstIdx + 1] = out.data[srcIdx + 1];
      scaled.data[dstIdx + 2] = out.data[srcIdx + 2];
      scaled.data[dstIdx + 3] = out.data[srcIdx + 3];
    }
  }
}

const buffer = PNG.sync.write(scaled);
fs.writeFileSync(OUTPUT, buffer);
console.log(`Dock icon saved: ${OUTPUT} (${TARGET}x${TARGET})`);

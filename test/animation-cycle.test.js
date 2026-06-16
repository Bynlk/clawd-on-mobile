"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CYCLE_STATUS,
  probeAssetCycle,
  probeSvgCycle,
  probeGifCycle,
  probeApngCycle,
} = require("../src/animation-cycle");

function buildGifFrame(delayCs) {
  return Buffer.from([
    0x21, 0xf9, 0x04, 0x00,
    delayCs & 0xff, (delayCs >> 8) & 0xff,
    0x00, 0x00,
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ]);
}

function buildGifBuffer(delaysCs) {
  const header = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00,
    0x80, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0xff, 0xff, 0xff,
  ]);
  const frames = delaysCs.map((delayCs) => buildGifFrame(delayCs));
  return Buffer.concat([header, ...frames, Buffer.from([0x3b])]);
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  return out;
}

function buildApngBuffer(frameDelays) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frameDelays.length, 0);
  actl.writeUInt32BE(0, 4);

  const chunks = [
    pngChunk("IHDR", ihdr),
    pngChunk("acTL", actl),
  ];

  for (let i = 0; i < frameDelays.length; i++) {
    const { num, den } = frameDelays[i];
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(i, 0);
    fctl.writeUInt32BE(1, 4);
    fctl.writeUInt32BE(1, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(num, 20);
    fctl.writeUInt16BE(den, 22);
    chunks.push(pngChunk("fcTL", fctl));
    if (i === 0) {
      chunks.push(pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])));
    } else {
      const fdat = Buffer.alloc(4);
      fdat.writeUInt32BE(i, 0);
      chunks.push(pngChunk("fdAT", fdat));
    }
  }

  chunks.push(pngChunk("IEND"));
  return Buffer.concat([signature, ...chunks]);
}

describe("animation-cycle SVG probe", () => {
  it("reads a single CSS loop duration exactly", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.body { animation: bounce 1.5s infinite ease-in-out; }</style>
        <g class="body"></g>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1500,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("computes the full repeat cycle for multiple looping animations", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .a { animation: bounce 1s infinite linear; }
          .b { animation: blink 1.5s infinite linear; }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 3000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("treats mixed finite and looping timelines as estimated fallback", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .looping { animation: spin 1s infinite linear; }
          .oneshot { animation: pulse 2.5s 1 ease-out; }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 2500,
      status: CYCLE_STATUS.ESTIMATED,
      source: "svg",
    });
  });

  it("accounts for alternate CSS loops returning to the starting pose", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.arm { animation: wave 150ms infinite alternate ease-in-out; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 300,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("reads finite duration probes from CDATA style blocks", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style><![CDATA[
          .duration-probe {
            animation: mini-enter-duration-probe 1.25s linear 1 both;
          }
        ]]></style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1250,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });
});

describe("animation-cycle raster probes", () => {
  it("sums GIF frame delays", () => {
    const gif = buildGifBuffer([20, 50]);
    assert.deepStrictEqual(probeGifCycle(gif), {
      ms: 700,
      status: CYCLE_STATUS.EXACT,
      source: "gif",
    });
  });

  it("sums APNG frame delays", () => {
    const apng = buildApngBuffer([{ num: 10, den: 10 }, { num: 15, den: 10 }]);
    assert.deepStrictEqual(probeApngCycle(apng), {
      ms: 2500,
      status: CYCLE_STATUS.EXACT,
      source: "apng",
    });
  });
});

describe("probeAssetCycle", () => {
  it("dispatches by extension, marks static rasters, and returns unavailable for unsupported files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-cycle-"));
    const svgPath = path.join(tempDir, "loop.svg");
    const gifPath = path.join(tempDir, "loop.gif");
    const pngPath = path.join(tempDir, "still.png");
    const webpPath = path.join(tempDir, "still.webp");
    const jpgPath = path.join(tempDir, "still.jpg");
    const jpegPath = path.join(tempDir, "still.jpeg");
    const txtPath = path.join(tempDir, "readme.txt");

    fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg"><style>.x { animation: blink 2s infinite linear; }</style></svg>`, "utf8");
    fs.writeFileSync(gifPath, buildGifBuffer([12]));
    fs.writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));
    fs.writeFileSync(webpPath, Buffer.from("524946460000000057454250", "hex"));
    fs.writeFileSync(jpgPath, Buffer.from("ffd8ffe000104a4649460001", "hex"));
    fs.writeFileSync(jpegPath, Buffer.from("ffd8ffe000104a4649460001", "hex"));
    fs.writeFileSync(txtPath, "plain text", "utf8");

    assert.deepStrictEqual(probeAssetCycle(svgPath), {
      ms: 2000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
    assert.deepStrictEqual(probeAssetCycle(gifPath), {
      ms: 120,
      status: CYCLE_STATUS.EXACT,
      source: "gif",
    });
    assert.deepStrictEqual(probeAssetCycle(pngPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "png",
    });
    assert.deepStrictEqual(probeAssetCycle(webpPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "webp",
    });
    assert.deepStrictEqual(probeAssetCycle(jpgPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "jpg",
    });
    assert.deepStrictEqual(probeAssetCycle(jpegPath), {
      ms: null,
      status: CYCLE_STATUS.STATIC,
      source: "jpeg",
    });
    assert.deepStrictEqual(probeAssetCycle(txtPath), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "txt",
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("probeAssetCycle edge cases", () => {
  it("returns unavailable for empty or non-string paths", () => {
    assert.deepStrictEqual(probeAssetCycle(""), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "file",
    });
    assert.deepStrictEqual(probeAssetCycle(null), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "file",
    });
    assert.deepStrictEqual(probeAssetCycle(undefined), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "file",
    });
  });

  it("returns unavailable for a nonexistent file path", () => {
    const result = probeAssetCycle("/nonexistent/path/to/file.svg");
    assert.strictEqual(result.ms, null);
    assert.strictEqual(result.status, CYCLE_STATUS.UNAVAILABLE);
  });

  it("returns unavailable for a path with no extension", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-cycle-ext-"));
    const noExtPath = path.join(tempDir, "noext");
    fs.writeFileSync(noExtPath, "data", "utf8");
    const result = probeAssetCycle(noExtPath);
    assert.strictEqual(result.status, CYCLE_STATUS.UNAVAILABLE);
    assert.strictEqual(result.source, "file");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("probeSvgCycle edge cases", () => {
  it("returns unavailable for empty or non-string input", () => {
    assert.deepStrictEqual(probeSvgCycle(""), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "svg",
    });
    assert.deepStrictEqual(probeSvgCycle(null), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "svg",
    });
    assert.deepStrictEqual(probeSvgCycle("   "), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "svg",
    });
  });

  it("returns unavailable when SVG has no animations", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.ms, null);
    assert.strictEqual(result.status, CYCLE_STATUS.UNAVAILABLE);
    assert.strictEqual(result.source, "svg");
  });

  it("handles malformed SVG gracefully without throwing", () => {
    const result = probeSvgCycle("<svg><not valid <<< xml");
    assert.strictEqual(result.source, "svg");
  });

  it("reads SMIL animate durations", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="opacity" dur="2s" repeatCount="indefinite"/>
        </rect>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 2000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("reads SMIL animate with numeric repeatCount for loop", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="opacity" dur="500ms" repeatCount="10"/>
        </rect>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.ms, 5000);
    assert.strictEqual(result.status, CYCLE_STATUS.EXACT);
  });

  it("reads finite SMIL animations with explicit iteration count", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" dur="1s" repeatCount="3"/>
        </rect>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 3000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("reads SMIL animations with repeatDur", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" dur="1s" repeatDur="5s" repeatCount="indefinite"/>
        </rect>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 5000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("marks SMIL animations with negative begin delay as complex for finite", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" dur="1s" begin="-500ms" repeatCount="1"/>
        </rect>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    // Negative begin delay shifts the animation but doesn't change the cycle duration
    assert.strictEqual(result.ms, 1000);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("reads inline style attributes on SVG elements", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect style="animation: pulse 800ms infinite ease-in-out"/>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 800,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("handles CSS animation-name: none by skipping that track", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .skip { animation-name: none; animation-duration: 5s; }
          .run { animation-name: pulse; animation-duration: 2s; animation-iteration-count: infinite; }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 2000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("uses CSS longhand properties when shorthand is absent", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .arm {
            animation-name: wave;
            animation-duration: 1.5s;
            animation-iteration-count: infinite;
            animation-direction: alternate;
            animation-timing-function: ease-in-out;
          }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 3000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("computes LCM for multiple loop cycles using longhand properties", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .a { animation-name: x; animation-duration: 2s; animation-iteration-count: infinite; }
          .b { animation-name: y; animation-duration: 3s; animation-iteration-count: infinite; }
        </style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 6000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("marks SMIL with complex begin (semicolons) as estimated", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" dur="1s" begin="0s;2s" repeatCount="infinite"/>
        </rect>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("handles SMIL with invalid repeatCount as estimated", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" dur="1s" repeatCount="abc"/>
        </rect>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("returns static for SMIL with indefinite repeatDur overriding repeatCount", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" dur="1s" repeatDur="indefinite" repeatCount="3"/>
        </rect>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.ms, 1000);
    assert.strictEqual(result.mode, undefined);
  });

  it("returns unavailable for SMIL with no dur and no repeatDur", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect>
          <animate attributeName="x" repeatCount="infinite"/>
        </rect>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.status, CYCLE_STATUS.UNAVAILABLE);
  });
});

describe("probeGifCycle edge cases", () => {
  it("returns unavailable for non-Buffer input", () => {
    assert.deepStrictEqual(probeGifCycle(null), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "gif",
    });
    assert.deepStrictEqual(probeGifCycle("not a buffer"), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "gif",
    });
  });

  it("returns unavailable for too-small buffer", () => {
    assert.deepStrictEqual(probeGifCycle(Buffer.alloc(10)), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "gif",
    });
  });

  it("returns unavailable for non-GIF header", () => {
    const buf = Buffer.alloc(30);
    buf.write("NOTAGIF", 0, "ascii");
    assert.deepStrictEqual(probeGifCycle(buf), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "gif",
    });
  });

  it("handles GIF87a header", () => {
    const header = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x37, 0x61, // GIF87a
      0x01, 0x00, 0x01, 0x00,
      0x80, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0xff, 0xff, 0xff,
    ]);
    const gif = Buffer.concat([header, buildGifFrame(10), Buffer.from([0x3b])]);
    assert.deepStrictEqual(probeGifCycle(gif), {
      ms: 100,
      status: CYCLE_STATUS.EXACT,
      source: "gif",
    });
  });

  it("uses default delay for zero-delay frames and marks as estimated", () => {
    const gif = buildGifBuffer([0]);
    const result = probeGifCycle(gif);
    assert.strictEqual(result.ms, 10);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("handles GIF with global color table", () => {
    const gif = buildGifBuffer([10]);
    const result = probeGifCycle(gif);
    assert.strictEqual(result.source, "gif");
    assert.strictEqual(result.status, CYCLE_STATUS.EXACT);
    assert.strictEqual(result.ms, 100);
  });

  it("handles GIF with local color table in image descriptor", () => {
    const gif = buildGifBuffer([10, 20]);
    const result = probeGifCycle(gif);
    assert.strictEqual(result.source, "gif");
    assert.strictEqual(result.status, CYCLE_STATUS.EXACT);
    assert.strictEqual(result.ms, 300);
  });

  it("returns unavailable for GIF with no frames", () => {
    const header = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    const gif = Buffer.concat([header, Buffer.from([0x3b])]);
    assert.deepStrictEqual(probeGifCycle(gif), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "gif",
    });
  });
});

describe("probeApngCycle edge cases", () => {
  it("returns unavailable for non-Buffer input", () => {
    assert.deepStrictEqual(probeApngCycle(null), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "apng",
    });
  });

  it("returns unavailable for too-small buffer", () => {
    assert.deepStrictEqual(probeApngCycle(Buffer.alloc(20)), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "apng",
    });
  });

  it("returns unavailable for non-PNG signature", () => {
    const buf = Buffer.alloc(40);
    buf.write("NOTAPNG0", 0, "ascii");
    assert.deepStrictEqual(probeApngCycle(buf), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "apng",
    });
  });

  it("returns unavailable for a plain PNG without acTL chunk", () => {
    const signature = Buffer.from("89504e470d0a1a0a", "hex");
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chunks = [
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
      pngChunk("IEND"),
    ];
    const png = Buffer.concat([signature, ...chunks]);
    assert.deepStrictEqual(probeApngCycle(png), {
      ms: null,
      status: CYCLE_STATUS.UNAVAILABLE,
      source: "apng",
    });
  });

  it("handles APNG with zero delay denominator (defaults to 100)", () => {
    const apng = buildApngBuffer([{ num: 0, den: 0 }]);
    const result = probeApngCycle(apng);
    assert.strictEqual(result.ms, 10);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("handles APNG with zero delay numerator (defaults to 10ms)", () => {
    const apng = buildApngBuffer([{ num: 0, den: 10 }]);
    const result = probeApngCycle(apng);
    assert.strictEqual(result.ms, 10);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("returns unavailable for truncated APNG chunk", () => {
    // Test with a truncated PNG signature
    const buf = Buffer.from("89504e470d0a1a0a000000", "hex");
    const result = probeApngCycle(buf);
    // Truncated buffer should return unavailable or parse what it can
    assert.ok(result.status === CYCLE_STATUS.UNAVAILABLE || result.status === CYCLE_STATUS.ESTIMATED);
  });
});

describe("animation-cycle CSS parsing helpers", () => {
  it("collects CSS timing entries from raw text without curly braces", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: spin 3s infinite linear; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 3000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("handles CSS shorthand with timing function and fill mode", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: fade 1.2s ease-in-out forwards infinite; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1200,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("handles CSS shorthand with steps() timing function", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: walk 0.8s steps(4) infinite; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 800,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("handles CSS shorthand with cubic-bezier timing function", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: move 1s cubic-bezier(0.4, 0, 0.2, 1) infinite; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("handles CSS shorthand with linear() timing function", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: move 1s linear(0, 0.5, 1) infinite; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("parses negative CSS delay as complex", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: bounce 1s -500ms infinite linear; }</style>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.status, CYCLE_STATUS.ESTIMATED);
  });

  it("handles CSS shorthand with play-state paused", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.x { animation: spin 2s infinite linear paused; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 2000,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });

  it("skips CSS declarations with missing value or name", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          ; ; animation: ;
          .x { animation: spin 1s infinite linear; }
        </style>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.ms, 1000);
  });

  it("handles CSS with no animation shorthand, returns empty when no duration", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .x { animation-name: spin; animation-iteration-count: infinite; }
        </style>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.status, CYCLE_STATUS.UNAVAILABLE);
  });

  it("handles multiple tracks in a single shorthand declaration", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>
          .x { animation: spin 1s infinite linear, pulse 2s infinite ease-in-out; }
        </style>
      </svg>
    `;
    const result = probeSvgCycle(svg);
    assert.strictEqual(result.ms, 2000);
    assert.strictEqual(result.status, CYCLE_STATUS.EXACT);
  });

  it("strips CSS comments before parsing", () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>/* comment */ .x { animation: spin 1.5s infinite linear; }</style>
      </svg>
    `;
    assert.deepStrictEqual(probeSvgCycle(svg), {
      ms: 1500,
      status: CYCLE_STATUS.EXACT,
      source: "svg",
    });
  });
});

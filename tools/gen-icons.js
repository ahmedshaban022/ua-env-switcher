// Generates the extension icons (purple rounded square, white ⇄ arrows,
// green accent dot) with zero dependencies. 2x supersampled then
// box-downsampled for smooth edges. Run: node tools/gen-icons.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---------- tiny PNG writer (RGBA, no interlace) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePNG(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
}

// ---------- drawing ----------

function makeIcon(size) {
  const S = size * 2; // supersample factor 2
  const px = new Float32Array(S * S * 4); // coverage-based RGBA

  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = Math.max(px[i + 3], a);
  };

  // Background: rounded square #7C3AED with a subtle vertical shade.
  const rad = S * 0.22;
  const inRounded = (x, y) => {
    const min = rad;
    const max = S - rad;
    const cx = Math.min(Math.max(x, min), max);
    const cy = Math.min(Math.max(y, min), max);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= rad * rad;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inRounded(x, y)) {
        const t = y / S;
        set(x, y, 124 + 10 * t, 58 + 6 * t, 237 - 14 * t, 255);
      }
    }
  }

  const rect = (x0, y0, x1, y1, r, g, b, a) => {
    for (let y = Math.floor(y0 * S); y < Math.ceil(y1 * S); y++) {
      for (let x = Math.floor(x0 * S); x < Math.ceil(x1 * S); x++) {
        set(x, y, r, g, b, a);
      }
    }
  };

  // Filled triangle via edge functions over the bounding box (unit-space
  // vertices, pixel-center sampling — smooth once downsampled).
  const tri = (ax, ay, bx, by, cx, cy, r, g, b, a) => {
    const minX = Math.floor(Math.min(ax, bx, cx) * S);
    const maxX = Math.ceil(Math.max(ax, bx, cx) * S);
    const minY = Math.floor(Math.min(ay, by, cy) * S);
    const maxY = Math.ceil(Math.max(ay, by, cy) * S);
    const edge = (px0, py0, qx, qy, xx, yy) => (xx - px0) * (qy - py0) - (yy - py0) * (qx - px0);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const sx = (x + 0.5) / S;
        const sy = (y + 0.5) / S;
        const d1 = edge(ax, ay, bx, by, sx, sy);
        const d2 = edge(bx, by, cx, cy, sx, sy);
        const d3 = edge(cx, cy, ax, ay, sx, sy);
        const hit = (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
        if (hit) set(x, y, r, g, b, a);
      }
    }
  };

  // White ⇄: top arrow points right, bottom arrow points left.
  rect(0.26, 0.315, 0.58, 0.395, 255, 255, 255, 255);
  tri(0.57, 0.24, 0.57, 0.47, 0.76, 0.355, 255, 255, 255, 255);
  rect(0.42, 0.605, 0.74, 0.685, 255, 255, 255, 255);
  tri(0.43, 0.53, 0.43, 0.76, 0.24, 0.645, 255, 255, 255, 255);

  // Green accent dot (the "go" marker under the arrows).
  const cx = 0.5;
  const cy = 0.86;
  const cr = 0.075;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - cx;
      const dy = (y + 0.5) / S - cy;
      if (dx * dx + dy * dy <= cr * cr) set(x, y, 74, 222, 128, 255);
    }
  }

  // Downsample 2x2 -> size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * S + (x * 2 + dx)) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = r / 4;
      out[o + 1] = g / 4;
      out[o + 2] = b / 4;
      out[o + 3] = a / 4;
    }
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  writePNG(path.join(OUT, `icon${size}.png`), size, size, makeIcon(size));
  console.log(`icon${size}.png written`);
}

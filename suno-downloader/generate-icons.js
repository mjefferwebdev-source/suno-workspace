/**
 * generate-icons.js
 * Creates icons/icon-48.png and icons/icon-96.png using only Node built-ins.
 * Run once: node generate-icons.js
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG chunk builder ──────────────────────────────────────────────────────
function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf   = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── PNG builder (RGB, no alpha) ────────────────────────────────────────────
function makePNG(size, pixels /* Uint8Array, size*size*3 */) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB
  // bytes 10-12 already 0 (deflate, adaptive filter, no interlace)

  // Build filtered scanlines (filter byte 0 = None per row)
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 3);
    raw[rowOff] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const pi = (y * size + x) * 3;
      const ri = rowOff + 1 + x * 3;
      raw[ri]     = pixels[pi];
      raw[ri + 1] = pixels[pi + 1];
      raw[ri + 2] = pixels[pi + 2];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Draw icon: purple background + white down-arrow ────────────────────────
function drawIcon(size) {
  const px = new Uint8Array(size * size * 3);

  const BG = [124, 58, 237];   // #7c3aed  purple
  const FG = [255, 255, 255];  // white

  function set(x, y, rgb) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
  }

  function fillRect(x, y, w, h, rgb) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        set(x + dx, y + dy, rgb);
  }

  // Background
  fillRect(0, 0, size, size, BG);

  // Round corners (just blank 2px squares at each corner)
  const r = Math.max(2, Math.round(size * 0.12));
  fillRect(0, 0, r, r, BG);
  fillRect(size - r, 0, r, r, BG);
  fillRect(0, size - r, r, r, BG);
  fillRect(size - r, size - r, r, r, BG);

  const cx = Math.floor(size / 2);
  const s  = size / 48; // scale factor

  // Shaft: centered vertical bar
  const shW = Math.max(2, Math.round(8 * s));
  const shH = Math.max(4, Math.round(18 * s));
  const shX = cx - Math.floor(shW / 2);
  const shY = Math.round(10 * s);
  fillRect(shX, shY, shW, shH, FG);

  // Arrowhead: triangle below shaft
  const tipY   = shY + shH;
  const headH  = Math.max(4, Math.round(14 * s));
  const halfW  = Math.round(11 * s);
  for (let dy = 0; dy < headH; dy++) {
    // At dy=0 head is widest; narrows to 1px at bottom
    const spread = Math.round(halfW * (1 - dy / headH));
    for (let dx = -spread; dx <= spread; dx++) {
      set(cx + dx, tipY + dy, FG);
    }
  }

  return px;
}

// ── Write files ────────────────────────────────────────────────────────────
const iconsDir = path.join(__dirname, 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [48, 96]) {
  const png = makePNG(size, drawIcon(size));
  const dest = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Created ${dest} (${png.length} bytes)`);
}

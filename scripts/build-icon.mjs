#!/usr/bin/env node
// Regenerate images/icon.png (256x256, opaque RGB) from docs/images/icon.png.
// Pure Node — uses only node:fs and node:zlib, no image dependencies.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const SRC = "docs/images/icon.png";
const OUT = "images/icon.png";
const SIZE = 256;

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// --- CRC32 (per PNG spec) ---
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

// --- decode: parse chunks, inflate IDAT, un-filter scanlines ---
function decode(file) {
  let o = 8; // skip signature
  let width, height, bitDepth, colorType;
  const idat = [];
  while (o < file.length) {
    const len = file.readUInt32BE(o);
    const type = file.toString("ascii", o + 4, o + 8);
    const data = file.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len; // length + type + data + crc
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (need 8)`);
  const ch = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!ch) throw new Error(`unsupported color type ${colorType} (need 2=RGB or 6=RGBA)`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const img = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const ro = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const rv = raw[ro + x];
      const a = x >= ch ? img[y * stride + x - ch] : 0;
      const up = y > 0 ? img[(y - 1) * stride + x] : 0;
      const ul = x >= ch && y > 0 ? img[(y - 1) * stride + x - ch] : 0;
      let v;
      if (ft === 0) v = rv;
      else if (ft === 1) v = rv + a;
      else if (ft === 2) v = rv + up;
      else if (ft === 3) v = rv + ((a + up) >> 1);
      else if (ft === 4) v = rv + paeth(a, up, ul);
      else throw new Error(`unsupported filter type ${ft} on row ${y}`);
      img[y * stride + x] = v & 255;
    }
  }
  return { width, height, ch, img };
}

// --- area-average (box) downscale to SIZE x SIZE, output RGB ---
function downscaleRGB({ width, height, ch, img }, size) {
  const out = Buffer.alloc(size * size * 3);
  for (let ty = 0; ty < size; ty++) {
    const sy0 = Math.floor((ty * height) / size);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / size));
    for (let tx = 0; tx < size; tx++) {
      const sx0 = Math.floor((tx * width) / size);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / size));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * ch;
          r += img[i]; g += img[i + 1]; b += img[i + 2]; n++;
        }
      }
      const o = (ty * size + tx) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// --- encode opaque RGB PNG (color type 2, filter 0 per row) ---
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodeRGB(rgb, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  // 10=compression, 11=filter, 12=interlace all default 0

  const stride = size * 3;
  const scanlines = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    scanlines[y * (stride + 1)] = 0; // filter: None
    rgb.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(scanlines, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const decoded = decode(readFileSync(SRC));
const rgb = downscaleRGB(decoded, SIZE);
const png = encodeRGB(rgb, SIZE);
mkdirSync("images", { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes) from ${SRC} (${decoded.width}x${decoded.height})`);

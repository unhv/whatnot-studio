/**
 * Writes build/icon.png (256) and build/icon.ico (16/32/48/256) from pixels.
 * No extra packages — Node zlib only.
 */
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const GOLD = [201, 162, 74, 255];
const GOLD_DIM = [140, 110, 48, 255];
const BG = [11, 11, 15, 255];
const INNER = [18, 18, 24, 255];
const FACE = [176, 138, 96, 255];
const TABLE = [86, 74, 54, 255];
const TALLY = [214, 64, 48, 255];
const CLEAR = [0, 0, 0, 0];

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeBmp32(width, height, rgba) {
  const xor = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const si = (srcY * width + x) * 4;
      const di = (y * width + x) * 4;
      xor[di] = rgba[si + 2];
      xor[di + 1] = rgba[si + 1];
      xor[di + 2] = rgba[si];
      xor[di + 3] = rgba[si + 3];
    }
  }
  const andRowBytes = ((width + 31) >> 5) << 2;
  const andMask = Buffer.alloc(andRowBytes * height);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(xor.length, 20);
  return Buffer.concat([header, xor, andMask]);
}

function inRoundedRect(x, y, l, t, r, b, rad) {
  if (x < l || x > r || y < t || y > b) return false;
  const cx = x < l + rad ? l + rad : x > r - rad ? r - rad : x;
  const cy = y < t + rad ? t + rad : y > b - rad ? b - rad : y;
  if (cx === x || cy === y) return true;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 256;
  const tilePad = 8 * s;
  const tileRad = 48 * s;
  const frameL = 78 * s;
  const frameT = 28 * s;
  const frameR = 177 * s;
  const frameB = 227 * s;
  const frameRad = 14 * s;
  const frameThick = Math.max(2, 8 * s);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = CLEAR;
      if (inRoundedRect(x, y, tilePad, tilePad, size - 1 - tilePad, size - 1 - tilePad, tileRad)) {
        c = BG;
      }
      if (inRoundedRect(x, y, frameL, frameT, frameR, frameB, frameRad)) {
        c = GOLD;
      }
      if (
        inRoundedRect(
          x,
          y,
          frameL + frameThick,
          frameT + frameThick,
          frameR - frameThick,
          frameB - frameThick,
          Math.max(2, frameRad - frameThick)
        )
      ) {
        c = INNER;
        if (inEllipse(x, y, size / 2, 92 * s, 28 * s, 34 * s)) c = FACE;
        if (y > 148 * s && y < 186 * s && x > 96 * s && x < 160 * s) c = TABLE;
        if (y > 186 * s && y < 190 * s && x > 96 * s && x < 160 * s) c = GOLD_DIM;
      }
      if (inCircle(x, y, size / 2, frameT + frameThick * 0.2, Math.max(2, 6 * s))) c = TALLY;
      const i = (y * size + x) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = c[3];
    }
  }
  return rgba;
}

function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  const payloads = [];
  let offset = 6 + 16 * count;
  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry[0] = img.size >= 256 ? 0 : img.size;
    entry[1] = img.size >= 256 ? 0 : img.size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(img.bitCount, 6);
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(img.data);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

const rgba256 = drawIcon(256);
writeFileSync(path.join(dir, "icon.png"), encodePng(256, 256, rgba256));

const ico = buildIco([
  { size: 16, bitCount: 32, data: encodeBmp32(16, 16, drawIcon(16)) },
  { size: 32, bitCount: 32, data: encodeBmp32(32, 32, drawIcon(32)) },
  { size: 48, bitCount: 32, data: encodeBmp32(48, 48, drawIcon(48)) },
  { size: 256, bitCount: 32, data: encodePng(256, 256, rgba256) },
]);
writeFileSync(path.join(dir, "icon.ico"), ico);
console.log("wrote build/icon.png and build/icon.ico");

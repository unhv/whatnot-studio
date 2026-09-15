/**
 * Best-effort duration from clip bytes. No ffprobe — memes are small and
 * the headers we need (mp4 mvhd, gif delays, webm Duration) are in-file.
 * Returns null when the container cannot be read.
 */

function u16le(buf: Uint8Array, o: number): number {
  return buf[o]! | (buf[o + 1]! << 8);
}

function u32be(buf: Uint8Array, o: number): number {
  return ((buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!) >>> 0;
}

function fourcc(buf: Uint8Array, o: number): string {
  return String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
}

function asciiStarts(buf: Uint8Array, text: string): boolean {
  if (buf.length < text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function parseMvhd(buf: Uint8Array, start: number, end: number): number | null {
  if (start >= end) return null;
  const version = buf[start]!;
  if (version === 1) {
    if (start + 28 > end) return null;
    const timescale = u32be(buf, start + 20);
    const durHi = u32be(buf, start + 24);
    const durLo = u32be(buf, start + 28);
    if (timescale === 0) return null;
    const duration = durHi * 2 ** 32 + durLo;
    const ms = (duration / timescale) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (start + 20 > end) return null;
  const timescale = u32be(buf, start + 12);
  const duration = u32be(buf, start + 16);
  if (timescale === 0) return null;
  const ms = (duration / timescale) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function walkMp4(buf: Uint8Array, start: number, end: number): number | null {
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(buf, o);
    const type = fourcc(buf, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      const hi = u32be(buf, o + 8);
      const lo = u32be(buf, o + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (!Number.isFinite(size) || size < header || o + size > end + 0.5) break;
    const boxEnd = o + size;
    if (type === "moov" || type === "trak" || type === "mdia") {
      const found = walkMp4(buf, o + header, boxEnd);
      if (found !== null) return found;
    } else if (type === "mvhd") {
      return parseMvhd(buf, o + header, boxEnd);
    }
    o = boxEnd;
  }
  return null;
}

export function durationMsFromMp4(buf: Uint8Array): number | null {
  return walkMp4(buf, 0, buf.length);
}

export function durationMsFromGif(buf: Uint8Array): number | null {
  if (buf.length < 13) return null;
  if (!asciiStarts(buf, "GIF87a") && !asciiStarts(buf, "GIF89a")) return null;
  const packed = buf[10]!;
  const gct = (packed & 0x80) !== 0;
  const gctSize = gct ? 3 * (2 ** ((packed & 7) + 1)) : 0;
  let o = 13 + gctSize;
  let delayCs = 0;
  let frames = 0;
  while (o < buf.length) {
    const b = buf[o]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[o + 1];
      if (label === 0xf9 && o + 8 <= buf.length) {
        const delay = u16le(buf, o + 4);
        delayCs += delay === 0 ? 10 : delay;
        o += 8;
        continue;
      }
      o += 2;
      while (o < buf.length) {
        const sz = buf[o]!;
        o += 1;
        if (sz === 0) break;
        o += sz;
      }
      continue;
    }
    if (b === 0x2c) {
      frames += 1;
      if (o + 10 > buf.length) break;
      const imgPacked = buf[o + 9]!;
      const lct = (imgPacked & 0x80) !== 0;
      const lctSize = lct ? 3 * (2 ** ((imgPacked & 7) + 1)) : 0;
      o += 10 + lctSize + 1;
      while (o < buf.length) {
        const sz = buf[o]!;
        o += 1;
        if (sz === 0) break;
        o += sz;
      }
      continue;
    }
    break;
  }
  if (frames === 0) return null;
  const ms = delayCs * 10;
  return ms > 0 ? ms : null;
}

function readVint(buf: Uint8Array, o: number): { value: number; width: number } | null {
  if (o >= buf.length) return null;
  const first = buf[o]!;
  let width = 1;
  let mask = 0x80;
  while (width <= 8 && (first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  if (width > 8 || o + width > buf.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < width; i++) {
    value = value * 256 + buf[o + i]!;
  }
  return { value, width };
}

function readFloat64be(buf: Uint8Array, o: number): number | null {
  if (o + 8 > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + o, 8);
  const n = view.getFloat64(0, false);
  return Number.isFinite(n) ? n : null;
}

function readFloat32be(buf: Uint8Array, o: number): number | null {
  if (o + 4 > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + o, 4);
  const n = view.getFloat32(0, false);
  return Number.isFinite(n) ? n : null;
}

function walkWebm(
  buf: Uint8Array,
  start: number,
  end: number,
  scale: number
): { ms: number | null; scale: number } {
  let o = start;
  let duration: number | null = null;
  let timestampScale = scale;
  while (o < end) {
    const id = readVint(buf, o);
    if (!id) break;
    const sizeOff = o + id.width;
    const size = readVint(buf, sizeOff);
    if (!size) break;
    const dataOff = sizeOff + size.width;
    const dataEnd = dataOff + size.value;
    if (dataEnd > end + 0.5) break;

    // TimestampScale 0x2AD7B1, Duration 0x4489, Info 0x1549A966, Segment 0x18538067
    if (id.value === 0x18538067 || id.value === 0x1549a966) {
      const inner = walkWebm(buf, dataOff, dataEnd, timestampScale);
      timestampScale = inner.scale;
      if (inner.ms !== null) duration = inner.ms;
    } else if (id.value === 0x2ad7b1) {
      let n = 0;
      for (let i = dataOff; i < dataEnd; i++) n = n * 256 + buf[i]!;
      if (n > 0) timestampScale = n;
    } else if (id.value === 0x4489) {
      const raw =
        size.value === 8
          ? readFloat64be(buf, dataOff)
          : size.value === 4
            ? readFloat32be(buf, dataOff)
            : null;
      if (raw !== null && raw > 0) {
        duration = (raw * timestampScale) / 1_000_000;
      }
    }
    o = dataEnd;
  }
  return { ms: duration, scale: timestampScale };
}

export function durationMsFromWebm(buf: Uint8Array): number | null {
  const found = walkWebm(buf, 0, buf.length, 1_000_000);
  return found.ms !== null && found.ms > 0 ? found.ms : null;
}

export function durationMsFromBytes(bytes: Uint8Array, fileName: string): number | null {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  try {
    if (ext === ".mp4" || asciiStarts(bytes, "ftyp") || (bytes.length > 8 && fourcc(bytes, 4) === "ftyp")) {
      const ms = durationMsFromMp4(bytes);
      if (ms !== null) return ms;
    }
    if (ext === ".gif" || asciiStarts(bytes, "GIF")) {
      const ms = durationMsFromGif(bytes);
      if (ms !== null) return ms;
    }
    if (ext === ".webm" || (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45)) {
      const ms = durationMsFromWebm(bytes);
      if (ms !== null) return ms;
    }
  } catch {
    return null;
  }
  return null;
}

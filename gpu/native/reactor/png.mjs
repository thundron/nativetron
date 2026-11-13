// Minimal PNG codec for capture artifacts (8-bit RGB/RGBA/gray(+alpha), non-interlaced) and image comparison.
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let at = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), t = buf.toString('latin1', at + 4, at + 8), d = buf.subarray(at + 8, at + 8 + len);
    if (t === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    at += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0, b = y ? px[row - stride + x] : 0, c = x >= channels && y ? px[row - stride + x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels >= 3) { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; rgba[i * 4 + 3] = channels === 4 ? px[s + 3] : 255; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; rgba[i * 4 + 3] = channels === 2 ? px[s + 1] : 255; }
  }
  return { width, height, rgba };
}
/** scripts/golden.mjs tolerance: a pixel differs when any RGB channel differs by more than `channel`; reports counts. */
export function compareRgba(a, b, channel = 12) {
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, reason: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  let differ = 0, notExact = 0, maxDelta = 0, sumAbs = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    let m = 0;
    for (let k = 0; k < 3; k++) { const d = Math.abs(a.rgba[i + k] - b.rgba[i + k]); sumAbs += d; if (d > m) m = d; }
    if (m > 0) notExact++;
    if (m > channel) differ++;
    if (m > maxDelta) maxDelta = m;
  }
  return { comparable: true, pixels: n, differ, differFraction: differ / n, notExact, maxDelta, meanAbs: sumAbs / (n * 3) };
}

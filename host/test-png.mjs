import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

// Chrome's lossless screenshot format; test utility, not an application decoder.
export function screenshotPixel(base64, x, y) {
  const png = Buffer.from(base64, "base64"), chunks = [];
  let width, height, channels;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset), kind = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[12], 0);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      assert.ok(channels);
    } else if (kind === "IDAT") chunks.push(data);
    offset += length + 12;
  }
  assert.ok(x >= 0 && x < width && y >= 0 && y < height);
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  let previous = new Uint8Array(stride);
  const paeth = (left, up, diagonal) => {
    const p = left + up - diagonal, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - diagonal);
    return a <= b && a <= c ? left : b <= c ? up : diagonal;
  };
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)], current = new Uint8Array(stride);
    assert.ok(filter <= 4);
    for (let col = 0; col < stride; col++) {
      const left = col >= channels ? current[col - channels] : 0;
      const up = previous[col], diagonal = col >= channels ? previous[col - channels] : 0;
      const add = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, diagonal);
      current[col] = (raw[row * (stride + 1) + 1 + col] + add) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

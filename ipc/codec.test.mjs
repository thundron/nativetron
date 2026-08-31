import assert from "node:assert/strict";
import { FrameReader, FrameWriter, MAX_FRAME_SIZE, encodeUtf8 } from "./codec.ts";
import { IPC_MAX_FRAME_SIZE } from "./protocol.generated.mjs";

assert.equal(MAX_FRAME_SIZE, IPC_MAX_FRAME_SIZE);

const writer = new FrameWriter();
writer.u8(4);
writer.str("event");
writer.bytes(encodeUtf8("payload"));
const frame = writer.finish();
const reader = new FrameReader();
reader.push(frame.subarray(0, 2));
assert.equal(reader.next(), false);
reader.push(frame.subarray(2));
assert.equal(reader.next(), true);
assert.equal(reader.u8(), 4);
assert.equal(reader.str(), "event");
assert.equal(reader.str(), "payload");
reader.finish();
reader.release();
assert.equal(reader.next(), false);

const joined = new Uint8Array(frame.length * 2);
joined.set(frame, 0);
joined.set(frame, frame.length);
reader.push(joined);
for (let i = 0; i < 2; i++) {
  assert.equal(reader.next(), true);
  assert.equal(reader.u8(), 4);
  assert.equal(reader.str(), "event");
  assert.equal(reader.str(), "payload");
  reader.finish();
  reader.release();
}

const header = (size) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, size);
  return bytes;
};
reader.push(header(0));
assert.throws(() => reader.next(), /no kind/);
reader.reset();
reader.push(header(MAX_FRAME_SIZE + 1));
assert.throws(() => reader.next(), /exceeds limit/);
reader.reset();

const badField = new Uint8Array(9);
new DataView(badField.buffer).setUint32(0, 5);
badField[4] = 4;
new DataView(badField.buffer).setUint32(5, 100);
reader.push(badField);
assert.equal(reader.next(), true);
assert.equal(reader.u8(), 4);
assert.throws(() => reader.bytes(), /field exceeds frame/);
reader.reset();

const trailing = new FrameWriter();
trailing.u8(2);
trailing.u8(9);
reader.push(trailing.finish());
assert.equal(reader.next(), true);
assert.equal(reader.u8(), 2);
assert.throws(() => reader.finish(), /trailing or missing fields/);
reader.reset();

assert.throws(() => reader.push(new Uint8Array(MAX_FRAME_SIZE + 5)), /buffer exceeds limit/);
const oversized = new FrameWriter();
assert.throws(() => oversized.bytes(new Uint8Array(MAX_FRAME_SIZE + 1)), /frame exceeds limit/);

console.log("ipc codec: framing limits and bounds checks passed");

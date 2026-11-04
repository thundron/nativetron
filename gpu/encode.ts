export interface UploadSlice {
  offset: number;
  length: number;
}

export interface ReadbackSlice {
  offset: number;
  length: number;
}

import {
  MAX_BATCH_BYTES, MAX_UPLOAD_BYTES, MAX_READBACK_BYTES, MAX_ARRAY_LENGTH, SLOT_MASK, GENERATION_MASK, GENERATION_SHIFT,
  PROTOCOL_OPCODE, PROTOCOL_VERSION, PROTOCOL_IDENTITY, PROTOCOL_HEADER_BYTES,
} from "./limits.generated.js";

const SLOT_LIMIT = SLOT_MASK;

// Every batch begins with the generated protocol header; it is written once and survives growth.
let commands: Uint8Array = new Uint8Array(65536);
let commandOffset = PROTOCOL_HEADER_BYTES;
// Start of the operation being encoded, or -1 between operations. A refused operand rolls the
// partially written operation back, and releases a handle that the host never saw.
let opStart = -1;
let opHandle = 0;
let uploads: Uint8Array = new Uint8Array(1048576);
let uploadOffset = 0;
let readbacks: Uint8Array = new Uint8Array(0);
let readbackOffset = 0;
let sink: (batch: Uint8Array, upload: Uint8Array, readback: Uint8Array) => void = (
  _batch: Uint8Array,
  _upload: Uint8Array,
  _readback: Uint8Array,
) => {};

const generations: number[] = [];
const live: boolean[] = [];
const freeSlots: number[] = [];

function writeHeader(): void {
  commands[0] = PROTOCOL_OPCODE;
  for (let i = 0; i < 4; i++) {
    commands[1 + i] = (PROTOCOL_VERSION >>> (8 * i)) & 255;
    commands[5 + i] = (PROTOCOL_IDENTITY >>> (8 * i)) & 255;
  }
}
writeHeader();

function refuse(message: string): void {
  if (opStart >= 0) {
    commandOffset = opStart;
    if (opHandle !== 0) unallocateHandle(opHandle);
  }
  opStart = -1;
  opHandle = 0;
  throw new Error(message);
}

export function setSink(fn: (batch: Uint8Array, upload: Uint8Array, readback: Uint8Array) => void): void {
  sink = fn;
}

function grow(source: Uint8Array, required: number, limit: number): Uint8Array {
  if (required > limit) refuse("GPU staging limit exceeded");
  let capacity = source.length;
  while (capacity < required) capacity = capacity * 2;
  if (capacity > limit) capacity = limit;
  const next = new Uint8Array(capacity);
  next.set(source, 0);
  return next;
}

function needCommand(length: number): void {
  const required = commandOffset + length;
  if (required <= commands.length) return;
  commands = grow(commands, required, MAX_BATCH_BYTES);
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

export function reserveUpload(length: number): UploadSlice {
  if (!Number.isInteger(length) || length < 0) throw new Error("invalid GPU upload length");
  const offset = align4(uploadOffset);
  const required = offset + length;
  if (required > uploads.length) uploads = grow(uploads, required, MAX_UPLOAD_BYTES);
  uploadOffset = required;
  return { offset, length };
}

export function uploadBytes(bytes: Uint8Array): UploadSlice {
  const slice = reserveUpload(bytes.length);
  uploadView(slice).set(bytes, 0);
  return slice;
}

export function reserveReadback(length: number): ReadbackSlice {
  if (!Number.isInteger(length) || length < 0) throw new Error("invalid GPU readback length");
  if (readbacks.length === 0) readbacks = new Uint8Array(MAX_READBACK_BYTES);
  const offset = align4(readbackOffset);
  const required = offset + length;
  if (required > readbacks.length) throw new Error("GPU readback staging limit exceeded");
  readbackOffset = required;
  return { offset, length };
}

export function uploadView(slice: UploadSlice): Uint8Array {
  return uploads.subarray(slice.offset, slice.offset + slice.length);
}

export function readbackView(slice: ReadbackSlice): Uint8Array {
  return readbacks.subarray(slice.offset, slice.offset + slice.length);
}

// Called from a guest export, never by mutating the read-only gpuPresent callback views.
export function writeReadback(offset: number, bytes: Uint8Array): number {
  if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > readbacks.length) throw new Error("invalid GPU readback destination");
  readbacks.set(bytes, offset);
  return 0;
}

export function resetReadbacks(): void {
  readbackOffset = 0;
}

export function begin(code: number): void {
  opStart = commandOffset;
  opHandle = 0;
  u8(code);
}

export function beginResult(code: number): number {
  const handle = allocateHandle();
  opStart = commandOffset;
  opHandle = handle;
  u8(code);
  u32(handle);
  return handle;
}

export function end(): void {
  opStart = -1;
  opHandle = 0;
}

export function u8(value: number): void {
  needCommand(1);
  commands[commandOffset++] = value & 255;
}

export function u32(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) refuse("invalid GPU u32 operand");
  needCommand(4);
  commands[commandOffset++] = value & 255;
  commands[commandOffset++] = (value >>> 8) & 255;
  commands[commandOffset++] = (value >>> 16) & 255;
  commands[commandOffset++] = (value >>> 24) & 255;
}

export function i32(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) refuse("invalid GPU i32 operand");
  u32(value >>> 0);
}

const numberScratch = new Uint8Array(8);
const numberView = new DataView(numberScratch.buffer);

export function f32(value: number): void {
  numberView.setFloat32(0, value, true);
  needCommand(4);
  commands.set(numberScratch.subarray(0, 4), commandOffset);
  commandOffset += 4;
}

export function f64(value: number): void {
  numberView.setFloat64(0, value, true);
  needCommand(8);
  commands.set(numberScratch, commandOffset);
  commandOffset += 8;
}

export function str(value: string): void {
  const bytes = Buffer.from(value, "utf8");
  u32(bytes.length);
  needCommand(bytes.length);
  commands.set(bytes, commandOffset);
  commandOffset += bytes.length;
}

export function u32Array(values: number[]): void {
  if (values.length > MAX_ARRAY_LENGTH) refuse("GPU array limit exceeded");
  u32(values.length);
  for (let i = 0; i < values.length; i++) u32(values[i]!);
}

export function f64Array(values: number[]): void {
  if (values.length > MAX_ARRAY_LENGTH) refuse("GPU array limit exceeded");
  u32(values.length);
  for (let i = 0; i < values.length; i++) f64(values[i]!);
}

export function upload(value: UploadSlice): void {
  u32(value.offset);
  u32(value.length);
}

export function readback(value: ReadbackSlice): void {
  u32(value.offset);
  u32(value.length);
}

export function allocateHandle(): number {
  let slot: number;
  if (freeSlots.length > 0) slot = freeSlots.pop()!;
  else {
    slot = generations.length;
    if (slot >= SLOT_LIMIT) throw new Error("GPU handle limit reached");
    generations.push(1);
    live.push(false);
  }
  if (live[slot]) throw new Error("GPU handle allocator corruption");
  live[slot] = true;
  return (((generations[slot]! & GENERATION_MASK) << GENERATION_SHIFT) | (slot + 1)) >>> 0;
}

// Returns a handle whose creation was refused before it reached the host; its generation is unchanged.
function unallocateHandle(handle: number): void {
  const slot = (handle & SLOT_MASK) - 1;
  if (slot < 0 || slot >= generations.length || !live[slot]) return;
  live[slot] = false;
  freeSlots.push(slot);
}

export function releaseHandle(handle: number): void {
  const encodedSlot = handle & SLOT_MASK;
  if (encodedSlot === 0) return;
  const slot = encodedSlot - 1;
  const generation = (handle >>> GENERATION_SHIFT) & GENERATION_MASK;
  if (slot >= generations.length || !live[slot] || generations[slot] !== generation) return;
  live[slot] = false;
  if (generation === GENERATION_MASK) return;
  generations[slot] = generation + 1;
  freeSlots.push(slot);
}

export function flush(): void {
  if (opStart >= 0) throw new Error("GPU flush during operation encoding");
  if (commandOffset === PROTOCOL_HEADER_BYTES) return;
  sink(
    commands.subarray(0, commandOffset),
    uploads.subarray(0, uploadOffset),
    readbacks.subarray(0, readbackOffset),
  );
  commandOffset = PROTOCOL_HEADER_BYTES;
  uploadOffset = 0;
}

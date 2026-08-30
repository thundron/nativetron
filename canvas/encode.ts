let buf = new Uint8Array(8192);
let off = 0;
let sink: (b: Uint8Array) => void = (_b: Uint8Array) => {};

export function setSink(fn: (b: Uint8Array) => void): void {
  sink = fn;
}

function need(n: number): void {
  if (off + n <= buf.length) return;
  let cap = buf.length * 2;
  while (cap < off + n) cap = cap * 2;
  const nb = new Uint8Array(cap);
  nb.set(buf.subarray(0, off), 0);
  buf = nb;
}

export function u8(v: number): void {
  need(1);
  buf[off++] = v & 0xff;
}

export function u32(v: number): void {
  need(4);
  buf[off++] = v & 0xff;
  buf[off++] = (v >>> 8) & 0xff;
  buf[off++] = (v >>> 16) & 0xff;
  buf[off++] = (v >>> 24) & 0xff;
}

const scratch = new Uint8Array(4);
const scratchView = new DataView(scratch.buffer);

export function f32(v: number): void {
  scratchView.setFloat32(0, v, true);
  need(4);
  buf[off++] = scratch[0]!;
  buf[off++] = scratch[1]!;
  buf[off++] = scratch[2]!;
  buf[off++] = scratch[3]!;
}

export function str(s: string): void {
  const b = Buffer.from(s, "utf8");
  u32(b.length);
  need(b.length);
  buf.set(b, off);
  off += b.length;
}

const internKeys: string[] = [];
let nextIntern = 1;

export function iref(v: string): number {
  for (let i = 0; i < internKeys.length; i++) {
    if (internKeys[i] === v) return i + 1;
  }
  internKeys.push(v);
  const id = nextIntern++;
  u8(22);
  u32(id);
  str(v);
  return id;
}

export function frame(): void {
  if (off === 0) return;
  sink(buf.subarray(0, off));
  off = 0;
}

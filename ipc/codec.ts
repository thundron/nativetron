export const MAX_FRAME_SIZE = 8 * 1024 * 1024;

export function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function decodeUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export class FrameWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len: number;

  constructor() {
    this.buf = new Uint8Array(256);
    this.view = new DataView(this.buf.buffer);
    this.len = 4;
  }

  private reserve(extra: number): void {
    const need = this.len + extra;
    if (need > MAX_FRAME_SIZE + 4) throw new Error("ipc frame exceeds limit");
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap = cap * 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len), 0);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.reserve(1);
    this.buf[this.len] = v & 0xff;
    this.len = this.len + 1;
  }

  u32(v: number): void {
    this.reserve(4);
    this.view.setUint32(this.len, v >>> 0);
    this.len = this.len + 4;
  }

  bytes(b: Uint8Array): void {
    this.u32(b.length);
    this.reserve(b.length);
    this.buf.set(b, this.len);
    this.len = this.len + b.length;
  }

  str(s: string): void {
    this.bytes(encodeUtf8(s));
  }

  finish(): Uint8Array {
    this.view.setUint32(0, (this.len - 4) >>> 0);
    return this.buf.subarray(0, this.len);
  }
}

export class FrameReader {
  private buf: Uint8Array;
  private len: number;
  private pos: number;
  private end: number;
  private view: DataView;

  constructor() {
    this.buf = new Uint8Array(1024);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
    this.pos = 0;
    this.end = 0;
  }

  push(chunk: Uint8Array): void {
    const need = this.len + chunk.length;
    if (need > MAX_FRAME_SIZE + 4) throw new Error("ipc frame buffer exceeds limit");
    if (need > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < need) cap = cap * 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len), 0);
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.buf.set(chunk, this.len);
    this.len = this.len + chunk.length;
  }

  next(): boolean {
    if (this.len < 4) return false;
    const size = this.view.getUint32(0) >>> 0;
    if (size === 0) throw new Error("ipc frame has no kind");
    if (size > MAX_FRAME_SIZE) throw new Error("ipc frame exceeds limit");
    if (this.len < 4 + size) return false;
    this.pos = 4;
    this.end = 4 + size;
    return true;
  }

  reset(): void {
    this.len = 0;
    this.pos = 0;
    this.end = 0;
  }

  release(): void {
    const rest = this.len - this.end;
    if (rest > 0) this.buf.set(this.buf.subarray(this.end, this.len), 0);
    this.len = rest;
    this.pos = 0;
    this.end = 0;
  }

  finish(): void {
    if (this.pos !== this.end) throw new Error("ipc frame has trailing or missing fields");
  }

  private require(n: number): void {
    if (this.pos + n > this.end) throw new Error("ipc field exceeds frame");
  }

  u8(): number {
    this.require(1);
    const v = this.buf[this.pos]!;
    this.pos = this.pos + 1;
    return v;
  }

  u32(): number {
    this.require(4);
    const v = this.view.getUint32(this.pos) >>> 0;
    this.pos = this.pos + 4;
    return v;
  }

  bytes(): Uint8Array {
    const n = this.u32();
    this.require(n);
    const out = new Uint8Array(n);
    out.set(this.buf.subarray(this.pos, this.pos + n), 0);
    this.pos = this.pos + n;
    return out;
  }

  str(): string {
    return decodeUtf8(this.bytes());
  }
}

export function toBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i]!;
  return out;
}

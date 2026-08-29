import { effect } from "./reactive.js";

export const ROOT = 0;
let nextId = 1;
export function newId(): number {
  return nextId++;
}

type Op = Array<number | string>;
let ops: Op[] = [];
let binary = false;
let buf = new Uint8Array(4096);
let off = 0;
let building = true;
let jsonSink: (json: string) => void = (_j: string) => {};
let binSink: (b: Uint8Array) => void = (_b: Uint8Array) => {};

export function setSink(fn: (json: string) => void): void {
  jsonSink = fn;
  binary = false;
}
export function setBinarySink(fn: (b: Uint8Array) => void): void {
  binSink = fn;
  binary = true;
}
export function setLive(): void {
  building = false;
}

function need(n: number): void {
  if (off + n <= buf.length) return;
  let cap = buf.length * 2;
  while (cap < off + n) cap = cap * 2;
  const nb = new Uint8Array(cap);
  nb.set(buf.subarray(0, off), 0);
  buf = nb;
}
function u8(v: number): void {
  need(1);
  buf[off++] = v & 0xff;
}
function u32(v: number): void {
  need(4);
  buf[off++] = v & 0xff;
  buf[off++] = (v >>> 8) & 0xff;
  buf[off++] = (v >>> 16) & 0xff;
  buf[off++] = (v >>> 24) & 0xff;
}
function str(s: string): void {
  const b = Buffer.from(s, "utf8");
  u32(b.length);
  need(b.length);
  buf.set(b, off);
  off += b.length;
}

const internKeys: string[] = [];
let nextIntern = 1;

function iref(v: string): number {
  for (let i = 0; i < internKeys.length; i++) {
    if (internKeys[i] === v) return i + 1;
  }
  internKeys.push(v);
  const id = nextIntern++;
  u8(12);
  u32(id);
  str(v);
  return id;
}

export function createElement(id: number, tag: string): void {
  if (binary) { const t = iref(tag); u8(1); u32(id); u32(t); } else ops.push([1, id, tag]);
}
export function elementWithText(parent: number, id: number, tag: string, textId: number, text: string): void {
  if (binary) {
    const t = iref(tag);
    u8(13); u32(parent); u32(id); u32(t); u32(textId); str(text);
  } else {
    ops.push([1, id, tag]);
    ops.push([2, textId, text]);
    ops.push([6, id, textId]);
    ops.push([6, parent, id]);
  }
}
export function createText(id: number, text: string): void {
  if (binary) { u8(2); u32(id); str(text); } else ops.push([2, id, text]);
}
export function setText(id: number, text: string): void {
  if (binary) { u8(3); u32(id); str(text); } else ops.push([3, id, text]);
}
export function setAttr(id: number, name: string, value: string): void {
  if (binary) { const n = iref(name); u8(4); u32(id); u32(n); str(value); } else ops.push([4, id, name, value]);
}
export function append(parent: number, child: number): void {
  if (binary) { u8(6); u32(parent); u32(child); } else ops.push([6, parent, child]);
}
export function insertBefore(parent: number, child: number, ref: number): void {
  if (binary) { u8(7); u32(parent); u32(child); u32(ref); } else ops.push([7, parent, child, ref]);
}
export function remove(id: number): void {
  if (binary) { u8(8); u32(id); } else ops.push([8, id]);
}
export function setProp(id: number, name: string, value: string): void {
  if (binary) { const n = iref(name); u8(11); u32(id); u32(n); str(value); } else ops.push([11, id, name, value]);
}

export function flush(): void {
  if (binary) {
    if (off === 0) return;
    binSink(buf.subarray(0, off));
    off = 0;
    return;
  }
  if (ops.length === 0) return;
  jsonSink(JSON.stringify(ops));
  ops = [];
}

export function bindText(nodeId: number, compute: () => string): void {
  effect(() => {
    setText(nodeId, compute());
    if (!building) flush();
  });
}

export interface NtEvent {
  n: number;
  t: string;
  value?: string;
}
type Handler = (ev: NtEvent) => void;
const handlerKeys: string[] = [];
const handlerFns: Handler[] = [];

export function on(id: number, type: string, h: Handler): void {
  const slot = handlerFns.length;
  handlerKeys.push(`${id}:${type}`);
  handlerFns.push(h);
  if (binary) { const t = iref(type); u8(9); u32(id); u32(t); u32(slot); } else ops.push([9, id, type]);
}

export function dispatch(ev: NtEvent): void {
  const key = `${ev.n}:${ev.t}`;
  for (let i = 0; i < handlerKeys.length; i++) {
    if (handlerKeys[i] === key) {
      handlerFns[i]!(ev);
      return;
    }
  }
}

export function dispatchSlot(slot: number, value: string): void {
  const h = handlerFns[slot];
  if (h !== undefined) h({ n: slot, t: "", value });
}

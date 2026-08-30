import { effect } from "./reactive.js";
import {
  OP_CREATE_ELEMENT,
  OP_CREATE_TEXT,
  OP_SET_TEXT,
  OP_SET_ATTR,
  OP_REMOVE_ATTR,
  OP_APPEND,
  OP_INSERT_BEFORE,
  OP_REMOVE,
  OP_LISTEN,
  OP_UNLISTEN,
  OP_SET_PROP,
  OP_INTERN,
  OP_ELEMENT_WITH_TEXT,
} from "./ops.generated.js";

export const ROOT = 0;
let nextId = 1;
export function newId(): number {
  return nextId++;
}

let buf = new Uint8Array(4096);
let off = 0;
let building = true;
let binSink: (b: Uint8Array) => void = (_b: Uint8Array) => {};

export function setBinarySink(fn: (b: Uint8Array) => void): void {
  binSink = fn;
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
  u8(OP_INTERN);
  u32(id);
  str(v);
  return id;
}

export function createElement(id: number, tag: string): void {
  const t = iref(tag); u8(OP_CREATE_ELEMENT); u32(id); u32(t);
}
export function elementWithText(parent: number, id: number, tag: string, textId: number, text: string): void {
  const t = iref(tag);
  u8(OP_ELEMENT_WITH_TEXT); u32(parent); u32(id); u32(t); u32(textId); str(text);
}
export function createText(id: number, text: string): void {
  u8(OP_CREATE_TEXT); u32(id); str(text);
}
export function setText(id: number, text: string): void {
  u8(OP_SET_TEXT); u32(id); str(text);
}
export function setAttr(id: number, name: string, value: string): void {
  const n = iref(name); u8(OP_SET_ATTR); u32(id); u32(n); str(value);
}
export function append(parent: number, child: number): void {
  u8(OP_APPEND); u32(parent); u32(child);
}
export function insertBefore(parent: number, child: number, ref: number): void {
  u8(OP_INSERT_BEFORE); u32(parent); u32(child); u32(ref);
}
export function remove(id: number): void {
  u8(OP_REMOVE); u32(id);
}
export function setProp(id: number, name: string, value: string): void {
  const n = iref(name); u8(OP_SET_PROP); u32(id); u32(n); str(value);
}

export function flush(): void {
  if (off === 0) return;
  binSink(buf.subarray(0, off));
  off = 0;
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
  const t = iref(type); u8(OP_LISTEN); u32(id); u32(t); u32(slot);
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

import { effect, type Cleanup } from "./reactive.js";
import {
  decodeDefaultHostEvent, decodePrimaryHostEvent, decodeHostEvent, type DecodedHostEvent,
} from "./event.generated.js";
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
  OP_CREATE_SVG_ELEMENT,
  OP_FOCUS,
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
export function createSvgElement(id: number, tag: string): void {
  const t = iref(tag); u8(OP_CREATE_SVG_ELEMENT); u32(id); u32(t);
}
export function focusElement(id: number): void {
  u8(OP_FOCUS); u32(id);
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
export function removeAttr(id: number, name: string): void {
  const n = iref(name); u8(OP_REMOVE_ATTR); u32(id); u32(n);
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

export function bindText(nodeId: number, compute: () => string): Cleanup {
  return effect(() => {
    setText(nodeId, compute());
    if (!building) flush();
  });
}

export type NtEvent = DecodedHostEvent;

type Handler = (ev: NtEvent) => void;
function noopHandler(_ev: NtEvent): void {}
const HANDLER_SLOT_LIMIT = 65536;
const handlerNodeIds: number[] = [];
const handlerEventTypes: string[] = [];
const handlerFns: Handler[] = [];
const handlerActive: boolean[] = [];

function reserveHandlerSlot(): number {
  for (let index = 0; index < handlerActive.length; index++) {
    if (!handlerActive[index]) return index;
  }
  if (handlerFns.length >= HANDLER_SLOT_LIMIT) throw new Error("event handler slot limit reached");
  handlerNodeIds.push(0);
  handlerEventTypes.push("");
  handlerFns.push(noopHandler);
  handlerActive.push(false);
  return handlerFns.length - 1;
}

export function on(id: number, type: string, handler: Handler): void {
  const slot = reserveHandlerSlot();
  handlerNodeIds[slot] = id;
  handlerEventTypes[slot] = type;
  handlerFns[slot] = handler;
  handlerActive[slot] = true;
  const internedType = iref(type);
  u8(OP_LISTEN); u32(id); u32(internedType); u32(slot);
}

export function unlisten(id: number, type: string): void {
  for (let index = 0; index < handlerFns.length; index++) {
    if (handlerNodeIds[index] === id && handlerEventTypes[index] === type) {
      handlerActive[index] = false;
      handlerNodeIds[index] = 0;
      handlerEventTypes[index] = "";
      handlerFns[index] = noopHandler;
    }
  }
  const internedType = iref(type);
  u8(OP_UNLISTEN); u32(id); u32(internedType);
}

/* generated:event-dispatch */
export function dispatchSlot(slot: number): void {
  const handler = handlerFns[slot];
  if (handler === undefined || !handlerActive[slot]) return;
  const nodeId = handlerNodeIds[slot];
  const eventType = handlerEventTypes[slot];
  if (nodeId === undefined || eventType === undefined) return;
  const event = decodeDefaultHostEvent(nodeId, eventType);
  if (event !== null) handler(event);
}

export function dispatchSlotValue(slot: number, value: string): void {
  const handler = handlerFns[slot];
  if (handler === undefined || !handlerActive[slot]) return;
  const nodeId = handlerNodeIds[slot];
  const eventType = handlerEventTypes[slot];
  if (nodeId === undefined || eventType === undefined) return;
  const event = decodePrimaryHostEvent(nodeId, eventType, value);
  if (event !== null) handler(event);
}

export function dispatchSlotRich(slot: number, value: string, checked: number, key: string, code: string, modifiers: number, inputType: string): void {
  const handler = handlerFns[slot];
  if (handler === undefined || !handlerActive[slot]) return;
  const nodeId = handlerNodeIds[slot];
  const eventType = handlerEventTypes[slot];
  if (nodeId === undefined || eventType === undefined) return;
  const event = decodeHostEvent(nodeId, eventType, value, checked, key, code, modifiers, inputType);
  if (event !== null) handler(event);
}
/* /generated:event-dispatch */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_EVENT_BRIDGE_JS, parseNativeEventMessage } from "../host/native-event.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const native = createRequire(import.meta.url)("./build/Release/nativetron.node");

const OPS = Object.fromEntries(
  JSON.parse(readFileSync(join(here, "..", "abi", "ops.json"), "utf8")).ops.map((o) => [o.name, o.code]),
);
const HOST_JS = readFileSync(join(here, "..", "host", "dom-host.js"), "utf8");
const WEBVIEW_MESSAGE_LIMIT = 65536;

function webviewMessage(raw) {
  try {
    const argumentsList = JSON.parse(raw);
    if (!Array.isArray(argumentsList) || argumentsList.length !== 1 ||
        typeof argumentsList[0] !== "string" || argumentsList[0].length > WEBVIEW_MESSAGE_LIMIT) return null;
    return argumentsList[0];
  } catch {
    return null;
  }
}

function readyMessage(raw) {
  try {
    const message = JSON.parse(raw);
    if (message === null || typeof message !== "object" || Array.isArray(message) ||
        Object.keys(message).length !== 2 || !Object.hasOwn(message, "n") || !Object.hasOwn(message, "t")) return false;
    return message.n === 0 && message.t === "__ready";
  } catch {
    return false;
  }
}

export class Encoder {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
    this.interned = new Map();
    this.nextIntern = 1;
    this.enc = new TextEncoder();
  }

  reserve(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len), 0);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) { this.reserve(1); this.buf[this.len++] = v & 0xff; }
  u32(v) { this.reserve(4); this.view.setUint32(this.len, v >>> 0, true); this.len += 4; }
  str(s) {
    const b = this.enc.encode(s);
    this.u32(b.length);
    this.reserve(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  iref(v) {
    const hit = this.interned.get(v);
    if (hit !== undefined) return hit;
    const id = this.nextIntern++;
    this.interned.set(v, id);
    this.u8(OPS.INTERN); this.u32(id); this.str(v);
    return id;
  }

  createElement(id, tag) { const t = this.iref(tag); this.u8(OPS.CREATE_ELEMENT); this.u32(id); this.u32(t); }
  createText(id, text) { this.u8(OPS.CREATE_TEXT); this.u32(id); this.str(text); }
  setText(id, text) { this.u8(OPS.SET_TEXT); this.u32(id); this.str(text); }
  setAttr(id, name, value) { const n = this.iref(name); this.u8(OPS.SET_ATTR); this.u32(id); this.u32(n); this.str(value); }
  removeAttr(id, name) { const n = this.iref(name); this.u8(OPS.REMOVE_ATTR); this.u32(id); this.u32(n); }
  setProp(id, name, value) { const n = this.iref(name); this.u8(OPS.SET_PROP); this.u32(id); this.u32(n); this.str(value); }
  append(parent, child) { this.u8(OPS.APPEND); this.u32(parent); this.u32(child); }
  insertBefore(parent, child, ref) { this.u8(OPS.INSERT_BEFORE); this.u32(parent); this.u32(child); this.u32(ref); }
  remove(id) { this.u8(OPS.REMOVE); this.u32(id); }
  listen(id, type, slot) { const t = this.iref(type); this.u8(OPS.LISTEN); this.u32(id); this.u32(t); this.u32(slot); }
  unlisten(id, type) { const t = this.iref(type); this.u8(OPS.UNLISTEN); this.u32(id); this.u32(t); }

  take() {
    const out = this.buf.subarray(0, this.len);
    this.len = 0;
    return out;
  }

  get empty() { return this.len === 0; }
}

export class Window {
  constructor({ title = "nativetron", width = 800, height = 600 } = {}) {
    this.enc = new Encoder();
    this.slots = [];
    this.ready = false;
    this.pending = [];
    this.onReady = null;
    this.closed = false;

    native.init();
    native.addInit(HOST_JS);
    native.addInit(NATIVE_EVENT_BRIDGE_JS);
    native.setTitle(title);
    native.setSize(width, height);
    native.onMessage((raw) => this._message(raw));
    native.setHtml(
      '<!doctype html><meta charset="utf-8">' +
        '<body style="font-family:-apple-system,system-ui,sans-serif;margin:32px;color:#111">' +
        '<div id="nt-root"></div></body>',
    );
  }

  _message(raw) {
    const payload = webviewMessage(raw);
    if (payload === null) return;
    if (readyMessage(payload)) {
      this.ready = true;
      for (const batch of this.pending) native.applyBatch(batch);
      this.pending.length = 0;
      if (this.onReady) this.onReady();
      return;
    }
    const event = parseNativeEventMessage(payload);
    if (event === null) return;
    const handler = this.slots[event.slot];
    if (handler) handler(event.value);
    this.flush();
  }

  listen(id, type, handler) {
    const slot = this.slots.length;
    this.slots.push(handler);
    this.enc.listen(id, type, slot);
  }

  flush() {
    if (this.enc.empty) return;
    const b = this.enc.take();
    if (!this.ready) { this.pending.push(Uint8Array.from(b)); return; }
    native.applyBatch(b);
  }

  eval(js) { native.eval(js); }

  run(intervalMs = 8) {
    native.activate();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.closed || native.pump()) { resolve(); return; }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  close() {
    this.closed = true;
    native.terminate();
  }
}

export { native, OPS };

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const hostSrc = readFileSync(join(here, "..", "host", "dom-host.js"), "utf8");

function makeNode(kind, tag) {
  return {
    kind, tag, children: [], attrs: {}, _text: "", listeners: {}, parentNode: null,
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    addEventListener(t, h) { (this.listeners[t] ||= []).push(h); },
    removeEventListener(t, h) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== h); },
  };
}

const root = makeNode("element", "div");
const document = {
  readyState: "complete",
  getElementById: (id) => (id === "nt-root" ? root : null),
  createElement: (tag) => makeNode("element", tag),
  createTextNode: (t) => { const n = makeNode("text", null); n._text = String(t); return n; },
  addEventListener() {},
};

const sandbox = { document, window: {}, console, TextDecoder };
vm.createContext(sandbox);

const glue = await import(pathToFileURL(join(here, ".scriptc", "renderer.mjs")).href);
const wasm = readFileSync(join(here, ".scriptc", "renderer.wasm"));

let api;
sandbox.window.__nt_send = (json) => {};
sandbox.window.__nt_event = (slot, value) => { if (api) { if (value) api.nt_on_event_value(slot, value); else api.nt_on_event(slot); } };
vm.runInContext(hostSrc, sandbox);
const nt = sandbox.window.__nt;

api = await glue.instantiateFromBytes(wasm, {
  ntApply: (bytes) => { nt.applyBin(bytes); },
});


api.nt_start();

assert.equal(root.children.length, 4, "h1, p, button, p");
assert.equal(root.children[0].tag, "h1");
assert.equal(root.children[0].children[0].textContent, "Hello from nativetron (wasm)");
assert.equal(root.children[2].tag, "button");
const out = root.children[3].children[0];
assert.equal(out.textContent, "count: 0");

const button = root.children[2];
button.listeners.click[0]({ target: {} });
assert.equal(out.textContent, "count: 1", "click -> compiled wasm handler -> DOM update");
button.listeners.click[0]({ target: {} });
button.listeners.click[0]({ target: {} });
assert.equal(out.textContent, "count: 3");

console.log("wasm renderer drives the DOM: build + 3 clicks -> count: 3");

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
    set textContent(v) {
      this._text = String(v);
      if (this.kind === "element") {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        if (v !== "") { const t = makeNode("text", null); t._text = String(v); t.parentNode = this; this.children.push(t); }
      }
    },
    get textContent() { return this._text; },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) {
      if (c.kind === "fragment") {
        for (const g of c.children.slice()) { if (g.parentNode) g.parentNode.removeChild(g); g.parentNode = this; this.children.push(g); }
        c.children = [];
        return c;
      }
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this; this.children.push(c); return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
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
  createDocumentFragment: () => makeNode("fragment", null),
  addEventListener() {},
};

const sandbox = { document, window: {}, console, TextDecoder };
vm.createContext(sandbox);

const glue = await import(pathToFileURL(join(here, ".scriptc", "renderer.mjs")).href);
const wasm = readFileSync(join(here, ".scriptc", "renderer.wasm"));

let api;
sandbox.window.__nt_send = () => {};
sandbox.window.__nt_event = (slot, value) => { if (api) { if (value) api.nt_on_event_value(slot, value); else api.nt_on_event(slot); } };
vm.runInContext(hostSrc, sandbox);
const nt = sandbox.window.__nt;

api = await glue.instantiateFromBytes(wasm, { ntApply: (bytes) => nt.applyBin(bytes) });
api.nt_start();

const main = root.children[0];
const text = (n) => (n.kind === "text" ? n.textContent : n.children.map(text).join(""));
const section = (i) => main.children[2 + i];
const counter = section(0);
const list = section(1);
const ul = list.children.find((c) => c.tag === "ul");
const liText = () => ul.children.map((li) => text(li));
const clickButton = (sec, label) => {
  const b = sec.children.find((c) => c.tag === "button" && text(c) === label);
  assert.ok(b, `button ${label} not found`);
  b.listeners.click[0]({ target: {} });
};

assert.equal(main.tag, "main");
assert.equal(text(main.children[0]), "nativetron");
assert.equal(text(counter.children[0]), "Counter");

const countP = counter.children[counter.children.length - 1];
assert.equal(text(countP), "count: 0");
clickButton(counter, "Increment");
clickButton(counter, "Increment");
assert.equal(text(countP), "count: 2", "counter updates through compiled handler");

assert.deepEqual(liText(), ["alpha", "beta", "gamma"], "initial keyed list");

clickButton(list, "Add");
assert.deepEqual(liText(), ["alpha", "beta", "gamma", "item-1"], "append new key");

clickButton(list, "Remove first");
assert.deepEqual(liText(), ["beta", "gamma", "item-1"], "REMOVE op drops the node");

clickButton(list, "Reverse");
assert.deepEqual(liText(), ["item-1", "gamma", "beta"], "INSERT_BEFORE reorders keyed nodes");

clickButton(list, "Add");
assert.deepEqual(liText(), ["item-1", "gamma", "beta", "item-2"], "append after reorder");

clickButton(list, "Reverse");
assert.deepEqual(liText(), ["item-2", "beta", "gamma", "item-1"], "reorder again");

const countLabel = list.children[list.children.length - 1];
assert.equal(text(countLabel), "4 items", "reactive count tracks the list");

console.log("components + signals + keyed list (add/remove/reorder): all checks passed");

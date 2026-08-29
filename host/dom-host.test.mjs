// Headless conformance test for the DOM Host ABI v0 host runtime.
// Runs host/dom-host.js against a minimal mock DOM (no browser) and asserts
// that command batches build the expected tree and events round-trip.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "dom-host.js"), "utf8");

// --- tiny mock DOM ---------------------------------------------------------
function makeNode(kind, tag) {
  return {
    kind, tag, children: [], attrs: {}, _text: "", listeners: {},
    parentNode: null,
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    addEventListener(t, h) { (this.listeners[t] ||= []).push(h); },
    removeEventListener(t, h) {
      this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== h);
    },
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

const sent = [];
const sandbox = { document, window: {}, TextDecoder };
sandbox.window.__nt_send = (s) => sent.push(JSON.parse(s));
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const nt = sandbox.window.__nt;

// __ready fires synchronously since readyState==="complete"
assert.deepEqual(sent.shift(), { n: 0, t: "__ready" }, "ready control message");

// --- apply a batch (same opcodes the renderer emits) -----------------------
const [H1, H1T, BTN, BLBL, OUT, OUTT] = [1, 2, 3, 4, 5, 6];
nt.apply([
  [1, H1, "h1"], [2, H1T, "Hello"], [6, H1, H1T], [6, 0, H1],
  [1, BTN, "button"], [4, BTN, "style", "x"], [2, BLBL, "Increment"], [6, BTN, BLBL], [6, 0, BTN],
  [1, OUT, "p"], [2, OUTT, "count: 0"], [6, OUT, OUTT], [6, 0, OUT],
  [9, BTN, "click"],
]);

assert.equal(root.children.length, 3, "root has h1, button, p");
assert.equal(root.children[0].tag, "h1");
assert.equal(root.children[0].children[0].textContent, "Hello");
assert.equal(root.children[1].tag, "button");
assert.equal(root.children[1].attrs.style, "x");
assert.equal(root.children[2].children[0].textContent, "count: 0");

// --- event round-trip: simulate a click ------------------------------------
root.children[1].listeners.click[0]({ target: {} });
assert.deepEqual(sent.shift(), { n: BTN, t: "click" }, "click event posted");

// --- SET_TEXT (what the native handler emits on click) ---------------------
nt.apply([[3, OUTT, "count: 1"]]);
assert.equal(root.children[2].children[0].textContent, "count: 1", "SET_TEXT applied");

// --- input value + SET_PROP + UNLISTEN -------------------------------------
const INP = 7;
nt.apply([[1, INP, "input"], [6, 0, INP], [11, INP, "value", "hi"], [9, INP, "input"]]);
assert.equal(root.children[3].value, "hi", "SET_PROP set value");
root.children[3].listeners.input[0]({ target: { value: "typed" } });
assert.deepEqual(sent.shift(), { n: INP, t: "input", value: "typed" }, "input event carries value");
nt.apply([[10, INP, "input"]]);
assert.equal(root.children[3].listeners.input.length, 0, "UNLISTEN removed handler");

// binary encoding (ABI v1 + interned names)
const root2 = makeNode("element", "div");
document.getElementById = (id) => (id === "nt-root" ? root2 : null);
const enc = [];
const te = new TextEncoder();
const pushU32 = (v) => { enc.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
const pushStr = (s) => { const b = te.encode(s); pushU32(b.length); for (const x of b) enc.push(x); };
const intern = (id, v) => { enc.push(12); pushU32(id); pushStr(v); };
intern(1, "h1"); intern(2, "button"); intern(3, "style"); intern(4, "click");
enc.push(1); pushU32(11); pushU32(1);
enc.push(2); pushU32(12); pushStr("Bin");
enc.push(6); pushU32(0); pushU32(11);
enc.push(6); pushU32(11); pushU32(12);
enc.push(1); pushU32(13); pushU32(2);
enc.push(4); pushU32(13); pushU32(3); pushStr("x");
enc.push(6); pushU32(0); pushU32(13);
enc.push(9); pushU32(13); pushU32(4); pushU32(4);
let slotSeen = null;
sandbox.window.__nt_event = (slot, value) => { slotSeen = [slot, value]; };
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children.length, 2, "binary: h1 + button");
assert.equal(root2.children[0].children[0].textContent, "Bin");
assert.equal(root2.children[1].attrs.style, "x");
root2.children[1].listeners.click[0]({ target: {} });
assert.deepEqual(slotSeen, [4, ""], "binary: slot-based event");
enc.length = 0;
enc.push(3); pushU32(12); pushStr("Bin2");
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[0].children[0].textContent, "Bin2", "binary SET_TEXT");
enc.length = 0;
enc.push(8); pushU32(13);
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children.length, 1, "binary REMOVE");

console.log("DOM Host ABI v0 (json) + v1 (binary): all conformance checks passed");

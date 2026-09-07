import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "dom-host.js"), "utf8");

// opcodes come from the spec, so a change to abi/ops.json that the decoder
// has not followed fails here instead of drifting silently
const OPS = Object.fromEntries(
  JSON.parse(readFileSync(join(here, "..", "abi", "ops.json"), "utf8")).ops.map((o) => [o.name, o.code]),
);


function makeNode(kind, tag) {
  return {
    kind, tag, children: [], attrs: {}, _text: "", listeners: {},
    parentNode: null,
    set textContent(v) {
      this._text = String(v);
      if (this.kind === "element") {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        if (v !== "") { const t = makeNode("text", null); t._text = String(v); t.parentNode = this; this.children.push(t); }
      }
    },
    get textContent() { return this.kind === "element" ? this.children.map((c) => c.textContent).join("") : this._text; },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.children.indexOf(this);
      return this.parentNode.children[i + 1] || null;
    },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) {
      if (c.kind === "fragment") {
        for (const g of c.children.slice()) { g.parentNode = this; this.children.push(g); }
        c.children = [];
        return c;
      }
      if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
      c.parentNode = this; this.children.push(c); return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
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
  createDocumentFragment: () => makeNode("fragment", null),
  addEventListener() {},
};

const sent = [];
const sandbox = { document, window: {}, TextDecoder };
sandbox.window.__nt_send = (s) => sent.push(JSON.parse(s));
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const nt = sandbox.window.__nt;

assert.deepEqual(sent.shift(), { n: 0, t: "__ready" }, "ready control message");

const root2 = makeNode("element", "div");
document.getElementById = (id) => (id === "nt-root" ? root2 : null);
const enc = [];
const te = new TextEncoder();
const pushU32 = (v) => { enc.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
const pushStr = (s) => { const b = te.encode(s); pushU32(b.length); for (const x of b) enc.push(x); };
const intern = (id, v) => { enc.push(OPS.INTERN); pushU32(id); pushStr(v); };
intern(1, "h1"); intern(2, "button"); intern(3, "style"); intern(4, "click"); intern(6, "value");
enc.push(OPS.CREATE_ELEMENT); pushU32(11); pushU32(1);
enc.push(OPS.CREATE_TEXT); pushU32(12); pushStr("Bin");
enc.push(OPS.APPEND); pushU32(0); pushU32(11);
enc.push(OPS.APPEND); pushU32(11); pushU32(12);
enc.push(OPS.CREATE_ELEMENT); pushU32(13); pushU32(2);
enc.push(OPS.SET_ATTR); pushU32(13); pushU32(3); pushStr("x");
enc.push(OPS.APPEND); pushU32(0); pushU32(13);
enc.push(OPS.LISTEN); pushU32(13); pushU32(4); pushU32(4);
let slotSeen = null;
sandbox.window.__nt_event = (slot, value) => { slotSeen = [slot, value]; };
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children.length, 2, "binary: h1 + button");
assert.equal(root2.children[0].children[0].textContent, "Bin");
assert.equal(root2.children[1].attrs.style, "x");
const button = root2.children[1];
enc.length = 0;
enc.push(OPS.REMOVE_ATTR); pushU32(13); pushU32(3);
nt.applyBin(new Uint8Array(enc));
assert.equal(button.attrs.style, undefined, "binary REMOVE_ATTR");
enc.length = 0;
enc.push(OPS.SET_PROP); pushU32(13); pushU32(6); pushStr("assigned");
nt.applyBin(new Uint8Array(enc));
assert.equal(button.value, "assigned", "binary SET_PROP");
button.listeners.click[0]({ target: {} });
assert.deepEqual(slotSeen, [4, ""], "binary: slot-based event");
assert.equal(sent.length, 0, "binary lane posts no json event messages");
enc.length = 0;
enc.push(OPS.SET_TEXT); pushU32(12); pushStr("Bin2");
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[0].children[0].textContent, "Bin2", "binary SET_TEXT");
enc.length = 0;
intern(5, "li");
enc.push(OPS.CREATE_ELEMENT); pushU32(24); pushU32(5);
enc.push(OPS.APPEND); pushU32(0); pushU32(24);
enc.push(OPS.INSERT_BEFORE); pushU32(0); pushU32(24); pushU32(11);
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[0].tag, "li", "binary INSERT_BEFORE");
enc.length = 0;
enc.push(OPS.REMOVE); pushU32(24);
nt.applyBin(new Uint8Array(enc));
enc.length = 0;
enc.push(OPS.ELEMENT_WITH_TEXT); pushU32(0); pushU32(20); pushU32(5); pushU32(21); pushStr("compound");
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[root2.children.length - 1].tag, "li", "compound: element created");
assert.equal(root2.children[root2.children.length - 1].textContent, "compound", "compound: text set");
enc.length = 0;
enc.push(OPS.SET_TEXT); pushU32(21); pushStr("patched");
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[root2.children.length - 1].textContent, "patched", "compound: text node id is addressable");
enc.length = 0;
enc.push(OPS.ELEMENT_WITH_TEXT); pushU32(0); pushU32(22); pushU32(5); pushU32(23); pushStr("");
nt.applyBin(new Uint8Array(enc));
enc.length = 0;
enc.push(OPS.SET_TEXT); pushU32(23); pushStr("filled");
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[root2.children.length - 1].textContent, "filled", "compound: empty text remains addressable");
enc.length = 0;
enc.push(OPS.REMOVE); pushU32(22);
nt.applyBin(new Uint8Array(enc));
enc.length = 0;
enc.push(OPS.UNLISTEN); pushU32(13); pushU32(4);
nt.applyBin(new Uint8Array(enc));
assert.equal(button.listeners.click.length, 0, "binary UNLISTEN");
enc.length = 0;
enc.push(OPS.LISTEN); pushU32(13); pushU32(4); pushU32(5);
nt.applyBin(new Uint8Array(enc));
assert.equal(button.listeners.click.length, 1, "binary LISTEN after UNLISTEN");
enc.length = 0;
enc.push(OPS.REMOVE); pushU32(20);
nt.applyBin(new Uint8Array(enc));
enc.length = 0;
enc.push(OPS.SET_TEXT); pushU32(21); pushStr("stale");
assert.throws(() => nt.applyBin(new Uint8Array(enc)), "REMOVE clears descendant ids");
enc.length = 0;
enc.push(OPS.REMOVE); pushU32(13);
nt.applyBin(new Uint8Array(enc));
assert.equal(button.listeners.click.length, 0, "REMOVE detaches listeners");
assert.equal(root2.children.length, 1, "binary REMOVE");

enc.length = 0;
enc.push(OPS.CREATE_ELEMENT); pushU32(30); pushU32(5);
enc.push(OPS.CREATE_ELEMENT); pushU32(31); pushU32(2);
enc.push(OPS.LISTEN); pushU32(31); pushU32(4); pushU32(6);
enc.push(OPS.APPEND); pushU32(30); pushU32(31);
enc.push(OPS.APPEND); pushU32(0); pushU32(30);
nt.applyBin(new Uint8Array(enc));
const rewrittenChild = root2.children[root2.children.length - 1].children[0];
enc.length = 0;
enc.push(OPS.SET_TEXT); pushU32(30); pushStr("replacement");
nt.applyBin(new Uint8Array(enc));
assert.equal(rewrittenChild.listeners.click.length, 0, "SET_TEXT detaches descendant listeners");
enc.length = 0;
enc.push(OPS.SET_ATTR); pushU32(31); pushU32(3); pushStr("stale");
assert.throws(() => nt.applyBin(new Uint8Array(enc)), "SET_TEXT clears descendant ids");
enc.length = 0;
enc.push(OPS.REMOVE); pushU32(30);
nt.applyBin(new Uint8Array(enc));

enc.length = 0;
enc.push(OPS.CREATE_ELEMENT); pushU32(65535); pushU32(5);
enc.push(OPS.CREATE_ELEMENT); pushU32(65536); pushU32(5);
enc.push(OPS.CREATE_TEXT); pushU32(65537); pushStr("overflow");
enc.push(OPS.APPEND); pushU32(65536); pushU32(65537);
enc.push(OPS.APPEND); pushU32(0); pushU32(65535);
enc.push(OPS.APPEND); pushU32(0); pushU32(65536);
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[root2.children.length - 1].textContent, "overflow", "overflow ids resolve");
enc.length = 0;
enc.push(OPS.REMOVE); pushU32(65535);
enc.push(OPS.REMOVE); pushU32(65536);
nt.applyBin(new Uint8Array(enc));
enc.length = 0;
enc.push(OPS.SET_TEXT); pushU32(65537); pushStr("stale");
assert.throws(() => nt.applyBin(new Uint8Array(enc)), "overflow REMOVE clears descendant ids");

console.log("DOM Host ABI: binary conformance checks passed");

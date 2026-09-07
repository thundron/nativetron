import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createTestDocument, makeTestNode } from "./test-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "dom-host.js"), "utf8");

// opcodes come from the spec, so a change to abi/ops.json that the decoder
// has not followed fails here instead of drifting silently
const OPS = Object.fromEntries(
  JSON.parse(readFileSync(join(here, "..", "abi", "ops.json"), "utf8")).ops.map((o) => [o.name, o.code]),
);
const EVENT_SCHEMA = JSON.parse(readFileSync(join(here, "..", "abi", "events.json"), "utf8"));
const eventField = (args, name) => args[EVENT_SCHEMA.fields.findIndex((field) => field.name === name) + 1];
const eventLimit = (name) => EVENT_SCHEMA.fields.find((field) => field.name === name).maximum;

const dom = createTestDocument();
const document = dom.document;
const sent = [];
const sandbox = { document, window: {}, TextDecoder, atob };
sandbox.window.__nt_send = (s) => sent.push(JSON.parse(s));
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const nt = sandbox.window.__nt;

assert.deepEqual(sent.shift(), { n: 0, t: "__ready" }, "ready control message");

const root2 = makeTestNode("element", "div");
dom.setRoot(root2);
const enc = [];
const te = new TextEncoder();
const pushU32 = (v) => { enc.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
const pushStr = (s) => { const b = te.encode(s); pushU32(b.length); for (const x of b) enc.push(x); };
const intern = (id, v) => { enc.push(OPS.INTERN); pushU32(id); pushStr(v); };
intern(1, "h1"); intern(2, "button"); intern(3, "style"); intern(4, "click"); intern(6, "value");
intern(7, "checked"); intern(8, "svg"); intern(9, "path"); intern(10, "innerHTML"); intern(11, "script");
enc.push(OPS.CREATE_ELEMENT); pushU32(11); pushU32(1);
enc.push(OPS.CREATE_TEXT); pushU32(12); pushStr("Bin");
enc.push(OPS.APPEND); pushU32(0); pushU32(11);
enc.push(OPS.APPEND); pushU32(11); pushU32(12);
enc.push(OPS.CREATE_ELEMENT); pushU32(13); pushU32(2);
enc.push(OPS.SET_ATTR); pushU32(13); pushU32(3); pushStr("x");
enc.push(OPS.APPEND); pushU32(0); pushU32(13);
enc.push(OPS.LISTEN); pushU32(13); pushU32(4); pushU32(4);
let slotSeen = null;
let tierSeen = null;
for (const tier of EVENT_SCHEMA.dispatch) {
  sandbox.window[tier.callback] = (...args) => { slotSeen = args; tierSeen = tier.semantics; };
}
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
enc.push(OPS.SET_PROP); pushU32(13); pushU32(7); pushStr("true");
enc.push(OPS.FOCUS); pushU32(13);
nt.applyBin(new Uint8Array(enc));
assert.equal(button.value, "assigned", "binary SET_PROP string");
assert.equal(button.checked, true, "binary SET_PROP coerces an allowed boolean");
assert.equal(button.focusCount, 1, "binary FOCUS uses the bounded focus operation");
assert.equal(button.focusOptions.preventScroll, true);
button.listeners.click[0]({
  target: { value: "x".repeat(5000), checked: false },
  key: "Enter", code: "Enter", shiftKey: true,
});
assert.equal(slotSeen[0], 4, "binary: slot-based event");
assert.equal(tierSeen, "rich", "non-default metadata selects the rich generated tier");
assert.equal(slotSeen.length, EVENT_SCHEMA.fields.length + 1, "rich event callback arity follows the ABI schema");
assert.equal(eventField(slotSeen, "value").length, eventLimit("value"), "event values are bounded");
assert.equal(eventField(slotSeen, "checked"), 0, "checked state uses an explicit numeric arm");
assert.equal(eventField(slotSeen, "key"), "Enter");
assert.equal(eventField(slotSeen, "code"), "Enter");
assert.equal(eventField(slotSeen, "modifiers"), 8);
assert.equal(eventField(slotSeen, "inputType"), "");
button.listeners.click[0]({ target: {} });
assert.equal(tierSeen, "default", "plain click crosses the boundary with its numeric slot only");
assert.deepEqual(slotSeen, [4]);
button.listeners.click[0]({ target: { value: "primary" } });
assert.equal(tierSeen, "primary", "a primary-only event crosses with slot and one string");
assert.deepEqual(slotSeen, [4, "primary"]);
assert.equal(sent.length, 0, "binary lane posts no json event messages");
enc.length = 0;
enc.push(OPS.SET_PROP); pushU32(13); pushU32(10); pushStr("forbidden");
assert.throws(() => nt.applyBin(new Uint8Array(enc)), /unsupported property/, "general script-bearing properties fail closed");
enc.length = 0;
enc.push(OPS.CREATE_SVG_ELEMENT); pushU32(14); pushU32(8);
enc.push(OPS.CREATE_SVG_ELEMENT); pushU32(15); pushU32(9);
enc.push(OPS.APPEND); pushU32(14); pushU32(15);
enc.push(OPS.APPEND); pushU32(0); pushU32(14);
nt.applyBin(new Uint8Array(enc));
assert.equal(root2.children[root2.children.length - 1].namespace, "http://www.w3.org/2000/svg", "SVG namespace is explicit");
enc.length = 0;
enc.push(OPS.CREATE_SVG_ELEMENT); pushU32(16); pushU32(11);
assert.throws(() => nt.applyBin(new Uint8Array(enc)), /unsupported SVG tag/, "SVG tags fail closed");
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
enc.length = 0;
enc.push(OPS.FOCUS); pushU32(13);
assert.throws(() => nt.applyBin(new Uint8Array(enc)), /node is not focusable/, "removed nodes cannot receive deferred focus");
assert.equal(root2.children.length, 2, "binary REMOVE keeps the heading and SVG");

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

enc.length = 0;
intern(12, "mousemove");
enc.push(OPS.LISTEN); pushU32(11); pushU32(12); pushU32(99);
assert.throws(() => nt.applyBin(new Uint8Array(enc)), /unsupported event type/, "event types fail closed");
assert.throws(
  () => nt.applyBin(new Uint8Array([OPS.CREATE_ELEMENT, 1, 0])),
  /truncated u32 operand/,
  "missing operation fields fail closed before a decoder overread",
);
const truncatedString = [OPS.INTERN, 13, 0, 0, 0];
// Write a declared string length with no payload.
truncatedString.push(8, 0, 0, 0);
assert.throws(
  () => nt.applyBin(new Uint8Array(truncatedString)),
  /truncated string operand/,
  "malformed length-prefixed operands fail closed",
);
assert.throws(() => nt.applyB64("/w=="), /unsupported DOM opcode/, "unknown opcodes fail closed");
assert.match(sandbox.window.__nt_last_error, /unsupported DOM opcode/, "base64 transport retains a bounded diagnostic");

console.log("DOM Host ABI: binary conformance checks passed");

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createTestDocument } from "./test-dom.mjs";
const schema = JSON.parse(readFileSync(new URL("../abi/ops.json", import.meta.url)));
const codes = Object.fromEntries(schema.ops.map(op => [op.name, op.code]));
const events = JSON.parse(readFileSync(new URL("../abi/events.json", import.meta.url)));
const source = readFileSync(new URL("./dom-host.js", import.meta.url), "utf8");
const encoder = new TextEncoder();
function encode(ops) {
  const out = [];
  const u32 = value => out.push(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255);
  const text = value => { const bytes = encoder.encode(value); u32(bytes.length); out.push(...bytes); };
  for (const [name, ...args] of ops) {
    out.push(codes[name]);
    for (const [index, value] of args.entries()) {
      const field = schema.ops.find(op => op.name === name).args[index];
      if (field.endsWith(":str")) text(value); else u32(value);
    }
  }
  return new Uint8Array(out);
}
test("resize observations are owned and stale callbacks cannot dispatch", () => {
  const dom = createTestDocument(), observers = [], seen = [];
  const sandbox = { document: dom.document, window: { __nt_send() {}, __nt_event() {}, __nt_event_value() {}, __nt_event_rich: (...args) => seen.push(args) }, TextDecoder, atob,
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.disconnected = true; } },
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const host = sandbox.window.__nt;
  host.applyBin(encode([["INTERN",1,"div"],["INTERN",2,"resize"],["CREATE_ELEMENT",1,1],["LISTEN",1,2,7],["APPEND",0,1]]));
  assert.equal(observers.length, 1);
  observers[0].target.clientHeight = 240;
  observers[0].callback([]);
  assert.equal(seen[0][0], 7);
  assert.equal(seen[0][events.fields.findIndex(field => field.name === "clientHeight") + 1], 240);
  host.applyBin(encode([["REMOVE",1]]));
  assert.equal(observers[0].disconnected, true);
  observers[0].callback([]);
  assert.equal(seen.length, 1);
});
test("bounded scroll properties refuse lossy coercion and apply after insertion", () => {
  const dom = createTestDocument();
  const sandbox = { document: dom.document, window: { __nt_send() {} }, TextDecoder, atob };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const host = sandbox.window.__nt;
  host.applyBin(encode([["INTERN",1,"div"],["INTERN",2,"scrollTop"],["CREATE_ELEMENT",1,1],["SET_PROP",1,2,"12.5"],["APPEND",0,1]]));
  const root = dom.document.getElementById("nt-root");
  assert.equal(root.children[0].scrollTop, 12.5);
  for (const value of ["", "NaN", "Infinity", "-1", "1073741825", "12px"]) assert.throws(() => host.applyBin(encode([["SET_PROP",1,2,value]])), /numeric property/);
  assert.throws(() => host.applyBin(encode([["INTERN",3,"constructor"],["SET_PROP",1,3,"invalid"]])), /unsupported property/);
  assert.throws(() => host.applyBin(encode([["LISTEN",1,3,8]])), /unsupported event/);
  assert.throws(() => host.applyBin(encode([["CREATE_SVG_ELEMENT",2,3]])), /unsupported SVG tag/);
});

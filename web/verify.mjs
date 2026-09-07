import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { bindEventCallbacks } from "../host/event.generated.mjs";
import { createTestDocument, makeTestNode } from "../host/test-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostSrc = readFileSync(join(here, "..", "host", "dom-host.js"), "utf8");

const root = makeTestNode("element", "div");
const document = createTestDocument(root).document;

const sandbox = { document, window: {}, console, TextDecoder };
vm.createContext(sandbox);

const glue = await import(pathToFileURL(join(here, ".scriptc", "renderer.mjs")).href);
const wasm = readFileSync(join(here, ".scriptc", "renderer.wasm"));
assert.equal(
  wasm.includes(Buffer.from("JSON.stringify({version")),
  false,
  "native JSON event bridge must not be linked into the browser Wasm hot path",
);

let api;
sandbox.window.__nt_send = () => {};
bindEventCallbacks(sandbox.window, () => api, "nt");
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

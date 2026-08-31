// Binary vs JSON on nativetron's own pipeline, over a real captured op stream.
// The binary path is host/dom-host.js, unmodified. The JSON path applies the
// identical DOM calls from tuples, so only the codec differs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const OPS = Object.fromEntries(
  JSON.parse(readFileSync(join(root, "abi", "ops.json"), "utf8")).ops.map((o) => [o.code, o.name]),
);

function makeNode(kind, tag) {
  return {
    kind, tag, children: [], attrs: {}, _text: "", parentNode: null,
    set textContent(v) {
      this._text = String(v);
      if (this.kind === "element") { this.children = []; if (v !== "") { const t = makeNode("text", null); t._text = String(v); t.parentNode = this; this.children.push(t); } }
    },
    get textContent() { return this.kind === "element" ? this.children.map((c) => c.textContent).join("") : this._text; },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) {
      if (c.kind === "fragment") { for (const g of c.children) { g.parentNode = this; this.children.push(g); } c.children = []; return c; }
      c.parentNode = this; this.children.push(c); return c;
    },
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    addEventListener() {}, removeEventListener() {},
  };
}

function freshDoc() {
  const r = makeNode("element", "div");
  return {
    root: r,
    doc: {
      readyState: "complete",
      getElementById: (id) => (id === "nt-root" ? r : null),
      createElement: (tag) => makeNode("element", tag),
      createTextNode: (t) => { const n = makeNode("text", null); n._text = String(t); return n; },
      createDocumentFragment: () => makeNode("fragment", null),
      addEventListener() {},
    },
  };
}

function makeHost() {
  const { doc, root: r } = freshDoc();
  const sandbox = { document: doc, window: {}, TextDecoder, TextEncoder };
  sandbox.window.__nt_send = () => {};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, "host", "dom-host.js"), "utf8"), sandbox);
  return { nt: sandbox.window.__nt, root: r };
}

// Decode our wire format into neutral tuples (GPUIX-style), resolving interns
// so JSON carries the strings inline the way a JSON protocol must.
function toTuples(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const td = new TextDecoder();
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const str = () => { const n = u32(); const s = td.decode(bytes.subarray(o, o + n)); o += n; return s; };
  const interned = [];
  const out = [];
  while (o < bytes.length) {
    const op = bytes[o++];
    const name = OPS[op];
    if (name === "INTERN") { const id = u32(); interned[id] = str(); continue; }
    if (name === "ELEMENT_WITH_TEXT") { out.push(["elementWithText", u32(), u32(), interned[u32()], u32(), str()]); continue; }
    if (name === "CREATE_ELEMENT") { out.push(["createElement", u32(), interned[u32()]]); continue; }
    if (name === "CREATE_TEXT") { out.push(["createText", u32(), str()]); continue; }
    if (name === "SET_TEXT") { out.push(["setText", u32(), str()]); continue; }
    if (name === "SET_ATTR") { out.push(["setAttr", u32(), interned[u32()], str()]); continue; }
    if (name === "REMOVE_ATTR") { out.push(["removeAttr", u32(), interned[u32()]]); continue; }
    if (name === "APPEND") { out.push(["append", u32(), u32()]); continue; }
    if (name === "INSERT_BEFORE") { out.push(["insertBefore", u32(), u32(), u32()]); continue; }
    if (name === "REMOVE") { out.push(["remove", u32()]); continue; }
    if (name === "LISTEN") { out.push(["listen", u32(), interned[u32()], u32()]); continue; }
    if (name === "UNLISTEN") { out.push(["unlisten", u32(), interned[u32()]]); continue; }
    if (name === "SET_PROP") { out.push(["setProp", u32(), interned[u32()], str()]); continue; }
    throw new Error("unhandled op " + op + " (" + name + ")");
  }
  return out;
}

function applyTuples(tuples, doc, r, nodes = []) {
  const node = (id) => (id === 0 ? r : nodes[id]);
  for (let i = 0; i < tuples.length; i++) {
    const t = tuples[i];
    switch (t[0]) {
      case "elementWithText": { const e = doc.createElement(t[3]); e.textContent = t[5]; nodes[t[2]] = e; nodes[t[4]] = e.firstChild; node(t[1]).appendChild(e); break; }
      case "createElement": nodes[t[1]] = doc.createElement(t[2]); break;
      case "createText": nodes[t[1]] = doc.createTextNode(t[2]); break;
      case "setText": node(t[1]).textContent = t[2]; break;
      case "setAttr": node(t[1]).setAttribute(t[2], t[3]); break;
      case "removeAttr": node(t[1]).removeAttribute(t[2]); break;
      case "append": node(t[1]).appendChild(node(t[2])); break;
      case "insertBefore": node(t[1]).insertBefore(node(t[2]), node(t[3])); break;
      case "remove": { const n = node(t[1]); if (n && n.parentNode) n.parentNode.removeChild(n); break; }
      case "listen": node(t[1]).addEventListener(t[2], () => {}); break;
      case "unlisten": break;
      case "setProp": node(t[1])[t[2]] = t[3]; break;
    }
  }
}

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const fmt = (n, d = 2) => n.toFixed(d).padStart(8);

function bench(label, bin, prefix) {
  const tuples = toTuples(bin);
  const json = JSON.stringify(tuples);
  const jsonBytes = Buffer.byteLength(json);
  const preTuples = prefix ? toTuples(prefix) : null;

  // correctness: identical apply path from both codecs must agree
  const a = freshDoc(); const an = []; if (preTuples) applyTuples(preTuples, a.doc, a.root, an); applyTuples(tuples, a.doc, a.root, an);
  const b2 = freshDoc(); const bn = []; if (preTuples) applyTuples(preTuples, b2.doc, b2.root, bn); applyTuples(JSON.parse(json), b2.doc, b2.root, bn);
  const same = a.root.textContent === b2.root.textContent;

  const reps = 15;
  const binDec = [], jsonDec = [], binE2E = [], jsonE2E = [];
  for (let i = 0; i < reps; i++) {
    { const t = performance.now(); toTuples(bin); binDec.push(performance.now() - t); }
    { const t = performance.now(); JSON.parse(json); jsonDec.push(performance.now() - t); }
    { const f = freshDoc(); const nn = []; if (preTuples) applyTuples(preTuples, f.doc, f.root, nn);
      const t = performance.now(); applyTuples(toTuples(bin), f.doc, f.root, nn); binE2E.push(performance.now() - t); }
    { const f = freshDoc(); const nn = []; if (preTuples) applyTuples(preTuples, f.doc, f.root, nn);
      const t = performance.now(); applyTuples(JSON.parse(json), f.doc, f.root, nn); jsonE2E.push(performance.now() - t); }
  }
  const b = median(binDec), j = median(jsonDec);
  console.log(`\n  ${label}  (${tuples.length.toLocaleString()} ops, both codecs agree: ${same ? "yes" : "NO"})`);
  console.log(`    wire bytes    binary ${bin.length.toLocaleString().padStart(9)}   json ${jsonBytes.toLocaleString().padStart(9)}   json/binary ${(jsonBytes / bin.length).toFixed(2)}x`);
  console.log(`    gzipped       binary ${gzipSync(bin).length.toLocaleString().padStart(9)}   json ${gzipSync(Buffer.from(json)).length.toLocaleString().padStart(9)}   json/binary ${(gzipSync(Buffer.from(json)).length / gzipSync(bin).length).toFixed(2)}x`);
  console.log(`    decode only   binary ${fmt(b)} ms   json ${fmt(j)} ms   json/binary ${(j / b).toFixed(2)}x`);
  const be = median(binE2E), je = median(jsonE2E);
  console.log(`    decode+apply  binary ${fmt(be)} ms   json ${fmt(je)} ms   json/binary ${(je / be).toFixed(2)}x   (identical apply path)`);
}

const mount = new Uint8Array(readFileSync("/tmp/mount.bin"));
const update = new Uint8Array(readFileSync("/tmp/update.bin"));
bench("mount 10k rows", mount, null);
bench("update 10k rows", update, mount);

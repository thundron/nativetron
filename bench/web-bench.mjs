#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const REACT = join(ROOT, "web-react");
const WEB = join(REPO, "web", ".scriptc");

const size = (p) => (existsSync(p) ? statSync(p).size : 0);
const gz = (p) => (existsSync(p) ? gzipSync(readFileSync(p)).length : 0);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

if (existsSync(join(REACT, "node_modules"))) {
  try {
    execFileSync("npx", ["esbuild", "app.jsx", "--bundle", "--minify", "--format=esm",
      "--define:process.env.NODE_ENV=\"production\"", "--outfile=bundle.js"], { cwd: REACT, stdio: "ignore" });
  } catch {}
}

const nt = {
  wasm: join(WEB, "renderer.wasm"),
  glue: join(WEB, "renderer.mjs"),
  host: join(REPO, "host", "dom-host.js"),
};
const ntRaw = size(nt.wasm) + size(nt.glue) + size(nt.host);
const ntGz = gz(nt.wasm) + gz(nt.glue) + gz(nt.host);
const rxRaw = size(join(REACT, "bundle.js"));
const rxGz = gz(join(REACT, "bundle.js"));

const ratio = (a, b) => (a && b ? `${(b / a).toFixed(2)}×` : "n/a");

console.log("# nativetron (wasm) vs React — browser payload\n");
console.log("Identical app: h1 + paragraph + Increment button + counter.\n");
console.log("| artifact | nativetron | react |");
console.log("|---|---|---|");
console.log(`| app+runtime (raw) | ${kb(ntRaw)} | ${rxRaw ? kb(rxRaw) : "n/a"} |`);
console.log(`| app+runtime (gzip) | ${kb(ntGz)} | ${rxGz ? kb(rxGz) : "n/a"} |`);
console.log(`| — wasm / react+react-dom+app | ${kb(size(nt.wasm))} | ${rxRaw ? kb(rxRaw) : "n/a"} |`);
console.log(`| — JS glue | ${kb(size(nt.glue))} | — |`);
console.log(`| — DOM host | ${kb(size(nt.host))} | — |`);
console.log(`\nratio (react / nativetron): raw ${ratio(ntRaw, rxRaw)}, gzip ${ratio(ntGz, rxGz)}`);
console.log("\nnativetron ships no framework runtime in JS: the reconciler and all app");
console.log("logic are AOT-compiled into the wasm. The wasm's fixed cost is the scriptc");
console.log("runtime (GC, strings, JSON); React's fixed cost is react+react-dom.");

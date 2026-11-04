import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "engine/assets.json"), "utf8"));

test("asset policy generated files do not drift", () => execFileSync(process.execPath, [resolve(root, "engine/generate-assets.mjs"), "--check"]));
test("all bundled module imports resolve inside the allowlist", () => {
  const files = new Set(manifest.files.map(file => file.path));
  for (const file of manifest.files) {
    if (!/\.(html|m?js)$/.test(file.path)) continue;
    if (!existsSync(resolve(root, file.path))) continue; // wasm glue is checked after build/package.
    const source = readFileSync(resolve(root, file.path), "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bfetch\s*\(\s*|\bnew\s+URL\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const dependency = posix.normalize(posix.join(posix.dirname(file.path), match[1]));
      assert.ok(files.has(dependency), `${file.path} imports unbundled ${dependency}`);
    }
  }
});
test("portable native policy denies unknown/traversal paths and reports exact MIME", () => {
  const temp = mkdtempSync(join(tmpdir(), "nt-assets-"));
  try {
    const source = `#include ${JSON.stringify(resolve(root, "native/assets.generated.h"))}\n#include <assert.h>\nint main(){assert(strcmp(nt_asset_mime("gpu/.scriptc/demo.wasm"),"application/wasm")==0);assert(strcmp(nt_asset_mime("engine/worker.js"),"text/javascript")==0);assert(!nt_asset_mime("../.git/config"));assert(!nt_asset_mime("engine/../gpu/.scriptc/demo.wasm"));assert(!nt_asset_mime(".git/config"));assert(!nt_asset_mime("unknown.js"));}\n`;
    writeFileSync(join(temp, "main.cc"), source);
    execFileSync("clang++", ["-std=c++17", join(temp, "main.cc"), "-o", join(temp, "test")]);
    execFileSync(join(temp, "test"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("staged files match source manifest byte counts and digests", (t) => {
  const packaged = resolve(root, "build/engine-assets/asset-manifest.json");
  if (!existsSync(packaged)) { t.skip("build/package engine assets first"); return; }
  const result = JSON.parse(readFileSync(packaged, "utf8"));
  assert.deepEqual(result.files.map(file => ({ path: file.path, mime: file.mime })), manifest.files);
  for (const asset of result.files) {
    const bytes = readFileSync(resolve(root, "build/engine-assets", asset.path));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  }
});

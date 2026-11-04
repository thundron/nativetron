import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bundleManifest, javaSource } from "../tools/bundle-manifest.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "nt-android-bundle-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("lists dot-directory assets and hashes inline scripts exactly", () => {
  const inline = "\nimport { a } from \"./host.js\";\nconsole.log(a);\n";
  const root = fixture({
    "engine/page.html": `<!doctype html><script type="module">${inline}</script><script src="./x.js"></script>`,
    "engine/host.js": "export const a = 1;",
    "engine/.scriptc/ui.wasm": "\0asm",
    "engine/.scriptc/ui.mjs": "",
  });
  try {
    const manifest = bundleManifest(root);
    assert.deepEqual(manifest.files, ["engine/.scriptc/ui.mjs", "engine/.scriptc/ui.wasm", "engine/host.js", "engine/page.html"]);
    assert.deepEqual(manifest.hashes, [`'sha256-${createHash("sha256").update(inline).digest("base64")}'`]);
    const java = javaSource(manifest);
    assert.match(java, /"engine\/\.scriptc\/ui\.wasm"/);
    assert.match(java, /SCRIPT_HASHES = "'sha256-/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses unservable bundles", () => {
  for (const files of [
    { "engine/page.html": "", "engine/blob.bin": "" },
    { "engine/page.html": "", "engine/no-extension": "" },
    { "engine/page.html": "", "engine/bad name.js": "" },
    { "engine/page.html": "<button onclick=\"x()\">" },
    { "engine/page.html": "<a href=\"javascript:x()\">" },
    { "engine/other.html": "" },
  ]) {
    const root = fixture(files);
    try { assert.throws(() => bundleManifest(root)); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

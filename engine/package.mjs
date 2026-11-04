import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build/engine-assets");
rmSync(output, { recursive: true, force: true });
const manifest = JSON.parse(readFileSync(resolve(root, "engine/assets.json"), "utf8"));
const files = [];
for (const asset of manifest.files) {
  const file = asset.path;
  const target = resolve(output, file);
  if (!target.startsWith(output + "/")) throw new Error("asset path escapes output");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(root, file), target);
  const bytes = readFileSync(target);
  files.push({ ...asset, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
writeFileSync(resolve(output, "asset-manifest.json"), JSON.stringify({ ...manifest, files }, null, 2) + "\n");
console.log(output);

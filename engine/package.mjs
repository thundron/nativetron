import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build/engine-assets");
rmSync(output, { recursive: true, force: true });
const files = [
  "engine/page.html", "engine/host.js", "engine/worker.js", "engine/reactor.js",
  "engine/.scriptc/ui.mjs", "engine/.scriptc/ui.wasm",
  "gpu/.scriptc/demo.mjs", "gpu/.scriptc/demo.wasm", "gpu/host.js", "gpu/gpu-host.generated.js",
  "host/dom-host.js", "host/event.generated.mjs", "ipc/engine.generated.mjs", "ipc/engine-bridge.generated.mjs",
];
for (const file of files) {
  const target = resolve(output, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(root, file), target);
}
console.log(output);

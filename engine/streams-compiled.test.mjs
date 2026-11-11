import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = resolve(root, "../../scriptc/packages/cli/dist/main.js");
test("compiled Wasm engineOffer returns scalar backpressure for state and bulk bytes", async t => {
  if (!existsSync(compiler)) { t.skip("build the scriptc checkout first"); return; }
  const dir = await mkdtemp(join(tmpdir(), "nt-compiled-stream-"));
  try {
    const scratch = join(dir, "scratch"); await mkdir(scratch);
    await writeFile(join(dir, "probe.ts"), `import {offerState,offerBulk} from ${JSON.stringify(resolve(root, "engine/transport.js"))}; export function probe():number { return (offerState(9,new Uint8Array([1,2]))?1:0)+(offerBulk(10,0,new Uint8Array(16*1024*1024))?2:0); }`);
    const abi = JSON.parse(await readFile(join(root, "gpu/profile.json"), "utf8")).abi;
    for (const key of Object.keys(abi)) if (typeof abi[key] === "string") abi[key] = abi[key].replaceAll("ntgpu_", "probe_");
    await writeFile(join(dir, "profile.json"), JSON.stringify({ profile_format: 1, name: "nt-stream-probe", entry: "probe.ts", emission: "llvm", abi, callbacks: [{ name: "engineOffer", params: ["bytes"], returns: "bool" }], exports: [{ export: "probe", symbol: "probe_probe", params: [], returns: "f64" }] }));
    execFileSync(process.execPath, [compiler, "build", "--lib", "--profile", join(dir, "profile.json"), "-o", join(dir, "probe.wasm")], { cwd: dir, env: { ...process.env, TMPDIR: scratch, SCRIPTC_TARGET: "wasm32-wasi" }, stdio: "pipe" });
    const { instantiateFromBytes } = await import(pathToFileURL(join(dir, "probe.mjs")));
    const seen = [];
    const api = await instantiateFromBytes(await readFile(join(dir, "probe.wasm")), { engineOffer: bytes => { seen.push(bytes.slice()); return bytes[1] === 6; } });
    assert.equal(api.probe_probe(), 1); assert.deepEqual(seen.map(bytes => bytes.length), [18, 16 * 1024 * 1024 + 16]);
    assert.deepEqual(await readdir(scratch), [], "compiler build left temporary directories behind");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

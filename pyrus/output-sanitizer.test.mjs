import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scriptc = process.env.SCRIPTC ?? join(root, "..", "..", "scriptc", "packages", "cli", "dist", "main.js");
assert.ok(existsSync(scriptc), `scriptc not found: ${scriptc}`);
const binary = join(root, "build", "pyrus-output-sanitizer-selftest");
const built = spawnSync(process.execPath, [scriptc, "build", join(here, "output-sanitizer.selftest.ts"), "--backend", "c", "-o", binary], {
  encoding: "utf8",
  timeout: 120000,
});
assert.equal(built.status, 0, built.stdout + built.stderr);
const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 30000 });
assert.equal(ran.status, 0, ran.stdout + ran.stderr);
assert.match(ran.stdout, /PYRUS_OUTPUT_SANITIZER=OK/);
const ipc = spawnSync(join(root, "build", "main"), [], {
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, NT_SELFTEST: "pyrus-output" },
});
assert.equal(ipc.status, 0, ipc.stdout + ipc.stderr);
assert.match(ipc.stdout, /NT_PYRUS_OUTPUT_SELFTEST=OK/);
console.log("pyrus output sanitizer: compiled workflow and IPC passed");

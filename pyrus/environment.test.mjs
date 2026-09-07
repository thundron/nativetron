import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scriptc = process.env.SCRIPTC ?? join(root, "..", "..", "scriptc", "packages", "cli", "dist", "main.js");
assert.ok(existsSync(scriptc), `scriptc not found: ${scriptc}`);
const binary = join(root, "build", "pyrus-environment-selftest");
const built = spawnSync(process.execPath, [scriptc, "build", join(here, "environment.selftest.ts"), "--backend", "c", "-o", binary], {
  encoding: "utf8",
  timeout: 120000,
});
assert.equal(built.status, 0, built.stdout + built.stderr);
const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 30000 });
assert.equal(ran.status, 0, ran.stdout + ran.stderr);
assert.match(ran.stdout, /PYRUS_ENVIRONMENT=OK/);
const processBinary = join(root, "build", "pyrus-process-runner-selftest");
const processBuilt = spawnSync(process.execPath, [scriptc, "build", join(here, "process-runner.selftest.ts"), "--backend", "c", "-o", processBinary], {
  encoding: "utf8",
  timeout: 120000,
});
assert.equal(processBuilt.status, 0, processBuilt.stdout + processBuilt.stderr);
const processRan = spawnSync(processBinary, [], { encoding: "utf8", timeout: 30000 });
assert.equal(processRan.status, 0, processRan.stdout + processRan.stderr);
assert.match(processRan.stdout, /PYRUS_PROCESS_RUNNER=OK/);
const ipc = spawnSync(join(root, "build", "main"), [], {
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, NT_SELFTEST: "process-security" },
});
assert.equal(ipc.status, 0, ipc.stdout + ipc.stderr);
assert.match(ipc.stdout, /NT_PROCESS_SECURITY_SELFTEST=OK/);
console.log("pyrus environment: filtering, bounded processes, and IPC policy passed");

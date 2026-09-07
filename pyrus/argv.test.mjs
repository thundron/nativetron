import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scriptc = process.env.SCRIPTC ?? join(root, "..", "..", "scriptc", "packages", "cli", "dist", "main.js");
assert.ok(existsSync(scriptc), `scriptc not found: ${scriptc}`);
for (const backend of ["c", "llvm"]) {
  const binary = join(root, "build", `pyrus-argv-selftest-${backend}`);
  const built = spawnSync(process.execPath, [scriptc, "build", join(here, "argv.selftest.ts"), "--backend", backend, "-o", binary], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 30000 });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /PYRUS_ARGV=OK/);
}
const ipc = spawnSync(join(root, "build", "main"), [], {
  encoding: "utf8",
  timeout: 30000,
  env: {
    ...process.env,
    NT_SELFTEST: "pyrus-argv",
    NT_PEAR_VERSION_OUTPUT: "Pear Runtime SemVer=3.2.4 pear://runtime",
  },
});
assert.equal(ipc.status, 0, ipc.stdout + ipc.stderr);
assert.match(ipc.stdout, /NT_PYRUS_ARGV_SELFTEST=OK/);
const unsupported = spawnSync(join(root, "build", "main"), [], {
  encoding: "utf8",
  timeout: 30000,
  env: {
    ...process.env,
    NT_SELFTEST: "pyrus-argv",
    NT_PEAR_VERSION_OUTPUT: "Pear Runtime SemVer=3.1.9 pear://runtime",
    NT_PEAR_VERSION_MODE: "unsupported",
  },
});
assert.equal(unsupported.status, 0, unsupported.stdout + unsupported.stderr);
assert.match(unsupported.stdout, /NT_PYRUS_ARGV_VERSION_SELFTEST=OK/);
console.log("pyrus argv: compiled versioned command construction and bounded IPC passed");

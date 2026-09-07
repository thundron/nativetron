import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scriptc = process.env.SCRIPTC ?? join(root, "..", "..", "scriptc", "packages", "cli", "dist", "main.js");
assert.ok(existsSync(scriptc), `scriptc not found: ${scriptc}`);

function referenceHash(target) {
  const hash = createHash("sha256");
  const queue = [""];
  while (queue.length > 0) {
    const relative = queue.shift();
    const names = readdirSync(join(target, relative)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const childRelative = relative.length > 0 ? `${relative}/${name}` : name;
      const filename = join(target, childRelative);
      const stat = lstatSync(filename);
      if (stat.isDirectory()) {
        hash.update(`directory\0${childRelative}\0`);
        queue.push(childRelative);
      } else {
        hash.update(`file\0${childRelative}\0${stat.size}\0`);
        hash.update(readFileSync(filename));
      }
    }
  }
  return hash.digest("hex");
}

const fixture = mkdtempSync(join(tmpdir(), "nativetron-build-hash-"));
const symlinkFixture = fixture + "-symlink";
try {
  const binaryData = Buffer.allocUnsafe(150_000);
  for (let i = 0; i < binaryData.length; i++) binaryData[i] = (i * 37 + 11) & 255;
  mkdirSync(join(fixture, "dir"));
  writeFileSync(join(fixture, "a.txt"), "alpha\n");
  writeFileSync(join(fixture, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(fixture, "dir", "b.bin"), binaryData);
  mkdirSync(join(symlinkFixture, "dir"), { recursive: true });
  writeFileSync(join(symlinkFixture, "a.txt"), "alpha\n");
  writeFileSync(join(symlinkFixture, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(symlinkFixture, "dir", "b.bin"), binaryData);
  symlinkSync("a.txt", join(symlinkFixture, "link"));

  const expectedHash = referenceHash(fixture);
  for (const backend of ["c", "llvm"]) {
    const binary = join(root, "build", `pyrus-build-hash-selftest-${backend}`);
    const built = spawnSync(process.execPath, [scriptc, "build", join(here, "build-hash.selftest.ts"), "--backend", backend, "-o", binary], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const ran = spawnSync(binary, [fixture], { encoding: "utf8", timeout: 30000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    const match = /PYRUS_BUILD_HASH=OK ([0-9a-f]{64})/.exec(ran.stdout);
    assert.ok(match, ran.stdout + ran.stderr);
    assert.equal(match[1], expectedHash);
  }
  const ipc = spawnSync(join(root, "build", "main"), [], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NT_SELFTEST: "pyrus-build-hash",
      NT_PYRUS_BUILD_ROOT: fixture,
      NT_PYRUS_BUILD_HASH: expectedHash,
    },
  });
  assert.equal(ipc.status, 0, ipc.stdout + ipc.stderr);
  assert.match(ipc.stdout, /NT_PYRUS_BUILD_HASH_SELFTEST=OK/);
  console.log("pyrus build hash: compiled traversal, digest, symlink refusal, and bounded IPC passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(symlinkFixture, { recursive: true, force: true });
}

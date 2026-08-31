import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scriptc = process.env.SCRIPTC ?? join(root, "..", "..", "scriptc", "packages", "cli", "dist", "main.js");
assert.ok(existsSync(scriptc), `scriptc not found: ${scriptc}`);
const binary = join(root, "build", "pyrus-release-review-selftest");
const built = spawnSync(process.execPath, [scriptc, "build", join(here, "release-review.selftest.ts"), "--backend", "c", "-o", binary], {
  encoding: "utf8",
  timeout: 120000,
});
assert.equal(built.status, 0, built.stdout + built.stderr);
const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 30000 });
assert.equal(ran.status, 0, ran.stdout + ran.stderr);
assert.match(ran.stdout, /PYRUS_RELEASE_REVIEW=OK/);
console.log("pyrus release review: compiled workflow passed");

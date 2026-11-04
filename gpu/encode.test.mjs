import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const scriptc = process.env.SCRIPTC ?? fileURLToPath(new URL("../../../scriptc/packages/cli/dist/main.js", import.meta.url));
const output = fileURLToPath(new URL("../build/gpu-encode-selftest", import.meta.url));
mkdirSync(new URL("../build/", import.meta.url), { recursive: true });
execFileSync(process.execPath, [scriptc, "build", "gpu/encode.selftest.ts", "--backend", "llvm", "-o", output], { cwd: root, stdio: "inherit" });
// Handles: slot 1 generation 1, then slot 1 generation 2 after destroy. Batch: header 9 + createBuffer 27 + destroy 5 + createBuffer 28.
assert.equal(execFileSync(output, { encoding: "utf8" }), "5/1/header/rolled-back/1048577/2097153/69\n4294967295/-2147483648/17\nbatches 1\n");
console.log("GPU encoder: protocol header, operand refusal with rollback, handle reuse and integer bounds");

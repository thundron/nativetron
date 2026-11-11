import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("only the affected simulator gets the WebContent and child JIT compatibility flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "nt-simulator-launch-"));
  try {
    const fixtures = join(dir, "devices.json");
    writeFileSync(fixtures, JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [{ udid: "S26" }], "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: "S18" }] } }));
    const tool = join(dir, "xcrun"); writeFileSync(tool, `#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),host:process.env.__XPC_JSC_useJIT,child:process.env.SIMCTL_CHILD___XPC_JSC_useJIT}));\n`); chmodSync(tool, 0o755);
    for (const [udid, macos, expected] of [["S26", "27.0", "false"], ["S18", "27.0", undefined], ["S26", "15.6", undefined]]) {
      const env = { ...process.env, PATH: dir + ":" + process.env.PATH, NT_IOS_SIMCTL_JSON: fixtures, NT_IOS_MACOS_VERSION: macos };
      delete env.__XPC_JSC_useJIT; delete env.SIMCTL_CHILD___XPC_JSC_useJIT;
      const result = spawnSync("bash", [new URL("./launch-simulator.sh", import.meta.url).pathname, udid, "--console-pty", "dev.nativetron.gpu"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
      assert.equal(data.host, expected); assert.equal(data.child, expected);
      assert.deepEqual(data.args, ["simctl", "launch", "--console-pty", udid, "dev.nativetron.gpu"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

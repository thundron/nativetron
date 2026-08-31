import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));

function probe(script) {
  const r = spawnSync(process.execPath, [join(here, script)], {
    env: { ...process.env, NT_SELFTEST: "1" },
    encoding: "utf8",
    timeout: 60000,
  });
  const line = (r.stdout || "").split("\n").find((l) => l.includes("_DOM="));
  assert.ok(line, `${script}: no DOM probe returned\n${r.stdout}\n${r.stderr}`);
  return line.slice(line.indexOf("=") + 1).trim();
}

const raw = probe("smoke.mjs");
assert.equal(raw, "Driven from NodeIncrementcount: 3", "raw op encoder through the live webview");
console.log("ok   node drives the native window (3 clicks -> count: 3)");

const react = probe("example-react.mjs");
assert.equal(
  react,
  "React, rendered nativelyreact-reconciler drives nativetron's op protocol." +
    "IncrementAddRemove firstcount: 2betagammaitem-43 items",
  "react state, keyed list and events through the op protocol",
);
console.log("ok   react renders and updates natively (count: 2, alpha removed, item-4 added)");
console.log("node bindings: all checks passed");

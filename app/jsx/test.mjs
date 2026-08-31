import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "..", "build", "jsx-app");

const r = spawnSync(bin, [], {
  env: { ...process.env, NT_SELFTEST: "jsx" },
  encoding: "utf8",
  timeout: 60000,
});
const line = (r.stdout || "").replace(/\r/g, "\n").split("\n").find((l) => l.includes("NT_SELFTEST_TEXT="));
assert.ok(line, `no probe returned\n${r.stdout}\n${r.stderr}`);
const got = JSON.parse(line.slice(line.indexOf("=") + 1));

// Increment x3 with step=3 from props, then Add, then Remove first.
assert.match(got.text, /count: 9/, "component props: step=3 applied three times");
assert.match(got.text, /over five/, "ternary switched to the true arm");
assert.match(got.text, /and over eight/, "&& child appeared");
assert.doesNotMatch(got.text, /five or fewer/, "ternary false arm removed");
assert.equal(got.countStyle, "color:#b00", "reactive attribute recomputed");
assert.equal(got.items, "beta,gamma,item-4", "keyed list: appended and removed by key");
assert.equal(got.fragmentParent, "MAIN", "fragment added no wrapper element");
assert.equal(got.fragmentAdjacent, "fragment-b", "fragment roots remained adjacent siblings");

console.log("ok   component props, conditionals, keyed list, reactive attributes, fragments");
console.log("jsx: all checks passed");

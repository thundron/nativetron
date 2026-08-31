import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
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
assert.equal(got.spreadClass, "after", "explicit prop after spread won");
assert.equal(got.spreadOrder, "explicit", "spread merge order was deterministic");
assert.equal(got.spreadTitle, "tone:hot", "function-valued spread prop remained reactive");
assert.equal(got.generalTags, "B,I,EM", "element-valued expression roots were inserted in order");
assert.equal(got.generalText, "storedcalledinline", "element-valued expressions preserved content");
assert.equal(got.contextDefault, "default", "consumer outside provider used the default");
assert.equal(got.contextValue, "light", "provider value remained reactive");
assert.equal(got.contextNested, "nested", "nearest nested provider won");
assert.equal(got.contextAfterNested, "light", "outer provider was restored after nesting");
assert.equal(got.contextDefaultAfter, "default", "provider stack was restored after its children");
assert.equal(got.contextParent, "context-demo", "provider added no wrapper element");

console.log("ok   props, spreads, expression children, context, conditionals, keyed list, reactive attributes, fragments");

const mixedSrc = join(here, ".mixed-child.tsx");
const mixedOut = join(here, ".mixed-child.generated.ts");
try {
  writeFileSync(mixedSrc, `
import { h } from "../../framework/jsx.js";
import { type El } from "../../framework/ui.js";
function mixed(flag: boolean): El | string {
  return flag ? h("b", null, "element") : "text";
}
const root: El = <main>{mixed(true)}</main>;
`);
  const refused = spawnSync(process.execPath, [join(here, "build.mjs"), mixedSrc, mixedOut], {
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0, "mixed element/primitive expression child should be refused");
  assert.match(refused.stderr + refused.stdout, /cannot mix element and non-element values/);
} finally {
  rmSync(mixedSrc, { force: true });
  rmSync(mixedOut, { force: true });
}

console.log("jsx: all checks passed");

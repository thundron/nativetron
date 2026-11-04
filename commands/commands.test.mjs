import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { parseShortcut } from "./keys.generated.mjs";
test("shortcut generation does not drift", () => execFileSync(process.execPath, [new URL("./generate.mjs", import.meta.url).pathname, "--check"]));
test("shortcut grammar is bounded and rejects approximations", () => {
  assert.deepEqual(parseShortcut("Meta+Shift+k"), { key: "k", modifiers: 12 });
  assert.deepEqual(parseShortcut("Control+F12"), { key: "f12", modifiers: 2 });
  for (const shortcut of ["Command+k", "Meta+Meta+k", "Meta+", "Alt+F13", "Meta+Space", "Meta+hello"]) assert.throws(() => parseShortcut(shortcut));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseShortcut, canonicalShortcut, commandShortcutError, parseCommandShortcut, eventShortcut, formatShortcut,
  PALETTE_SHORTCUTS, RESERVED_SHORTCUTS, RESERVED_REASONS,
} from "./keys.generated.mjs";
import { commandKeySet } from "./host.js";

const generator = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const keysPath = fileURLToPath(new URL("./keys.json", import.meta.url));
const spec = JSON.parse(readFileSync(keysPath, "utf8"));
const outputs = ["keys.generated.ts", "keys.generated.mjs"].map((name) => fileURLToPath(new URL("./" + name, import.meta.url)));
const generate = (...args) => spawnSync(process.execPath, [generator, ...args], { encoding: "utf8" });
function withSpec(mutate, run) {
  const dir = mkdtempSync(join(tmpdir(), "nt-commands-"));
  try {
    const next = structuredClone(spec); mutate(next);
    const path = join(dir, "keys.json"); writeFileSync(path, JSON.stringify(next));
    return run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("shortcut generation does not drift", () => {
  const result = generate("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to date/);
});

test("--check validates the JSON spec with the generated parser and never writes", () => {
  const before = outputs.map((path) => readFileSync(path, "utf8"));
  const refusals = [
    [(s) => { s.palette.push("Control+K"); }, /palette Control\+K duplicates palette Control\+k after normalisation/],
    [(s) => { s.reserved["Meta+Q"] = "again"; }, /reserved Meta\+Q duplicates reserved Meta\+q/],
    [(s) => { s.reserved["Meta+k"] = "clash"; }, /palette Meta\+k duplicates reserved Meta\+k/],
    [(s) => { s.palette = ["Shift+k"]; }, /never steals typing/],
    [(s) => { s.palette = ["Command+k"]; }, /palette: invalid shortcut modifier/],
    [(s) => { s.reserved["Meta+Space"] = "x"; }, /reserved: invalid shortcut key/],
    [(s) => { s.modifiers.Hyper = 4; }, /reuses bit 4/],
    [(s) => { s.modifiers = { Shift: 8, Alt: 1 }; }, /ascending bit order/],
    [(s) => { s.modifiers.Alt = 3; }, /single bit/],
    [(s) => { s.namedKeys.push("enter"); }, /invalid named key|case-insensitive duplicates/],
    [(s) => { s.unmodifiedKeys.push("Space"); }, /unknown key Space/],
    [(s) => { s.commandModifiers = ["Hyper"]; }, /unknown modifier Hyper/],
    [(s) => { s.extra = 1; }, /unknown field extra/],
    [(s) => { delete s.reserved; }, /missing field reserved/],
    [(s) => { s.reserved["Meta+e"] = "bad\"reason"; }, /plain reason/],
  ];
  for (const [mutate, pattern] of refusals) {
    withSpec(mutate, (path) => {
      const result = generate("--check", "--spec", path);
      assert.equal(result.status, 1, pattern.source);
      assert.match(result.stderr, pattern);
    });
  }
  withSpec((s) => { s.palette = ["Meta+p"]; }, (path) => {
    const result = generate("--check", "--spec", path);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale: .*keys\.generated\.ts/);
  });
  assert.equal(generate("--check", "--spec", "/nonexistent/keys.json").status, 1);
  assert.deepEqual(outputs.map((path) => readFileSync(path, "utf8")), before);
});

test("shortcut grammar is bounded and rejects approximations", () => {
  assert.deepEqual(parseShortcut("Meta+Shift+k"), { key: "k", modifiers: 12 });
  assert.deepEqual(parseShortcut("Control+F12"), { key: "f12", modifiers: 2 });
  for (const shortcut of ["Command+k", "Meta+Meta+k", "Meta+", "Alt+F13", "Meta+Space", "Meta+hello", "", "+", "Meta++k", "meta+k", "Meta+enter", "Meta+" + "k".repeat(80)]) assert.throws(() => parseShortcut(shortcut), shortcut);
});

test("normalisation is order and case independent and round-trips", () => {
  assert.equal(canonicalShortcut("Shift+Meta+K"), "Meta+Shift+k");
  assert.equal(canonicalShortcut("Shift+Alt+Control+Meta+ArrowUp"), "Alt+Control+Meta+Shift+ArrowUp");
  for (const shortcut of ["F1", "Control+f", "Meta+Shift+Tab", "Alt+Control+Delete"]) {
    const name = canonicalShortcut(shortcut);
    assert.equal(canonicalShortcut(name), name);
    assert.equal(formatShortcut(parseShortcut(name)), name);
  }
});

test("command shortcut ownership: typing keys, reserved and palette shortcuts are refused", () => {
  for (const shortcut of ["k", "Shift+k", "Alt+k", "Alt+Shift+1", "Enter", "Escape", "Tab", "Shift+Tab", "ArrowDown", "Delete", "Backspace"]) assert.match(commandShortcutError(shortcut), /needs Control or Meta/, shortcut);
  for (const shortcut of ["Meta+q", "Shift+Meta+T", "Control+Tab", "Alt+F4", "Meta+c", "Control+V"]) assert.match(commandShortcutError(shortcut), /^reserved shortcut /, shortcut);
  for (const shortcut of ["Meta+K", "Control+k"]) assert.match(commandShortcutError(shortcut), /owned by the command palette/);
  for (const shortcut of ["Meta+j", "Control+Shift+1", "F2", "Shift+F5", "Meta+Enter", "Control+ArrowUp", "Meta+z"]) assert.equal(commandShortcutError(shortcut), "", shortcut);
  assert.throws(() => parseCommandShortcut("Meta+c"), /copies text/);
  assert.equal(RESERVED_SHORTCUTS.length, RESERVED_REASONS.length);
  assert.equal(new Set(RESERVED_SHORTCUTS).size, RESERVED_SHORTCUTS.length);
  for (const name of RESERVED_SHORTCUTS) assert.equal(canonicalShortcut(name), name);
  for (const shortcut of PALETTE_SHORTCUTS) assert.equal(RESERVED_SHORTCUTS.includes(canonicalShortcut(shortcut)), false);
});

test("event projection matches layout keys first, physical codes as fallback", () => {
  assert.equal(eventShortcut("K", "KeyK", 12), "Meta+Shift+k");
  assert.equal(eventShortcut("!", "Digit1", 10), "Control+Shift+1");
  assert.equal(eventShortcut("˚", "KeyK", 1), "Alt+k");
  assert.equal(eventShortcut("л", "KeyK", 2), "Control+k");
  assert.equal(eventShortcut("a", "KeyQ", 4), "Meta+a");
  assert.equal(eventShortcut("Enter", "NumpadEnter", 0), "Enter");
  assert.equal(eventShortcut("F12", "F12", 2), "Control+F12");
  for (const [key, code, modifiers] of [["Shift", "ShiftLeft", 8], ["Dead", "Quote", 0], ["k", "KeyK", 16], ["k", "KeyK", -1], ["k", "KeyK", 1.5], [" ", "Space", 4]]) assert.equal(eventShortcut(key, code, modifiers), "", key);
});

test("page shortcut set uses the registry rules and normalised ownership", () => {
  assert.deepEqual([...commandKeySet(["Shift+Meta+J", "F2"])], ["Meta+k", "Control+k", "Meta+Shift+j", "F2"]);
  assert.throws(() => commandKeySet(["Meta+j", "Meta+J"]), /duplicate shortcut Meta\+j/);
  assert.throws(() => commandKeySet(["Control+K"]), /palette/);
  assert.throws(() => commandKeySet(["Meta+v"]), /reserved/);
  assert.throws(() => commandKeySet(["Delete"]), /needs Control or Meta/);
  assert.throws(() => commandKeySet([1]), TypeError);
  assert.throws(() => commandKeySet("Meta+j"), TypeError);
});

test("guest and host outputs come from one template", () => {
  const [ts, mjs] = outputs.map((path) => readFileSync(path, "utf8"));
  const strip = (text) => text.replace(/export interface Shortcut[^\n]*\n/, "").replace(/: (string\[\]|number\[\]|string|number|Shortcut)(?=[\s,)=;{])/g, "").replace(/\]!/g, "]");
  assert.equal(strip(ts), strip(mjs));
});

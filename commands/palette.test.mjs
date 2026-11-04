// Compiled palette/registry browser test. Owns its fixture (commands/palette.*) and does not
// depend on framework/components.fixture.ts. Requires SCRIPTC=<scriptc packages/cli/dist/main.js>
// (or a scriptc checkout next to this repository), zig, and Chrome (CHROME overrides the path).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";

const here = fileURLToPath(new URL("./", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const scriptc = process.env.SCRIPTC ?? [fileURLToPath(new URL("../../scriptc/packages/cli/dist/main.js", import.meta.url))].find(existsSync);
if (!scriptc || !existsSync(scriptc)) throw new Error("set SCRIPTC to scriptc's packages/cli/dist/main.js");

// The fixture's event exports must match the ABI generator's copy in the shared fixture.
const region = (path) => readFileSync(path, "utf8").match(/\/\* generated:event-export \*\/[\s\S]*\/\* \/generated:event-export \*\//)[0];
assert.equal(region(new URL("./palette.fixture.ts", import.meta.url)), region(new URL("../framework/components.fixture.ts", import.meta.url)), "palette fixture event exports drifted from abi/events.json");
for (const generator of ["commands/generate.mjs", "i18n/generate.mjs"]) execFileSync(process.execPath, [fileURLToPath(new URL("../" + generator, import.meta.url)), "--check"]);
execFileSync(process.execPath, [scriptc, "build", "--lib", "--profile", "palette-profile.json"], { cwd: here, env: { ...process.env, SCRIPTC_TARGET: "wasm32-wasi", SCRIPTC_CC: process.env.SCRIPTC_CC ?? "zigcc" }, stdio: "inherit" });

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, F2: 113 };
const browser = await testBrowser(root);
const { evaluate, send, delay } = browser;
// Trusted keys through CDP; modifier bits match the guest projection (Alt 1, Control 2, Meta 4, Shift 8).
async function press(key, modifiers = 0, code) {
  const single = key.length === 1;
  const base = {
    key, modifiers,
    code: code ?? (single ? (/[0-9]/.test(key) ? "Digit" + key : "Key" + key.toUpperCase()) : key),
    windowsVirtualKeyCode: single ? key.toUpperCase().charCodeAt(0) : KEY_CODES[key],
  };
  await send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
  if (key === "Enter" || (single && (modifiers & ~8) === 0)) await send("Input.dispatchKeyEvent", { ...base, type: "char", text: key === "Enter" ? "\r" : key });
  await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await delay(20);
}
const state = () => evaluate(`(() => {
  const dialog = document.querySelector('[data-nt-command-palette]'), active = document.activeElement;
  const input = dialog && dialog.querySelector('input[role=combobox]');
  return {
    dialogs: document.querySelectorAll('[role=dialog]').length,
    focus: active === document.body ? 'body' : active.id || active.getAttribute('role') || active.tagName,
    log: document.getElementById('log') ? document.getElementById('log').textContent : '',
    options: dialog ? [...dialog.querySelectorAll('[role=option]')].map((o) => o.textContent) : [],
    selected: dialog ? [...dialog.querySelectorAll('[role=option][aria-selected=true]')].map((o) => o.textContent) : [],
    activeOption: input && input.getAttribute('aria-activedescendant') ? (document.getElementById(input.getAttribute('aria-activedescendant')) || {}).textContent || 'missing' : '',
    empty: dialog ? !!dialog.querySelector('[role=status]') : false,
    query: input ? input.value : null,
    caret: input ? input.selectionStart : null,
  };
})()`);
const focusOn = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
// Synthetic cancelable keydown; returns whether the page suppressed the browser default.
const prevented = (target, init) => evaluate(`!document.querySelector(${JSON.stringify(target)}).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})))`);

try {
  await browser.navigate("/commands/palette-test.html");
  for (let i = 0; i < 100; i++) { if (await evaluate("!!window.fixture")) break; await delay(100); }
  assert.equal(await evaluate("!!window.fixture"), true, JSON.stringify(browser.diagnostics));

  // Compiled registry ownership/grammar/enabled/limit rules (0 = all checks passed).
  assert.equal(await evaluate("fixture.nt_registryTest()"), 0);

  // Page-side shortcut validation mirrors the compiled registry.
  assert.deepEqual(await evaluate("[...commandKeySet(['Shift+Meta+J', 'F2'])]"), ["Meta+k", "Control+k", "Meta+Shift+j", "F2"]);
  for (const [list, pattern] of [[["Meta+K"], /palette/], [["Meta+c"], /reserved/], [["Meta+j", "Meta+J"], /duplicate/], [["j"], /needs Control or Meta/], [["Command+k"], /modifier/], [["Meta+Space"], /key/]]) {
    assert.match(await evaluate(`(() => { try { commandKeySet(${JSON.stringify(list)}); return 'accepted'; } catch (error) { return error.message; } })()`), pattern, JSON.stringify(list));
  }
  assert.match(await evaluate("(() => { try { installKeys([]); return 'accepted'; } catch (error) { return error.message; } })()"), /already installed/);

  // Browser default suppression and routing of keys that start outside the compiled root.
  assert.equal(await prevented("#outside", { key: "j", code: "KeyJ", metaKey: true }), true);
  assert.match((await state()).log, /runs=1 last=first/);
  assert.equal(await prevented("#outside", { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), true, "Shift+digit matches by physical code");
  assert.match((await state()).log, /runs=2 last=second/);
  assert.equal(await prevented("#outside", { key: "p", code: "KeyP", metaKey: true }), false, "undeclared shortcuts keep browser defaults");
  assert.equal(await prevented("#outside", { key: "c", code: "KeyC", metaKey: true }), false, "copy stays with the browser");
  assert.equal(await prevented("#outside", { key: "Enter", code: "Enter" }), false);
  assert.match((await state()).log, /runs=2 /);

  // Typing and Enter in an unrelated input are never taken by commands.
  await focusOn("other-input");
  await press("j"); await press("Enter");
  assert.equal(await evaluate("document.getElementById('other-input').value"), "j");
  assert.match((await state()).log, /runs=2 last=second other=1/);

  // Open from outside the root: dialog, focus, ARIA wiring and first option active.
  await focusOn("outside");
  await press("k", 2);
  let s = await state();
  assert.equal(s.dialogs, 1); assert.equal(s.focus, "combobox");
  assert.deepEqual(s.options, ["Commands", "Close", "Search commands"]);
  assert.deepEqual(s.selected, ["Commands"]); assert.equal(s.activeOption, "Commands");
  assert.deepEqual(await evaluate(`(() => { const d = document.querySelector('[role=dialog]'), i = d.querySelector('input'), l = document.getElementById(i.getAttribute('aria-controls'));
    return [d.getAttribute('aria-modal'), document.getElementById(d.getAttribute('aria-labelledby')).textContent, i.getAttribute('aria-label'), l.getAttribute('role'),
      [...l.children].map((o) => o.getAttribute('aria-keyshortcuts') + ':' + o.tabIndex)]; })()`),
    ["true", "Commands", "Search commands", "listbox", ["Meta+J:-1", "Control+Shift+1:-1", "F2:-1"]]);

  // ArrowUp/ArrowDown wrap; Home/End jump without moving the search caret.
  await press("ArrowDown"); assert.equal((await state()).activeOption, "Close");
  await press("ArrowUp"); await press("ArrowUp"); assert.equal((await state()).activeOption, "Search commands");
  await press("Home"); assert.equal((await state()).activeOption, "Commands");
  await press("End"); assert.equal((await state()).activeOption, "Search commands");
  await press("ArrowDown"); assert.deepEqual((await state()).selected, ["Commands"]);
  await send("Input.insertText", { text: "c" });
  await press("End"); s = await state();
  assert.equal(s.query, "c"); assert.equal(s.caret, 1, "End selected the last option without moving the caret");
  await press("Home"); s = await state();
  assert.equal(s.caret, 1, "Home selected the first option without moving the caret"); assert.equal(s.activeOption, "Commands");

  // Query filters translated labels case-insensitively and resets the active option.
  await press("ArrowDown");
  await send("Input.insertText", { text: "LOSE" });
  s = await state(); assert.deepEqual(s.options, ["Close"]); assert.equal(s.activeOption, "Close"); assert.equal(s.empty, false);
  await send("Input.insertText", { text: "zzz" });
  s = await state(); assert.deepEqual(s.options, []); assert.equal(s.activeOption, ""); assert.equal(s.empty, true);
  assert.match(await evaluate("document.querySelector('[role=dialog] [role=status]').textContent"), /No enabled commands/);
  await press("Enter"); await press("ArrowDown"); await press("Home");
  s = await state(); assert.equal(s.dialogs, 1, "Enter with no results keeps the palette open"); assert.match(s.log, /runs=2 /);
  await evaluate("(() => { const i = document.querySelector('[role=dialog] input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  assert.deepEqual((await state()).options, ["Commands", "Close", "Search commands"]);

  // Focus trap: Tab cycles input <-> close button, options are not tab stops, stray focus returns.
  await press("Tab"); assert.equal(await evaluate("document.activeElement.textContent"), "Close");
  assert.equal((await state()).focus, "BUTTON");
  await press("Tab"); assert.equal((await state()).focus, "combobox");
  await press("Tab", 8); assert.equal((await state()).focus, "BUTTON");
  await press("Tab", 8); assert.equal((await state()).focus, "combobox");
  await focusOn("outside"); assert.equal((await state()).focus, "combobox");
  await focusOn("other-input"); assert.equal((await state()).focus, "combobox");

  // IME composition keys never reach the palette.
  assert.equal(await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }))"), true);
  s = await state(); assert.equal(s.dialogs, 1); assert.match(s.log, /runs=2 /);

  // Enter runs the active enabled command, closes, and restores focus to where the palette opened.
  await press("ArrowDown"); await press("Enter");
  s = await state(); assert.equal(s.dialogs, 0); assert.match(s.log, /runs=3 last=second/); assert.equal(s.focus, "outside");

  // Escape closes and restores focus inside the root too.
  await focusOn("other-input"); await press("k", 4);
  assert.equal((await state()).focus, "combobox");
  await press("Escape"); s = await state();
  assert.equal(s.dialogs, 0); assert.equal(s.focus, "other-input"); assert.match(s.log, /other=1/);

  // The palette shortcut toggles closed and restores focus.
  await focusOn("outside"); await press("k", 2); await press("k", 2);
  s = await state(); assert.equal(s.dialogs, 0); assert.equal(s.focus, "outside");

  // A command that moves focus keeps it; restoration only fills a vacuum.
  await press("k", 2); await send("Input.insertText", { text: "search" }); await press("Enter");
  s = await state(); assert.equal(s.dialogs, 0); assert.match(s.log, /runs=4 last=third/); assert.equal(s.focus, "other-input");

  // Command shortcuts while open close the palette first, then run.
  await focusOn("outside"); await press("k", 2); await press("j", 4);
  s = await state(); assert.equal(s.dialogs, 0); assert.match(s.log, /runs=5 last=first/); assert.equal(s.focus, "outside");
  await press("F2"); assert.match((await state()).log, /runs=6 last=third/);

  // Disabled commands disappear reactively, the active option clamps, shortcuts and clicks refuse.
  await focusOn("outside"); await press("k", 2); await press("End");
  assert.equal(await evaluate("fixture.nt_setEnabled(2, 0)"), 0);
  s = await state(); assert.deepEqual(s.options, ["Commands", "Close"]); assert.equal(s.activeOption, "Close"); assert.deepEqual(s.selected, ["Close"]);
  await evaluate("document.getElementById('toggle-first').click()");
  s = await state(); assert.deepEqual(s.options, ["Close"]); assert.equal(s.activeOption, "Close");
  await press("j", 4); s = await state();
  assert.equal(s.dialogs, 1, "a disabled command shortcut leaves the palette open"); assert.match(s.log, /runs=6 /);
  assert.equal(await evaluate("fixture.nt_setEnabled(1, 0)"), 0);
  s = await state(); assert.deepEqual(s.options, []); assert.equal(s.empty, true);
  await press("Enter"); assert.match((await state()).log, /runs=6 /);
  for (const index of [0, 1, 2]) assert.equal(await evaluate(`fixture.nt_setEnabled(${index}, 1)`), 0);
  assert.deepEqual((await state()).options, ["Commands", "Close", "Search commands"]);
  await evaluate("[...document.querySelectorAll('[role=dialog] [role=option]')].find((o) => o.textContent === 'Commands').click()");
  s = await state(); assert.equal(s.dialogs, 0); assert.match(s.log, /runs=7 last=first/); assert.equal(s.focus, "outside");

  // Close button closes and restores.
  await press("k", 2);
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Close' && b.getAttribute('role') !== 'option').click()");
  s = await state(); assert.equal(s.dialogs, 0); assert.equal(s.focus, "outside");

  // Escape that starts outside the root still closes the open palette (focus on body).
  await press("k", 2);
  await evaluate("document.activeElement.blur()");
  assert.equal(await prevented("body", { key: "Escape", code: "Escape" }), true);
  assert.equal((await state()).dialogs, 0);

  // Repeated disposal/remount: disposal while open removes the dialog and restores focus;
  // each remount owns exactly one root listener (one run per shortcut, one dialog per toggle).
  for (let cycle = 0; cycle < 5; cycle++) {
    await focusOn("outside"); await press("k", 2);
    assert.equal((await state()).dialogs, 1);
    assert.equal(await evaluate("fixture.nt_dispose()"), 0);
    s = await state();
    assert.equal(await evaluate("document.getElementById('nt-root').childNodes.length"), 0);
    assert.equal(s.dialogs, 0); assert.equal(s.focus, "outside");
    await press("k", 2); await press("j", 4);
    assert.equal((await state()).dialogs, 0);
    assert.equal(await evaluate("fixture.nt_remount()"), 0);
    const before = Number((await state()).log.match(/runs=(\d+)/)[1]);
    await press("j", 4);
    assert.equal(Number((await state()).log.match(/runs=(\d+)/)[1]), before + 1);
    await press("k", 2); assert.equal((await state()).dialogs, 1);
    await press("Escape"); assert.equal((await state()).dialogs, 0);
  }

  // Disposing the page half releases its listeners: defaults return, nothing is routed.
  await evaluate("disposeKeys()");
  await focusOn("outside");
  assert.equal(await prevented("#outside", { key: "j", code: "KeyJ", metaKey: true }), false);
  assert.equal(await prevented("#outside", { key: "k", code: "KeyK", ctrlKey: true }), false);
  assert.equal((await state()).dialogs, 0);
  assert.deepEqual(browser.diagnostics.filter((entry) => entry.exceptionDetails || entry.entry?.level === "error"), []);
  console.log("commands palette: compiled registry ownership, host suppression/routing, ArrowUp/Down/Home/End, query/no-results, Enter/Escape, focus trap/restoration, disabled state and 5x disposal passed");
} finally { await browser.close(); }

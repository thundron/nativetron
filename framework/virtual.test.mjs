// Fixed-row virtualisation acceptance: compiled geometry, then a compiled wasm reactor driven by real Chrome DOM events.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const here = fileURLToPath(new URL("./", import.meta.url));
const scriptc = process.env.SCRIPTC ?? fileURLToPath(new URL("../../../scriptc/packages/cli/dist/main.js", import.meta.url));
const output = fileURLToPath(new URL("../build/virtual-selftest", import.meta.url));
mkdirSync(new URL("../build/", import.meta.url), { recursive: true });

// 1. Pure geometry, compiled natively.
execFileSync(process.execPath, [scriptc, "build", "framework/virtual.selftest.ts", "--backend", "llvm", "-o", output], { cwd: root, stdio: "inherit" });
assert.equal(execFileSync(output, { encoding: "utf8" }), [
  "4997/5013/119928/119688", "0/0", "0/5", "invalid height refused", "invalid offset refused",
  "collapsed 7/13", "grown viewport 0/23", "fractional 51/62", "huge end 999977/1000000 bottom=0", "huge middle 499997/500023",
  "oversized collection refused", "fractional count refused", "overscan bound refused",
  "inside 0/13 top=0 bottom=239688 active=-1 before=0 gap=0",
  "before 4997/5013 top=48 bottom=119688 active=2 before=1 gap=119856",
  "after 0/13 top=0 bottom=23976 active=9000 before=0 gap=215688",
  "adjacent 4997/5013 top=119904 bottom=119688 active=4996 before=1 gap=0",
  "unpinned 0/5 top=0 bottom=0 active=-1 before=0 gap=0",
  "empty 0/0 top=0 bottom=0 active=-1 before=0 gap=0",
  "totals exact", "fractional active refused", "negative active refused", "",
].join("\n"));
console.log("virtual geometry: compiled range/pinned-window/limit checks passed");

// 2. The fixture's event exports must match the generator-owned copy until the integrator adds this fixture to abi/generate.mjs.
const region = (text) => text.slice(text.indexOf("/* generated:event-export */"), text.indexOf("/* /generated:event-export */"));
assert.equal(region(readFileSync(new URL("./virtual.fixture.ts", import.meta.url), "utf8")), region(readFileSync(new URL("./components.fixture.ts", import.meta.url), "utf8")));
const eventExports = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).exports.filter((entry) => entry.export.startsWith("onEvent"));
assert.deepEqual(eventExports("./virtual-profile.json"), eventExports("./components-profile.json"));

// 3. Compiled reactor in Chrome.
execFileSync(process.execPath, [scriptc, "build", "--lib", "--profile", "virtual-profile.json"], { cwd: here, env: { ...process.env, SCRIPTC_TARGET: "wasm32-wasi", SCRIPTC_CC: "zigcc" }, stdio: "inherit" });
const browser = await testBrowser(root);
const js = (expression) => browser.evaluate(expression);
async function waitFor(expression, label) {
  for (let i = 0; i < 100; i++) { if (await js(expression)) return; await browser.delay(30); }
  assert.fail(`timed out waiting for ${label ?? expression}: ${JSON.stringify(browser.diagnostics)}`);
}
const count = (selector) => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const attrs = (selector, name) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(n => n.getAttribute(${JSON.stringify(name)}))`);
async function scroll(id, top) {
  await js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.scrollTop = ${top}; return s.scrollTop; })()`);
  await browser.delay(60);
}
// Row whose layout box is at the scroller's top edge; proves padding/gap geometry against the real layout engine.
const topRow = (id, attribute) => js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.scrollIntoView({ block: "start" }); const r = s.getBoundingClientRect(); const n = document.elementFromPoint(r.left + 4, r.top + 1); const row = n && n.closest("[${attribute}]"); return row ? Number(row.getAttribute("${attribute}")) : -1; })()`);
const scrollTopOf = (id) => js(`document.getElementById(${JSON.stringify(id)}).scrollTop`);
async function key(keyName, code, keyCode) {
  await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}
async function settled(id) {
  let last = -1;
  for (let i = 0; i < 100; i++) {
    const now = await scrollTopOf(id);
    if (now === last) break;
    last = now; await browser.delay(80);
  }
  await browser.delay(60);
  return last;
}

try {
  // Headless pages are unfocused; emulate page focus so focus/blur events fire as in a foreground window.
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await browser.navigate("/framework/virtual-test.html");
  await waitFor("!!window.fixture", "fixture start");
  const fx = (call) => js(`fixture.nt_${call}`);
  const stats = async () => [await fx("statsLists()"), await fx("statsRows()")];

  // Initial bounded window for each list.
  assert.equal(await count("#list-a [data-row]"), 13);
  assert.equal(await count("#list-b [data-key]"), 12);
  assert.equal(await count("#table-c [role=row]"), 9);
  assert.equal(await count("#list-d [data-huge]"), 23);
  assert.deepEqual(await stats(), [4, 56]);
  assert.equal(await js("document.getElementById('list-a').scrollHeight"), 240000);
  assert.equal(await js("document.getElementById('list-d').scrollHeight"), 16000000);
  assert.equal(await js("document.getElementById('list-a').getAttribute('aria-label') + '/' + document.getElementById('list-a').tabIndex"), "Rows/0");
  assert.deepEqual(await js("[document.getElementById('table-c').getAttribute('aria-rowcount'), document.querySelector('#table-c [role=row]:not([aria-rowindex=\"1\"])').getAttribute('aria-rowindex')]"), ["1001", "2"]);

  // Reactive viewport height: container height and mounted window follow the signal.
  await fx("setViewA(480)");
  assert.equal(await js("document.getElementById('list-a').clientHeight"), 480);
  assert.equal(await count("#list-a [data-row]"), 23);
  await fx("setViewA(120)");
  assert.equal(await count("#list-a [data-row]"), 8);
  await fx("setViewA(0)");
  assert.equal(await count("#list-a [data-row]"), 3);
  await fx("setViewA(240)");
  assert.equal(await count("#list-a [data-row]"), 13);
  await fx("setViewC(240)");
  assert.equal(await count("#table-c [role=row]"), 14);
  // Growing the viewport near the end clamps the offset exactly as the DOM does.
  await scroll("list-a", 239760);
  await waitFor("fixture.nt_scrollValueA() === 239760", "end scroll");
  await fx("setViewA(480)");
  assert.equal(await fx("scrollValueA()"), 239520);
  assert.equal(await scrollTopOf("list-a"), 239520);
  assert.equal(await topRow("list-a", "data-row"), 9980);
  await fx("setViewA(240)");
  await scroll("list-a", 0);

  // Huge jumps across a 1,000,000-row, 16,000,000-pixel list keep the window bounded and aligned.
  for (const [top, first, rows] of [[15999680, 999977, 23], [8000000, 499997, 26], [16, 0, 24], [12345678, 771601, 27], [0, 0, 23]]) {
    await scroll("list-d", top);
    await waitFor(`document.querySelector('#list-d [data-huge]').getAttribute('data-huge') === '${first}'`, `huge jump ${top}`);
    assert.equal(await count("#list-d [data-huge]"), rows, `rows after jump ${top}`);
    assert.equal(await topRow("list-d", "data-huge"), Math.floor(top / 16), `aligned row after jump ${top}`);
  }
  assert.equal(await js("document.querySelector('#list-d [data-huge=\"0\"]') !== null"), true);

  // Shrink, empty and grow while scrolled.
  await scroll("list-a", 120000);
  await waitFor("document.querySelector('#list-a [data-row]').getAttribute('data-row') === '4997'", "middle");
  assert.equal(await count("#list-a [data-row]"), 16);
  assert.equal(await topRow("list-a", "data-row"), 5000);
  await fx("setCountA(5005)");
  assert.equal(await fx("scrollValueA()"), 119880);
  assert.equal(await scrollTopOf("list-a"), 119880);
  assert.equal(await topRow("list-a", "data-row"), 4995);
  await fx("setCountA(5)");
  assert.deepEqual(await attrs("#list-a [data-row]", "data-row"), ["0", "1", "2", "3", "4"]);
  assert.equal(await fx("scrollValueA()"), 0);
  await browser.delay(60);
  assert.equal(await scrollTopOf("list-a"), 0);
  await fx("setCountA(10000)");
  assert.equal(await count("#list-a [data-row]"), 13);
  assert.equal(await topRow("list-a", "data-row"), 0);
  await fx("setCountA(0)");
  assert.equal(await count("#list-a [data-row]"), 0);
  assert.equal(await js("document.getElementById('list-a').scrollHeight"), 240);
  await fx("setCountA(50)");
  assert.equal(await count("#list-a [data-row]"), 13);
  await fx("setCountA(10000)");
  assert.equal(await fx("invalidCountA()"), 1);
  assert.equal(await count("#list-a [data-row]"), 13);
  await fx("setCountC(3)");
  assert.deepEqual([await count("#table-c [role=row]"), await js("document.getElementById('table-c').getAttribute('aria-rowcount')")], [4, "4"]);
  await fx("setCountC(1000)");

  // Index identity (virtualList): a key change at an index remounts; content stays bound to its index.
  await js("document.querySelectorAll('#list-a [data-row]').forEach(n => n.__tag = n.getAttribute('data-row'))");
  await fx("setShiftA(1)");
  assert.equal(await js("[...document.querySelectorAll('#list-a [data-row]')].filter(n => n.__tag).length"), 0);
  assert.deepEqual((await attrs("#list-a [data-row]", "data-row")).slice(0, 3), ["0", "1", "2"]);
  await fx("setShiftA(0)");

  // Key identity (keyedVirtualList): moved keys keep DOM nodes and row-local state; index is reactive.
  await js("document.querySelectorAll('#list-b [data-key]').forEach(n => n.__tag = n.getAttribute('data-key'))");
  await js("document.querySelector('#list-b [data-click=\"k1\"]').click(); document.querySelector('#list-b [data-click=\"k1\"]').click()");
  assert.equal(await js("document.querySelector('#list-b [data-click=\"k1\"]').textContent"), "clicks 2");
  await fx("rotateB()");
  assert.deepEqual((await attrs("#list-b [data-key]", "data-key")).slice(0, 3), ["k1", "k2", "k3"]);
  assert.equal(await js("[...document.querySelectorAll('#list-b [data-key]')].filter(n => n.__tag === n.getAttribute('data-key')).length"), 11);
  assert.equal(await js("document.querySelector('#list-b [data-key=\"k1\"] [data-index]').textContent"), "@0");
  assert.equal(await js("document.querySelector('#list-b [data-click=\"k1\"]').textContent"), "clicks 2");
  await fx("setCountB(10)");
  await js("document.querySelectorAll('#list-b [data-key]').forEach(n => n.__tag = n.getAttribute('data-key'))");
  await fx("reverseB()");
  assert.deepEqual(await attrs("#list-b [data-key]", "data-key"), ["k9", "k8", "k7", "k6", "k5", "k4", "k3", "k2", "k1", "k0"]);
  assert.equal(await js("[...document.querySelectorAll('#list-b [data-key]')].filter(n => n.__tag === n.getAttribute('data-key')).length"), 10);
  assert.equal(await js("document.querySelector('#list-b [data-key=\"k1\"] [data-index]').textContent + document.querySelector('#list-b [data-click=\"k1\"]').textContent"), "@8clicks 2");
  // Duplicate keys in the mounted window refuse the write and leave the window intact and reactive.
  const beforeDuplicate = await attrs("#list-b [data-key]", "data-key");
  assert.equal(await fx("duplicateB(0, 1)"), 1);
  assert.deepEqual(await attrs("#list-b [data-key]", "data-key"), beforeDuplicate);
  await fx("resetB()");
  assert.deepEqual((await attrs("#list-b [data-key]", "data-key")).slice(0, 2), ["k0", "k1"]);
  assert.equal(await count("#list-b [data-key]"), 12);
  assert.equal(await js("document.querySelector('#list-b [data-click=\"k1\"]').textContent"), "clicks 2");
  await scroll("list-b", 2000);
  await waitFor("fixture.nt_scrollValueB() === 2000", "keyed scroll");
  assert.equal(await js("(() => { const b = document.getElementById('list-b'); b.scrollIntoView({ block: 'start' }); const s = b.getBoundingClientRect(); return document.elementFromPoint(s.left + 4, s.top + 1).closest('[data-key]').getAttribute('data-key'); })()"), "k100");
  await scroll("list-b", 0);
  await waitFor("fixture.nt_scrollValueB() === 0", "keyed scroll back");

  // Reactive edits: signal reads inside dyn/dynProp update in place; direct reads rebuild only that row's content.
  await js("document.querySelectorAll('#list-a [data-row]').forEach(n => n.__tag = n.getAttribute('data-row'))");
  await fx("editLabel(2, 'hello')");
  assert.equal(await js("document.querySelector('#list-a [data-echo=\"2\"]').textContent"), "=hello");
  assert.equal(await js("document.querySelector('#list-a [data-input=\"2\"]').value"), "hello");
  assert.equal(await js("[...document.querySelectorAll('#list-a [data-row]')].filter(n => n.__tag).length"), 13);
  await js("document.querySelectorAll('#table-c [role=row]').forEach(n => { n.__tag = 1; n.parentElement.__shell = 1; })");
  const rowsBefore = await fx("statsRows()");
  await fx("bumpTable()");
  assert.match(await js("document.getElementById('table-c').textContent"), /entry 0 v1/);
  assert.equal(await js("[...document.querySelectorAll('#table-c [aria-rowindex]:not([aria-rowindex=\"1\"])')].filter(n => n.__tag).length"), 0);
  assert.equal(await js("[...document.querySelectorAll('#table-c [aria-rowindex]:not([aria-rowindex=\"1\"])')].filter(n => n.parentElement.__shell).length"), 13);
  assert.equal(await fx("statsRows()"), rowsBefore);
  await fx("setViewC(120)");
  assert.equal(await count("#table-c [role=row]"), 9);

  // Focus/editing: the focused row stays mounted (pinned) while scrolled away and keeps focus, caret and value.
  await js("document.querySelector('#list-a [data-input=\"2\"]').focus()");
  assert.equal(await fx("activeValueA()"), 2);
  await js("document.activeElement.__editor = 1; document.activeElement.setSelectionRange(5, 5)");
  await browser.send("Input.insertText", { text: " world" });
  assert.equal(await js("document.querySelector('#list-a [data-echo=\"2\"]').textContent"), "=hello world");
  await scroll("list-a", 120000);
  await waitFor("fixture.nt_scrollValueA() === 120000", "scroll away from editor");
  assert.equal(await count("#list-a [data-row]"), 17);
  assert.equal(await topRow("list-a", "data-row"), 5000);
  assert.equal(await js("document.activeElement.__editor === 1 && document.activeElement.getAttribute('data-input')"), "2");
  assert.equal(await js("document.getElementById('list-a').scrollHeight"), 240000);
  await browser.send("Input.insertText", { text: "!" });
  assert.equal(await js("document.activeElement.value"), "hello world!");
  await scroll("list-a", 0);
  await waitFor("fixture.nt_scrollValueA() === 0", "scroll back to editor");
  assert.equal(await count("#list-a [data-row]"), 13);
  assert.equal(await js("document.activeElement.__editor === 1 && document.querySelector('#list-a [data-input=\"2\"]') === document.activeElement"), true);
  await js("document.activeElement.blur()");
  assert.equal(await fx("activeValueA()"), -1);
  await scroll("list-a", 120000);
  await waitFor("fixture.nt_scrollValueA() === 120000", "scroll away after blur");
  assert.equal(await count("#list-a [data-row]"), 16);
  assert.equal(await js("document.querySelector('#list-a [data-row=\"2\"]')"), null);
  await scroll("list-a", 0);
  await waitFor("fixture.nt_scrollValueA() === 0", "scroll back after blur");
  assert.equal(await js("document.querySelector('#list-a [data-input=\"2\"]').__editor === undefined && document.querySelector('#list-a [data-input=\"2\"]').value"), "hello world!");
  // A pinned row after the window, then inside it, then dropped by shrinking.
  await fx("setActiveA(9000)");
  assert.equal(await count("#list-a [data-row]"), 14);
  assert.equal(await js("document.getElementById('list-a').scrollHeight"), 240000);
  assert.equal(await topRow("list-a", "data-row"), 0);
  await scroll("list-a", 216000);
  await waitFor("fixture.nt_scrollValueA() === 216000", "scroll to pinned");
  assert.equal(await topRow("list-a", "data-row"), 9000);
  assert.equal(await count("#list-a [data-row]"), 16);
  await fx("setCountA(5)");
  assert.equal(await count("#list-a [data-row]"), 5);
  await fx("setCountA(10000)");
  await fx("setActiveA(-1)");

  // Keyboard: the labelled scroller is focusable and native End/Home/PageDown scrolling drives the window.
  await js("document.getElementById('list-a').focus()");
  await key("End", "End", 35);
  await settled("list-a");
  await waitFor("fixture.nt_scrollValueA() === 239760", "End key");
  assert.equal(await js("document.querySelector('#list-a [data-row=\"9999\"]') !== null"), true);
  assert.equal(await topRow("list-a", "data-row"), 9990);
  await key("Home", "Home", 36);
  await settled("list-a");
  await waitFor("fixture.nt_scrollValueA() === 0", "Home key");
  assert.equal(await topRow("list-a", "data-row"), 0);
  await key("PageDown", "PageDown", 34);
  const paged = await settled("list-a");
  assert.ok(paged > 0, "PageDown scrolled");
  await waitFor(`fixture.nt_scrollValueA() === ${paged}`, "PageDown signal");
  assert.equal(await topRow("list-a", "data-row"), Math.floor(paged / 24));
  assert.ok(await count("#list-a [data-row]") <= 17);
  await scroll("list-a", 0);

  // Repeated mount/disposal: rows, lists and linear memory stay bounded.
  assert.deepEqual(await js("window.panics"), []);
  await fx("cycle(200)");
  assert.deepEqual(await stats(), [4, 56]);
  const memoryWarm = await js("fixture.__memory().byteLength");
  await fx("cycle(1000)");
  const memoryAfter = await js("fixture.__memory().byteLength");
  assert.deepEqual(await stats(), [4, 56]);
  assert.equal(memoryAfter, memoryWarm, `linear memory grew from ${memoryWarm} to ${memoryAfter} over 1000 warm mount/dispose cycles`);
  for (let i = 0; i < 10; i++) {
    await fx("dispose()");
    assert.equal(await js("document.getElementById('nt-root').childNodes.length"), 0);
    assert.deepEqual(await stats(), [0, 0]);
    await fx("start()");
    assert.deepEqual(await stats(), [4, i === 0 ? 56 : 59]);
    assert.equal(await fx("scrollValueA()"), 0);
    assert.equal(await topRow("list-d", "data-huge"), i === 0 ? 0 : 500000 + i - 1);
    await scroll("list-d", 8000000 + i * 16);
    await waitFor(`document.querySelector('#list-d [data-huge]').getAttribute('data-huge') === '${499997 + i}'`, `remounted scroll ${i}`);
    assert.equal(await topRow("list-d", "data-huge"), 500000 + i);
  }
  await fx("dispose()");
  assert.equal(await js("document.getElementById('nt-root').childNodes.length"), 0);
  assert.deepEqual(await stats(), [0, 0]);
  assert.deepEqual(await js("window.panics"), []);
  console.log(`virtual DOM: reactive viewport, 1M-row jumps, shrink/empty/grow clamps, index vs key identity, duplicate refusal, in-place/direct edits, pinned focus/editing, native keyboard scrolling and 1,210 mount/dispose cycles (linear memory ${memoryAfter} bytes, unchanged over the last 1,000) passed`);

  await js("window.liveObservers = 0; window.NativeResizeObserver = ResizeObserver; window.ResizeObserver = class extends NativeResizeObserver { constructor(cb) { super(cb); liveObservers++; this.stopped=false; } disconnect() { if(!this.stopped) {liveObservers--; this.stopped=true;} super.disconnect(); } }");
  await fx("startAuto()");
  await waitFor("document.getElementById('auto-list').clientHeight === 360 && document.querySelectorAll('[data-auto]').length === 21", "automatic viewport observation");
  assert.equal(await scrollTopOf("auto-list"), 480, "initial scroll position restored after insertion/layout");
  assert.equal(await js("liveObservers"), 1);
  await fx("setAutoHeight(120)");
  await waitFor("document.querySelectorAll('[data-auto]').length === 11", "automatic parent resize");
  await fx("scrollAuto(1000)");
  await waitFor("document.getElementById('auto-list').scrollTop === 24000", "programmatic scrollToIndex");
  assert.equal(await topRow("auto-list", "data-auto"), 1000);
  await fx("disposeAuto()");
  assert.equal(await js("liveObservers"), 0, "ResizeObserver disposed");
  assert.deepEqual(await stats(), [0,0]);

  // Duplicates exposed by user scrolling are a fatal contract violation surfaced through the panic sink.
  await fx("start()");
  assert.equal(await fx("duplicateB(145, 150)"), 0);
  await scroll("list-b", 2900);
  await waitFor("window.panics.length > 0", "duplicate panic");
  assert.match(await js("window.panics[0]"), /duplicate virtual row key: k145/);
  console.log("virtual duplicate keys: refused on write and surfaced through the panic sink when exposed by scrolling");
} finally { await browser.close(); }

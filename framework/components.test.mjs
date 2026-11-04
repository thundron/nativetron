import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
for (const generator of ["abi/generate.mjs", "commands/generate.mjs", "i18n/generate.mjs"]) execFileSync(process.execPath, [fileURLToPath(new URL("../" + generator, import.meta.url)), "--check"]);
execFileSync(process.execPath, [fileURLToPath(new URL("../../../scriptc/packages/cli/dist/main.js", import.meta.url)), "build", "--lib", "--profile", "components-profile.json"], { cwd: fileURLToPath(new URL("./", import.meta.url)), env: { ...process.env, SCRIPTC_TARGET: "wasm32-wasi", SCRIPTC_CC: "zigcc" }, stdio: "inherit" });
const browser = await testBrowser(root);
try {
  await browser.navigate("/framework/components-test.html");
  for (let i = 0; i < 100; i++) { if (await browser.evaluate("!!window.fixture")) break; await browser.delay(100); }
  assert.equal(await browser.evaluate("!!window.fixture"), true, JSON.stringify(browser.diagnostics));
  assert.equal(await browser.evaluate("fixture.nt_rangeTest()"), 1);
  assert.match(await browser.evaluate("document.body.innerText"), /Hello, world/);
  assert.match(await browser.evaluate("document.body.innerText"), /10,000 items/);
  assert.match(await browser.evaluate("document.body.innerText"), /12,345.68 \/ 1.5 m/);
  assert.equal(await browser.evaluate("document.querySelectorAll('[data-row]').length"), 13);
  await browser.evaluate("document.getElementById('virtual-test').scrollTop = 120000");
  await browser.delay(150);
  assert.equal(await browser.evaluate("document.querySelector('[data-row]').getAttribute('data-row')"), "4997");
  assert.equal(await browser.evaluate("document.querySelectorAll('[data-row]').length"), 16);
  assert.equal(await browser.evaluate("document.querySelectorAll('[role=table] [role=row]').length"), 9);
  assert.match(await browser.evaluate("document.getElementById('table-test').textContent"), /IndexLabel/);
  // The shortcut begins outside the compiled root and is routed in-page.
  await browser.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'k',code:'KeyK',metaKey:true,bubbles:true}))");
  assert.equal(await browser.evaluate("document.querySelectorAll('[role=dialog]').length"), 1);
  assert.equal(await browser.evaluate("document.activeElement.tagName"), "INPUT");
  await browser.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent==='Commands').click()");
  assert.equal(await browser.evaluate("document.getElementById('command-result').textContent"), "executions=1");
  await browser.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Disable command').click()");
  await browser.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'j',code:'KeyJ',metaKey:true,bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('command-result').textContent"), "executions=1");
  await browser.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'k',code:'KeyK',metaKey:true,bubbles:true}))");
  assert.match(await browser.evaluate("document.querySelector('[role=dialog]').textContent"), /No enabled commands/);
  await browser.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Shrink list').click()");
  assert.equal(await browser.evaluate("document.querySelectorAll('[data-row]').length"), 5);
  await browser.evaluate("fixture.nt_dispose()");
  assert.equal(await browser.evaluate("document.getElementById('nt-root').childNodes.length"), 0);
  await browser.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'k',code:'KeyK',metaKey:true,bubbles:true}))");
  assert.equal(await browser.evaluate("document.querySelectorAll('[role=dialog]').length"), 0);
  console.log("components: compiled catalogue/Intl formatting, command palette/disabled command, 10k-row virtual window/scroll/shrink and disposal passed");
} finally { await browser.close(); }

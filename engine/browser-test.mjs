import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
const browser = await testBrowser(fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
try {
  for (const [query, expected] of [["", "worker"], ["?main", "main"]]) {
    await browser.navigate("/engine/page.html" + query);
    let state;
    for (let i = 0; i < 250; i++) {
      state = await browser.evaluate("window.engineDemo ? ({ mode: engineDemo.lane.mode, reports: engineDemo.reports, events: engineDemo.events }) : null");
      if (state?.reports.includes("GPU_READBACK_OK 4096")) break;
      await browser.delay(100);
    }
    assert.equal(state?.mode, expected, JSON.stringify(browser.diagnostics) + JSON.stringify(state) + " " + await browser.evaluate("document.body.innerText"));
    assert.ok(state.reports.includes("GPU_READBACK_OK 4096"));
    assert.ok(!state.events.some((event) => event.status && event.type !== 7));
    await browser.evaluate("document.querySelector('button').click()");
    await browser.delay(400);
    assert.equal(await browser.evaluate("engineDemo.reports.includes('GPU_COLOUR_CHANGED')"), true);
    assert.match(await browser.evaluate("document.getElementById('nt-root').textContent"), /GPU_COLOUR_CHANGED/);
    console.log(`engine: Chrome ${expected}, compiled UI ↔ engine and real GPU readback passed`);
  }
} finally { await browser.close(); }

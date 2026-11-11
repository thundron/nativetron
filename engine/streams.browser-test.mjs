import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
const browser = await testBrowser(fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
try {
  for (const forceMain of [false, true]) {
    await browser.navigate("/engine/fixtures/streams.html");
    for (let i = 0; i < 200 && !await browser.evaluate("typeof window.streamProbe === 'function'"); i++) await browser.delay(10);
    const result = await browser.evaluate(`streamProbe(${forceMain})`);
    assert.equal(result.mode, forceMain ? "main" : "worker"); assert.equal(result.inputBytes, 1048576); assert.equal(result.outputBytes, 2097152);
    assert.equal(result.coalesced, true); assert.equal(result.backpressure, true);
    console.log(`streams: Chrome ${result.mode}, latest state both ways, 1 MiB inbound/2 MiB outbound, acknowledgements and frame-mode switching passed`);
  }
} finally { await browser.close(); }

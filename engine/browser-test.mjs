import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
const browser = await testBrowser(fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
try {
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: "globalThis.__nativeFrames=[];globalThis.__nt_ipc=(frame)=>__nativeFrames.push(frame)" });
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
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 2, mobile: false });
    await browser.delay(200);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1001, height: 800, deviceScaleFactor: 2, mobile: false });
    await browser.delay(300);
    const resize = await browser.evaluate("engineDemo.events.filter(event => event.type === 8).at(-1)");
    assert.equal(resize.dpr, 2, "wrong DPR in engine resize event");
    const width = await browser.evaluate("Math.round(document.getElementById('surface').clientWidth * devicePixelRatio)");
    assert.equal(resize.width, width, "worker dimensions were scaled twice");
    const replies = await browser.evaluate(`(async () => {
      const ipc = await import('/ipc/engine.generated.mjs');
      const bridge = await import('/ipc/engine-bridge.generated.mjs');
      window.__nt_engine_receive(bridge.engineBase64(ipc.encodeEngineMessage(ipc.ENGINE_COMMAND, ipc.LANE_NATIVE, ipc.LANE_ENGINE, 0xfedcba98, 1, new Uint8Array([0,255]))));
      await new Promise(resolve => setTimeout(resolve, 250));
      return __nativeFrames.map(bridge.parseEngineEnvelope).filter(Boolean).map(ipc.decodeEngineMessage).filter(frame => frame?.kind === ipc.ENGINE_RESULT).map(frame => [frame.source,frame.target,frame.requestId,frame.topic]);
    })()`);
    assert.ok(replies.some(reply => JSON.stringify(reply) === JSON.stringify([2,0,0xfedcba98,1])), "native request id was dropped on the engine lane");
    assert.equal(await browser.evaluate("engineDemo.events.some(event => Object.hasOwn(event, 'data'))"), false, "readback data crossed into the UI lane");
    await browser.evaluate("engineDemo.lane.dispose()");
    await browser.send("Emulation.clearDeviceMetricsOverride");
    console.log(`engine: Chrome ${expected}, compiled UI ↔ engine, real GPU readback and DPR resize passed`);
  }
} finally { await browser.close(); }

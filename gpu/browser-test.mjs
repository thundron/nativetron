import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
const browser = await testBrowser(fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
const { evaluate, delay } = browser;
try {
  await browser.navigate("/gpu/page.html");
  let result;
  for (let i = 0; i < 300; i++) {
    result = await evaluate("window.demo ? ({ reports: demo.reports, events: demo.events, idle: demo.host.idle, frames: demo.host.stats.frames, uploadedBytes: demo.host.stats.uploadedBytes }) : null");
    if (result?.reports.some((line) => line.startsWith("GPU_READBACK_") || line.startsWith("GPU_UNAVAILABLE") || line.startsWith("GPU_ERROR"))) break;
    await delay(100);
  }
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result?.reports.includes("GPU_READBACK_OK 4096"), "real GPU compute/readback acceptance did not pass");
  assert.equal(result.uploadedBytes, 16777216);
  assert.equal(result.events.filter((event) => event.status && event.type !== 7).length, 0, "GPU errors");
  assert.equal(result.idle, true);
  const frames = result.frames;
  await delay(500);
  assert.equal(await evaluate("demo.host.stats.frames"), frames, "idle host scheduled a frame");
  await evaluate("demo.message(1)");
  await delay(250);
  assert.equal(await evaluate("demo.host.stats.frames"), frames + 1);
  await evaluate(`(() => {
    demo.host.createShaderModule(1948577, 900, "@compute @workgroup_size(1)\\nfn broken() { invalid token; }", "intentional compile failure");
  })()`);
  await delay(500);
  const shader = await evaluate("demo.events.find(event => event.type === 7 && event.requestId === 900)");
  assert.equal(shader?.status, 1);
  assert.ok(shader.messages.some((message) => message.type === "error" && message.lineNum === 2));
  const measurements = await evaluate("import('./measure.js').then(module => module.measureGpu(demo))");
  console.log("GPU_MEASUREMENTS " + JSON.stringify(measurements));
  await evaluate("demo.host.device.destroy()");
  await delay(250);
  assert.equal(await evaluate("demo.events.some(event => event.type === 5)"), true);
  console.log("GPU: real compute + indirect draw + 16 MiB upload + 4 KiB readback + shader diagnostics + device loss + idle scheduling passed");
} finally { await browser.close(); }

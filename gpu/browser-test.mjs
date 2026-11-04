import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
import { screenshotPixel } from "../host/test-png.mjs";
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
  const screenshot = await browser.send("Page.captureScreenshot", { format: "png" });
  const centre = screenshotPixel(screenshot.data, 320, 200);
  const background = screenshotPixel(screenshot.data, 5, 5);
  assert.ok(centre[1] > 180 && centre[0] > 150 && centre[2] < 120, "compute-generated triangle was not presented");
  assert.ok(background[0] < 50 && background[1] < 60, "clear colour was not presented");
  const frames = result.frames;
  await delay(500);
  assert.equal(await evaluate("demo.host.stats.frames"), frames, "idle host scheduled a frame");
  await evaluate("demo.message(1)");
  await delay(250);
  assert.equal(await evaluate("demo.host.stats.frames"), frames + 1);
  const beforeGrowth = await evaluate("demo.api.__memory().byteLength");
  await evaluate("demo.api.ntgpu_grow_frame()");
  await delay(250);
  assert.ok(await evaluate("demo.api.__memory().byteLength") > beforeGrowth, "guest did not grow memory while encoding the frame");
  assert.equal(await evaluate("demo.events.filter(event => event.status).length"), 0, "grown-memory frame failed");
  await evaluate(`(() => {
    demo.host.createShaderModule(1948577, 900, "@compute @workgroup_size(1)\\nfn broken() { invalid token; }", "intentional compile failure");
  })()`);
  await delay(500);
  const shader = await evaluate("demo.events.find(event => event.type === 7 && event.requestId === 900)");
  assert.equal(shader?.status, 1);
  assert.ok(shader.messages.some((message) => message.type === "error" && message.lineNum === 2));
  // NT_GPU_SKIP_MEASURE=1 runs the correctness gates only; timings belong to serialized benchmark runs.
  const measurements = process.env.NT_GPU_SKIP_MEASURE === "1" ? null : await evaluate("import('./measure.js').then(module => module.measureGpu(demo))");
  if (measurements) console.log("GPU_MEASUREMENTS " + JSON.stringify(measurements));
  if (measurements && process.env.NT_RECORD_GPU === "1") {
    const version = await browser.send("Browser.getVersion");
    writeFileSync(new URL("./last-run.json", import.meta.url), JSON.stringify({ date: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0].model, browser: version.product, ...measurements }, null, 2) + "\n");
  }
  await evaluate("demo.host.device.destroy()");
  await delay(250);
  assert.equal(await evaluate("demo.events.some(event => event.type === 5)"), true);
  console.log("GPU: real compute + indirect draw + 16 MiB upload + 4 KiB readback + shader diagnostics + device loss + idle scheduling passed");
} finally { await browser.close(); }

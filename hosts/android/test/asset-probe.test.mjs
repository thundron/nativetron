import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../src/dev/nativetron/app/AssetProbe.java", import.meta.url), "utf8").match(/SCRIPT = """\n([\s\S]*?)\n\s*""";/)[1];
async function probe(change = {}) {
  const lines = [];
  await vm.runInNewContext(source, {
    isSecureContext: true, crossOriginIsolated: false, console: { log: line => lines.push(line) },
    fetch: async (path, { method }) => {
      if (path.startsWith("https:")) {
        if (change.network) return { status: 200, headers: { get: () => "" }, arrayBuffer: async () => new ArrayBuffer(1) };
        throw new TypeError("blocked offline");
      }
      const type = path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript";
      const status = method === "POST" ? 405 : path.includes("unknown") || path.includes("%") || path.includes("manifest") ? 404 : 200;
      return { status, headers: { get: name => name === "content-type" ? change.mime ?? type : name === "cross-origin-opener-policy" ? change.coop ?? "same-origin" : name === "cross-origin-embedder-policy" ? "require-corp" : "nosniff" }, arrayBuffer: async () => new ArrayBuffer(method === "HEAD" ? change.headBytes ?? 0 : 8) };
    },
  });
  assert.equal(lines.length, 1);
  return lines[0];
}
test("real-WebView probe checks MIME, headers, method/asset refusals and offline fetches", async () => {
  const line = await probe();
  assert.match(line, /^NT_ANDROID_ASSET_OK /);
  assert.equal(JSON.parse(line.slice("NT_ANDROID_ASSET_OK ".length)).isolated, false, "headers do not imply crossOriginIsolated support");
  for (const change of [{ mime: "text/plain" }, { coop: "unsafe-none" }, { headBytes: 1 }, { network: true }]) assert.match(await probe(change), /^NT_ANDROID_ASSET_FAIL /);
});
test("runner requires asset success on both launches and treats GPU failure as terminal", () => {
  const runner = readFileSync(new URL("../run.sh", import.meta.url), "utf8");
  assert.match(runner, /wait_for 'NT_ANDROID_ASSET_OK' 1/);
  assert.match(runner, /wait_for 'NT_ANDROID_ASSET_OK' 2/);
  assert.match(runner, /TERMINAL=.*GPU_FAILED/);
});

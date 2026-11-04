import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("real WKWebView bundled asset policy", { skip: process.platform !== "darwin" ? "requires WKWebView on macOS" : false }, () => {
  const temp = mkdtempSync(join(tmpdir(), "nt-native-assets-"));
  try {
    const output = join(temp, "assets-test");
    execFileSync("clang++", ["-std=c++17", "-O2", "-fobjc-arc", resolve(root, "engine/assets-native.test.mm"), resolve(root, "native/assets-darwin.mm"), "-framework", "Cocoa", "-framework", "WebKit", "-o", output], { stdio: "inherit" });
    assert.match(execFileSync(output, { encoding: "utf8", timeout: 50000 }), /optional isolation headers passed/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

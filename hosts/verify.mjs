import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
test("mobile hosts consume generated bridge codecs", () => {
  execFileSync(process.execPath, [new URL("../ipc/generate-engine.mjs", import.meta.url).pathname, "--check"]);
  assert.match(read("./ios/Sources/App.swift"), /EngineProtocol\.decodeEnvelope/);
  assert.match(read("./android/src/dev/nativetron/app/MainActivity.java"), /EngineProtocol\.decodeEnvelope/);
  assert.match(read("./windows/main.cc"), /engine.generated.h/);
});
test("Android has no network permission or Gradle dependency", () => {
  assert.doesNotMatch(read("./android/AndroidManifest.xml"), /uses-permission/);
  assert.doesNotMatch(read("./android/build.sh"), /gradle/i);
  assert.match(read("./android/src/dev/nativetron/app/MainActivity.java"), /MIXED_CONTENT_NEVER_ALLOW/);
});
test("iOS build refuses prohibited signing teams before build", () => {
  for (const team of ["UQBV6LD494", "DM6V8H4Q6Q"]) {
    assert.throws(() => execFileSync("bash", [new URL("./ios/build.sh", import.meta.url).pathname, "device"], { env: { ...process.env, NT_IOS_TEAM: team }, stdio: "pipe" }), /prohibited/);
  }
});

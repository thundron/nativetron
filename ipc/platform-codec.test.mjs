import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeEngineMessage } from "./engine.generated.mjs";
import { engineBase64 } from "./engine-bridge.generated.mjs";

const expected = engineBase64(encodeEngineMessage(1, 0, 2, 0, 42, new Uint8Array()));
test("generated C++ engine codec matches the JS wire contract", () => {
  const temp = mkdtempSync(join(tmpdir(), "nt-codec-cpp-"));
  try {
    const header = fileURLToPath(new URL("./engine.generated.h", import.meta.url));
    writeFileSync(join(temp, "main.cc"), `#include ${JSON.stringify(header)}\n#include <cassert>\n#include <iostream>\nint main(){ auto b=nt_engine::command(42); assert(nt_engine::valid(b)); auto text=nt_engine::base64(b); assert(nt_engine::from_base64(text)==b); assert(nt_engine::from_base64(text+"=").empty()); std::cout<<text; }`);
    execFileSync("clang++", ["-std=c++17", join(temp, "main.cc"), "-o", join(temp, "test")]);
    assert.equal(execFileSync(join(temp, "test"), { encoding: "utf8" }), expected);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("generated Swift engine codec matches the JS wire contract", { skip: process.platform !== "darwin" ? "Swift Foundation test requires macOS" : false }, () => {
  const temp = mkdtempSync(join(tmpdir(), "nt-codec-swift-"));
  try {
    writeFileSync(join(temp, "main.swift"), `import Foundation\nlet bytes = EngineProtocol.command(topic: 42)!\nassert(EngineProtocol.valid(bytes))\nassert(EngineProtocol.decodeEnvelope(EngineProtocol.envelope(bytes)!) == bytes)\nassert(EngineProtocol.decodeEnvelope("{\\\"ntEngine\\\":true,\\\"frame\\\":\\\"${expected}\\\"}") == nil)\nprint(bytes.base64EncodedString(), terminator: "")\n`);
    execFileSync("swiftc", [fileURLToPath(new URL("../hosts/ios/Sources/EngineProtocol.generated.swift", import.meta.url)), join(temp, "main.swift"), "-o", join(temp, "test")]);
    assert.equal(execFileSync(join(temp, "test"), { encoding: "utf8" }), expected);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

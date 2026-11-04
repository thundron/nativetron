import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMessage } from "./message-parser.mjs";
import { formatLocaleNumber } from "./host.js";

test("catalogue generation detects missing literal keys at build time", () => {
  const temp = mkdtempSync(join(tmpdir(), "nt-i18n-"));
  try {
    writeFileSync(join(temp, "app.ts"), 'message("not.in.catalogue")');
    assert.throws(() => execFileSync(process.execPath, [new URL("./generate.mjs", import.meta.url).pathname, "--check", "--source-dir", temp], { stdio: "pipe" }), /missing message key not.in.catalogue/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("ICU-style cardinal parsing requires other and rejects unsupported syntax", () => {
  const ast = parseMessage("{n, plural, =0 {none} one {# item} other {{name}: # items}}");
  assert.equal(ast[0].kind, "plural");
  assert.equal(ast[0].cases.length, 3);
  for (const source of ["{n, plural, one {one}}", "{n, selectordinal, one {first} other {rest}}", "{n, plural, offset:1 one {one} other {other}}", "{n, plural, one {one} one {again} other {other}}", "{unterminated", "stray }", "'{escaped}'"]) assert.throws(() => parseMessage(source));
});
test("number/unit formatting uses real Intl and reports bounded-output overflow", () => {
  const output = new Uint8Array(512);
  const count = formatLocaleNumber(12345.678, "en", "meter", 2, output);
  assert.equal(new TextDecoder().decode(output.subarray(0, count)), "12,345.68 m");
  assert.equal(formatLocaleNumber(12345, "en", "", 2, new Uint8Array(1)), -1);
});

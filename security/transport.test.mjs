import { instantiateFromBytes } from "./.scriptc/hostile-strings.mjs";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
let bin = null;
const api = await instantiateFromBytes(readFileSync(new URL("./.scriptc/hostile-strings.wasm", import.meta.url)), { binOut: (b) => { bin = b.slice(); } });
const names = ["quote+backslash", "U+2028/U+2029", "</script> + img", 'break-out ");...("', "newline/tab", "NUL + control"];
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
for (let i = 0; i < 6; i++) {
  api.nt_attack(i);
  const b64 = Buffer.from(bin).toString("base64");
  const src = `window.__nt.applyB64("${b64}")`;           // exactly what the C++ builds
  globalThis.__PWNED = 0;
  let decoded = null;
  globalThis.window = { __nt: { applyB64: (s) => { decoded = Buffer.from(s, "base64"); } } };
  (0, eval)(src);
  const roundTrip = decoded && Buffer.compare(decoded, Buffer.from(bin)) === 0;
  assert.ok(B64.test(b64), `${names[i]}: payload escaped the base64 alphabet`);
  assert.equal(globalThis.__PWNED, 0, `${names[i]}: operand executed as code`);
  assert.ok(roundTrip, `${names[i]}: bytes did not survive the transport`);
}
console.log(`transport: ${names.length} hostile payloads carried without executing`);

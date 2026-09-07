import { OutputSanitizer } from "./output-sanitizer.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function run(parts: Uint8Array[]): string {
  const sanitizer = new OutputSanitizer();
  let output = "";
  for (let i = 0; i < parts.length; i++) output += sanitizer.write(parts[i]!);
  return output + sanitizer.end();
}

let ok = run([
  bytes("safe\r"),
  bytes("\n\u001b]8;;https://evil.invalid"),
  bytes("\u0007click\u001b]8;;\u0007\u202eevil"),
]) === "safe\nclickevil";

const emoji = bytes("A😀B");
ok = ok && run([emoji.slice(0, 3), emoji.slice(3, 4), emoji.slice(4)]) === "A😀B";
ok = ok && run([bytes("x\u001b[31"), bytes("mred\u001b[0m!" )]) === "xred!";
ok = ok && run([bytes("a\u001bPpayload\u001b"), bytes("\\b")]) === "ab";
ok = ok && run([bytes("a\u009b31mhidden?z")]) === "ahidden?z";
ok = ok && run([new Uint8Array([0x61, 0xff, 0x62])]) === "a�b";

console.log(ok ? "PYRUS_OUTPUT_SANITIZER=OK" : "PYRUS_OUTPUT_SANITIZER=FAIL");
if (!ok) process.exit(1);

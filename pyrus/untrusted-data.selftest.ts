import { boundedText, sanitizeData, type StructuredDataLimits } from "./untrusted-data.js";

function rejected(value: unknown, message: string, options: StructuredDataLimits = {}): boolean {
  try {
    sanitizeData(value, options);
  } catch (error) {
    return error instanceof Error && error.message === message;
  }
  return false;
}

function main(): void {
  const source = JSON.parse('{"name":"café","items":[1,true,null,{"ok":"😀"}]}') as unknown;
  const clean = sanitizeData(source);
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  const deep = JSON.parse('{"a":{"b":{"c":1}}}') as unknown;
  const wide = JSON.parse('{"a":1,"b":2,"c":3}') as unknown;
  const ok = JSON.stringify(clean) === '{"name":"café","items":[1,true,null,{"ok":"😀"}]}'
    && sanitizeData(undefined) === null
    && boundedText("safe\ntext") === "safe\ntext"
    && rejected(Infinity, "Structured data contains a non-finite number")
    && rejected("bad\u0001text", "Structured text is invalid")
    && rejected(unsafe, "Unsafe structured key")
    && rejected([1, 2, 3], "Structured array exceeds limit", { maxArray: 2 })
    && rejected(wide, "Structured object exceeds key limit", { maxKeys: 2 })
    && rejected(deep, "Structured data exceeds limits", { maxDepth: 2 })
    && rejected([1, 2, 3], "Structured data exceeds limits", { maxNodes: 3 })
    && rejected("éé", "Structured data exceeds byte limit", { maxBytes: 3 })
    && rejected("abcd", "Structured text is invalid", { maxString: 3 });
  console.log(ok ? "PYRUS_UNTRUSTED_DATA=OK" : "PYRUS_UNTRUSTED_DATA=FAIL");
  if (!ok) process.exit(1);
}

main();

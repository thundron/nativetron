import { ROOT, newId, createText, flush, setBinarySink, setLive } from "../framework/core.js";

declare function binOut(b: Uint8Array): void;

export function attack(which: number): number {
  setBinarySink((b: Uint8Array) => { binOut(b); });
  setLive();
  const t = newId();
  let payload = "";
  if (which === 0) payload = "quote\" and backslash\\ end";
  else if (which === 1) payload = "\u2028injected\u2029";
  else if (which === 2) payload = "</script><img src=x onerror=alert(1)>";
  else if (which === 3) payload = "\");globalThis.__PWNED=1;(\"";
  else if (which === 4) payload = "line\nbreak\ttab";
  else payload = "\u0000null\u001fctl";
  createText(t, payload);
  flush();
  return which;
}

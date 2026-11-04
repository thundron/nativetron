// Static PE32+ inspection for build/engine-windows.exe: machine, subsystem and
// the imported DLL set. The package must load only Windows system DLLs; the
// WebView2 runtime is discovered at run time by webview/webview's built-in
// loader, so WebView2Loader.dll (or any other third-party DLL) is refused.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SYSTEM_DLLS = new Set([
  "kernel32.dll", "user32.dll", "gdi32.dll", "ole32.dll", "oleaut32.dll", "shell32.dll", "shlwapi.dll", "version.dll",
  "advapi32.dll", "comdlg32.dll", "ntdll.dll", "msvcrt.dll", "ws2_32.dll", "bcrypt.dll", "userenv.dll", "dwmapi.dll",
]);
const allowed = (name) => SYSTEM_DLLS.has(name) || /^api-ms-win-[a-z0-9-]+\.dll$/.test(name);

export function inspectPe(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x5a4d) throw new Error("missing MZ header");
  const pe = view.getUint32(0x3c, true);
  if (view.getUint32(pe, true) !== 0x4550) throw new Error("missing PE signature");
  const machine = view.getUint16(pe + 4, true);
  const sections = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  const magic = view.getUint16(optional, true);
  if (magic !== 0x20b) throw new Error("not PE32+");
  const subsystem = view.getUint16(optional + 68, true);
  const directories = optional + 112;
  const table = [];
  for (let i = 0; i < sections; i++) {
    const at = optional + optionalSize + i * 40;
    table.push({ va: view.getUint32(at + 12, true), size: Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true)), raw: view.getUint32(at + 20, true) });
  }
  const offset = (rva) => {
    const section = table.find((s) => rva >= s.va && rva < s.va + s.size);
    if (!section) throw new Error(`RVA 0x${rva.toString(16)} outside sections`);
    return rva - section.va + section.raw;
  };
  const cstring = (at) => { let end = at; while (bytes[end]) end++; return Buffer.from(bytes.subarray(at, end)).toString("latin1"); };
  const names = (rva, stride, nameField) => {
    const out = [];
    if (!rva) return out;
    for (let at = offset(rva); ; at += stride) {
      const name = view.getUint32(at + nameField, true);
      if (!name) break;
      out.push(cstring(offset(name)));
    }
    return out;
  };
  const imports = names(view.getUint32(directories + 8, true), 20, 12);
  const delayed = names(view.getUint32(directories + 13 * 8, true), 32, 4);
  return { machine, subsystem, imports, delayed };
}

export function checkPe(bytes) {
  const info = inspectPe(bytes);
  const problems = [];
  if (info.machine !== 0x8664) problems.push(`machine 0x${info.machine.toString(16)} is not x86-64`);
  if (info.subsystem !== 3 && info.subsystem !== 2) problems.push(`unexpected subsystem ${info.subsystem}`);
  for (const dll of [...info.imports, ...info.delayed]) if (!allowed(dll.toLowerCase())) problems.push(`non-system import ${dll}`);
  return { ...info, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? "build/engine-windows.exe";
  const result = checkPe(readFileSync(file));
  console.log(`${file}: PE32+ x86-64 subsystem=${result.subsystem === 3 ? "console" : "gui"} imports=${result.imports.join(",")}${result.delayed.length ? " delayed=" + result.delayed.join(",") : ""}`);
  if (result.problems.length) { for (const problem of result.problems) console.error(problem); process.exit(1); }
}

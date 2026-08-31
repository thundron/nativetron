import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const scriptcRoot = process.env.SCRIPTC_ROOT ?? "/Users/thundron/Documents/development/scriptc";
const ts = createRequire(join(scriptcRoot, "package.json"))("typescript");
const src = process.argv[2] ?? join(here, "app.tsx");
const out = process.argv[3] ?? join(here, "app.generated.ts");

const emitted = ts.transpileModule(readFileSync(src, "utf8"), {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;

writeFileSync(out, "// generated from " + src.split("/").pop() + " — do not edit\n" + emitted);
console.log("jsx: wrote " + out.split("/").pop());

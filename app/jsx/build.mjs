import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const scriptcRoot = process.env.SCRIPTC_ROOT ?? "/Users/thundron/Documents/development/scriptc";
const ts = createRequire(join(scriptcRoot, "package.json"))("typescript");

const src = process.argv[2] ?? join(here, "app.tsx");
const out = process.argv[3] ?? join(here, "app.generated.ts");

// A JSX child expression becomes a reactive binding: {expr} -> {() => expr}.
// Already-function expressions are left alone, as are plain literals, which
// cannot change and so do not need a subscription.
function bindChildren(context) {
  const f = context.factory;
  const isStatic = (e) =>
    ts.isStringLiteral(e) || ts.isNumericLiteral(e) ||
    ts.isArrowFunction(e) || ts.isFunctionExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;

  const visit = (node) => {
    node = ts.visitEachChild(node, visit, context);
    if (
      ts.isJsxExpression(node) && node.expression &&
      node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      !isStatic(node.expression)
    ) {
      // coerce to string in the thunk: the binding sink takes () => string,
      // and scriptc unions do not re-tag () => number into () => string | number
      const coerced = f.createBinaryExpression(
        f.createStringLiteral(""),
        f.createToken(ts.SyntaxKind.PlusToken),
        f.createParenthesizedExpression(node.expression),
      );
      return f.updateJsxExpression(
        node,
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), coerced),
      );
    }
    return node;
  };
  return (sf) => ts.visitNode(sf, visit);
}

const sourceFile = ts.createSourceFile(src, readFileSync(src, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const bound = ts.transform(sourceFile, [bindChildren]).transformed[0];
const printed = ts.createPrinter().printFile(bound);

const emitted = ts.transpileModule(printed, {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;

writeFileSync(out, "// generated from " + src.split("/").pop() + " by app/jsx/build.mjs — do not edit\n" + emitted);
console.log("jsx: wrote " + out.split("/").pop());

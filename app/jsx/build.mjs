import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const scriptcRoot = resolveScriptc();

function resolveScriptc() {
  const env = process.env.SCRIPTC_ROOT;
  const candidates = env ? [env] : [join(REPO, "..", "..", "scriptc"), join(REPO, "..", "scriptc")];
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return c;
  }
  console.error(
    "cannot find the scriptc checkout" + (env ? ` at SCRIPTC_ROOT=${env}` : "") + " — set SCRIPTC_ROOT to it",
  );
  process.exit(1);
}

const ts = createRequire(join(scriptcRoot, "package.json"))("typescript");
const src = resolve(process.argv[2] ?? join(here, "app.tsx"));
const out = resolve(process.argv[3] ?? join(here, "app.generated.ts"));

const isComponent = (tag) => /^[A-Z]/.test(tag);

/* JSX is lowered here rather than by ts.transpileModule so host elements and
 * components can take different shapes:
 *
 *   <div a="1">x</div>   ->  h("div", { a: "1" }, "x")
 *   <Comp a={1} />       ->  Comp({ a: 1 })          (a direct call)
 *   {expr}               ->  () => "" + (expr)       (a reactive binding)
 *   {list.map(...)}      ->  listChild(() => ...)    (a keyed list)
 *   {cond ? a : b}       ->  when(() => cond, ...)   via `show`
 */
function lowerJsx(context) {
  const f = context.factory;
  const emittedElements = new Set();

  const markElement = (expr) => {
    emittedElements.add(expr);
    return expr;
  };

  const elementKind = (expr) => {
    if (emittedElements.has(expr)) return 1;
    const original = ts.getOriginalNode(expr);
    const type = checker.getTypeAtLocation(original);
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return 0;
    const parts = type.isUnion() ? type.types : [type];
    let elements = 0;
    let values = 0;
    for (const part of parts) {
      if ((part.flags & (ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) continue;
      values++;
      if (checker.getPropertyOfType(part, "roots") !== undefined) elements++;
    }
    if (elements === 0) return 0;
    return elements === values ? 1 : 2;
  };

  const isStaticText = (e) =>
    ts.isStringLiteral(e) || ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;

  const thunk = (expr) =>
    f.createArrowFunction(undefined, undefined, [], undefined,
      f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), expr);

  const stringThunk = (expr) =>
    thunk(f.createBinaryExpression(
      f.createStringLiteral(""),
      f.createToken(ts.SyntaxKind.PlusToken),
      f.createParenthesizedExpression(expr),
    ));

  const attrsOf = (node, component) => {
    const attrs = node.attributes.properties;
    if (attrs.length === 0) return f.createNull();
    const props = [];
    for (const a of attrs) {
      if (ts.isJsxSpreadAttribute(a)) {
        props.push(f.createSpreadAssignment(a.expression));
        continue;
      }
      const name = ts.isIdentifier(a.name) ? a.name.text : a.name.getText();
      let value;
      if (a.initializer === undefined) value = f.createStringLiteral("");
      else if (ts.isStringLiteral(a.initializer)) value = a.initializer;
      else value = a.initializer.expression;
      const isHandler = name.startsWith("on");
      const isStatic = ts.isStringLiteral(value) || name === "key" || name === "ref";
      if (!component && !isHandler && !isStatic) value = stringThunk(value);
      props.push(f.createPropertyAssignment(f.createStringLiteral(name), value));
    }
    return props.length === 0 ? f.createNull() : f.createObjectLiteralExpression(props, false);
  };

  const childrenOf = (node) => {
    const out = [];
    for (const c of node.children ?? []) {
      if (ts.isJsxText(c)) {
        // React's rule: whitespace spanning a newline is layout, whitespace
        // on one line is content. `count: {x}` keeps its trailing space.
        const raw = c.text;
        const t = raw.includes("\n")
          ? raw.split("\n").map((l) => l.trim()).filter((l) => l !== "").join(" ")
          : raw;
        if (t !== "") out.push(f.createStringLiteral(t));
        continue;
      }
      if (ts.isJsxExpression(c)) {
        if (!c.expression) continue;
        const e = c.expression;
        if (isStaticText(e)) { out.push(e); continue; }
        if (isMapCall(e)) { out.push(listChild(f, e)); continue; }
        if (ts.isBinaryExpression(e) &&
            e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            elementKind(e.right) === 1) {
          out.push(f.createCallExpression(f.createIdentifier("show"), undefined, [
            thunk(e.left), thunk(e.right),
            f.createIdentifier("nothing"),
          ]));
          continue;
        }
        if (ts.isConditionalExpression(e) && elementKind(e.whenTrue) === 1) {
          out.push(f.createCallExpression(f.createIdentifier("show"), undefined, [
            thunk(e.condition), thunk(e.whenTrue), thunk(e.whenFalse),
          ]));
          continue;
        }
        const kind = elementKind(e);
        if (kind === 1) { out.push(e); continue; }
        if (kind === 2) {
          throw new Error("an expression child cannot mix element and non-element values; use a conditional");
        }
        out.push(stringThunk(e));
        continue;
      }
      out.push(c);
    }
    return out;
  };

  const visit = (node) => {
    node = ts.visitEachChild(node, visit, context);

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = open.tagName.getText();
      const provider = tag.endsWith(".Provider");
      const props = attrsOf(open, isComponent(tag));
      const kids = ts.isJsxElement(node) ? childrenOf(node) : [];
      if (provider) {
        if (props.kind === ts.SyntaxKind.NullKeyword) {
          throw new Error("a context provider needs a value prop");
        }
        const contextName = tag.slice(0, -".Provider".length);
        const value = f.createPropertyAccessExpression(
          f.createParenthesizedExpression(props),
          "value",
        );
        const subtree = f.createCallExpression(f.createIdentifier("frag"), undefined, [
          f.createArrayLiteralExpression(kids, false),
        ]);
        return markElement(f.createCallExpression(f.createIdentifier("provide"), undefined, [
          f.createIdentifier(contextName), thunk(value), thunk(subtree),
        ]));
      }
      if (isComponent(tag)) {
        const args = [];
        if (props.kind !== ts.SyntaxKind.NullKeyword || kids.length > 0) {
          args.push(props.kind === ts.SyntaxKind.NullKeyword ? f.createObjectLiteralExpression([]) : props);
        }
        if (kids.length > 0) {
          args[0] = f.createObjectLiteralExpression([
            ...(props.kind === ts.SyntaxKind.NullKeyword ? [] : props.properties),
            f.createPropertyAssignment("children", f.createArrayLiteralExpression(kids, false)),
          ], false);
        }
        return markElement(f.createCallExpression(f.createIdentifier(tag), undefined, args));
      }
      const only = onlyMapChild(node);
      if (only !== null) {
        const each = f.createCallExpression(f.createIdentifier("each"), undefined, [
          f.createStringLiteral(tag), thunk(keyedMap(f, only)),
        ]);
        const withProps = props.kind === ts.SyntaxKind.NullKeyword
          ? each
          : f.createCallExpression(f.createIdentifier("applyProps"), undefined, [each, props]);
        return markElement(withProps);
      }
      return markElement(f.createCallExpression(f.createIdentifier("h"), undefined, [
        f.createStringLiteral(tag), props, ...kids,
      ]));
    }

    if (ts.isJsxFragment(node)) {
      return markElement(f.createCallExpression(f.createIdentifier("frag"), undefined, [
        f.createArrayLiteralExpression(childrenOf(node), false),
      ]));
    }
    return node;
  };
  return (sf) => ts.visitNode(sf, visit);

  /* <ul>{xs.map(x => <li key={x}>..</li>)}</ul> — children are already
   * lowered to h(...) by the bottom-up visit, so the key is read back out
   * of the emitted props object and removed from the DOM attributes. */
  function onlyMapChild(node) {
    const real = (node.children ?? []).filter(
      (c) => !(ts.isJsxText(c) && c.text.trim() === ""),
    );
    if (real.length !== 1) return null;
    const c = real[0];
    if (!ts.isJsxExpression(c) || !c.expression || !isMapCall(c.expression)) return null;
    return c.expression;
  }

  function keyedMap(f, mapCall) {
    const cb = mapCall.arguments[0];
    if (cb === undefined || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) {
      throw new Error("a list child needs an inline map callback");
    }
    const body = ts.isBlock(cb.body) ? null : cb.body;
    if (body === null || !ts.isCallExpression(body)) {
      throw new Error("a list callback must return a single element expression");
    }
    const propsArg = body.arguments[1];
    if (propsArg !== undefined && propsArg.kind === ts.SyntaxKind.NullKeyword) {
      throw new Error("a list element needs a key prop");
    }
    let keyExpr = null;
    let rest = propsArg;
    if (propsArg !== undefined && ts.isObjectLiteralExpression(propsArg)) {
      const keep = [];
      for (const p of propsArg.properties) {
        const n = ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) ? p.name.text : null;
        if (n === "key") keyExpr = p.initializer;
        else keep.push(p);
      }
      rest = keep.length === 0 ? f.createNull() : f.createObjectLiteralExpression(keep, false);
    }
    if (keyExpr === null) throw new Error("a list element needs a key prop");
    const elExpr = f.updateCallExpression(body, body.expression, body.typeArguments, [
      body.arguments[0], rest, ...body.arguments.slice(2),
    ]);
    const item = f.createObjectLiteralExpression([
      f.createPropertyAssignment("key", f.createBinaryExpression(
        f.createStringLiteral(""), f.createToken(ts.SyntaxKind.PlusToken),
        f.createParenthesizedExpression(keyExpr))),
      f.createPropertyAssignment("el", elExpr),
    ], false);
    const newCb = f.createArrowFunction(undefined, undefined, cb.parameters, undefined,
      f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), f.createParenthesizedExpression(item));
    return f.updateCallExpression(mapCall, mapCall.expression, mapCall.typeArguments, [
      newCb, ...mapCall.arguments.slice(1),
    ]);
  }

  function isMapCall(e) {
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "map";
  }

  function listChild(f, e) {
    return f.createCallExpression(f.createIdentifier("list"), undefined, [thunk(e)]);
  }
}

const program = ts.createProgram([join(here, "jsx-env.d.ts"), src], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  skipLibCheck: true,
});
const sourceFile = program.getSourceFile(src);
if (sourceFile === undefined) throw new Error("cannot load " + src);
const checker = program.getTypeChecker();
const lowered = ts.transform(sourceFile, [lowerJsx]).transformed[0];
const printed = ts.createPrinter().printFile(lowered);

// The transform removes every JSX node, so what is left is plain TypeScript.
// It is NOT transpiled: scriptc needs the type annotations.
writeFileSync(out, "// generated from " + src.split("/").pop() + " by app/jsx/build.mjs — do not edit\n" + printed);
console.log("jsx: wrote " + out.split("/").pop());

// Declared static analysis boundary for message keys.
//
// What this proves, for every scanned file that imports the i18n module through a relative specifier:
//   - each call `message("literal", ...)` (named import, alias, or `namespace.message`) names a key present
//     in every catalogue;
//   - when the argument list is a literal array of `textArgument("name", …)` / `numberArgument("name", …)`
//     calls, the argument names equal the message's declared arguments and plural selectors are numeric;
//   - literal string values of declared key-bearing properties (for example `labelKey: "commands.title"`)
//     name present keys, in every scanned file.
// What it does not prove: keys computed at runtime. Such call sites and any non-call use of `message`
// (aliasing, passing it as a value, re-exporting it) are refused unless the file is declared in
// `dynamicKeyFiles`; declared sites are reported and rely on the runtime `missing message key` error.
// The analysis is lexical, not type-directed: a local binding that shadows the imported name is treated as
// the i18n function, which can only produce a conservative failure, never an unchecked pass.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const REGEX_PREFIX_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>", "==", "===", "!=", "!==", "&&", "||", "??", "+=", "-=", "*=", "/=", "<=", ">="]);
const PUNCT = ["===", "!==", "...", "**=", "??=", "&&=", "||=", ">>>", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "+=", "-=", "*=", "/=", "%=", "++", "--", "**", "<<", ">>"];

export function lex(source, file = "<source>", jsx = /\.[cm]?[jt]sx$/.test(file)) {
  const tokens = [];
  let offset = 0, line = 1;
  const fail = (text) => { throw new Error(`${file}:${line}: i18n source scan cannot lex ${text}`); };
  const previous = () => tokens[tokens.length - 1];
  const expressionStart = () => {
    const token = previous();
    if (!token) return true;
    if (token.type === "punct") return REGEX_PREFIX_PUNCT.has(token.value);
    return token.type === "id" && REGEX_PREFIX_WORDS.has(token.value);
  };
  const advance = (count) => { for (let i = 0; i < count; i++) if (source[offset + i] === "\n") line++; offset += count; };
  const template = () => {
    // offset is just after the opening backtick.
    const startLine = line;
    let cooked = "", plain = true;
    while (true) {
      if (offset >= source.length) fail("an unterminated template literal");
      const char = source[offset];
      if (char === "\\") { plain = false; cooked += source.slice(offset, offset + 2); advance(2); continue; }
      if (char === "`") { advance(1); tokens.push({ type: "template", value: cooked, literal: plain, line: startLine }); return; }
      if (char === "$" && source[offset + 1] === "{") {
        advance(1);
        plain = false;
        substitution();
        continue;
      }
      cooked += char; advance(1);
    }
  };
  const substitution = () => {
    tokens.push({ type: "punct", value: "{", line });
    advance(1); code(true); advance(1);
    tokens.push({ type: "punct", value: "}", line });
  };
  const jsxExpression = substitution;
  // JSX element starting at "<"; JSX text and attribute strings are not code and produce no tokens.
  const element = () => {
    const startLine = line;
    advance(1);
    const name = /^[A-Za-z_$][\w$.:-]*/.exec(source.slice(offset, offset + 256))?.[0] ?? "";
    advance(name.length);
    while (true) {
      while (/\s/.test(source[offset] ?? "")) advance(1);
      if (offset >= source.length) fail("an unterminated JSX element");
      if (source.startsWith("/>", offset)) { advance(2); return; }
      if (source[offset] === ">") { advance(1); break; }
      if (source[offset] === "{") { jsxExpression(); continue; }
      const attribute = /^[A-Za-z_$][\w$:-]*/.exec(source.slice(offset, offset + 256))?.[0];
      if (!attribute) fail(`JSX attribute syntax in element starting at line ${startLine}`);
      advance(attribute.length);
      while (/\s/.test(source[offset] ?? "")) advance(1);
      if (source[offset] !== "=") continue;
      advance(1);
      while (/\s/.test(source[offset] ?? "")) advance(1);
      const quote = source[offset];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, offset + 1);
        if (close < 0) fail("an unterminated JSX attribute string");
        advance(close + 1 - offset);
      } else if (quote === "{") jsxExpression();
      else if (quote === "<") element();
      else fail("a JSX attribute value");
    }
    while (true) {
      if (offset >= source.length) fail(`an unterminated JSX element starting at line ${startLine}`);
      const char = source[offset];
      if (char === "{") { jsxExpression(); continue; }
      if (char === "<") {
        if (source[offset + 1] === "/") {
          const close = source.indexOf(">", offset);
          if (close < 0) fail("an unterminated JSX closing tag");
          advance(close + 1 - offset);
          return;
        }
        element();
        continue;
      }
      advance(1);
    }
  };
  // Lexes code; when `nested`, stops before the "}" that closes the enclosing substitution/expression.
  const code = (nested) => {
    let depth = 0;
    while (offset < source.length) {
      const char = source[offset];
      if (/\s/.test(char)) { advance(1); continue; }
      if (source.startsWith("//", offset)) { while (offset < source.length && source[offset] !== "\n") offset++; continue; }
      if (source.startsWith("/*", offset)) {
        const end = source.indexOf("*/", offset + 2);
        if (end < 0) fail("an unterminated comment");
        advance(end + 2 - offset); continue;
      }
      if (char === "'" || char === '"') {
        let value = "", plain = true, i = offset + 1;
        while (true) {
          if (i >= source.length || source[i] === "\n") fail("an unterminated string literal");
          if (source[i] === "\\") { plain = false; value += source.slice(i, i + 2); i += 2; continue; }
          if (source[i] === char) break;
          value += source[i++];
        }
        tokens.push({ type: "string", value, literal: plain, line });
        advance(i + 1 - offset); continue;
      }
      if (char === "`") { advance(1); template(); continue; }
      if (char === "}" && nested && depth === 0) return;
      if (/[A-Za-z_$]/.test(char)) {
        const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(offset, offset + 256));
        tokens.push({ type: "id", value: match[0], line }); offset += match[0].length; continue;
      }
      if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[offset + 1] ?? ""))) {
        const match = /^(?:0[xXoObB][0-9a-fA-F_]+n?|[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9_]+)?n?)/.exec(source.slice(offset, offset + 64));
        tokens.push({ type: "number", value: match[0], line }); offset += match[0].length; continue;
      }
      if (char === "/" && expressionStart()) {
        let i = offset + 1, inClass = false;
        while (true) {
          if (i >= source.length || source[i] === "\n") fail("an unterminated regular expression");
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          else if (source[i] === "/" && !inClass) break;
          i++;
        }
        i++;
        while (/[a-z]/.test(source[i] ?? "")) i++;
        tokens.push({ type: "regex", value: source.slice(offset, i), line }); offset = i; continue;
      }
      if (jsx && char === "<" && expressionStart() && /[A-Za-z_$>]/.test(source[offset + 1] ?? "")) {
        const startLine = line;
        element();
        tokens.push({ type: "jsx", value: "", line: startLine });
        continue;
      }
      const punct = PUNCT.find((candidate) => source.startsWith(candidate, offset)) ?? char;
      if (punct === "{") depth++;
      if (punct === "}") depth--;
      tokens.push({ type: "punct", value: punct, line }); offset += punct.length;
    }
    if (nested) fail("an unterminated substitution or JSX expression");
  };
  code(false);
  return tokens;
}

const isLiteral = (token) => token && (token.type === "string" || token.type === "template") && token.literal;

// Bindings imported from the i18n module: { message: Set, textArgument: Set, numberArgument: Set, namespaces: Set }.
function importedBindings(tokens, file, i18nIndex, problems) {
  const result = { message: new Set(), textArgument: new Set(), numberArgument: new Set(), namespaces: new Set(), ranges: [] };
  const targets = new Set([i18nIndex, i18nIndex.replace(/\.ts$/, ".js"), i18nIndex.replace(/\/index\.ts$/, ""), i18nIndex.replace(/\.ts$/, "")]);
  const fromI18n = (token) => token?.type === "string" && token.value.startsWith(".") && targets.has(resolve(dirname(file), token.value));
  for (let i = 0; i < tokens.length; i++) {
    const keyword = tokens[i];
    if (keyword.type !== "id" || (keyword.value !== "import" && keyword.value !== "export") || tokens[i - 1]?.value === ".") continue;
    let j = i + 1;
    if (tokens[j]?.value === "type") j++;
    if (tokens[j]?.value === "*") {
      // import * as ns from "…" / export * from "…"
      const as = tokens[j + 1]?.value === "as" ? tokens[j + 2]?.value : null;
      const fromAt = as ? j + 3 : j + 1;
      if (tokens[fromAt]?.value === "from" && fromI18n(tokens[fromAt + 1])) {
        if (keyword.value === "export") problems.push({ file, line: keyword.line, text: "re-exports the i18n module; uses through the re-export cannot be analysed" });
        else result.namespaces.add(as);
        result.ranges.push([i, fromAt + 1]);
      }
      continue;
    }
    if (tokens[j]?.value !== "{") continue;
    let close = j;
    while (close < tokens.length && tokens[close].value !== "}") close++;
    if (tokens[close + 1]?.value !== "from" || !fromI18n(tokens[close + 2])) continue;
    result.ranges.push([i, close + 2]);
    for (let k = j + 1; k < close; k++) {
      let name = tokens[k];
      if (name.value === "type" && tokens[k + 1]?.type === "id" && tokens[k + 1].value !== "as" && tokens[k + 1].value !== ",") { k++; name = tokens[k]; }
      if (name.type !== "id") continue;
      let local = name.value;
      if (tokens[k + 1]?.value === "as") { local = tokens[k + 2].value; k += 2; }
      if (keyword.value === "export") {
        if (name.value === "message") problems.push({ file, line: keyword.line, text: "re-exports message; uses through the re-export cannot be analysed" });
        continue;
      }
      if (Object.hasOwn(result, name.value) && name.value !== "namespaces" && name.value !== "ranges") result[name.value].add(local);
    }
  }
  return result;
}

// Parses `[textArgument("a", …), numberArgument("b", …)]` starting at `[`; returns null when not fully literal.
function literalArguments(tokens, start, bindings) {
  if (tokens[start]?.value !== "[") return { args: null, end: start };
  const args = [];
  let i = start + 1;
  while (tokens[i] && tokens[i].value !== "]") {
    const callee = tokens[i];
    let kind = null;
    if (callee.type === "id" && bindings.textArgument.has(callee.value)) kind = "text";
    if (callee.type === "id" && bindings.numberArgument.has(callee.value)) kind = "number";
    if (callee.type === "id" && bindings.namespaces.has(callee.value) && tokens[i + 1]?.value === "." ) {
      const member = tokens[i + 2]?.value;
      if (member === "textArgument" || member === "numberArgument") { kind = member === "textArgument" ? "text" : "number"; i += 2; }
    }
    if (!kind || tokens[i + 1]?.value !== "(" || !isLiteral(tokens[i + 2]) || tokens[i + 3]?.value !== ",") return { args: null, end: i };
    args.push({ name: tokens[i + 2].value, kind, line: callee.line });
    // Skip the value expression to the matching close parenthesis.
    let depth = 0, k = i + 1;
    for (; k < tokens.length; k++) {
      const value = tokens[k].value;
      if (value === "(" || value === "[" || value === "{") depth++;
      if (value === ")" || value === "]" || value === "}") { depth--; if (depth === 0) break; }
    }
    i = k + 1;
    if (tokens[i]?.value === ",") i++;
    else if (tokens[i]?.value !== "]") return { args: null, end: i };
  }
  return { args, end: i };
}

export function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

// catalogue: { keys: Set, signatures: Map<key, Map<name, "any"|"number">> }
export function scanSources({ root, files, i18nIndex, catalogue, keyProperties = [], dynamicKeyFiles = [] }) {
  const errors = [], dynamic = [], report = { files: 0, importingFiles: 0, literalCalls: 0, verifiedArguments: 0, keyProperties: 0 };
  const allowed = new Set(dynamicKeyFiles.map((path) => resolve(root, path)));
  const display = (file) => relative(root, file) || file;
  const checkKey = (file, line, key, how) => {
    if (!catalogue.keys.has(key)) { errors.push(`${display(file)}:${line}: missing message key ${key} (${how})`); return false; }
    return true;
  };
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    report.files++;
    const tokens = lex(source, display(file));
    const escapes = [];
    const bindings = importedBindings(tokens, file, i18nIndex, escapes);
    const inImport = (index) => bindings.ranges.some(([from, to]) => index >= from && index <= to);
    if (bindings.message.size || bindings.namespaces.size) report.importingFiles++;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "id" && keyProperties.includes(token.value) || token.type === "string" && token.literal && keyProperties.includes(token.value)) {
        if (["{", ","].includes(tokens[i - 1]?.value) && tokens[i + 1]?.value === ":" && isLiteral(tokens[i + 2]) && [",", "}", ";"].includes(tokens[i + 3]?.value)) {
          report.keyProperties++;
          checkKey(file, tokens[i + 2].line, tokens[i + 2].value, `${token.value} property`);
        }
      }
      if (token.type !== "id" || inImport(i)) continue;
      let calleeEnd = -1;
      if (bindings.message.has(token.value) && tokens[i - 1]?.value !== "." && tokens[i - 1]?.value !== "?.") {
        // Object keys and member names spelled like the binding are not uses.
        if (tokens[i + 1]?.value === ":" && ["{", ","].includes(tokens[i - 1]?.value)) continue;
        calleeEnd = i;
      } else if (bindings.namespaces.has(token.value) && tokens[i - 1]?.value !== ".") {
        if (tokens[i + 1]?.value !== ".") { escapes.push({ file, line: token.line, text: `uses i18n namespace ${token.value} as a value` }); continue; }
        if (tokens[i + 2]?.value !== "message") continue;
        calleeEnd = i + 2;
      } else continue;
      if (tokens[calleeEnd + 1]?.value !== "(") { escapes.push({ file, line: token.line, text: "uses message other than as a direct call" }); continue; }
      const first = tokens[calleeEnd + 2];
      const after = tokens[calleeEnd + 3];
      if (!isLiteral(first) || (after?.value !== "," && after?.value !== ")")) { dynamic.push({ file, line: token.line }); continue; }
      report.literalCalls++;
      if (!checkKey(file, first.line, first.value, "literal message call")) continue;
      let args = [];
      if (after.value === ",") {
        if (tokens[calleeEnd + 4]?.value === ")") args = [];
        else {
          const parsed = literalArguments(tokens, calleeEnd + 4, bindings);
          args = parsed.args && tokens[parsed.end + 1]?.value !== ")" && tokens[parsed.end + 1]?.value !== "," ? null : parsed.args;
        }
      }
      if (args === null) continue; // non-literal argument lists are validated at runtime
      report.verifiedArguments++;
      const signature = catalogue.signatures.get(first.value);
      const names = new Set();
      for (const arg of args) {
        if (names.has(arg.name)) errors.push(`${display(file)}:${arg.line}: duplicate message argument ${arg.name} for ${first.value}`);
        names.add(arg.name);
        if (!signature.has(arg.name)) errors.push(`${display(file)}:${arg.line}: message ${first.value} has no argument ${arg.name}`);
        else if (signature.get(arg.name) === "number" && arg.kind !== "number") errors.push(`${display(file)}:${arg.line}: message ${first.value} argument ${arg.name} selects a plural and needs numberArgument`);
      }
      for (const name of signature.keys()) if (!names.has(name)) errors.push(`${display(file)}:${first.line}: message ${first.value} is missing argument ${name}`);
    }
    for (const escape of escapes) errors.push(`${display(escape.file)}:${escape.line}: ${escape.text}; not statically analysable`);
  }
  for (const site of dynamic) if (!allowed.has(site.file)) errors.push(`${display(site.file)}:${site.line}: message key is not a string literal; declare the file in dynamicKeyFiles to rely on the runtime check`);
  return { errors, dynamic: dynamic.filter((site) => allowed.has(site.file)).map((site) => `${display(site.file)}:${site.line}`), report };
}

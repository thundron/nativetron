// Parser for the supported ICU MessageFormat subset:
//   text, `{name}` arguments, and `{name, plural, ...}` cardinal plurals with `=N` exact branches,
//   the locale's CLDR categories, a required `other`, nested messages, and `#` inside plural branches.
// Every other ICU construct is rejected rather than approximated: select/selectordinal/number/date/
// time/spellout/duration arguments, plural offsets, and apostrophe quoting of syntax characters.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
const EXACT = /^=-?\d+(?:\.\d+)?/;

export function parseMessage(source, categories = ["one", "other"]) {
  if (typeof source !== "string") throw new Error("ICU message must be a string");
  let offset = 0;
  const fail = (text) => { throw new Error(`${text} at offset ${offset} in ${JSON.stringify(source)}`); };
  const whitespace = () => { while (offset < source.length && /\s/.test(source[offset])) offset++; };
  const read = (pattern, what) => {
    whitespace();
    const match = pattern.exec(source.slice(offset));
    if (!match) fail(`expected ${what}`);
    offset += match[0].length;
    return match[0];
  };
  const body = (depth) => {
    const nodes = [];
    let text = "";
    const flush = () => { if (text) { nodes.push({ kind: "text", value: text }); text = ""; } };
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "}") { if (!depth) fail("unmatched ICU close brace"); flush(); return nodes; }
      if (char === "'" && /[{}#|']/.test(source[offset] ?? "")) fail("ICU apostrophe quoting is not supported");
      if (char !== "{") { text += char; continue; }
      flush();
      const name = read(IDENTIFIER, "ICU argument name");
      whitespace();
      if (source[offset] === "}") { offset++; nodes.push({ kind: "argument", name }); continue; }
      if (source[offset++] !== ",") fail("expected , or } after ICU argument name");
      whitespace();
      const type = IDENTIFIER.exec(source.slice(offset))?.[0];
      if (type !== "plural") fail(`unsupported ICU argument type ${JSON.stringify(type ?? source.slice(offset, offset + 8))}; only plain arguments and cardinal plural are supported`);
      offset += type.length;
      whitespace();
      if (source[offset++] !== ",") fail("expected , after plural");
      whitespace();
      if (/^offset\s*:/.test(source.slice(offset))) fail("ICU plural offset is not supported");
      const cases = [];
      while (true) {
        whitespace();
        if (offset >= source.length) fail("unterminated ICU plural");
        if (source[offset] === "}") { offset++; break; }
        const key = source[offset] === "=" ? read(EXACT, "exact plural value") : read(IDENTIFIER, "plural category");
        if (!key.startsWith("=") && !categories.includes(key)) fail(`plural category ${key} is not defined by this locale's rule (${categories.join(", ")})`);
        const exact = key.startsWith("=") ? Number(key.slice(1)) : null;
        if (cases.some((entry) => entry.key === key || (exact !== null && entry.exact === exact))) fail(`duplicate plural branch ${key}`);
        whitespace();
        if (source[offset++] !== "{") fail("expected ICU branch body");
        cases.push({ key, exact, body: body(depth + 1) });
      }
      if (!cases.some((entry) => entry.key === "other")) fail("ICU plural requires an other branch");
      nodes.push({ kind: "plural", name, cases });
    }
    if (depth) fail("unterminated ICU message");
    flush();
    return nodes;
  };
  return body(0);
}

// Argument signature: name -> "number" when used as a plural selector, otherwise "any".
export function messageArguments(nodes, result = new Map()) {
  for (const node of nodes) {
    if (node.kind === "argument") { if (!result.has(node.name)) result.set(node.name, "any"); }
    else if (node.kind === "plural") {
      result.set(node.name, "number");
      for (const entry of node.cases) messageArguments(entry.body, result);
    }
  }
  return result;
}

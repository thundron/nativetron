export function parseMessage(source) {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++; };
  const token = () => { whitespace(); const match = /^[A-Za-z_][A-Za-z0-9_]*|^=-?\d+(?:\.\d+)?/.exec(source.slice(offset)); if (!match) throw new Error(`expected ICU token at ${offset}`); offset += match[0].length; return match[0]; };
  const body = (nested = false) => {
    const nodes = [];
    let text = "";
    const flush = () => { if (text) { nodes.push({ kind: "text", value: text }); text = ""; } };
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "}") { if (!nested) throw new Error("unmatched ICU close brace"); flush(); return nodes; }
      if (char === "'" && /[{}#']/.test(source[offset] ?? "")) throw new Error("ICU apostrophe escaping is not supported");
      if (char !== "{") { text += char; continue; }
      flush();
      const name = token(); whitespace();
      if (source[offset] === "}") { offset++; nodes.push({ kind: "argument", name }); continue; }
      if (source[offset++] !== "," || token() !== "plural") throw new Error("only ICU arguments and cardinal plurals are supported");
      whitespace(); if (source[offset++] !== ",") throw new Error("expected ICU plural comma");
      const cases = [];
      while (true) {
        whitespace();
        if (source[offset] === "}") { offset++; break; }
        const key = token();
        if (!["one", "other"].includes(key) && !key.startsWith("=")) throw new Error(`unsupported English plural branch ${key}`);
        if (cases.some((entry) => entry.key === key)) throw new Error(`duplicate plural branch ${key}`);
        whitespace(); if (source[offset++] !== "{") throw new Error("expected ICU branch body");
        cases.push({ key, body: body(true) });
      }
      if (!cases.some((entry) => entry.key === "other")) throw new Error("ICU plural requires other branch");
      nodes.push({ kind: "plural", name, cases });
    }
    if (nested) throw new Error("unterminated ICU branch");
    flush(); return nodes;
  };
  return body();
}


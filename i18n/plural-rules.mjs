// Parser/compiler for the supported subset of CLDR plural-rule syntax (UTS #35, "Language Plural Rules").
//
// Supported: operands n i v w f t e c, `%` modulo, `=` / `!=` against comma-separated values and `a..b`
// integer ranges, `and` (binds tighter) and `or`. Unsupported syntax fails: samples (`@integer`), the
// legacy `is`/`in`/`within`/`not` forms, and anything else.
//
// Operand semantics are those of the number as message formatting displays it (see i18n/plural.ts):
// standard (non-compact, non-scientific) notation rounded to the declared plural fraction digits with
// trailing zeros removed. Therefore w = v, t = f, and the compact exponent operands e/c are always 0.
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const OPERANDS = new Set(["n", "i", "v", "w", "f", "t", "e", "c"]);

function tokenize(source) {
  const tokens = [];
  const pattern = /\s*(?:(\.\.)|(!=|=|%|,)|(\d+)|([a-z]+)|(\S))/gy;
  let match;
  while (pattern.lastIndex < source.length && (match = pattern.exec(source))) {
    if (match[5] !== undefined) throw new Error(`unsupported plural rule syntax ${JSON.stringify(match[5])} in ${JSON.stringify(source)}`);
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return tokens;
}

export function parsePluralCondition(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("plural rule condition must be a non-empty string");
  if (source.includes("@")) throw new Error(`plural rule samples are not supported: ${JSON.stringify(source)}`);
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (expected) => {
    const token = tokens[position++];
    if (expected !== undefined && token !== expected) throw new Error(`expected ${expected} in plural rule ${JSON.stringify(source)}`);
    if (token === undefined) throw new Error(`truncated plural rule ${JSON.stringify(source)}`);
    return token;
  };
  const integer = () => {
    const token = take();
    if (!/^\d+$/.test(token)) throw new Error(`expected integer in plural rule ${JSON.stringify(source)}`);
    return Number(token);
  };
  const relation = () => {
    const operand = take();
    if (!OPERANDS.has(operand)) throw new Error(`unsupported plural operand ${JSON.stringify(operand)} in ${JSON.stringify(source)}`);
    let modulo = null;
    if (peek() === "%") { take("%"); modulo = integer(); if (modulo === 0 || modulo > 1e12) throw new Error("plural modulo must be in 1..1e12"); }
    const operator = take();
    if (operator !== "=" && operator !== "!=") throw new Error(`unsupported plural relation ${JSON.stringify(operator)} in ${JSON.stringify(source)}`);
    const ranges = [];
    do {
      if (ranges.length) take(",");
      const low = integer();
      let high = low;
      if (peek() === "..") { take(".."); high = integer(); if (high < low) throw new Error(`empty plural range in ${JSON.stringify(source)}`); }
      ranges.push([low, high]);
    } while (peek() === ",");
    return { operand, modulo, negated: operator === "!=", ranges };
  };
  const disjunction = [];
  do {
    if (disjunction.length) take("or");
    const conjunction = [relation()];
    while (peek() === "and") { take("and"); conjunction.push(relation()); }
    disjunction.push(conjunction);
  } while (peek() === "or");
  if (position !== tokens.length) throw new Error(`unsupported plural rule syntax near ${JSON.stringify(tokens[position])} in ${JSON.stringify(source)}`);
  return disjunction;
}

// Validates a rule table ({ category: condition }) and returns it in CLDR evaluation order.
export function compilePluralRule(name, table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error(`plural rule ${name} must be an object`);
  const entries = [];
  for (const category of Object.keys(table)) {
    if (!PLURAL_CATEGORIES.includes(category)) throw new Error(`plural rule ${name}: unknown category ${category}`);
    if (category === "other") throw new Error(`plural rule ${name}: other is implicit and must not be declared`);
  }
  for (const category of PLURAL_CATEGORIES) if (Object.hasOwn(table, category)) entries.push({ category, condition: parsePluralCondition(table[category]) });
  return { name, categories: [...entries.map((entry) => entry.category), "other"], entries };
}

const CONSTANT_OPERANDS = new Set(["e", "c"]); // always 0 for standard notation

// Emits a TypeScript/JavaScript boolean expression over `o: PluralOperands` (i18n/plural.ts) and
// `digitsMod`, or the constants "true"/"false". Every range is in the integer domain (UTS #35), so n — which
// is an integer exactly when no fraction digit is visible — compares as `v = 0 and i …`.
function relationExpression({ operand, modulo, negated, ranges }) {
  if (CONSTANT_OPERANDS.has(operand)) {
    const matched = ranges.some(([low, high]) => low <= 0 && 0 <= high);
    return String(matched !== negated);
  }
  let value;
  if (operand === "n" || operand === "i") value = modulo === null ? "o.i" : `digitsMod(o.iDigits, ${modulo})`;
  else if (operand === "v" || operand === "w") value = modulo === null ? "o.v" : `(o.v % ${modulo})`;
  else value = modulo === null ? "o.f" : `digitsMod(o.fDigits, ${modulo})`;
  const tests = ranges.map(([low, high]) => low === high ? `${value} === ${low}` : `(${value} >= ${low} && ${value} <= ${high})`);
  let any = tests.length === 1 ? tests[0] : `(${tests.join(" || ")})`;
  if (operand === "n") any = `(o.v === 0 && ${any})`;
  return negated ? `!(${any})` : any;
}

// Constant-folds e/c relations so generated code contains no literal-only comparisons.
export function conditionExpression(condition) {
  const conjunctions = [];
  for (const conjunction of condition) {
    const parts = conjunction.map(relationExpression);
    if (parts.includes("false")) continue;
    const live = parts.filter((part) => part !== "true");
    if (!live.length) return "true";
    conjunctions.push(live.join(" && "));
  }
  if (!conjunctions.length) return "false";
  return conjunctions.length === 1 ? conjunctions[0] : conjunctions.map((part) => `(${part})`).join(" || ");
}

function digitsMod(digits, modulus) {
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % modulus;
  return remainder;
}

// Host-side evaluator with identical semantics, used by tests to compare against Intl.PluralRules.
export function pluralRuleEvaluator(rule) {
  const tests = rule.entries.map((entry) => ({ category: entry.category, test: new Function("o", "digitsMod", `return ${conditionExpression(entry.condition)};`) }));
  return (operands) => { for (const { category, test } of tests) if (test(operands, digitsMod)) return category; return "other"; };
}

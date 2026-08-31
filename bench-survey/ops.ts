// Benchmark ops. Each export: (n) => checksum. Same source runs in Node (V8)
// via type-strip and compiled to wasm via scriptc. Checksums must match.

// ---------- helpers ----------
function mkNums(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push((i * 7919 + 13) % 100003);
  return a;
}

// ---------- Array ----------
export function arrPush(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push((i * 3 + 1) % 100003);
  let s: number = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

export function arrPop(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  while (a.length > 0) s += a.pop()!;
  return s;
}

export function arrShift(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  while (a.length > 0) s += a.shift()!;
  return s;
}

export function arrUnshift(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.unshift((i * 3 + 1) % 100003);
  let s: number = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

export function arrIndexOf(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let i = 0; i < n; i++) s += a.indexOf((i * 7919 + 13) % 100003);
  return s;
}

export function arrIncludes(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let i = 0; i < n; i++) if (a.includes((i * 13) % 100003)) s += 1;
  return s;
}

export function arrSlice(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 50; r++) {
    const b = a.slice(r, n - r);
    s += b.length;
  }
  return s;
}

export function arrSplice(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  while (a.length > 1) {
    const b = a.splice(0, 2);
    s += b[0]!;
  }
  return s;
}

export function arrConcat(n: number): number {
  const a = mkNums(n);
  const b = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 100; r++) {
    const c = a.concat(b);
    s += c.length;
  }
  return s;
}

export function arrJoin(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    const j = a.join(",");
    s += j.length;
  }
  return s;
}

export function arrMap(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    const b = a.map((x: number) => x * 2 + 1);
    for (let i = 0; i < b.length; i++) s += b[i]!;
  }
  return s;
}

export function arrFilter(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    const b = a.filter((x: number) => (x & 1) === 0);
    s += b.length;
  }
  return s;
}

export function arrReduce(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    s += a.reduce((acc: number, x: number) => acc + x, 0);
  }
  return s;
}

export function arrForEach(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    a.forEach((x: number) => { s += x; });
  }
  return s;
}

export function arrFind(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const target = (i * 7919 + 13) % 100003;
    const v = a.find((x: number) => x === target);
    s += v!;
  }
  return s;
}

export function arrSome(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    if (a.some((x: number) => x === i)) s += 1;
  }
  return s;
}

export function arrEvery(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 200; r++) {
    if (a.every((x: number) => x >= 0)) s += 1;
  }
  return s;
}

export function arrReverse(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 200; r++) {
    a.reverse();
    s += a[0]!;
  }
  return s;
}

export function arrFill(n: number): number {
  const a = mkNums(n);
  let s: number = 0;
  for (let r = 0; r < 200; r++) {
    a.fill(r);
    s += a[0]!;
  }
  return s;
}

export function arrSort(n: number): number {
  let s: number = 0;
  for (let r = 0; r < 40; r++) {
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push((i * 7919 + r * 31) % 100003);
    a.sort((x: number, y: number) => x - y);
    s += a[0]! + a[n - 1]!;
  }
  return s;
}

// ---------- Numeric ----------
export function numIntLoop(n: number): number {
  let s: number = 0;
  for (let r = 0; r < 200; r++) {
    for (let i = 0; i < n; i++) s = (s + i * 3 + 1) % 1000000007;
  }
  return s;
}

export function numFloatMath(n: number): number {
  let s: number = 0;
  for (let r = 0; r < 100; r++) {
    for (let i = 0; i < n; i++) s += (i * 1.5 + 0.25) / 3.0 - 0.1;
  }
  return s;
}

export function numMathCalls(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    s += Math.sqrt(i + 1) + Math.sin(i) + Math.abs(i - n / 2) + Math.floor(i * 1.3);
  }
  return s;
}

export function numBitOps(n: number): number {
  let s: number = 0;
  for (let r = 0; r < 200; r++) {
    for (let i = 0; i < n; i++) s = (s ^ (i << 3) | (i >> 1)) & 0x7fffffff;
  }
  return s;
}

// ---------- Object / record ----------
export function objFieldRW(n: number): number {
  const o = { x: 0, y: 0, z: 0 };
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    o.x = i;
    o.y = o.x * 2;
    o.z = o.y + o.x;
    s += o.z;
  }
  return s;
}

export function objLiteral(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const o = { a: i, b: i * 2, c: i + 1 };
    s += o.a + o.b + o.c;
  }
  return s;
}

export function objSpread(n: number): number {
  let s: number = 0;
  const base = { a: 1, b: 2, c: 3 };
  for (let i = 0; i < n; i++) {
    const o = { ...base, a: i };
    s += o.a + o.b + o.c;
  }
  return s;
}

// ---------- Array flat ----------
export function arrFlat(n: number): number {
  const a: number[][] = [];
  for (let i = 0; i < n; i++) a.push([i, i + 1]);
  let s: number = 0;
  for (let r = 0; r < 50; r++) {
    const b = a.flat();
    s += b.length;
  }
  return s;
}

// ---------- String ----------
function mkStr(n: number): string {
  let s: string = "";
  for (let i = 0; i < n; i++) s += "abc" + (i % 10);
  return s;
}

export function strBuild(n: number): number {
  let s: string = "";
  for (let i = 0; i < n; i++) s += "x" + (i % 10);
  return s.length;
}

export function strIndexOf(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 200; r++) s += str.indexOf("abc" + (r % 10));
  return s;
}

export function strIncludes(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 200; r++) if (str.includes("abc" + (r % 10))) s += 1;
  return s;
}

export function strSlice(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 500; r++) s += str.slice(r, r + 100).length;
  return s;
}

export function strSubstring(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 500; r++) s += str.substring(r, r + 100).length;
  return s;
}

export function strSplit(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 50; r++) s += str.split("a").length;
  return s;
}

export function strJoin(n: number): number {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("item" + (i % 100));
  let s: number = 0;
  for (let r = 0; r < 50; r++) s += a.join("-").length;
  return s;
}

export function strUpper(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 200; r++) {
    const upper = (str + r).toUpperCase();
    s += upper.length + upper.charCodeAt(0) + upper.charCodeAt(upper.length - 1);
  }
  return s;
}

export function strTrim(n: number): number {
  const str = "   " + mkStr(n) + "   ";
  let s: number = 0;
  for (let r = 0; r < 500; r++) s += str.trim().length;
  return s;
}

export function strStartsWith(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 2000; r++) if (str.startsWith("abc")) s += 1;
  return s;
}

export function strEndsWith(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 2000; r++) if (str.endsWith("9")) s += 1;
  return s;
}

export function strRepeat(n: number): number {
  let s: number = 0;
  for (let r = 0; r < 500; r++) s += "ab".repeat(n).length;
  return s;
}

export function strCharCodeAt(n: number): number {
  const str = mkStr(n);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    for (let i = 0; i < str.length; i++) s += str.charCodeAt(i);
  }
  return s;
}

export function strCompare(n: number): number {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("key" + (i % 1000));
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    for (let i = 1; i < a.length; i++) if (a[i - 1]! < a[i]!) s += 1;
  }
  return s;
}

export function strTemplate(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const t = `row ${i} val ${i * 2} end`;
    s += t.length;
  }
  return s;
}

export function strNumToStr(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const t = (i * 7919).toString();
    s += t.length;
  }
  return s;
}

export function strStrToNum(n: number): number {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("" + (i * 7919));
  let s: number = 0;
  for (let i = 0; i < a.length; i++) s += Number(a[i]!);
  return s;
}

// ---------- Map / Set ----------
export function mapSet(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  return m.size;
}

export function mapGet(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  let s: number = 0;
  for (let i = 0; i < n; i++) s += m.get(i)!;
  return s;
}

export function mapHas(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  let s: number = 0;
  for (let i = 0; i < n; i++) if (m.has(i)) s += 1;
  return s;
}

export function mapDelete(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  let s: number = 0;
  for (let i = 0; i < n; i++) if (m.delete(i)) s += 1;
  return s;
}

export function mapIterate(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    for (const v of m.values()) s += v;
  }
  return s;
}

export function setAdd(n: number): number {
  const st = new Set<number>();
  for (let i = 0; i < n; i++) st.add(i % (n / 2 + 1));
  return st.size;
}

export function setHas(n: number): number {
  const st = new Set<number>();
  for (let i = 0; i < n; i++) st.add(i);
  let s: number = 0;
  for (let i = 0; i < n; i++) if (st.has(i)) s += 1;
  return s;
}

// ---------- JSON ----------
type Rec = { id: number; name: string; ok: boolean; vals: number[] };

export function jsonStringify(n: number): number {
  const arr: Rec[] = [];
  for (let i = 0; i < n; i++) arr.push({ id: i, name: "n" + i, ok: (i & 1) === 0, vals: [i, i + 1, i + 2] });
  let s: number = 0;
  for (let r = 0; r < 20; r++) s += JSON.stringify(arr).length;
  return s;
}

export function jsonParse(n: number): number {
  const arr: Rec[] = [];
  for (let i = 0; i < n; i++) arr.push({ id: i, name: "n" + i, ok: (i & 1) === 0, vals: [i, i + 1, i + 2] });
  const str = JSON.stringify(arr);
  let s: number = 0;
  for (let r = 0; r < 20; r++) {
    const p = JSON.parse(str) as Rec[];
    s += p.length;
  }
  return s;
}

// ---------- Allocation pressure ----------
export function allocObjects(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const o = { a: i, b: i + 1, c: i + 2, d: i + 3 };
    s += o.a + o.d;
  }
  return s;
}

export function allocArrays(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const a = [i, i + 1, i + 2, i + 3];
    s += a[0]! + a[3]!;
  }
  return s;
}

export function allocStrings(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i++) {
    const t = "s" + i + "_" + (i * 2);
    s += t.length;
  }
  return s;
}

type Quad = { a: number; b: number; c: number; d: number };

export function escapeObjects(n: number): number {
  const values: Quad[] = [];
  for (let i = 0; i < n; i++) values.push({ a: i, b: i + 1, c: i + 2, d: i + 3 });
  let s: number = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!.a + values[i]!.d;
  return s;
}

export function escapeArrays(n: number): number {
  const values: number[][] = [];
  for (let i = 0; i < n; i++) values.push([i, i + 1, i + 2, i + 3]);
  let s: number = 0;
  for (let i = 0; i < values.length; i++) s += values[i]![0]! + values[i]![3]!;
  return s;
}

export function escapeStrings(n: number): number {
  const values: string[] = [];
  for (let i = 0; i < n; i++) values.push("s" + i + "_" + (i * 2));
  let s: number = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!.length;
  return s;
}

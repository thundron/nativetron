// f32 lowering probe (inspect.mjs). Same source in V8 and wasm; each profile exports one kernel so its binary isolates it.
const a = new Float32Array(1024), b = new Float32Array(1024), c = new Float32Array(1024);
export function fill(n: number): number { for (let i = 0; i < n; i++) { a[i] = i * 0.37 - 100; b[i] = 1 / (i + 1); } return n; }
/** Float32Array operands, f64 expression, one rounding at the store. */
export function wide(n: number): number { let h = 0; for (let i = 0; i < n; i++) { c[i] = a[i]! * b[i]! + a[i]!; h = (Math.imul(h, 31) + Math.round(c[i]! * 4096)) | 0; } return h; }
/** The same expression rounded after every operation: equal to IEEE single-precision arithmetic on these operands. */
export function perOp(n: number): number { let h = 0; for (let i = 0; i < n; i++) { c[i] = Math.fround(Math.fround(a[i]! * b[i]!) + a[i]!); h = (Math.imul(h, 31) + Math.round(c[i]! * 4096)) | 0; } return h; }

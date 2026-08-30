// scriptc build --lib (wasm32-wasi) fails at wasm-ld: undefined symbol: scr_str_to_upper
export function run(n: number): number { const s = "abc"; return s.toUpperCase().length; }

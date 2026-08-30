// scriptc build --lib fails: SC2020 'number[][].flat' has no scriptc lowering yet
export function run(n: number): number { const a = [[1], [2]]; const b = a.flat(); return b.length; }

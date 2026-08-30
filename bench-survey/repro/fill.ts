// scriptc build --lib fails: SC2020 'number[].fill' has no scriptc lowering yet
export function run(n: number): number { const a = [1, 2, 3]; a.fill(9); return a[0]!; }

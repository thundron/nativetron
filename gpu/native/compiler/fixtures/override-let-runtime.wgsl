// `c` is a `let`, so `c + 1u`, `A[c + 1u]` and `10u / c` are runtime expressions (WGSL §8.1.2, §8.16) even though
// `c`'s initializer is the override O: with O = 1 the guarded access never runs, and with O = 0 the division yields
// 10 (integer division by zero yields the dividend), so neither may fail pipeline creation. Unpatched Naga
// evaluates them during override substitution and reports InvalidAccessIndex / DivisionByZero.
const A = array<u32, 2>(10u, 20u);
@id(0) override O: u32 = 0u;
@group(0) @binding(0) var<storage, read_write> out: array<u32, 4>;

@compute @workgroup_size(1)
fn main() {
  let c = O;
  out[0] = 99u;
  if c + 1u < 2u { out[0] = A[c + 1u]; }
  out[1] = A[min(c, 1u)];
  out[2] = c;
  out[3] = 10u / c;
}

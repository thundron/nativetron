// No `let`: `A[O + 1u]` is an override-expression, so with O = 1 pipeline creation must fail (WGSL §8.1.2), even
// though the access is guarded. The module itself is valid.
const A = array<u32, 2>(10u, 20u);
@id(0) override O: u32 = 0u;
@group(0) @binding(0) var<storage, read_write> out: array<u32, 4>;

@compute @workgroup_size(1)
fn main() {
  if O + 1u < 2u { out[0] = A[O + 1u]; }
}

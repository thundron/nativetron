// Valid WGSL; the pipeline must fail because 1024x2 invocations exceed maxComputeInvocationsPerWorkgroup.
@group(0) @binding(0) var<storage, read_write> data: array<u32>;

@compute @workgroup_size(1024, 2)
fn main(@builtin(local_invocation_index) i: u32) {
  data[i] = i;
}

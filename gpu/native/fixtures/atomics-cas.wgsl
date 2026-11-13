// Compare-exchange claim table: the construct WebKit (Safari 27.0.1) rejects.
@group(0) @binding(0) var<storage, read_write> table: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> claimed: atomic<u32>;

@compute @workgroup_size(64)
fn claim(@builtin(global_invocation_id) gid: vec3<u32>) {
  let slot = gid.x % arrayLength(&table);
  let r = atomicCompareExchangeWeak(&table[slot], 0u, gid.x + 1u);
  if (r.exchanged) { atomicAdd(&claimed, 1u); }
}

/* @compute fn commented_out() {} */
@compute @workgroup_size(1)
fn reset() {
  atomicStore(&claimed, 0u);
}

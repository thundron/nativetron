// Functions with a return type whose end is unreachable only by WGSL §9.7 behavior analysis: each body's behavior
// is {Return}, so the module is valid WGSL (Tint accepts it); unpatched Naga reports "Returning None where Some(..)
// is expected". The entry point checks the results on the GPU (corpus-runner exec ... main 32).
const EMPTY = 0u;
const FULL = 0xffffffffu;
var<workgroup> table: array<atomic<u32>, 16>;
@group(0) @binding(0) var<storage, read_write> out: array<u32, 32>;

// Open-addressing insert: the loop is left only through `return` (`continue` retries a spuriously failed exchange).
fn insert(key: u32) -> u32 {
  var i = 0u;
  loop {
    if i >= 16u { return FULL; }
    let slot = (key * 7u + i) & 15u;
    let r = atomicCompareExchangeWeak(&table[slot], EMPTY, key);
    if r.exchanged || r.old_value == key { return slot; }
    if r.old_value == EMPTY { continue; }
    i += 1u;
  }
}

// `for` without a condition; the `break` leaves the `switch`, not the loop.
fn find(key: u32) -> u32 {
  for (var i = 0u; ; i++) {
    switch i {
      case 16u: { return FULL; }
      default: { break; }
    }
    let slot = (key * 7u + i) & 15u;
    if atomicLoad(&table[slot]) == key { return slot; }
  }
}

// The unreachable ends are in nested tail positions.
fn classify(x: u32) -> u32 {
  if x == FULL {
    loop { return 1u; }
  } else {
    switch x & 1u {
      case 0u: { return 2u; }
      default: { loop { if x > 0u { return 3u; } } }
    }
  }
}

// Statically unreachable code after a return (WGSL §9.7.3).
fn after_return(x: u32) -> u32 {
  var a = x;
  return a + 1u;
  a = 7u;
}

@compute @workgroup_size(16)
fn main(@builtin(local_invocation_index) li: u32) {
  atomicStore(&table[li], EMPTY);
  workgroupBarrier();
  let key = li * 3u + 1u;
  let slot = insert(key);
  workgroupBarrier();
  out[li] = slot;
  out[16u + li] = select(0u, 1u, find(key) == slot) | (classify(slot) << 1u) | (after_return(li) << 4u);
}

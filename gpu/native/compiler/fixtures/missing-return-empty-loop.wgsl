// Invalid: `loop {}` has an empty behavior (WGSL §9.7.2), and it does not prove that `f` returns.
fn f() -> u32 {
  loop { }
}

@compute @workgroup_size(1)
fn main() { _ = f(); }

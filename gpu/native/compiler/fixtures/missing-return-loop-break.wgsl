// Invalid: the loop can be left through `break`, so the end of `f` is reachable.
fn f(n: u32) -> u32 {
  var i = 0u;
  loop {
    if i >= n { break; }
    if i == 7u { return i; }
    i += 1u;
  }
}

@compute @workgroup_size(1)
fn main() { _ = f(3u); }

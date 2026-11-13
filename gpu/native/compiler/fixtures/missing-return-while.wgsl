// Invalid: a `while` loop is left when its condition is false.
fn f(n: u32) -> u32 {
  var i = 0u;
  while i < n {
    if i == 7u { return i; }
    i += 1u;
  }
}

@compute @workgroup_size(1)
fn main() { _ = f(3u); }

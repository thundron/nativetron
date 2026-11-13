// Invalid: `break if` leaves the loop when the body falls through to the continuing block.
fn f(n: u32) -> u32 {
  var i = 0u;
  loop {
    if i == 7u { return i; }
    continuing {
      i += 1u;
      break if i >= n;
    }
  }
}

@compute @workgroup_size(1)
fn main() { _ = f(3u); }

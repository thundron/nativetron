struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> transform: mat4x4<f32>;

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VsOut {
  var out: VsOut;
  out.position = transform * vec4<f32>(position, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.uv, 0.0, 1.0);
}

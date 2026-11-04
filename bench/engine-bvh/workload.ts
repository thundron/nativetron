import { buildBinary, type BinTree } from "./algorithm.ts";
let triangles = new Float32Array(0);
let bounds = new Float32Array(0);
let centroids = new Float32Array(0);
let triangleCount = 0;
let tree: BinTree = { count: 0, bmin: new Float32Array(0), bmax: new Float32Array(0), left: new Int32Array(0), right: new Int32Array(0), start: new Uint32Array(0), size: new Uint32Array(0), order: new Uint32Array(0) };

export function prepare(count: number): number {
  triangleCount = count;
  triangles = new Float32Array(count * 9);
  bounds = new Float32Array(count * 6);
  centroids = new Float32Array(count * 3);
  let state = 0x12345678;
  for (let triangle = 0; triangle < count; triangle++) {
    const base = triangle * 9;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = (state & 65535) / 1024;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const y = (state & 65535) / 1024;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const z = (state & 65535) / 4096;
    triangles[base] = x; triangles[base + 1] = y; triangles[base + 2] = z;
    triangles[base + 3] = x + 0.125; triangles[base + 4] = y + 0.25; triangles[base + 5] = z + 0.0625;
    triangles[base + 6] = x + 0.25; triangles[base + 7] = y + 0.0625; triangles[base + 8] = z + 0.125;
    for (let axis = 0; axis < 3; axis++) {
      const min = Math.min(triangles[base + axis]!, triangles[base + 3 + axis]!, triangles[base + 6 + axis]!);
      const max = Math.max(triangles[base + axis]!, triangles[base + 3 + axis]!, triangles[base + 6 + axis]!);
      bounds[triangle * 6 + axis] = min; bounds[triangle * 6 + 3 + axis] = max;
      centroids[triangle * 3 + axis] = (min + max) * 0.5;
    }
  }
  return count;
}
export function build(): number {
  tree = buildBinary(bounds, centroids, triangleCount, 16);
  return tree.count;
}
export function refit(): number {
  for (let node = tree.count - 1; node >= 0; node--) {
    const left = tree.left[node]!, right = tree.right[node]!;
    if (left < 0) {
      const triangle = tree.order[tree.start[node]!]!;
      const base = triangle * 9;
      for (let axis = 0; axis < 3; axis++) {
        tree.bmin[node * 3 + axis] = Math.min(triangles[base + axis]!, triangles[base + 3 + axis]!, triangles[base + 6 + axis]!);
        tree.bmax[node * 3 + axis] = Math.max(triangles[base + axis]!, triangles[base + 3 + axis]!, triangles[base + 6 + axis]!);
      }
    } else {
      for (let axis = 0; axis < 3; axis++) {
        tree.bmin[node * 3 + axis] = Math.min(tree.bmin[left * 3 + axis]!, tree.bmin[right * 3 + axis]!);
        tree.bmax[node * 3 + axis] = Math.max(tree.bmax[left * 3 + axis]!, tree.bmax[right * 3 + axis]!);
      }
    }
  }
  return tree.count;
}
export function checksum(): number {
  let hash = 2166136261;
  for (let node = 0; node < tree.count; node++) {
    hash = Math.imul(hash ^ tree.left[node]!, 16777619) >>> 0;
    hash = Math.imul(hash ^ tree.right[node]!, 16777619) >>> 0;
    hash = Math.imul(hash ^ tree.start[node]!, 16777619) >>> 0;
    for (let axis = 0; axis < 3; axis++) {
      hash = Math.imul(hash ^ Math.round(tree.bmin[node * 3 + axis]! * 4096), 16777619) >>> 0;
      hash = Math.imul(hash ^ Math.round(tree.bmax[node * 3 + axis]! * 4096), 16777619) >>> 0;
    }
  }
  for (let triangle = 0; triangle < triangleCount; triangle++) hash = Math.imul(hash ^ tree.order[triangle]!, 16777619) >>> 0;
  return hash;
}
export function validate(): number {
  if (tree.count !== triangleCount * 2 - 1) return 0;
  let leaves = 0;
  const visited = new Uint8Array(triangleCount);
  for (let node = 0; node < tree.count; node++) {
    const left = tree.left[node]!, right = tree.right[node]!;
    if (left < 0) {
      if (tree.size[node] !== 1) return 0;
      const triangle = tree.order[tree.start[node]!]!;
      if (triangle >= triangleCount || visited[triangle]) return 0;
      visited[triangle] = 1;
      const base = triangle * 9;
      for (let axis = 0; axis < 3; axis++) {
        if (tree.bmin[node * 3 + axis] !== Math.min(triangles[base + axis]!, triangles[base + 3 + axis]!, triangles[base + 6 + axis]!)) return 0;
        if (tree.bmax[node * 3 + axis] !== Math.max(triangles[base + axis]!, triangles[base + 3 + axis]!, triangles[base + 6 + axis]!)) return 0;
      }
      leaves++;
    }
    else {
      if (left <= node || right <= node || left >= tree.count || right >= tree.count) return 0;
      for (let axis = 0; axis < 3; axis++) {
        if (tree.bmin[node * 3 + axis]! > tree.bmin[left * 3 + axis]! || tree.bmin[node * 3 + axis]! > tree.bmin[right * 3 + axis]!) return 0;
        if (tree.bmax[node * 3 + axis]! < tree.bmax[left * 3 + axis]! || tree.bmax[node * 3 + axis]! < tree.bmax[right * 3 + axis]!) return 0;
      }
    }
  }
  return leaves === triangleCount ? 1 : 0;
}
export function f32Probe(left: number, right: number): number {
  const values = new Float32Array(2);
  values[0] = left; values[1] = right;
  return Math.fround(values[0]! * values[1]! + values[0]!);
}

export function perturb(): number {
  triangles[0] = triangles[0]! + 0.015625;
  return 1;
}

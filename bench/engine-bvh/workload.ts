// Same source for the V8 lane (imported by run.mjs) and the scriptc wasm reactor (profile.json).
// Variant 0 is house-planner's original Float64 builder; variant 1 is the renderer-facing Float32/Uint32 substitution.
// bounds64/bounds32 copy buildWideBvh's triangle-bounds prologue and refit64/refit32 copy the binary loop of
// refitWideBvh (house-planner packages/render/src/rt/wbvh/builder.ts). CWBVH collapse/quantisation is not copied.
import { buildBinary as buildBinary64, type BinTree as BinTree64 } from "./algorithm-f64.ts";
import { buildBinary as buildBinary32, type BinTree as BinTree32 } from "./algorithm-f32.ts";

/** SceneBuffers triangle stride: [ax,ay,az, bx,by,bz, cx,cy,cz, matId, pad, pad]. */
const STRIDE = 12;
const BINS = 16;
export const DISTRIBUTIONS = 7;

interface Slot {
  count: number;
  base: Float32Array;
  tris: Float32Array;
  tb64: Float64Array; cent64: Float64Array;
  tb32: Float32Array; cent32: Float32Array;
  t64: BinTree64; t32: BinTree32;
  /** allocation probe: the same arrays buildBinary allocates */
  p64: BinTree64; p32: BinTree32; pBins64: Float64Array; pArea64: Float64Array; pBins32: Float32Array; pArea32: Float32Array;
  pCnt: Int32Array; pRCnt: Int32Array; pBinOf: Uint8Array; pStack: number[];
}

function empty64(): BinTree64 { return { count: 0, bmin: new Float64Array(0), bmax: new Float64Array(0), left: new Int32Array(0), right: new Int32Array(0), start: new Uint32Array(0), size: new Uint32Array(0), order: new Uint32Array(0) }; }
function empty32(): BinTree32 { return { count: 0, bmin: new Float32Array(0), bmax: new Float32Array(0), left: new Int32Array(0), right: new Int32Array(0), start: new Uint32Array(0), size: new Uint32Array(0), order: new Uint32Array(0) }; }
function emptySlot(): Slot {
  return { count: 0, base: new Float32Array(0), tris: new Float32Array(0), tb64: new Float64Array(0), cent64: new Float64Array(0), tb32: new Float32Array(0), cent32: new Float32Array(0), t64: empty64(), t32: empty32(), p64: empty64(), p32: empty32(), pBins64: new Float64Array(0), pArea64: new Float64Array(0), pBins32: new Float32Array(0), pArea32: new Float32Array(0), pCnt: new Int32Array(0), pRCnt: new Int32Array(0), pBinOf: new Uint8Array(0), pStack: [] };
}
const slots: Slot[] = [];
for (let d = 0; d < DISTRIBUTIONS; d++) slots.push(emptySlot());

// ---- deterministic generation (integer LCG, IEEE-exact arithmetic only; no transcendental functions) ----
let rng = 1;
function next(): number { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng; }
/** Uniform in [0, 1) with 24 bits. */
function unit(): number { return (next() >>> 8) / 16777216; }
function put(t: Float32Array, i: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, mat: number): void {
  const k = i * STRIDE;
  t[k] = ax; t[k + 1] = ay; t[k + 2] = az; t[k + 3] = bx; t[k + 4] = by; t[k + 5] = bz;
  t[k + 6] = cx; t[k + 7] = cy; t[k + 8] = cz; t[k + 9] = mat; t[k + 10] = 0; t[k + 11] = 0;
}
/** Twelve triangles of an axis-aligned box (fewer if the buffer ends); returns the next triangle index. */
function box(t: Float32Array, i: number, T: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): number {
  const xs = [x0, x1], ys = [y0, y1], zs = [z0, z1];
  for (let axis = 0; axis < 3; axis++) for (let side = 0; side < 2; side++) for (let half = 0; half < 2; half++) {
    if (i >= T) return i;
    const a = half === 0 ? 0 : 1, b = half === 0 ? 1 : 0;
    if (axis === 0) put(t, i, xs[side]!, ys[0]!, zs[0]!, xs[side]!, ys[1]!, zs[a]!, xs[side]!, ys[b]!, zs[1]!, mat);
    else if (axis === 1) put(t, i, xs[0]!, ys[side]!, zs[0]!, xs[1]!, ys[side]!, zs[a]!, xs[b]!, ys[side]!, zs[1]!, mat);
    else put(t, i, xs[0]!, ys[0]!, zs[side]!, xs[1]!, ys[a]!, zs[side]!, xs[b]!, ys[1]!, zs[side]!, mat);
    i++;
  }
  return i;
}
/** Room-scale boxes (furniture/fit-out) plus zero-thickness wall panels, metres; `offset` shifts the scene, `scale` shrinks parts. */
function architectural(t: Float32Array, T: number, offset: number, scale: number): void {
  let i = 0, part = 0;
  while (i < T) {
    const room = next() % 24, rx = (room % 6) * 5, rz = Math.floor(room / 6) * 4;
    if (part % 50 === 0) { // wall panel: exact zero extent on one axis
      const x = offset + rx + Math.floor(unit() * 5);
      i = box(t, i, T, x, 0, offset + rz, x, 3 * scale + 0.001, offset + rz + 4 * scale, part);
    } else {
      const u = unit(), v = unit(), w = unit();
      const sx = (0.02 + 1.98 * u * u * u) * scale, sy = (0.02 + 1.4 * v * v) * scale, sz = (0.02 + 1.98 * w * w * w) * scale;
      const x = offset + rx + unit() * (5 - sx), y = unit() * (3 - sy) * scale, z = offset + rz + unit() * (4 - sz);
      i = box(t, i, T, x, y, z, x + sx, y + sy, z + sz, part);
    }
    part++;
  }
}

/** Fills slot `d` with distribution `d`; generation is outside every timed window. Returns the triangle count. */
export function prepare(distribution: number, count: number): number {
  const d = distribution, T = count;
  const s = emptySlot();
  s.count = T; s.base = new Float32Array(T * STRIDE); s.tris = new Float32Array(T * STRIDE);
  const t = s.base;
  rng = (0x12345678 + Math.imul(d + 1, 0x9e3779b1)) >>> 0;
  if (d === 0) architectural(t, T, 0, 1);
  else if (d === 1) { // uniform soup of small, equally shaped triangles (the previous harness workload)
    for (let i = 0; i < T; i++) {
      const x = (next() & 65535) / 1024, y = (next() & 65535) / 1024, z = (next() & 65535) / 4096;
      put(t, i, x, y, z, x + 0.125, y + 0.25, z + 0.0625, x + 0.25, y + 0.0625, z + 0.125, 0);
    }
  } else if (d === 2) { // every bounding-box centroid coincides: forces the "split the range in half" fallback
    for (let i = 0; i < T; i++) {
      const h = (1 + (next() & 1023)) / 1024;
      put(t, i, 1 - h, 1 - h, 1 - h, 1 + h, 1 + h, 1, 1, 1, 1 + h, 0);
    }
  } else if (d === 3) { // 48 geometric clusters x≈2^-k: each SAH split peels off roughly one cluster (deep tree)
    for (let i = 0; i < T; i++) {
      let p = 1; const k = i % 48; for (let j = 0; j < k; j++) p *= 0.5;
      const x = p * (1 + unit() * 0.01), y = p * unit(), z = p * unit(), e = p * 0.001;
      put(t, i, x, y, z, x + e, y, z + e, x, y + e, z + e, k);
    }
  } else if (d === 4) { // long slivers across a 100 m scene: heavily overlapping boxes
    for (let i = 0; i < T; i++) {
      const x = unit() * 100, y = unit() * 100, z = unit() * 100;
      const dx = (unit() - 0.5) * 100, dy = (unit() - 0.5) * 100, dz = (unit() - 0.5) * 100;
      put(t, i, x, y, z, x + dx, y + dy, z + dz, x + dx + 0.001, y + dy, z + dz + 0.001, 0);
    }
  } else if (d === 5) architectural(t, T, 4096, 0.01); // mm-to-cm parts 4 km from the origin: Float32 quantisation
  else { // one plane, every triangle repeated 8 times consecutively: zero-extent axis and identical centroids
    let x = 0, y = 0;
    for (let i = 0; i < T; i++) {
      if (i % 8 === 0) { x = unit() * 10; y = unit() * 10; }
      put(t, i, x, y, 0, x + 0.05, y, 0, x, y + 0.05, 0, 0);
    }
  }
  s.tris.set(s.base);
  slots[d] = s;
  return T;
}

/** Restores the undeformed input (untimed). */
export function reset(distribution: number): number { const s = slots[distribution]!; s.tris.set(s.base); return s.count; }

/** Drops a variant's previous bounds/tree/allocation probe so their release is not inside the next timed window. */
export function release(distribution: number, variant: number): number {
  const s = slots[distribution]!;
  if (variant === 0) { s.t64 = empty64(); s.tb64 = new Float64Array(0); s.cent64 = new Float64Array(0); s.p64 = empty64(); s.pBins64 = new Float64Array(0); s.pArea64 = new Float64Array(0); }
  else { s.t32 = empty32(); s.tb32 = new Float32Array(0); s.cent32 = new Float32Array(0); s.p32 = empty32(); s.pBins32 = new Float32Array(0); s.pArea32 = new Float32Array(0); }
  s.pCnt = new Int32Array(0); s.pRCnt = new Int32Array(0); s.pBinOf = new Uint8Array(0); s.pStack = [];
  return 1;
}

/**
 * Allocation-only probe: exactly the typed arrays (and fills) buildBinary allocates for this size, kept alive until release().
 * It omits buildBinary's order initialisation loop and all build work. Not subtractable from build: allocator/GC state differs.
 */
export function allocate(distribution: number, variant: number): number {
  const s = slots[distribution]!, T = s.count, cap = Math.max(1, 2 * T - 1);
  if (variant === 0) {
    s.p64 = { count: 0, bmin: new Float64Array(cap * 3), bmax: new Float64Array(cap * 3), left: new Int32Array(cap).fill(-1), right: new Int32Array(cap).fill(-1), start: new Uint32Array(cap), size: new Uint32Array(cap), order: new Uint32Array(T) };
    s.pBins64 = new Float64Array(BINS * 6); s.pArea64 = new Float64Array(BINS);
  } else {
    s.p32 = { count: 0, bmin: new Float32Array(cap * 3), bmax: new Float32Array(cap * 3), left: new Int32Array(cap).fill(-1), right: new Int32Array(cap).fill(-1), start: new Uint32Array(cap), size: new Uint32Array(cap), order: new Uint32Array(T) };
    s.pBins32 = new Float32Array(BINS * 6); s.pArea32 = new Float32Array(BINS);
  }
  s.pCnt = new Int32Array(BINS); s.pRCnt = new Int32Array(BINS); s.pBinOf = new Uint8Array(T); s.pStack = [0, 0, T];
  return cap;
}

/** Triangle AABBs and centroids, as buildWideBvh computes them before buildBinary (allocation included). */
export function bounds(distribution: number, variant: number): number {
  const s = slots[distribution]!, src = s.tris, T = s.count, stride = STRIDE;
  if (variant === 0) {
    const tb = new Float64Array(T * 6), cent = new Float64Array(T * 3);
    for (let i = 0; i < T; i++) {
      const k = i * stride;
      for (let a = 0; a < 3; a++) {
        const v0 = src[k + a]!, v1 = src[k + 3 + a]!, v2 = src[k + 6 + a]!;
        const mn = Math.min(v0, v1, v2), mx = Math.max(v0, v1, v2);
        tb[i * 6 + a] = mn; tb[i * 6 + 3 + a] = mx; cent[i * 3 + a] = (mn + mx) * 0.5;
      }
    }
    s.tb64 = tb; s.cent64 = cent;
  } else {
    const tb = new Float32Array(T * 6), cent = new Float32Array(T * 3);
    for (let i = 0; i < T; i++) {
      const k = i * stride;
      for (let a = 0; a < 3; a++) {
        const v0 = src[k + a]!, v1 = src[k + 3 + a]!, v2 = src[k + 6 + a]!;
        const mn = Math.min(v0, v1, v2), mx = Math.max(v0, v1, v2);
        tb[i * 6 + a] = mn; tb[i * 6 + 3 + a] = mx; cent[i * 3 + a] = (mn + mx) * 0.5;
      }
    }
    s.tb32 = tb; s.cent32 = cent;
  }
  return T;
}

/** buildBinary only (its own allocations included); bounds() must have run. Returns the node count. */
export function build(distribution: number, variant: number): number {
  const s = slots[distribution]!;
  if (variant === 0) { s.t64 = buildBinary64(s.tb64, s.cent64, s.count, BINS); return s.t64.count; }
  s.t32 = buildBinary32(s.tb32, s.cent32, s.count, BINS); return s.t32.count;
}

function mix(h: number, v: number): number { return Math.imul((h ^ v) >>> 0, 16777619) >>> 0; }

/** Deterministic changed geometry for frame `frame`, written from the undeformed base. Returns triangles whose stored coordinates changed. */
export function deform(distribution: number, frame: number): number {
  const s = slots[distribution]!, T = s.count, base = s.base, tris = s.tris;
  let changed = 0;
  for (let i = 0; i < T; i++) {
    const k = i * STRIDE;
    let ext = 0, centre = 0;
    for (let a = 0; a < 3; a++) {
      const v0 = base[k + a]!, v1 = base[k + 3 + a]!, v2 = base[k + 6 + a]!;
      const e = Math.max(v0, v1, v2) - Math.min(v0, v1, v2); if (e > ext) ext = e;
      const c = Math.abs(v0); if (c > centre) centre = c;
    }
    let amplitude = ext * 0.25 + centre * 0.00000762939453125; // quarter extent + |v|·2^-17 (survives Float32 storage)
    if (amplitude === 0) amplitude = 0.0000152587890625;
    let h = mix(mix(2166136261, i), frame + 1);
    let moved = 0;
    for (let a = 0; a < 3; a++) {
      h = mix(h, a + 7);
      const delta = (((h >>> 8) & 255) - 127.5) / 127.5 * amplitude;
      for (let v = 0; v < 3; v++) {
        const o = k + v * 3 + a;
        tris[o] = base[o]! + delta;
        if (tris[o] !== base[o]) moved = 1;
      }
    }
    changed += moved;
  }
  return changed;
}

/** Binary-tree refit from refitWideBvh (bottom-up, children follow parents). No allocation. */
export function refit(distribution: number, variant: number): number {
  const s = slots[distribution]!, tris = s.tris, stride = STRIDE;
  if (variant === 0) {
    const bt = s.t64, N = bt.count;
    for (let n = N - 1; n >= 0; n--) {
      const L = bt.left[n]!, R = bt.right[n]!;
      if (L < 0) { // one triangle per binary leaf
        const t = bt.order[bt.start[n]!]!, k = t * stride;
        for (let a = 0; a < 3; a++) {
          const v0 = tris[k + a]!, v1 = tris[k + 3 + a]!, v2 = tris[k + 6 + a]!;
          bt.bmin[n * 3 + a] = Math.min(v0, v1, v2); bt.bmax[n * 3 + a] = Math.max(v0, v1, v2);
        }
        continue;
      }
      for (let a = 0; a < 3; a++) { bt.bmin[n * 3 + a] = Math.min(bt.bmin[L * 3 + a]!, bt.bmin[R * 3 + a]!); bt.bmax[n * 3 + a] = Math.max(bt.bmax[L * 3 + a]!, bt.bmax[R * 3 + a]!); }
    }
    return N;
  }
  const bt = s.t32, N = bt.count;
  for (let n = N - 1; n >= 0; n--) {
    const L = bt.left[n]!, R = bt.right[n]!;
    if (L < 0) {
      const t = bt.order[bt.start[n]!]!, k = t * stride;
      for (let a = 0; a < 3; a++) {
        const v0 = tris[k + a]!, v1 = tris[k + 3 + a]!, v2 = tris[k + 6 + a]!;
        bt.bmin[n * 3 + a] = Math.min(v0, v1, v2); bt.bmax[n * 3 + a] = Math.max(v0, v1, v2);
      }
      continue;
    }
    for (let a = 0; a < 3; a++) { bt.bmin[n * 3 + a] = Math.min(bt.bmin[L * 3 + a]!, bt.bmin[R * 3 + a]!); bt.bmax[n * 3 + a] = Math.max(bt.bmax[L * 3 + a]!, bt.bmax[R * 3 + a]!); }
  }
  return N;
}

// ---- exact hashes (IEEE-754 bit patterns, not rounded values) ----
const scratch = new Float64Array(1);
const words = new Uint32Array(scratch.buffer);
function mixBits(h: number, x: number): number { scratch[0] = x; return mix(mix(h, words[0]!), words[1]!); }

/** Topology: count, children, ranges and primitive order. */
export function topologyHash(distribution: number, variant: number): number {
  const s = slots[distribution]!;
  let h = mix(2166136261, variant === 0 ? s.t64.count : s.t32.count);
  const N = variant === 0 ? s.t64.count : s.t32.count;
  const left = variant === 0 ? s.t64.left : s.t32.left, right = variant === 0 ? s.t64.right : s.t32.right;
  const start = variant === 0 ? s.t64.start : s.t32.start, size = variant === 0 ? s.t64.size : s.t32.size, order = variant === 0 ? s.t64.order : s.t32.order;
  for (let n = 0; n < N; n++) { h = mix(h, left[n]! >>> 0); h = mix(h, right[n]! >>> 0); h = mix(h, start[n]!); h = mix(h, size[n]!); }
  for (let i = 0; i < s.count; i++) h = mix(h, order[i]!);
  return h;
}
/** Every node box bit pattern. */
export function boundsHash(distribution: number, variant: number): number {
  const s = slots[distribution]!;
  let h = 2166136261;
  if (variant === 0) { const b = s.t64, n6 = b.count * 3; for (let i = 0; i < n6; i++) { h = mixBits(h, b.bmin[i]!); h = mixBits(h, b.bmax[i]!); } }
  else { const b = s.t32, n6 = b.count * 3; for (let i = 0; i < n6; i++) { h = mixBits(h, b.bmin[i]!); h = mixBits(h, b.bmax[i]!); } }
  return h;
}
/** Current triangles plus the bounds phase output of `variant`. */
export function inputHash(distribution: number, variant: number): number {
  const s = slots[distribution]!;
  let h = 2166136261;
  for (let i = 0; i < s.tris.length; i++) h = mixBits(h, s.tris[i]!);
  if (variant === 0) { for (let i = 0; i < s.tb64.length; i++) h = mixBits(h, s.tb64[i]!); for (let i = 0; i < s.cent64.length; i++) h = mixBits(h, s.cent64[i]!); }
  else { for (let i = 0; i < s.tb32.length; i++) h = mixBits(h, s.tb32[i]!); for (let i = 0; i < s.cent32.length; i++) h = mixBits(h, s.cent32[i]!); }
  return h;
}

/**
 * In-module structural validation against the current triangles. Returns 1, or a negative code naming the first failure:
 * -1 node count, -2 root range, -3 child index/order, -4 parent multiplicity, -5 range partition, -6 leaf shape,
 * -7 order not a permutation, -8 leaf bounds not exact, -9 internal bounds not the exact child union, -10 leaf count.
 */
export function validate(distribution: number, variant: number): number {
  const s = slots[distribution]!, T = s.count, tris = s.tris;
  const N = variant === 0 ? s.t64.count : s.t32.count;
  const left = variant === 0 ? s.t64.left : s.t32.left, right = variant === 0 ? s.t64.right : s.t32.right;
  const start = variant === 0 ? s.t64.start : s.t32.start, size = variant === 0 ? s.t64.size : s.t32.size, order = variant === 0 ? s.t64.order : s.t32.order;
  if (N !== 2 * T - 1 || left.length < N || order.length !== T) return -1;
  if (start[0] !== 0 || size[0] !== T) return -2;
  const parents = new Uint8Array(N), seen = new Uint8Array(T);
  let leaves = 0;
  for (let n = 0; n < N; n++) {
    const L = left[n]!, R = right[n]!;
    let lo = 0, hi = 0;
    if (L < 0) {
      if (R >= 0 || size[n] !== 1) return -6;
      const t = order[start[n]!]!;
      if (t >= T || seen[t]) return -7;
      seen[t] = 1; leaves++;
      const k = t * STRIDE;
      for (let a = 0; a < 3; a++) {
        const v0 = tris[k + a]!, v1 = tris[k + 3 + a]!, v2 = tris[k + 6 + a]!;
        lo = variant === 0 ? s.t64.bmin[n * 3 + a]! : s.t32.bmin[n * 3 + a]!;
        hi = variant === 0 ? s.t64.bmax[n * 3 + a]! : s.t32.bmax[n * 3 + a]!;
        if (lo !== Math.min(v0, v1, v2) || hi !== Math.max(v0, v1, v2)) return -8;
      }
      continue;
    }
    if (L <= n || R <= n || L >= N || R >= N || L === R) return -3;
    parents[L]++; parents[R]++;
    if (parents[L]! > 1 || parents[R]! > 1) return -4;
    if (start[L] !== start[n] || size[L]! < 1 || size[R]! < 1 || start[R] !== start[n]! + size[L]! || size[L]! + size[R]! !== size[n]) return -5;
    for (let a = 0; a < 3; a++) {
      const i = n * 3 + a, l = L * 3 + a, r = R * 3 + a;
      if (variant === 0) {
        if (s.t64.bmin[i] !== Math.min(s.t64.bmin[l]!, s.t64.bmin[r]!) || s.t64.bmax[i] !== Math.max(s.t64.bmax[l]!, s.t64.bmax[r]!)) return -9;
      } else if (s.t32.bmin[i] !== Math.min(s.t32.bmin[l]!, s.t32.bmin[r]!) || s.t32.bmax[i] !== Math.max(s.t32.bmax[l]!, s.t32.bmax[r]!)) return -9;
    }
  }
  for (let n = 1; n < N; n++) if (parents[n] !== 1) return -4;
  if (parents[0] !== 0) return -4;
  return leaves === T ? 1 : -10;
}

/** Float32Array storage widens to f64 arithmetic; Math.fround rounds the result (inspected in the emitted LLVM). */
export function f32Probe(left: number, right: number): number {
  const values = new Float32Array(2);
  values[0] = left; values[1] = right;
  return Math.fround(values[0]! * values[1]! + values[0]!);
}

// ---- V8-lane-only accessors for run.mjs's independent validator (not in profile.json) ----
export function tree64Of(distribution: number): BinTree64 { return slots[distribution]!.t64; }
export function tree32Of(distribution: number): BinTree32 { return slots[distribution]!.t32; }
export function trianglesOf(distribution: number): Float32Array { return slots[distribution]!.tris; }
export const TRIANGLE_STRIDE = STRIDE;

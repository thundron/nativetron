// Adapted from house-planner/packages/render/src/gi/binned.ts; identical source runs under V8 and scriptc.
// Float32 bounds/centroids/bin bounds exercise the renderer-facing typed-array lane.
/**
 * Binned-SAH binary BVH over triangle bounds (one primitive per leaf), shared by the probe/path-tracer BVH
 * (gi/bvh.ts) and the compressed wide BVH (rt/wbvh). Typed arrays only; children always follow their parent in node
 * numbering, so bottom-up passes (refit) iterate nodes in reverse.
 */
export interface BinTree { count: number; bmin: Float32Array; bmax: Float32Array; left: Int32Array; right: Int32Array; start: Uint32Array; size: Uint32Array; order: Uint32Array }

/** Binned-SAH binary BVH with one primitive per leaf. Nodes are numbered so that children always follow their parent. */
export function buildBinary(tb: Float32Array, cent: Float32Array, T: number, BINS: number): BinTree {
  const cap = Math.max(1, 2 * T - 1);
  const bmin = new Float32Array(cap * 3), bmax = new Float32Array(cap * 3);
  const left = new Int32Array(cap).fill(-1), right = new Int32Array(cap).fill(-1);
  const start = new Uint32Array(cap), size = new Uint32Array(cap);
  const order = new Uint32Array(T); for (let i = 0; i < T; i++) order[i] = i;
  const binCnt = new Int32Array(BINS), binB = new Float32Array(BINS * 6), rArea = new Float32Array(BINS), rCnt = new Int32Array(BINS);
  const binOf = new Uint8Array(T);
  let count = 1;
  const stack: number[] = [0, 0, T];
  while (stack.length) {
    const hi = stack.pop()!, lo = stack.pop()!, n = stack.pop()!;
    start[n] = lo; size[n] = hi - lo;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let cmnx = Infinity, cmny = Infinity, cmnz = Infinity, cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = order[i]!, k = t * 6, c = t * 3;
      if (tb[k]! < mnx) mnx = tb[k]!; if (tb[k + 1]! < mny) mny = tb[k + 1]!; if (tb[k + 2]! < mnz) mnz = tb[k + 2]!;
      if (tb[k + 3]! > mxx) mxx = tb[k + 3]!; if (tb[k + 4]! > mxy) mxy = tb[k + 4]!; if (tb[k + 5]! > mxz) mxz = tb[k + 5]!;
      if (cent[c]! < cmnx) cmnx = cent[c]!; if (cent[c + 1]! < cmny) cmny = cent[c + 1]!; if (cent[c + 2]! < cmnz) cmnz = cent[c + 2]!;
      if (cent[c]! > cmxx) cmxx = cent[c]!; if (cent[c + 1]! > cmxy) cmxy = cent[c + 1]!; if (cent[c + 2]! > cmxz) cmxz = cent[c + 2]!;
    }
    bmin[n * 3] = mnx; bmin[n * 3 + 1] = mny; bmin[n * 3 + 2] = mnz; bmax[n * 3] = mxx; bmax[n * 3 + 1] = mxy; bmax[n * 3 + 2] = mxz;
    const N = hi - lo;
    if (N <= 1) continue;
    const cmn = [cmnx, cmny, cmnz], cmx = [cmxx, cmxy, cmxz];
    let bestCost = Infinity, bestAxis = -1, bestSplit = -1;
    for (let a = 0; a < 3; a++) {
      const ext = cmx[a]! - cmn[a]!;
      if (!(ext > 0)) continue;
      const scale = (BINS * (1 - 1e-9)) / ext;
      binCnt.fill(0);
      for (let b = 0; b < BINS; b++) { binB[b * 6] = binB[b * 6 + 1] = binB[b * 6 + 2] = Infinity; binB[b * 6 + 3] = binB[b * 6 + 4] = binB[b * 6 + 5] = -Infinity; }
      for (let i = lo; i < hi; i++) {
        const t = order[i]!, k = t * 6;
        const b = Math.min(BINS - 1, Math.floor((cent[t * 3 + a]! - cmn[a]!) * scale));
        binCnt[b]!++;
        const o = b * 6;
        for (let j = 0; j < 3; j++) { if (tb[k + j]! < binB[o + j]!) binB[o + j] = tb[k + j]!; if (tb[k + 3 + j]! > binB[o + 3 + j]!) binB[o + 3 + j] = tb[k + 3 + j]!; }
      }
      // sweep right → left
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, cnt = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const o = b * 6;
        if (binCnt[b]! > 0) { x0 = Math.min(x0, binB[o]!); y0 = Math.min(y0, binB[o + 1]!); z0 = Math.min(z0, binB[o + 2]!); x1 = Math.max(x1, binB[o + 3]!); y1 = Math.max(y1, binB[o + 4]!); z1 = Math.max(z1, binB[o + 5]!); }
        cnt += binCnt[b]!; rCnt[b] = cnt; rArea[b] = cnt ? halfArea(x1 - x0, y1 - y0, z1 - z0) : 0;
      }
      x0 = y0 = z0 = Infinity; x1 = y1 = z1 = -Infinity; cnt = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const o = b * 6;
        if (binCnt[b]! > 0) { x0 = Math.min(x0, binB[o]!); y0 = Math.min(y0, binB[o + 1]!); z0 = Math.min(z0, binB[o + 2]!); x1 = Math.max(x1, binB[o + 3]!); y1 = Math.max(y1, binB[o + 4]!); z1 = Math.max(z1, binB[o + 5]!); }
        cnt += binCnt[b]!;
        const rc = rCnt[b + 1]!;
        if (cnt === 0 || rc === 0) continue;
        const cost = halfArea(x1 - x0, y1 - y0, z1 - z0) * cnt + rArea[b + 1]! * rc;
        if (cost < bestCost) { bestCost = cost; bestAxis = a; bestSplit = b; }
      }
    }
    let mid: number;
    if (bestAxis < 0) mid = lo + (N >> 1); // all centroids coincide: split the range in half
    else {
      const a = bestAxis, scale = (BINS * (1 - 1e-9)) / (cmx[a]! - cmn[a]!);
      for (let i = lo; i < hi; i++) { const t = order[i]!; binOf[i] = Math.min(BINS - 1, Math.floor((cent[t * 3 + a]! - cmn[a]!) * scale)); }
      let i = lo, j = hi - 1;
      while (i <= j) {
        if (binOf[i]! <= bestSplit) i++;
        else { const t = order[i]!; order[i] = order[j]!; order[j] = t; const b = binOf[i]!; binOf[i] = binOf[j]!; binOf[j] = b; j--; }
      }
      mid = i;
      if (mid === lo || mid === hi) mid = lo + (N >> 1);
    }
    const l = count++, r = count++;
    left[n] = l; right[n] = r;
    stack.push(r, mid, hi, l, lo, mid);
  }
  return { count, bmin, bmax, left, right, start, size, order };
}


function halfArea(x: number, y: number, z: number): number { return x * y + y * z + z * x; }

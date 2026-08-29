export function installBench({ setup, click, readCount, extra }) {
  window.__bench = async (n) => {
    await setup();
    for (let i = 0; i < 200; i++) click();
    await new Promise((r) => setTimeout(r, 100));
    if (window.gc) window.gc();
    const heapBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) click();
    const t1 = performance.now();
    await new Promise((r) => setTimeout(r, 100));
    const heapAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;
    return {
      n,
      totalMs: +(t1 - t0).toFixed(2),
      perClickUs: +(((t1 - t0) * 1000) / n).toFixed(2),
      finalCount: readCount(),
      jsHeapMB: +(heapAfter / 1048576).toFixed(2),
      jsHeapDeltaMB: +((heapAfter - heapBefore) / 1048576).toFixed(2),
      ...(extra ? extra() : {}),
    };
  };
  window.__benchReady = true;
}

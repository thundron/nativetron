export function installBench({ setup, click, readCount, extra }) {
  window.__setup = async () => { await setup(); for (let i = 0; i < 500; i++) click(); return true; };
  window.__trial = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) click();
    const t1 = performance.now();
    return +(((t1 - t0) * 1000) / n).toFixed(3);
  };
  window.__stats = () => ({
    finalCount: readCount(),
    jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : 0,
    ...(extra ? extra() : {}),
  });
  window.__benchReady = true;
}

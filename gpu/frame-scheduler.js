// Throughput schedules work, not physical presentation. MessageChannel yields
// to the event loop without binding engine progress to display refresh.
export function createFrameScheduler(mode = "display", scope = globalThis, hooks = {}) {
  if (mode !== "display" && mode !== "throughput") throw new Error("invalid frame mode");
  const request = hooks.requestAnimationFrame ?? scope.requestAnimationFrame?.bind(scope);
  const cancel = hooks.cancelAnimationFrame ?? scope.cancelAnimationFrame?.bind(scope);
  if (mode === "display") return {
    request(fn) { if (!request) throw new Error("requestAnimationFrame unavailable"); return request(fn); },
    cancel(id) { cancel?.(id); }, dispose() {},
  };
  const Channel = scope.MessageChannel ?? globalThis.MessageChannel;
  if (!Channel) throw new Error("throughput scheduling requires MessageChannel");
  const channel = new Channel(), pending = new Map();
  let next = 1, closed = false;
  channel.port1.onmessage = ({ data }) => {
    const fn = pending.get(data); pending.delete(data);
    if (!closed) fn?.((scope.performance ?? globalThis.performance).now());
  };
  return {
    request(fn) { if (closed) throw new Error("scheduler disposed"); const id = next++; pending.set(id, fn); channel.port2.postMessage(id); return id; },
    cancel(id) { pending.delete(id); },
    dispose() { closed = true; pending.clear(); channel.port1.close(); channel.port2.close(); },
  };
}

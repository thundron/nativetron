import { decodeEngineMessage, ENGINE_STATE, ENGINE_BULK } from "../ipc/engine.generated.mjs";

// Separate from reliable control: state is replaceable; bulk has two bounded,
// acknowledged leases. A slow receiver cannot accumulate worker postMessages.
export function createStreams({ deliver, onError = () => {}, timeoutMs = 30000, maxTopics = 32, maxBulk = 2 }) {
  const states = new Map(), bulk = [], cancellations = new Set();
  let closed = false, scheduled = false, stateBusy = 0, bulkBusy = 0, replaced = 0;
  const schedule = () => { if (!closed && !scheduled) { scheduled = true; queueMicrotask(flush); } };
  const dispatch = (bytes, isState) => {
    if (isState) stateBusy++; else bulkBusy++;
    let timer, cancel;
    const timeout = new Promise((_, reject) => {
      cancel = () => reject(new Error("engine stream closed"));
      cancellations.add(cancel);
      timer = setTimeout(() => reject(new Error("engine stream acknowledgement timed out")), timeoutMs);
    });
    Promise.race([Promise.resolve().then(() => closed ? undefined : deliver(bytes)), timeout])
      .catch(error => { if (!closed) { try { onError(error); } catch {} } })
      .finally(() => { clearTimeout(timer); cancellations.delete(cancel); if (isState) stateBusy--; else bulkBusy--; schedule(); });
  };
  function flush() {
    scheduled = false;
    if (closed) return;
    if (!stateBusy && states.size) {
      const [key, bytes] = states.entries().next().value;
      states.delete(key); dispatch(bytes, true);
    }
    while (bulkBusy < maxBulk && bulk.length) dispatch(bulk.shift(), false);
  }
  return {
    offer(bytes) {
      if (closed) return false;
      const message = bytes instanceof Uint8Array ? decodeEngineMessage(bytes) : null;
      if (!message) return false;
      if (message.kind === ENGINE_STATE) {
        const key = `${message.source}:${message.target}:${message.topic}`;
        if (!states.has(key) && states.size >= maxTopics) return false;
        if (states.has(key)) replaced++;
        states.set(key, new Uint8Array(bytes));
      } else if (message.kind === ENGINE_BULK) {
        if (bulkBusy + bulk.length >= maxBulk) return false;
        bulk.push(new Uint8Array(bytes));
      } else return false;
      schedule(); return true;
    },
    get stats() { return { statePending: states.size, stateInFlight: stateBusy, bulkPending: bulk.length, bulkInFlight: bulkBusy, replaced }; },
    close() { closed = true; states.clear(); bulk.length = 0; for (const cancel of cancellations) cancel(); cancellations.clear(); },
  };
}

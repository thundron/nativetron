import { loadConformance } from "./conformance-host.js";

// Dedicated-worker lane: the same reactor and host drive a device from an OffscreenCanvas worker.
const conformance = await loadConformance({
  canvas: new OffscreenCanvas(4, 4),
  report: (line) => self.postMessage({ type: "report", line }),
  observe: (event) => self.postMessage({ type: "event", event }),
});
self.onmessage = ({ data }) => {
  if (data.type === "step") conformance.step(data.phase);
  else if (data.type === "lose") { conformance.step(data.phase); conformance.host.device.destroy(); }
};
self.postMessage({ type: "ready" });

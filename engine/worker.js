import { loadReactor } from "./reactor.js";
let reactor;
const text = (error) => error instanceof Error ? error.message : String(error);
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "probe") {
      let device;
      try {
        if (!self.navigator.gpu || !self.OffscreenCanvas || !self.requestAnimationFrame) throw new Error("worker WebGPU, OffscreenCanvas or rAF absent");
        const adapter = await self.navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("worker adapter unavailable");
        device = await adapter.requestDevice();
        const context = new OffscreenCanvas(1, 1).getContext("webgpu");
        if (!context) throw new Error("worker WebGPU context unavailable");
        context.configure({ device, format: self.navigator.gpu.getPreferredCanvasFormat() });
        context.getCurrentTexture(); context.unconfigure();
        self.postMessage({ type: "probe", available: true });
      } catch (error) { self.postMessage({ type: "probe", available: false, reason: text(error) }); }
      finally { device?.destroy(); }
    } else if (data.type === "start") {
      reactor = await loadReactor({ ...data.options, canvas: data.canvas,
        report: (message) => self.postMessage({ type: "report", message }),
        post: (bytes) => self.postMessage({ type: "message", bytes }, [bytes.buffer]),
        onEvent: (event) => self.postMessage({ type: "gpu-event", event }),
      });
      self.postMessage({ type: "ready" });
    } else if (data.type === "message") reactor.receive(data.bytes);
    else if (data.type === "resize") reactor?.resize(data.width, data.height, data.dpr);
    else if (data.type === "stop") { reactor?.dispose(); self.close(); }
  } catch (error) { self.postMessage({ type: "error", message: text(error) }); }
};

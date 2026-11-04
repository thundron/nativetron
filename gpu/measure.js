import { decodeGpuBatch, writeGpuProtocolHeader, GPU_FIXED_LAYOUTS, GPU_PROTOCOL_HEADER_BYTES } from "./gpu-host.generated.js";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export async function measureGpu(demo) {
  const device = demo.host.device;
  const host = demo.host;
  const count = 500, trials = 101, warmups = 20;
  const layout = GPU_FIXED_LAYOUTS.renderSetScissor;
  const bytes = new Uint8Array(GPU_PROTOCOL_HEADER_BYTES + count * layout.bytes);
  const view = new DataView(bytes.buffer);
  const handle = 1948578;
  writeGpuProtocolHeader(bytes);
  for (let i = 0; i < count; i++) {
    const offset = GPU_PROTOCOL_HEADER_BYTES + i * layout.bytes;
    bytes[offset] = layout.code;
    view.setUint32(offset + layout.fields.pass, handle, true);
    view.setUint32(offset + layout.fields.x, 0, true); view.setUint32(offset + layout.fields.y, 0, true);
    view.setUint32(offset + layout.fields.width, 32, true); view.setUint32(offset + layout.fields.height, 32, true);
  }
  const texture = device.createTexture({ size: [32, 32], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const textureView = texture.createView();
  const entry = host.handles.reserve(handle, "renderPass", {});
  const samples = { decode: [], direct: [], upload: [], plainUpload: [] };
  const decode = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: textureView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    entry.value = pass;
    const start = performance.now();
    if (!decodeGpuBatch(host, bytes)) throw new Error("benchmark batch failed");
    const elapsed = performance.now() - start;
    pass.end(); encoder.finish();
    return elapsed;
  };
  const direct = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: textureView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    const start = performance.now();
    for (let i = 0; i < count; i++) pass.setScissorRect(0, 0, 32, 32);
    const elapsed = performance.now() - start;
    pass.end(); encoder.finish();
    return elapsed;
  };
  // Read the existing guest upload arena from the successful writeBuffer batch by
  // reserving a new one through a guest export; memory bytes stay in the reactor.
  demo.api.ntgpu_prepare_upload();
  const source = demo.uploadSource;
  if (!source) throw new Error("guest did not publish upload staging range");
  const buffer = device.createBuffer({ size: 16777216, usage: GPUBufferUsage.COPY_DST });
  host.handles.reserve(1948579, "buffer", buffer);
  const copy = () => {
    const start = performance.now();
    host.writeBuffer(1948579, 0, { offset: 0, length: 16777216 });
    return performance.now() - start;
  };
  const plain = () => {
    const start = performance.now();
    device.queue.writeBuffer(buffer, 0, demo.api.__memory(), source.offset, 16777216);
    return performance.now() - start;
  };
  try {
    for (let i = -warmups; i < trials; i++) {
      const paired = i & 1 ? [direct(), decode()] : [decode(), direct()];
      const uploads = i & 1 ? [plain(), copy()] : [copy(), plain()];
      if (i >= 0) {
        samples.decode.push(paired[i & 1 ? 1 : 0]); samples.direct.push(paired[i & 1 ? 0 : 1]);
        samples.upload.push(uploads[i & 1 ? 1 : 0]); samples.plainUpload.push(uploads[i & 1 ? 0 : 1]);
      }
      await device.queue.onSubmittedWorkDone();
    }
    return {
      trials, warmups, pairedInterleaved: true, opsPerBatch: count,
      decode500Ms: median(samples.decode), direct500Ms: median(samples.direct),
      opsPerMs: count / median(samples.decode),
      upload16MiBMs: median(samples.upload), directUpload16MiBMs: median(samples.plainUpload),
      memoryGrew: demo.api.__memory().byteLength > demo.initialMemoryBytes,
    };
  } finally {
    buffer.destroy(); texture.destroy();
    host.handles.retire(handle); host.handles.retire(1948579);
  }
}

import { decodeGpuBatch, writeGpuProtocolHeader, GPU_FIXED_LAYOUTS, GPU_PROTOCOL_HEADER_BYTES, GPU_PROTOCOL_VERSION, GPU_PROTOCOL_IDENTITY } from "./gpu-host.generated.js";

export function sampleStats(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("invalid timing samples");
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.floor((sorted.length - 1) * q)];
  return { median: at(0.5), p10: at(0.1), p90: at(0.9), min: sorted[0], max: sorted.at(-1) };
}

export async function measureGpu(demo) {
  const device = demo.host.device, host = demo.host;
  const count = 500, repeats = 8, trials = 101, warmups = 20, uploadBytes = 16777216;
  const layout = GPU_FIXED_LAYOUTS.renderSetScissor, handle = 1948578, bufferHandle = 1948579;
  const bytes = new Uint8Array(GPU_PROTOCOL_HEADER_BYTES + count * layout.bytes), view = new DataView(bytes.buffer);
  writeGpuProtocolHeader(bytes);
  for (let i = 0; i < count; i++) {
    const offset = GPU_PROTOCOL_HEADER_BYTES + i * layout.bytes;
    bytes[offset] = layout.code;
    view.setUint32(offset + layout.fields.pass, handle, true);
    view.setUint32(offset + layout.fields.x, 0, true); view.setUint32(offset + layout.fields.y, 0, true);
    view.setUint32(offset + layout.fields.width, 32, true); view.setUint32(offset + layout.fields.height, 32, true);
  }
  let checkedBatches = 0;
  const validateEncoding = batch => {
    let operations = 0;
    if (!decodeGpuBatch({ renderSetScissor(pass, x, y, width, height) {
      if (pass !== handle || x !== 0 || y !== 0 || width !== 32 || height !== 32) throw new Error("guest encoded wrong benchmark operands");
      operations++;
    } }, batch) || operations !== count) throw new Error("guest encoded wrong benchmark operation count");
    checkedBatches++;
  };
  demo.setBenchmarkObserver(validateEncoding); demo.api.ntgpu_encode_benchmark(count); demo.setBenchmarkObserver(() => {});
  const texture = device.createTexture({ size: [32, 32], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const textureView = texture.createView(), entry = host.handles.reserve(handle, "renderPass", {});
  const attachment = { view: textureView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] };
  const recordPass = transport => {
    const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [attachment] });
    entry.value = pass;
    const start = performance.now();
    if (transport) { if (!decodeGpuBatch(host, bytes)) throw new Error("benchmark batch failed"); }
    else for (let i = 0; i < count; i++) pass.setScissorRect(0, 0, 32, 32);
    const elapsed = performance.now() - start;
    pass.end(); encoder.finish(); // Deliberately not submitted: this phase measures CPU recording, not GPU execution.
    return elapsed;
  };
  const noop = { renderSetScissor() {} };
  const metrics = {
    guestEncode: () => { const start = performance.now(); for (let i = 0; i < repeats; i++) if (demo.api.ntgpu_encode_benchmark(count) !== 0) throw new Error("guest encoder refused benchmark"); return (performance.now() - start) / repeats; },
    decodeOnly: () => { const start = performance.now(); for (let i = 0; i < repeats; i++) if (!decodeGpuBatch(noop, bytes)) throw new Error("decoder refused benchmark"); return (performance.now() - start) / repeats; },
    decode: () => { let sum = 0; for (let i = 0; i < repeats; i++) sum += recordPass(true); return sum / repeats; },
    direct: () => { let sum = 0; for (let i = 0; i < repeats; i++) sum += recordPass(false); return sum / repeats; },
  };
  demo.api.ntgpu_prepare_upload();
  const source = demo.uploadSource;
  if (!source || source.length < uploadBytes) throw new Error("guest did not publish upload staging range");
  const buffer = device.createBuffer({ size: uploadBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  host.handles.reserve(bufferHandle, "buffer", buffer);
  const validateUpload = async () => {
    const target = device.createBuffer({ size: 4100, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, target, 0, 4096); encoder.copyBufferToBuffer(buffer, uploadBytes - 4, target, 4096, 4);
      device.queue.submit([encoder.finish()]); await target.mapAsync(GPUMapMode.READ);
      const actual = new Uint8Array(target.getMappedRange()), memory = new Uint8Array(demo.api.__memory());
      for (let i = 0; i < 4100; i++) if (actual[i] !== memory[source.offset + (i < 4096 ? i : uploadBytes - 4 + i - 4096)]) throw new Error("16 MiB GPU upload failed first/last-byte validation");
      target.unmap();
    } finally { target.destroy(); }
  };
  const upload = async transport => {
    await device.queue.onSubmittedWorkDone();
    const start = performance.now();
    if (transport) host.writeBuffer(bufferHandle, 0, { offset: 0, length: uploadBytes });
    else device.queue.writeBuffer(buffer, 0, demo.api.__memory(), source.offset, uploadBytes);
    const returned = performance.now();
    device.queue.submit([]); // Explicitly flush queue writes; excluded from CPU API-call time.
    await device.queue.onSubmittedWorkDone();
    const completed = performance.now();
    return { cpuMs: returned - start, completionWaitMs: completed - returned, wallMs: completed - start };
  };
  const raw = [], warmupSamples = [];
  device.pushErrorScope("validation");
  try {
    for (let i = -warmups; i < trials; i++) {
      const names = Object.keys(metrics), shift = ((i % names.length) + names.length) % names.length;
      const order = [...names.slice(shift), ...names.slice(0, shift)], cpu = {};
      for (const name of order) cpu[name] = metrics[name]();
      const uploadOrder = i & 1 ? ["direct", "transport"] : ["transport", "direct"], uploads = {};
      for (const name of uploadOrder) uploads[name] = await upload(name === "transport");
      const sample = { trial: i, order, cpu, uploadOrder, uploads };
      (i < 0 ? warmupSamples : raw).push(sample);
      if (i === -warmups || i === trials - 1) await validateUpload();
    }
    demo.setBenchmarkObserver(validateEncoding); demo.api.ntgpu_encode_benchmark(count); demo.setBenchmarkObserver(() => {});
    const statistics = Object.fromEntries(Object.keys(metrics).map(name => [name, sampleStats(raw.map(sample => sample.cpu[name]))]));
    for (const lane of ["transport", "direct"]) for (const phase of ["cpuMs", "completionWaitMs", "wallMs"]) statistics[`${lane}Upload-${phase}`] = sampleStats(raw.map(sample => sample.uploads[lane][phase]));
    return {
      adapter: host.adapter?.info ? { vendor: host.adapter.info.vendor, architecture: host.adapter.info.architecture, device: host.adapter.info.device, description: host.adapter.info.description, isFallbackAdapter: host.adapter.info.isFallbackAdapter ?? host.adapter.isFallbackAdapter ?? null } : null,
      version: 2, protocol: { version: GPU_PROTOCOL_VERSION, identity: GPU_PROTOCOL_IDENTITY }, trials, warmups, repeats, pairedInterleaved: true, opsPerBatch: count, uploadBytes,
      guestEncode500Ms: statistics.guestEncode.median, decodeOnly500Ms: statistics.decodeOnly.median,
      decode500Ms: statistics.decode.median, direct500Ms: statistics.direct.median, opsPerMs: count / statistics.decode.median,
      upload16MiBMs: statistics["transportUpload-cpuMs"].median, directUpload16MiBMs: statistics["directUpload-cpuMs"].median,
      memoryGrew: demo.api.__memory().byteLength > demo.initialMemoryBytes,
      method: { unit: "milliseconds", guestEncode: "compiled encoder + sink selection/flush + one opaque no-op host import per 500 ops; no GPU calls", decodeOnly: "protocol/operand decoder into no-op handlers; optimisable lower bound, not general handler cost", decode: "decode + handle/state/operand validation + CPU WebGPU recording calls", direct: "same 500 CPU WebGPU recording calls; no decode; both exclude pass creation/end/finish and are not submitted", uploads: "same 16 MiB current guest-memory range and GPU buffer, alternating lane order; drain queue before each lane; cpuMs ends when writeBuffer returns; completionWaitMs/wallMs include explicit empty submit, browser scheduling and queue completion, not GPU-only timestamp time", repeats: "CPU metrics average 8 repetitions per sample; raw values are normalised to 500 ops", excluded: "wasm instantiation, byte-pattern generation, validation readback and pass creation/end/finish" },
      correctness: { guestBatchesDecodedExactly: checkedBatches, uploadFirst4096AndLast4Checked: 2, noBorrowedBufferMutation: true }, statistics, warmupSamples, raw,
    };
  } finally {
    demo.setBenchmarkObserver(() => {});
    buffer.destroy(); texture.destroy(); host.handles.retire(handle); host.handles.retire(bufferHandle);
    const error = await device.popErrorScope(); if (error) throw new Error(`GPU benchmark validation: ${error.message}`);
  }
}

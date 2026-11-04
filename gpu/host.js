import { decodeGpuBatch, GPU_HANDLE_SLOT_BITS, GPU_HANDLE_GENERATION_BITS, GPU_ENUMS, GPU_RECORDS, GPU_MAX_PENDING_REQUESTS, readGpuRecord } from "./gpu-host.generated.js";

const SLOT_MASK = 2 ** GPU_HANDLE_SLOT_BITS - 1;
const GENERATION_MASK = 2 ** GPU_HANDLE_GENERATION_BITS - 1;
const enums = GPU_ENUMS;
const formats = enums.format;
const vertexFormats = enums.vertexFormat;

function choice(table, value) {
  if (!Number.isInteger(value) || value < 0 || value >= table.length || table[value] == null) throw new Error(`unsupported GPU enum ${value}`);
  return table[value];
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid GPU ${label}`);
  return value;
}
function range(buffer, offset, length) {
  integer(offset, "offset"); integer(length, "length");
  if (offset + length > buffer.byteLength) throw new Error("GPU memory range out of bounds");
}

export class GpuHandles {
  constructor() { this.slots = new Map(); }
  split(handle) {
    integer(handle, "handle");
    if (handle > 0xffffffff || !(handle & SLOT_MASK)) throw new Error("invalid GPU handle");
    const generation = handle >>> GPU_HANDLE_SLOT_BITS;
    if (!generation) throw new Error("invalid GPU handle generation");
    return { slot: handle & SLOT_MASK, generation };
  }
  reserve(handle, kind, value = null) {
    const { slot, generation } = this.split(handle);
    const old = this.slots.get(slot);
    if (old && (old.live || generation !== old.next)) throw new Error("stale or duplicate GPU handle");
    if (!old && generation !== 1) throw new Error("unissued GPU handle generation");
    const entry = { generation, next: generation, kind, value, live: true };
    this.slots.set(slot, entry);
    return entry;
  }
  get(handle, kind) {
    const { slot, generation } = this.split(handle);
    const entry = this.slots.get(slot);
    if (!entry || !entry.live || entry.generation !== generation) throw new Error("stale GPU handle");
    if (kind && entry.kind !== kind) throw new Error(`GPU handle is ${entry.kind}, expected ${kind}`);
    if (entry.value === null) throw new Error("GPU resource is not ready");
    return entry.value;
  }
  retire(handle, destroy = false) {
    const { slot, generation } = this.split(handle);
    const entry = this.slots.get(slot);
    if (!entry || !entry.live || entry.generation !== generation) throw new Error("stale GPU handle");
    const value = entry.value;
    entry.live = false;
    entry.value = null;
    entry.next = entry.generation === GENERATION_MASK ? 0 : entry.generation + 1;
    if (destroy && typeof value?.destroy === "function") value.destroy();
    return value;
  }
  complete(handle, entry, value) {
    const current = this.slots.get(handle & SLOT_MASK);
    if (current !== entry || !entry.live) {
      value?.destroy?.();
      return false;
    }
    entry.value = value;
    return true;
  }
  clear() {
    for (const entry of this.slots.values()) {
      if (entry.live) { entry.live = false; entry.value?.destroy?.(); entry.value = null; }
    }
  }
}

export function createGpuHost(options) {
  const scope = options.scope ?? globalThis;
  const gpu = options.gpu ?? scope.navigator?.gpu;
  const canvas = options.canvas;
  const handles = new GpuHandles();
  const getMemory = options.getMemory;
  let device = null, adapter = null, context = null, stopped = false;
  let uploadBase = 0, uploadLength = 0, readbackBase = 0, readbackLength = 0;
  let frameToken = null, deviceEpoch = 0, requesting = false;
  let observer = null, media = null, lastSize = "";
  const pending = new Map();
  const stats = { batches: 0, frames: 0, uploadedBytes: 0 };
  const raf = options.requestAnimationFrame ?? scope.requestAnimationFrame?.bind(scope);
  const cancelRaf = options.cancelAnimationFrame ?? scope.cancelAnimationFrame?.bind(scope);
  const emit = (type, requestId = 0, handle = 0, status = 0, data = {}) => {
    if (stopped) return;
    const event = { type, requestId, handle: handle >>> 0, status, ...data };
    queueMicrotask(() => { if (!stopped) options.onEvent?.(event); });
  };
  const errorMessage = (error) => error instanceof Error ? error.message : String(error);
  const fail = (error, requestId = 0, handle = 0) => emit(9, requestId, handle, 1, { message: errorMessage(error) });
  const active = () => { if (!device) throw new Error("WebGPU device unavailable"); return device; };
  const ref = (handle, kind) => handles.get(handle, kind);
  const optional = (handle, kind) => handle ? ref(handle, kind) : undefined;
  const create = (handle, kind, make) => {
    const entry = handles.reserve(handle, kind);
    try { entry.value = make(); }
    catch (error) { entry.live = false; entry.next = entry.generation === GENERATION_MASK ? 0 : entry.generation + 1; throw error; }
    return entry.value;
  };
  const request = (id, task) => {
    if (!id || pending.has(id) || pending.size >= GPU_MAX_PENDING_REQUESTS) throw new Error("invalid, duplicate, or excessive GPU request id");
    const token = {};
    pending.set(id, token);
    const epoch = deviceEpoch;
    const current = () => !stopped && pending.get(id) === token && epoch === deviceEpoch;
    Promise.resolve().then(() => { if (!stopped) return task(current); }).catch((error) => { if (current()) fail(error, id); }).finally(() => { if (pending.get(id) === token) pending.delete(id); });
  };
  const pixels = () => {
    const dpr = options.getPixelRatio?.() ?? scope.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round((canvas.clientWidth ?? canvas.width) * dpr));
    const height = Math.max(1, Math.round((canvas.clientHeight ?? canvas.height) * dpr));
    const key = `${width}/${height}/${dpr}`;
    if (key === lastSize) return;
    lastSize = key;
    canvas.width = width; canvas.height = height;
    emit(8, 0, 0, 0, { width, height, dpr });
  };
  const watchDpr = () => {
    if (!scope.matchMedia) return;
    media?.removeEventListener("change", changedDpr);
    media = scope.matchMedia(`(resolution: ${scope.devicePixelRatio ?? 1}dppx)`);
    media.addEventListener("change", changedDpr, { once: true });
  };
  const changedDpr = () => { pixels(); watchDpr(); };
  if (scope.ResizeObserver && canvas) {
    observer = new scope.ResizeObserver(pixels);
    observer.observe(canvas);
  }
  watchDpr();
  const timestampWrites = (querySet, beginIndex, endIndex) => querySet ? { querySet: ref(querySet, "querySet"), beginningOfPassWriteIndex: beginIndex, endOfPassWriteIndex: endIndex } : undefined;
  const computeDescriptor = (layout, shader, entry, label) => ({ label, layout: layout ? ref(layout, "pipelineLayout") : "auto", compute: { module: ref(shader, "shaderModule"), entryPoint: entry } });
  const vertexLayouts = (values) => {
    let index = 0;
    const read = () => { if (index >= values.length) throw new Error("truncated GPU vertex layout"); return values[index++]; };
    const layouts = [];
    while (index < values.length) {
      const arrayStride = integer(read(), "vertex stride"), step = read(), count = integer(read(), "attribute count");
      const attributes = [];
      if (count > 32) throw new Error("GPU vertex attribute limit exceeded");
      for (let i = 0; i < count; i++) attributes.push({ shaderLocation: integer(read(), "shader location"), offset: integer(read(), "attribute offset"), format: choice(vertexFormats, read()) });
      layouts.push({ arrayStride, stepMode: choice(["vertex", "instance"], step), attributes });
      if (layouts.length > 8) throw new Error("GPU vertex buffer limit exceeded");
    }
    return layouts;
  };
  const renderDescriptor = (layout, vertexShader, vertexEntry, fragmentShader, fragmentEntry, colorFormat, depthFormat, topology, frontFace, cullMode, sampleCount, depthWrite, depthCompare, blend, layouts, label) => {
    const target = { format: colorFormat || gpu.getPreferredCanvasFormat() };
    if (blend === 1) target.blend = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
    else if (blend !== 0) throw new Error("unsupported GPU blend mode");
    const result = { label, layout: layout ? ref(layout, "pipelineLayout") : "auto", vertex: { module: ref(vertexShader, "shaderModule"), entryPoint: vertexEntry, buffers: vertexLayouts(layouts) }, primitive: { topology: choice(enums.topology, topology), frontFace: choice(enums.front, frontFace), cullMode: choice(enums.cull, cullMode) }, multisample: { count: sampleCount } };
    if (fragmentShader) result.fragment = { module: ref(fragmentShader, "shaderModule"), entryPoint: fragmentEntry, targets: [target] };
    if (depthFormat) result.depthStencil = { format: depthFormat, depthWriteEnabled: depthWrite, depthCompare: choice(enums.compare, depthCompare) };
    return result;
  };
  const asyncPipeline = (handle, requestId, kind, make) => {
    const entry = handles.reserve(handle, kind);
    request(requestId, async (current) => {
      const value = await make();
      if (!current()) { value?.destroy?.(); return; }
      if (handles.complete(handle, entry, value)) emit(2, requestId, handle);
    });
  };
  const uploadRange = (slice) => {
    if (slice.offset + slice.length > uploadLength) throw new Error("GPU upload outside staging arena");
    const memory = getMemory();
    const ptr = uploadBase + slice.offset;
    range(memory, ptr, slice.length);
    return { memory, ptr, length: slice.length };
  };
  const host = {
    protocolError: fail,
    requestDevice(requestId, powerPreference, featureBits, maxBufferSize) {
      if (requesting || device) throw new Error("GPU device already requested");
      if (featureBits & ~1) throw new Error("unsupported GPU feature bits");
      requesting = true;
      request(requestId, async () => {
        try {
          if (!gpu) { emit(1, requestId, 0, 1, { available: false, reason: "navigator.gpu unavailable" }); return; }
          adapter = await gpu.requestAdapter({ powerPreference: choice(["low-power", "high-performance"], powerPreference) });
          if (!adapter) { emit(1, requestId, 0, 1, { available: false, reason: "no WebGPU adapter" }); return; }
          const requiredFeatures = [];
          if ((featureBits & 1) && adapter.features.has("timestamp-query")) requiredFeatures.push("timestamp-query");
          const requiredLimits = {};
          if (maxBufferSize) requiredLimits.maxBufferSize = integer(maxBufferSize, "maxBufferSize");
          const created = await adapter.requestDevice({ requiredFeatures, requiredLimits });
          if (stopped) { created.destroy(); return; }
          device = created;
          const epoch = ++deviceEpoch;
          created.addEventListener("uncapturederror", (event) => { if (epoch === deviceEpoch) emit(6, 0, 0, 1, { message: event.error.message }); });
          created.lost.then((info) => {
            if (epoch !== deviceEpoch || stopped) return;
            device = null; deviceEpoch++;
            if (frameToken !== null) cancelRaf?.(frameToken);
            frameToken = null;
            pending.clear(); handles.clear();
            emit(5, 0, 0, 1, { reason: info.reason, message: info.message });
          });
          const limits = {};
          for (let source = created.limits; source && source !== Object.prototype; source = Object.getPrototypeOf(source)) {
            for (const name of Object.getOwnPropertyNames(source)) if (typeof created.limits[name] === "number") limits[name] = created.limits[name];
          }
          emit(1, requestId, 0, 0, { available: true, features: [...created.features], adapterFeatures: [...adapter.features], limits, format: gpu.getPreferredCanvasFormat() });
          pixels();
        } finally { requesting = false; }
      });
    },
    createBuffer(handle, size, usage, mappedAtCreation, label) { create(handle, "buffer", () => active().createBuffer({ size: integer(size, "buffer size"), usage, mappedAtCreation, label })); },
    createTexture(handle, width, height, depth, mipLevels, samples, dimension, format, usage, label) { create(handle, "texture", () => active().createTexture({ size: [width, height, depth], mipLevelCount: mipLevels, sampleCount: samples, dimension: choice(enums.dimension, dimension), format, usage, label })); },
    createTextureView(handle, texture, format, dimension, baseMip, mipCount, baseLayer, layerCount, aspect, label) {
      const descriptor = { label, baseMipLevel: baseMip, baseArrayLayer: baseLayer, aspect: choice(enums.aspect, aspect) };
      if (format) descriptor.format = format;
      if (dimension) descriptor.dimension = choice(enums.view, dimension);
      if (mipCount) descriptor.mipLevelCount = mipCount;
      if (layerCount) descriptor.arrayLayerCount = layerCount;
      create(handle, "textureView", () => ref(texture, "texture").createView(descriptor));
    },
    createSampler(handle, addressU, addressV, addressW, magFilter, minFilter, mipmapFilter, lodMin, lodMax, compare, maxAnisotropy, label) { create(handle, "sampler", () => active().createSampler({ label, addressModeU: choice(enums.address, addressU), addressModeV: choice(enums.address, addressV), addressModeW: choice(enums.address, addressW), magFilter: choice(enums.filter, magFilter), minFilter: choice(enums.filter, minFilter), mipmapFilter: choice(enums.filter, mipmapFilter), lodMinClamp: lodMin, lodMaxClamp: lodMax, compare: compare ? choice(enums.compare, compare) : undefined, maxAnisotropy })); },
    createShaderModule(handle, requestId, code, label) {
      const module = create(handle, "shaderModule", () => active().createShaderModule({ code, label }));
      request(requestId, async (current) => {
        const info = await module.getCompilationInfo();
        if (!current()) return;
        const messages = [...info.messages].map(({ message, type, lineNum, linePos, offset, length }) => ({ message, type, lineNum, linePos, offset, length }));
        emit(7, requestId, handle, messages.some((message) => message.type === "error") ? 1 : 0, { messages });
      });
    },
    createBindGroupLayout(handle, entries, label) {
      if (entries.length % GPU_RECORDS.bindGroupLayout.length) throw new Error("invalid GPU bind group layout record");
      const result = [];
      for (let i = 0; i < entries.length; i += GPU_RECORDS.bindGroupLayout.length) {
        const { binding, visibility, kind, type, dynamic, minSize, dimension, multisampled, format, access } = readGpuRecord("bindGroupLayout", entries, i).record;
        const entry = { binding: integer(binding, "binding"), visibility };
        if (kind === 1) entry.buffer = { type: choice(enums.buffer, type), hasDynamicOffset: dynamic !== 0, minBindingSize: integer(minSize, "min binding size") };
        else if (kind === 2) entry.sampler = { type: choice(enums.sampler, type) };
        else if (kind === 3) entry.texture = { sampleType: choice(enums.sample, type), viewDimension: choice(enums.view, dimension), multisampled: multisampled !== 0 };
        else if (kind === 4) entry.storageTexture = { access: choice(enums.access, access), format: choice(formats, format), viewDimension: choice(enums.view, dimension) };
        else throw new Error("unsupported GPU binding kind");
        result.push(entry);
      }
      create(handle, "bindGroupLayout", () => active().createBindGroupLayout({ label, entries: result }));
    },
    createBindGroup(handle, layout, entries, label) {
      if (entries.length % GPU_RECORDS.bindGroup.length) throw new Error("invalid GPU bind group record");
      const result = [];
      for (let i = 0; i < entries.length; i += GPU_RECORDS.bindGroup.length) {
        const { binding, kind, resource, offset, size } = readGpuRecord("bindGroup", entries, i).record;
        let value;
        if (kind === 1) { value = { buffer: ref(resource, "buffer"), offset: integer(offset, "binding offset") }; if (size) value.size = integer(size, "binding size"); }
        else if (kind === 2) value = ref(resource, "sampler");
        else if (kind === 3 || kind === 4) value = ref(resource, "textureView");
        else throw new Error("unsupported GPU binding resource");
        result.push({ binding: integer(binding, "binding"), resource: value });
      }
      create(handle, "bindGroup", () => active().createBindGroup({ label, layout: ref(layout, "bindGroupLayout"), entries: result }));
    },
    createPipelineLayout(handle, layouts, label) { create(handle, "pipelineLayout", () => active().createPipelineLayout({ label, bindGroupLayouts: layouts.map((layout) => ref(layout, "bindGroupLayout")) })); },
    createComputePipeline(handle, ...args) { create(handle, "computePipeline", () => active().createComputePipeline(computeDescriptor(...args))); },
    createComputePipelineAsync(handle, requestId, ...args) { asyncPipeline(handle, requestId, "computePipeline", () => active().createComputePipelineAsync(computeDescriptor(...args))); },
    createRenderPipeline(handle, ...args) { create(handle, "renderPipeline", () => active().createRenderPipeline(renderDescriptor(...args))); },
    createRenderPipelineAsync(handle, requestId, ...args) { asyncPipeline(handle, requestId, "renderPipeline", () => active().createRenderPipelineAsync(renderDescriptor(...args))); },
    createQuerySet(handle, type, count, label) {
      if (type !== 1 || !active().features.has("timestamp-query")) throw new Error("GPU timestamp queries unavailable");
      create(handle, "querySet", () => active().createQuerySet({ label, type: "timestamp", count }));
    },
    createCommandEncoder(handle, label) { create(handle, "commandEncoder", () => active().createCommandEncoder({ label })); },
    beginComputePass(handle, encoder, querySet, beginIndex, endIndex, label) { create(handle, "computePass", () => ref(encoder, "commandEncoder").beginComputePass({ label, timestampWrites: timestampWrites(querySet, beginIndex, endIndex) })); },
    computeSetPipeline(pass, pipeline) { ref(pass, "computePass").setPipeline(ref(pipeline, "computePipeline")); },
    computeSetBindGroup(pass, index, bindGroup, dynamicOffsets) { ref(pass, "computePass").setBindGroup(index, ref(bindGroup, "bindGroup"), dynamicOffsets); },
    computeDispatch(pass, x, y, z) { ref(pass, "computePass").dispatchWorkgroups(x, y, z); },
    computeDispatchIndirect(pass, buffer, offset) { ref(pass, "computePass").dispatchWorkgroupsIndirect(ref(buffer, "buffer"), integer(offset, "indirect offset")); },
    endComputePass(pass) { ref(pass, "computePass").end(); },
    beginRenderPass(handle, encoder, colorView, resolveView, colorLoad, colorStore, clearR, clearG, clearB, clearA, depthView, depthLoad, depthStore, clearDepth, querySet, beginIndex, endIndex, label) {
      const descriptor = { label, colorAttachments: colorView ? [{ view: ref(colorView, "textureView"), resolveTarget: optional(resolveView, "textureView"), loadOp: choice(enums.load, colorLoad), storeOp: choice(enums.store, colorStore), clearValue: [clearR, clearG, clearB, clearA] }] : [], timestampWrites: timestampWrites(querySet, beginIndex, endIndex) };
      if (depthView) descriptor.depthStencilAttachment = { view: ref(depthView, "textureView"), depthLoadOp: choice(enums.load, depthLoad), depthStoreOp: choice(enums.store, depthStore), depthClearValue: clearDepth };
      create(handle, "renderPass", () => ref(encoder, "commandEncoder").beginRenderPass(descriptor));
    },
    renderSetViewport(pass, x, y, width, height, minDepth, maxDepth) { ref(pass, "renderPass").setViewport(x, y, width, height, minDepth, maxDepth); },
    renderSetScissor(pass, x, y, width, height) { ref(pass, "renderPass").setScissorRect(x, y, width, height); },
    renderSetPipeline(pass, pipeline) { ref(pass, "renderPass").setPipeline(ref(pipeline, "renderPipeline")); },
    renderSetBindGroup(pass, index, bindGroup, dynamicOffsets) { ref(pass, "renderPass").setBindGroup(index, ref(bindGroup, "bindGroup"), dynamicOffsets); },
    renderSetVertexBuffer(pass, slot, buffer, offset, size) { ref(pass, "renderPass").setVertexBuffer(slot, ref(buffer, "buffer"), integer(offset, "vertex offset"), size ? integer(size, "vertex size") : undefined); },
    renderSetIndexBuffer(pass, buffer, format, offset, size) { ref(pass, "renderPass").setIndexBuffer(ref(buffer, "buffer"), choice([undefined, "uint16", "uint32"], format), integer(offset, "index offset"), size ? integer(size, "index size") : undefined); },
    renderDraw(pass, vertexCount, instanceCount, firstVertex, firstInstance) { ref(pass, "renderPass").draw(vertexCount, instanceCount, firstVertex, firstInstance); },
    renderDrawIndexed(pass, indexCount, instanceCount, firstIndex, baseVertex, firstInstance) { ref(pass, "renderPass").drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance); },
    renderDrawIndirect(pass, buffer, offset) { ref(pass, "renderPass").drawIndirect(ref(buffer, "buffer"), integer(offset, "indirect offset")); },
    renderDrawIndexedIndirect(pass, buffer, offset) { ref(pass, "renderPass").drawIndexedIndirect(ref(buffer, "buffer"), integer(offset, "indirect offset")); },
    endRenderPass(pass) { ref(pass, "renderPass").end(); },
    copyBufferToBuffer(encoder, source, sourceOffset, destination, destinationOffset, size) { ref(encoder, "commandEncoder").copyBufferToBuffer(ref(source, "buffer"), integer(sourceOffset, "copy offset"), ref(destination, "buffer"), integer(destinationOffset, "copy offset"), integer(size, "copy size")); },
    copyBufferToTexture(encoder, source, sourceOffset, bytesPerRow, rowsPerImage, destination, mipLevel, originX, originY, originZ, aspect, width, height, depth) { ref(encoder, "commandEncoder").copyBufferToTexture({ buffer: ref(source, "buffer"), offset: sourceOffset, bytesPerRow, rowsPerImage }, { texture: ref(destination, "texture"), mipLevel, origin: [originX, originY, originZ], aspect: choice(enums.aspect, aspect) }, [width, height, depth]); },
    copyTextureToTexture(encoder, source, sourceMip, sourceX, sourceY, sourceZ, destination, destinationMip, destinationX, destinationY, destinationZ, width, height, depth) { ref(encoder, "commandEncoder").copyTextureToTexture({ texture: ref(source, "texture"), mipLevel: sourceMip, origin: [sourceX, sourceY, sourceZ] }, { texture: ref(destination, "texture"), mipLevel: destinationMip, origin: [destinationX, destinationY, destinationZ] }, [width, height, depth]); },
    resolveQuerySet(encoder, querySet, first, count, destination, offset) { ref(encoder, "commandEncoder").resolveQuerySet(ref(querySet, "querySet"), first, count, ref(destination, "buffer"), integer(offset, "query offset")); },
    finishCommandEncoder(handle, encoder, label) { create(handle, "commandBuffer", () => ref(encoder, "commandEncoder").finish({ label })); },
    queueSubmit(commandBuffers) { active().queue.submit(commandBuffers.map((command) => ref(command, "commandBuffer"))); },
    writeBuffer(buffer, bufferOffset, data) {
      const source = uploadRange(data);
      active().queue.writeBuffer(ref(buffer, "buffer"), integer(bufferOffset, "write offset"), source.memory, source.ptr, source.length);
      stats.uploadedBytes += source.length;
    },
    writeTexture(texture, mipLevel, originX, originY, originZ, aspect, data, bytesPerRow, rowsPerImage, width, height, depth) {
      const source = uploadRange(data);
      active().queue.writeTexture({ texture: ref(texture, "texture"), mipLevel, origin: [originX, originY, originZ], aspect: choice(enums.aspect, aspect) }, new Uint8Array(source.memory, source.ptr, source.length), { offset: 0, bytesPerRow, rowsPerImage }, [width, height, depth]);
      stats.uploadedBytes += source.length;
    },
    unmap(buffer) { ref(buffer, "buffer").unmap(); },
    writeMappedBuffer(buffer, bufferOffset, data) {
      const source = uploadRange(data);
      const mapped = ref(buffer, "buffer").getMappedRange(integer(bufferOffset, "mapped offset"), source.length);
      new Uint8Array(mapped).set(new Uint8Array(source.memory, source.ptr, source.length));
    },
    configureCanvas(format, usage, alphaMode, colorSpace) {
      context = canvas.getContext("webgpu");
      if (!context) throw new Error("WebGPU canvas context unavailable");
      context.configure({ device: active(), format: format || gpu.getPreferredCanvasFormat(), usage, alphaMode: choice(["opaque", "premultiplied"], alphaMode), colorSpace: choice(["srgb", "display-p3"], colorSpace) });
    },
    getCurrentTexture(handle) { if (!context) throw new Error("GPU canvas not configured"); create(handle, "texture", () => context.getCurrentTexture()); },
    destroy(resource) { handles.retire(resource, true); },
    release(resource) { handles.retire(resource, false); },
    mapAsync(requestId, buffer, mode, offset, size, destination) {
      if (mode !== 1) throw new Error("GPU readback supports MAP_READ only");
      if (destination.offset + destination.length > readbackLength || size > destination.length) throw new Error("GPU readback outside staging arena");
      const target = readbackBase + destination.offset;
      range(getMemory(), target, size);
      const resource = ref(buffer, "buffer");
      const epoch = deviceEpoch;
      request(requestId, async (current) => {
        await resource.mapAsync(mode, offset, size);
        try {
          if (!current() || epoch !== deviceEpoch) return;
          const memory = getMemory();
          range(memory, target, size);
          new Uint8Array(memory, target, size).set(new Uint8Array(resource.getMappedRange(offset, size)));
        } finally { resource.unmap(); }
        emit(3, requestId, buffer, 0, { offset: destination.offset, length: size });
      });
    },
    onSubmittedWorkDone(requestId) { const queue = active().queue; request(requestId, async (current) => { await queue.onSubmittedWorkDone(); if (current()) emit(4, requestId); }); },
    requestFrame() {
      if (stopped || !device || frameToken !== null) return;
      if (!raf) throw new Error("requestAnimationFrame unavailable");
      frameToken = raf((time) => {
        frameToken = null;
        if (stopped || !device) return;
        pixels(); stats.frames++;
        try { options.onFrame?.(time); } catch (error) { fail(error); }
      });
    },
    apply(batch, uploads, readbacks) {
      if (stopped) return false;
      const memory = getMemory();
      if (batch.buffer !== memory || uploads.buffer !== memory || readbacks.buffer !== memory) { fail("GPU batch and arenas must share reactor memory"); return false; }
      uploadBase = uploads.byteOffset; uploadLength = uploads.byteLength;
      readbackBase = readbacks.byteOffset; readbackLength = readbacks.byteLength;
      stats.batches++;
      return decodeGpuBatch(host, batch);
    },
    dispose() {
      if (stopped) return;
      stopped = true; deviceEpoch++;
      if (frameToken !== null) cancelRaf?.(frameToken);
      frameToken = null;
      observer?.disconnect(); media?.removeEventListener("change", changedDpr);
      handles.clear(); context?.unconfigure(); device?.destroy(); device = null;
    },
    handles,
    stats,
    get device() { return device; },
    get idle() { return frameToken === null; },
  };
  return host;
}

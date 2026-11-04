import {
  decodeGpuBatch, readGpuRecord, GPU_HANDLE_SLOT_BITS, GPU_HANDLE_GENERATION_BITS, GPU_ENUMS, GPU_RECORDS, GPU_MAX_PENDING_REQUESTS,
  GPU_FEATURES, GPU_LIMITS, GPU_PROTOCOL_VERSION, GPU_PROTOCOL_IDENTITY,
  GPU_EVENT_CAPABILITIES, GPU_EVENT_PIPELINE_READY, GPU_EVENT_MAP_READY, GPU_EVENT_WORK_DONE, GPU_EVENT_DEVICE_LOST,
  GPU_EVENT_UNCAUGHT_ERROR, GPU_EVENT_SHADER_INFO, GPU_EVENT_RESIZE, GPU_EVENT_ERROR,
  GPU_STATUS_OK, GPU_STATUS_ERROR, GPU_STATUS_CANCELLED, GPU_STATUS_LOST,
  MAP_MODE_READ, SHADER_STAGE_VERTEX, SHADER_STAGE_FRAGMENT, SHADER_STAGE_COMPUTE, QUERY_TYPE_TIMESTAMP, QUERY_TYPE_OCCLUSION, LIMIT_MODE_REQUIRED, LIMIT_MODE_PREFERRED,
} from "./gpu-host.generated.js";

const SLOT_MASK = 2 ** GPU_HANDLE_SLOT_BITS - 1;
const GENERATION_MASK = 2 ** GPU_HANDLE_GENERATION_BITS - 1;
const enums = GPU_ENUMS;
const formats = enums.format;
const KNOWN_FEATURE_BITS = 2 ** GPU_FEATURES.length - 1;
const MAX_QUERIES = 4096;
// Buffer mapping states and command encoder phases tracked by the protocol.
const UNMAPPED = 0, MAPPING = 1, MAPPED = 2;
const OPEN = 0, LOCKED = 1, FINISHED = 2;

function choice(table, value) {
  if (!Number.isInteger(value) || value < 0 || value >= table.length || table[value] == null) throw new Error(`unsupported GPU enum ${value}`);
  return table[value];
}
const optionalChoice = (table, value) => value === 0 ? undefined : choice(table, value);
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid GPU ${label}`);
  return value;
}
function u32Field(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`invalid GPU ${label}`);
  return value;
}
function i32Field(value, label) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error(`invalid GPU ${label}`);
  return value;
}
function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`invalid GPU ${label}`);
  return value;
}
function flag(value, label) {
  if (value !== 0 && value !== 1) throw new Error(`invalid GPU ${label} flag`);
  return value === 1;
}
function range(buffer, offset, length) {
  integer(offset, "offset"); integer(length, "length");
  if (offset + length > buffer.byteLength) throw new Error("GPU memory range out of bounds");
}
function records(kind, values, { min = 0, max = Infinity, optional = false } = {}) {
  const width = GPU_RECORDS[kind].length;
  if (values.length % width) throw new Error(`invalid GPU ${kind} record`);
  const count = values.length / width;
  if (optional && count > 1) throw new Error(`GPU ${kind} accepts at most one record`);
  if (count < min || count > max) throw new Error(`GPU ${kind} record count ${count} outside ${min}..${max}`);
  const result = [];
  for (let i = 0; i < values.length; i += width) result.push(readGpuRecord(kind, values, i).record);
  return result;
}
function featureBits(features) {
  let bits = 0;
  GPU_FEATURES.forEach((name, bit) => { if (features?.has?.(name)) bits += 2 ** bit; });
  return bits;
}
function numericLimits(source) {
  const limits = {};
  for (let proto = source; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) if (typeof source[name] === "number") limits[name] = source[name];
  }
  return limits;
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
  reserve(handle, kind, value = null, state = null) {
    const { slot, generation } = this.split(handle);
    const old = this.slots.get(slot);
    if (old && (old.live || generation !== old.next)) throw new Error("stale or duplicate GPU handle");
    if (!old && generation !== 1) throw new Error("unissued GPU handle generation");
    const entry = { generation, next: generation, kind, value, state, live: true, failed: false, lost: false, request: 0 };
    this.slots.set(slot, entry);
    return entry;
  }
  // The live entry for exactly this handle, or null; never throws for lost or failed resources.
  peek(handle) {
    const { slot, generation } = this.split(handle);
    const entry = this.slots.get(slot);
    return entry && entry.live && entry.generation === generation ? entry : null;
  }
  lookup(handle, kind) {
    const entry = this.peek(handle);
    if (!entry) throw new Error("stale GPU handle");
    if (kind && entry.kind !== kind) throw new Error(`GPU handle is ${entry.kind}, expected ${kind}`);
    if (entry.value === null) throw new Error(entry.lost ? "GPU resource was lost with its device" : entry.failed ? "GPU resource creation failed" : "GPU resource is not ready");
    return entry;
  }
  get(handle, kind) { return this.lookup(handle, kind).value; }
  retire(handle, destroy = false) {
    const { slot, generation } = this.split(handle);
    const entry = this.slots.get(slot);
    // A handle whose creating operation was rejected before reservation is retired without a resource,
    // keeping guest and host generations synchronized.
    if (!entry ? generation === 1 : (!entry.live && entry.next === generation)) {
      this.slots.set(slot, { generation, next: generation === GENERATION_MASK ? 0 : generation + 1, kind: null, value: null, state: null, live: false, failed: true, lost: false, request: 0 });
      return null;
    }
    if (!entry || !entry.live || entry.generation !== generation) throw new Error("stale GPU handle");
    const value = entry.value;
    entry.live = false;
    entry.value = null;
    entry.state = null;
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
    entry.request = 0;
    return true;
  }
  // Device loss: every live handle stays allocated until the guest retires it, but no longer resolves.
  lose() {
    for (const entry of this.slots.values()) {
      if (entry.live) { entry.lost = true; entry.value = null; entry.state = null; entry.request = 0; }
    }
  }
  clear() {
    for (const entry of this.slots.values()) {
      if (entry.live) { entry.live = false; entry.value?.destroy?.(); entry.value = null; entry.state = null; }
    }
  }
}

const bufferState = (entry) => entry.state ??= { map: UNMAPPED };
const encoderState = (entry) => entry.state ??= { phase: OPEN };
const passState = (encoder) => ({ encoder, ended: false, pipeline: false, index: false, occlusionSet: null, occlusionActive: false, occlusionUsed: null });

export function createGpuHost(options) {
  const scope = options.scope ?? globalThis;
  const gpu = options.gpu ?? scope.navigator?.gpu;
  const canvas = options.canvas;
  const handles = new GpuHandles();
  const getMemory = options.getMemory;
  const later = (fn) => (scope.setTimeout ?? globalThis.setTimeout)(fn, 0);
  let device = null, adapter = null, context = null, configured = false, stopped = false;
  let uploadBase = 0, uploadLength = 0, readbackBase = 0, readbackLength = 0;
  let frameToken = null, deviceEpoch = 0, requesting = null, lostSignal = null;
  let observer = null, media = null, lastSize = "";
  const pending = new Map();
  const stats = { batches: 0, frames: 0, uploadedBytes: 0 };
  const raf = options.requestAnimationFrame ?? scope.requestAnimationFrame?.bind(scope);
  const cancelRaf = options.cancelAnimationFrame ?? scope.cancelAnimationFrame?.bind(scope);
  const emit = (type, requestId = 0, handle = 0, status = GPU_STATUS_OK, data = {}) => {
    if (stopped) return;
    const event = { type, requestId, handle: handle >>> 0, status, ...data };
    queueMicrotask(() => { if (!stopped) options.onEvent?.(event); });
  };
  const errorMessage = (error) => error instanceof Error ? error.message : String(error);
  const fail = (error, requestId = 0, handle = 0) => emit(GPU_EVENT_ERROR, requestId, handle, GPU_STATUS_ERROR, { message: errorMessage(error) });
  const active = () => { if (!device) throw new Error("WebGPU device unavailable"); return device; };
  const limit = (name, fallback) => device?.limits?.[name] ?? fallback;
  const ref = (handle, kind) => handles.get(handle, kind);
  const optional = (handle, kind) => handle ? ref(handle, kind) : undefined;
  const create = (handle, kind, make, state = null) => {
    const entry = handles.reserve(handle, kind, null, state);
    try { entry.value = make(); }
    catch (error) { entry.failed = true; throw error; }
    return entry.value;
  };

  // Requests: every id that reaches the host completes exactly once — with its completion event, or
  // ERROR — unless the host is disposed. Settling removes the id before the event is delivered.
  const settle = (id, record, type, status, data = {}) => {
    if (pending.get(id) !== record) return false;
    pending.delete(id);
    record.cleanup?.(status);
    emit(type, id, record.handle, status, data);
    return true;
  };
  const lossSettled = (epoch) => {
    if (!lostSignal || epoch !== deviceEpoch) return Promise.resolve();
    return Promise.race([lostSignal, new Promise((done) => later(done))]);
  };
  const request = (id, type, handle, task, extra = {}) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error("invalid GPU request id");
    if (pending.has(id)) throw new Error(`duplicate pending GPU request id ${id}`);
    if (pending.size >= GPU_MAX_PENDING_REQUESTS) throw new Error("too many pending GPU requests");
    const record = { type, handle, epoch: deviceEpoch, device: true, readback: null, cleanup: null, ...extra };
    pending.set(id, record);
    const current = () => !stopped && pending.get(id) === record;
    // The task starts synchronously so its WebGPU call is ordered with the rest of the batch.
    (async () => task(current, record))()
      .catch(async (error) => {
        if (!current()) return;
        // A rejection caused by a concurrent device loss settles as LOST through the loss handler.
        if (record.device) await lossSettled(record.epoch);
        settle(id, record, GPU_EVENT_ERROR, GPU_STATUS_ERROR, { message: errorMessage(error) });
      });
    return record;
  };
  const cancel = (id, message = "GPU request cancelled") => {
    const record = pending.get(id);
    if (record) settle(id, record, record.type, GPU_STATUS_CANCELLED, { message });
  };
  const retireOwned = (handle) => {
    const entry = handles.peek(handle);
    if (entry?.request) cancel(entry.request, "GPU request cancelled by releasing its resource");
  };
  const loseDevice = (epoch, reason, message) => {
    if (stopped || epoch !== deviceEpoch || !device) return;
    device = null; deviceEpoch++; configured = false; lostSignal = null;
    if (frameToken !== null) cancelRaf?.(frameToken);
    frameToken = null;
    for (const [id, record] of [...pending]) if (record.device) settle(id, record, record.type, GPU_STATUS_LOST, { message: "GPU device lost" });
    handles.lose();
    emit(GPU_EVENT_DEVICE_LOST, 0, 0, GPU_STATUS_ERROR, { reason, message });
  };

  const pixels = () => {
    const dpr = options.getPixelRatio?.() ?? scope.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round(canvas.clientWidth === undefined ? canvas.width : canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight === undefined ? canvas.height : canvas.clientHeight * dpr));
    const key = `${width}/${height}/${dpr}`;
    if (key === lastSize) return;
    lastSize = key;
    canvas.width = width; canvas.height = height;
    emit(GPU_EVENT_RESIZE, 0, 0, GPU_STATUS_OK, { width, height, dpr });
  };
  const watchDpr = () => {
    if (!scope.matchMedia) return;
    media?.removeEventListener("change", changedDpr);
    media = scope.matchMedia(`(resolution: ${scope.devicePixelRatio ?? 1}dppx)`);
    media.addEventListener("change", changedDpr, { once: true });
  };
  let resizeFrame = null;
  const changedDpr = () => { pixels(); watchDpr(); };
  const changedWindow = () => {
    if (resizeFrame !== null || !raf) return;
    resizeFrame = raf(() => { resizeFrame = null; changedDpr(); });
  };
  if (scope.ResizeObserver && canvas) {
    observer = new scope.ResizeObserver(pixels);
    observer.observe(canvas);
  }
  watchDpr();
  scope.addEventListener?.("resize", changedWindow);

  const negotiate = (requestId, powerPreference, requiredBits, optionalBits, limitValues) => {
    if (requesting || device) throw new Error("GPU device already requested");
    if ((requiredBits | optionalBits) & ~KNOWN_FEATURE_BITS) throw new Error("unsupported GPU feature bits");
    const power = choice(enums.power, powerPreference);
    const wanted = new Set();
    const limitRequests = records("limitRequest", limitValues, { max: GPU_LIMITS.length - 1 }).map(({ limit: id, value, mode }) => {
      const spec = GPU_LIMITS[id];
      if (!Number.isInteger(id) || !spec) throw new Error(`unsupported GPU limit ${id}`);
      if (wanted.has(id)) throw new Error(`duplicate GPU limit ${spec.name}`);
      wanted.add(id);
      integer(value, `${spec.name} value`);
      if (mode !== LIMIT_MODE_REQUIRED && mode !== LIMIT_MODE_PREFERRED) throw new Error(`invalid GPU limit mode ${mode}`);
      if (spec.class === "alignment" && (value === 0 || (value & (value - 1)) !== 0)) throw new Error(`GPU ${spec.name} must be a power of two`);
      return { ...spec, value, required: mode === LIMIT_MODE_REQUIRED };
    });
    const token = {};
    const done = () => { if (requesting === token) requesting = null; };
    requesting = token;
    try { request(requestId, GPU_EVENT_CAPABILITIES, 0, async (current, record) => {
      try {
        const refuse = (data) => settle(requestId, record, GPU_EVENT_CAPABILITIES, GPU_STATUS_ERROR, { available: false, ...data });
        if (!gpu) { refuse({ reason: "navigator.gpu unavailable" }); return; }
        const found = await gpu.requestAdapter({ powerPreference: power });
        if (!current()) return;
        if (!found) { refuse({ reason: "no WebGPU adapter" }); return; }
        const adapterLimits = numericLimits(found.limits);
        const adapterFeatures = [...found.features];
        const has = (bit) => (requiredBits | optionalBits) & 2 ** bit;
        const missingFeatures = GPU_FEATURES.filter((name, bit) => (requiredBits & 2 ** bit) && !found.features.has(name));
        const requiredFeatures = GPU_FEATURES.filter((name, bit) => has(bit) && found.features.has(name));
        const requiredLimits = {}, missingLimits = [];
        for (const wantedLimit of limitRequests) {
          const supported = adapterLimits[wantedLimit.name];
          if (typeof supported !== "number") { if (wantedLimit.required) missingLimits.push(wantedLimit.name); continue; }
          const satisfied = wantedLimit.class === "maximum" ? wantedLimit.value <= supported : wantedLimit.value >= supported;
          if (wantedLimit.required && !satisfied) { missingLimits.push(wantedLimit.name); continue; }
          requiredLimits[wantedLimit.name] = satisfied ? wantedLimit.value : supported;
        }
        if (missingFeatures.length || missingLimits.length) {
          refuse({ reason: "required GPU features or limits unavailable", missingFeatures, missingFeatureBits: featureBits(new Set(missingFeatures)), missingLimits, adapterFeatures, adapterFeatureBits: featureBits(found.features), adapterLimits });
          return;
        }
        const created = await found.requestDevice({ requiredFeatures, requiredLimits });
        if (!current()) { created.destroy(); return; }
        adapter = found;
        device = created;
        const epoch = ++deviceEpoch;
        lostSignal = created.lost;
        created.addEventListener("uncapturederror", (event) => { if (epoch === deviceEpoch) emit(GPU_EVENT_UNCAUGHT_ERROR, 0, 0, GPU_STATUS_ERROR, { message: event.error.message }); });
        created.lost.then((info) => loseDevice(epoch, info.reason, info.message));
        const format = gpu.getPreferredCanvasFormat();
        settle(requestId, record, GPU_EVENT_CAPABILITIES, GPU_STATUS_OK, {
          available: true, features: [...created.features], featureBits: featureBits(created.features), adapterFeatures, adapterFeatureBits: featureBits(found.features),
          limits: numericLimits(created.limits), adapterLimits, format, formatCode: Math.max(0, formats.indexOf(format)), protocol: { version: GPU_PROTOCOL_VERSION, identity: GPU_PROTOCOL_IDENTITY },
        });
        pixels();
      } finally { done(); }
    }, { device: false, cleanup: done }); } catch (error) { done(); throw error; }
  };

  const timestampWrites = (querySet, beginIndex, endIndex) => {
    if (!querySet) return undefined;
    const entry = handles.lookup(querySet, "querySet");
    if (entry.state && entry.state.type !== QUERY_TYPE_TIMESTAMP) throw new Error("GPU timestamp writes need a timestamp query set");
    return { querySet: entry.value, beginningOfPassWriteIndex: beginIndex, endOfPassWriteIndex: endIndex };
  };
  // Pipeline-overridable constants by numeric @id; each record names the shader stages it applies to.
  const constantsOf = (values, stage) => {
    const result = {};
    for (const { stages, id, value } of records("constant", values)) {
      if (!Number.isInteger(stages) || stages < 1 || stages > 7) throw new Error("invalid GPU pipeline constant stages");
      if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error(`invalid GPU pipeline constant ${id}`);
      finite(value, "pipeline constant");
      if (!(stages & stage)) continue;
      if (String(id) in result) throw new Error(`duplicate GPU pipeline constant ${id}`);
      result[String(id)] = value;
    }
    return result;
  };
  const computeDescriptor = (layout, shader, entry, label, constants = {}) => ({ label, layout: layout ? ref(layout, "pipelineLayout") : "auto", compute: { module: ref(shader, "shaderModule"), entryPoint: entry, constants } });
  const vertexLayouts = (values) => {
    let index = 0;
    const read = () => { if (index >= values.length) throw new Error("truncated GPU vertex layout"); return values[index++]; };
    const layouts = [], locations = new Set();
    const maxBuffers = limit("maxVertexBuffers", 8), maxAttributes = limit("maxVertexAttributes", 16), maxStride = limit("maxVertexBufferArrayStride", 2048);
    while (index < values.length) {
      const arrayStride = integer(read(), "vertex stride"), step = read(), count = integer(read(), "attribute count");
      if (arrayStride % 4 || arrayStride > maxStride) throw new Error("GPU vertex stride must be a multiple of 4 within maxVertexBufferArrayStride");
      if (locations.size + count > maxAttributes) throw new Error("GPU vertex attribute limit exceeded");
      const attributes = [];
      for (let i = 0; i < count; i++) {
        const shaderLocation = integer(read(), "shader location"), offset = integer(read(), "attribute offset"), format = choice(enums.vertexFormat, read());
        if (shaderLocation >= maxAttributes || locations.has(shaderLocation)) throw new Error(`invalid or duplicate GPU shader location ${shaderLocation}`);
        locations.add(shaderLocation);
        attributes.push({ shaderLocation, offset, format });
      }
      layouts.push({ arrayStride, stepMode: choice(enums.step, step), attributes });
      if (layouts.length > maxBuffers) throw new Error("GPU vertex buffer limit exceeded");
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
  const blendComponent = (operation, srcFactor, dstFactor) => ({ operation: optionalChoice(enums.blendOperation, operation), srcFactor: optionalChoice(enums.blendFactor, srcFactor), dstFactor: optionalChoice(enums.blendFactor, dstFactor) });
  const stencilFace = (compare, failOp, depthFailOp, passOp) => ({ compare: optionalChoice(enums.compare, compare), failOp: optionalChoice(enums.stencilOperation, failOp), depthFailOp: optionalChoice(enums.stencilOperation, depthFailOp), passOp: optionalChoice(enums.stencilOperation, passOp) });
  const renderDescriptorWith = (layout, vertexShader, vertexEntry, fragmentShader, fragmentEntry, targetValues, primitiveValues, depthValues, multisampleValues, layouts, constantValues, label) => {
    const targets = records("colorTarget", targetValues, { max: limit("maxColorAttachments", 8) }).map((target) => {
      if (target.format === 0) return null;
      const result = { format: choice(formats, target.format), writeMask: integer(target.writeMask, "color write mask") };
      if (result.writeMask > 15) throw new Error("invalid GPU color write mask");
      if (flag(target.blend, "blend")) result.blend = { color: blendComponent(target.colorOperation, target.colorSrcFactor, target.colorDstFactor), alpha: blendComponent(target.alphaOperation, target.alphaSrcFactor, target.alphaDstFactor) };
      return result;
    });
    const result = { label, layout: layout ? ref(layout, "pipelineLayout") : "auto", vertex: { module: ref(vertexShader, "shaderModule"), entryPoint: vertexEntry, buffers: vertexLayouts(layouts), constants: constantsOf(constantValues, SHADER_STAGE_VERTEX) } };
    if (fragmentShader) result.fragment = { module: ref(fragmentShader, "shaderModule"), entryPoint: fragmentEntry, targets, constants: constantsOf(constantValues, SHADER_STAGE_FRAGMENT) };
    else if (targets.length) throw new Error("GPU colour targets need a fragment stage");
    const [primitive] = records("primitive", primitiveValues, { optional: true });
    if (primitive) result.primitive = { topology: optionalChoice(enums.topology, primitive.topology), stripIndexFormat: optionalChoice(enums.index, primitive.stripIndexFormat), frontFace: optionalChoice(enums.front, primitive.frontFace), cullMode: choice(enums.cull, primitive.cullMode), unclippedDepth: flag(primitive.unclippedDepth, "unclipped depth") };
    const [depth] = records("depthStencil", depthValues, { optional: true });
    if (depth) {
      if (depth.format === 0) throw new Error("GPU depth-stencil state needs a format");
      result.depthStencil = {
        format: choice(formats, depth.format), depthWriteEnabled: flag(depth.depthWrite, "depth write"), depthCompare: optionalChoice(enums.compare, depth.depthCompare),
        stencilFront: stencilFace(depth.frontCompare, depth.frontFail, depth.frontDepthFail, depth.frontPass), stencilBack: stencilFace(depth.backCompare, depth.backFail, depth.backDepthFail, depth.backPass),
        stencilReadMask: u32Field(depth.stencilReadMask, "stencil read mask"), stencilWriteMask: u32Field(depth.stencilWriteMask, "stencil write mask"),
        depthBias: i32Field(depth.depthBias, "depth bias"), depthBiasSlopeScale: finite(depth.depthBiasSlopeScale, "depth bias slope scale"), depthBiasClamp: finite(depth.depthBiasClamp, "depth bias clamp"),
      };
    }
    const [multisample] = records("multisample", multisampleValues, { optional: true });
    if (multisample) result.multisample = { count: integer(multisample.count, "sample count"), mask: u32Field(multisample.mask, "sample mask"), alphaToCoverageEnabled: flag(multisample.alphaToCoverage, "alpha to coverage") };
    return result;
  };
  const asyncPipeline = (handle, requestId, kind, make) => {
    const entry = handles.reserve(handle, kind);
    try {
      request(requestId, GPU_EVENT_PIPELINE_READY, handle, async (current, record) => {
        const value = await make();
        if (!current()) return;
        if (handles.complete(handle, entry, value)) settle(requestId, record, GPU_EVENT_PIPELINE_READY, GPU_STATUS_OK);
      }, { cleanup: (status) => { if (entry.request === requestId) { entry.request = 0; if (status !== GPU_STATUS_OK && entry.value === null) entry.failed = true; } } });
    } catch (error) { entry.failed = true; throw error; }
    entry.request = requestId;
  };
  const uploadRange = (slice) => {
    if (slice.offset + slice.length > uploadLength) throw new Error("GPU upload outside staging arena");
    const memory = getMemory();
    const ptr = uploadBase + slice.offset;
    range(memory, ptr, slice.length);
    return { memory, ptr, length: slice.length };
  };
  const encoder = (handle) => {
    const entry = handles.lookup(handle, "commandEncoder");
    const state = encoderState(entry);
    if (state.phase === LOCKED) throw new Error("GPU command encoder has an open pass");
    if (state.phase === FINISHED) throw new Error("GPU command encoder has finished");
    return entry;
  };
  const pass = (handle, kind) => {
    const entry = handles.lookup(handle, kind);
    const state = entry.state ??= passState(null);
    if (state.ended) throw new Error(`GPU ${kind === "renderPass" ? "render" : "compute"} pass has ended`);
    return entry;
  };
  const beginPass = (handle, kind, owner, make, setup) => {
    const state = passState(owner);
    setup?.(state);
    create(handle, kind, () => make(owner.value), state);
    encoderState(owner).phase = LOCKED;
  };
  const endPass = (handle, kind) => {
    const entry = pass(handle, kind);
    if (entry.state.occlusionActive) throw new Error("GPU occlusion query is still active");
    entry.value.end();
    entry.state.ended = true;
    const owner = entry.state.encoder?.state;
    if (owner?.phase === LOCKED) owner.phase = OPEN;
  };
  const drawable = (handle, indexed) => {
    const entry = pass(handle, "renderPass");
    if (!entry.state.pipeline) throw new Error("GPU draw without a render pipeline");
    if (indexed && !entry.state.index) throw new Error("GPU indexed draw without an index buffer");
    return entry.value;
  };
  const dispatchable = (handle) => {
    const entry = pass(handle, "computePass");
    if (!entry.state.pipeline) throw new Error("GPU dispatch without a compute pipeline");
    return entry.value;
  };
  const unmappedBuffer = (handle) => {
    const entry = handles.lookup(handle, "buffer");
    if (bufferState(entry).map !== UNMAPPED) throw new Error("GPU buffer is mapped or has a pending map");
    return entry.value;
  };

  const host = {
    protocolError(error, requestId, handle, fatal) {
      const data = { message: errorMessage(error) };
      if (fatal) data.fatal = true;
      // A rejected operation that reuses a pending id must not complete the original request.
      if (requestId && pending.has(requestId)) { data.duplicateRequestId = requestId; requestId = 0; }
      emit(GPU_EVENT_ERROR, requestId, handle, GPU_STATUS_ERROR, data);
    },
    skipRequest(requestId, type, handle) {
      if (!requestId) return;
      if (pending.has(requestId)) { emit(GPU_EVENT_ERROR, 0, handle, GPU_STATUS_ERROR, { message: "GPU request id is already pending", duplicateRequestId: requestId }); return; }
      emit(type, requestId, handle, GPU_STATUS_CANCELLED, { message: "GPU batch aborted before this request", ...(type === GPU_EVENT_CAPABILITIES ? { available: false } : {}) });
    },
    requestDevice(requestId, powerPreference, featureBitsValue, maxBufferSize) {
      if (featureBitsValue & ~1) throw new Error("unsupported GPU feature bits");
      negotiate(requestId, powerPreference, 0, featureBitsValue, maxBufferSize ? [GPU_LIMITS.findIndex((entry) => entry?.name === "maxBufferSize"), maxBufferSize, LIMIT_MODE_REQUIRED] : []);
    },
    requestDeviceWith(requestId, powerPreference, requiredFeatures, optionalFeatures, limitValues) { negotiate(requestId, powerPreference, requiredFeatures, optionalFeatures, limitValues); },
    cancelRequest(requestId) { cancel(requestId); },
    destroyDevice() {
      const current = active();
      loseDevice(deviceEpoch, "destroyed", "GPU device destroyed by the guest");
      current.destroy();
    },
    createBuffer(handle, size, usage, mappedAtCreation, label) {
      const bytes = integer(size, "buffer size");
      if (mappedAtCreation && bytes % 4) throw new Error("GPU mapped-at-creation buffer size must be a multiple of 4");
      create(handle, "buffer", () => active().createBuffer({ size: bytes, usage, mappedAtCreation, label }), { map: mappedAtCreation ? MAPPED : UNMAPPED });
    },
    createTexture(handle, width, height, depth, mipLevels, samples, dimension, format, usage, label) { create(handle, "texture", () => active().createTexture({ size: [width, height, depth], mipLevelCount: mipLevels, sampleCount: samples, dimension: choice(enums.dimension, dimension), format, usage, label })); },
    createTextureView(handle, texture, format, dimension, baseMip, mipCount, baseLayer, layerCount, aspect, label) {
      const descriptor = { label, baseMipLevel: baseMip, baseArrayLayer: baseLayer, aspect: choice(enums.aspect, aspect) };
      if (format) descriptor.format = format;
      if (dimension) descriptor.dimension = choice(enums.view, dimension);
      if (mipCount) descriptor.mipLevelCount = mipCount;
      if (layerCount) descriptor.arrayLayerCount = layerCount;
      const source = ref(texture, "texture");
      create(handle, "textureView", () => source.createView(descriptor));
    },
    createSampler(handle, addressU, addressV, addressW, magFilter, minFilter, mipmapFilter, lodMin, lodMax, compare, maxAnisotropy, label) { create(handle, "sampler", () => active().createSampler({ label, addressModeU: choice(enums.address, addressU), addressModeV: choice(enums.address, addressV), addressModeW: choice(enums.address, addressW), magFilter: choice(enums.filter, magFilter), minFilter: choice(enums.filter, minFilter), mipmapFilter: choice(enums.filter, mipmapFilter), lodMinClamp: lodMin, lodMaxClamp: lodMax, compare: compare ? choice(enums.compare, compare) : undefined, maxAnisotropy })); },
    createShaderModule(handle, requestId, code, label) {
      const module = create(handle, "shaderModule", () => active().createShaderModule({ code, label }));
      request(requestId, GPU_EVENT_SHADER_INFO, handle, async (current, record) => {
        const info = await module.getCompilationInfo();
        if (!current()) return;
        const messages = [...info.messages].map(({ message, type, lineNum, linePos, offset, length }) => ({ message, type, lineNum, linePos, offset, length }));
        settle(requestId, record, GPU_EVENT_SHADER_INFO, messages.some((message) => message.type === "error") ? GPU_STATUS_ERROR : GPU_STATUS_OK, { messages });
      });
    },
    createBindGroupLayout(handle, entries, label) {
      const result = records("bindGroupLayout", entries).map(({ binding, visibility, kind, type, dynamic, minSize, dimension, multisampled, format, access }) => {
        const entry = { binding: integer(binding, "binding"), visibility };
        if (kind === 1) entry.buffer = { type: choice(enums.buffer, type), hasDynamicOffset: dynamic !== 0, minBindingSize: integer(minSize, "min binding size") };
        else if (kind === 2) entry.sampler = { type: choice(enums.sampler, type) };
        else if (kind === 3) entry.texture = { sampleType: choice(enums.sample, type), viewDimension: choice(enums.view, dimension), multisampled: multisampled !== 0 };
        else if (kind === 4) entry.storageTexture = { access: choice(enums.access, access), format: choice(formats, format), viewDimension: choice(enums.view, dimension) };
        else throw new Error("unsupported GPU binding kind");
        return entry;
      });
      create(handle, "bindGroupLayout", () => active().createBindGroupLayout({ label, entries: result }));
    },
    createBindGroup(handle, layout, entries, label) {
      const result = records("bindGroup", entries).map(({ binding, kind, resource, offset, size }) => {
        let value;
        if (kind === 1) { value = { buffer: ref(resource, "buffer"), offset: integer(offset, "binding offset") }; if (size) value.size = integer(size, "binding size"); }
        else if (kind === 2) value = ref(resource, "sampler");
        else if (kind === 3 || kind === 4) value = ref(resource, "textureView");
        else throw new Error("unsupported GPU binding resource");
        return { binding: integer(binding, "binding"), resource: value };
      });
      const groupLayout = ref(layout, "bindGroupLayout");
      create(handle, "bindGroup", () => active().createBindGroup({ label, layout: groupLayout, entries: result }));
    },
    createPipelineLayout(handle, layouts, label) { const bindGroupLayouts = layouts.map((layout) => ref(layout, "bindGroupLayout")); create(handle, "pipelineLayout", () => active().createPipelineLayout({ label, bindGroupLayouts })); },
    createComputePipeline(handle, ...args) { const descriptor = computeDescriptor(...args); create(handle, "computePipeline", () => active().createComputePipeline(descriptor)); },
    createComputePipelineAsync(handle, requestId, ...args) { const descriptor = computeDescriptor(...args); const current = active(); asyncPipeline(handle, requestId, "computePipeline", () => current.createComputePipelineAsync(descriptor)); },
    createComputePipelineWith(handle, layout, shader, entry, constants, label) { const descriptor = computeDescriptor(layout, shader, entry, label, constantsOf(constants, SHADER_STAGE_COMPUTE)); create(handle, "computePipeline", () => active().createComputePipeline(descriptor)); },
    createComputePipelineAsyncWith(handle, requestId, layout, shader, entry, constants, label) { const descriptor = computeDescriptor(layout, shader, entry, label, constantsOf(constants, SHADER_STAGE_COMPUTE)); const current = active(); asyncPipeline(handle, requestId, "computePipeline", () => current.createComputePipelineAsync(descriptor)); },
    createRenderPipeline(handle, ...args) { const descriptor = renderDescriptor(...args); create(handle, "renderPipeline", () => active().createRenderPipeline(descriptor)); },
    createRenderPipelineAsync(handle, requestId, ...args) { const descriptor = renderDescriptor(...args); const current = active(); asyncPipeline(handle, requestId, "renderPipeline", () => current.createRenderPipelineAsync(descriptor)); },
    createRenderPipelineWith(handle, ...args) { const descriptor = renderDescriptorWith(...args); create(handle, "renderPipeline", () => active().createRenderPipeline(descriptor)); },
    createRenderPipelineAsyncWith(handle, requestId, ...args) { const descriptor = renderDescriptorWith(...args); const current = active(); asyncPipeline(handle, requestId, "renderPipeline", () => current.createRenderPipelineAsync(descriptor)); },
    createQuerySet(handle, type, count, label) {
      if (!Number.isInteger(count) || count < 1 || count > MAX_QUERIES) throw new Error("invalid GPU query count");
      if (type === QUERY_TYPE_TIMESTAMP && !active().features.has("timestamp-query")) throw new Error("GPU timestamp queries unavailable");
      if (type !== QUERY_TYPE_TIMESTAMP && type !== QUERY_TYPE_OCCLUSION) throw new Error("unsupported GPU query type");
      create(handle, "querySet", () => active().createQuerySet({ label, type: choice(enums.queryType, type), count }), { type, count });
    },
    createCommandEncoder(handle, label) { create(handle, "commandEncoder", () => active().createCommandEncoder({ label }), { phase: OPEN }); },
    beginComputePass(handle, encoderHandle, querySet, beginIndex, endIndex, label) {
      const owner = encoder(encoderHandle);
      const descriptor = { label, timestampWrites: timestampWrites(querySet, beginIndex, endIndex) };
      beginPass(handle, "computePass", owner, (value) => value.beginComputePass(descriptor));
    },
    computeSetPipeline(passHandle, pipeline) { const entry = pass(passHandle, "computePass"); entry.value.setPipeline(ref(pipeline, "computePipeline")); entry.state.pipeline = true; },
    computeSetBindGroup(passHandle, index, bindGroup, dynamicOffsets) { pass(passHandle, "computePass").value.setBindGroup(index, ref(bindGroup, "bindGroup"), dynamicOffsets); },
    computeDispatch(passHandle, x, y, z) { dispatchable(passHandle).dispatchWorkgroups(x, y, z); },
    computeDispatchIndirect(passHandle, buffer, offset) { dispatchable(passHandle).dispatchWorkgroupsIndirect(ref(buffer, "buffer"), integer(offset, "indirect offset")); },
    endComputePass(passHandle) { endPass(passHandle, "computePass"); },
    beginRenderPass(handle, encoderHandle, colorView, resolveView, colorLoad, colorStore, clearR, clearG, clearB, clearA, depthView, depthLoad, depthStore, clearDepth, querySet, beginIndex, endIndex, label) {
      const owner = encoder(encoderHandle);
      const descriptor = { label, colorAttachments: colorView ? [{ view: ref(colorView, "textureView"), resolveTarget: optional(resolveView, "textureView"), loadOp: choice(enums.load, colorLoad), storeOp: choice(enums.store, colorStore), clearValue: [clearR, clearG, clearB, clearA] }] : [], timestampWrites: timestampWrites(querySet, beginIndex, endIndex) };
      if (depthView) descriptor.depthStencilAttachment = { view: ref(depthView, "textureView"), depthLoadOp: choice(enums.load, depthLoad), depthStoreOp: choice(enums.store, depthStore), depthClearValue: clearDepth };
      beginPass(handle, "renderPass", owner, (value) => value.beginRenderPass(descriptor));
    },
    beginRenderPassWith(handle, encoderHandle, colors, depthStencil, occlusionQuerySet, timestampQuerySet, beginIndex, endIndex, label) {
      const owner = encoder(encoderHandle);
      const colorAttachments = records("colorAttachment", colors, { max: limit("maxColorAttachments", 8) }).map((color) => {
        if (color.view === 0) return null;
        const attachment = { view: ref(color.view, "textureView"), resolveTarget: optional(color.resolveView, "textureView"), loadOp: choice(enums.load, color.load), storeOp: choice(enums.store, color.store), clearValue: [finite(color.clearR, "clear value"), finite(color.clearG, "clear value"), finite(color.clearB, "clear value"), finite(color.clearA, "clear value")] };
        if (color.depthSlicePlusOne) attachment.depthSlice = integer(color.depthSlicePlusOne, "depth slice") - 1;
        return attachment;
      });
      const descriptor = { label, colorAttachments, timestampWrites: timestampWrites(timestampQuerySet, beginIndex, endIndex) };
      const [depth] = records("depthStencilAttachment", depthStencil, { optional: true });
      if (depth) descriptor.depthStencilAttachment = {
        view: ref(depth.view, "textureView"), depthLoadOp: optionalChoice(enums.load, depth.depthLoad), depthStoreOp: optionalChoice(enums.store, depth.depthStore), depthClearValue: finite(depth.depthClear, "depth clear value"), depthReadOnly: flag(depth.depthReadOnly, "depth read-only"),
        stencilLoadOp: optionalChoice(enums.load, depth.stencilLoad), stencilStoreOp: optionalChoice(enums.store, depth.stencilStore), stencilClearValue: u32Field(depth.stencilClear, "stencil clear value"), stencilReadOnly: flag(depth.stencilReadOnly, "stencil read-only"),
      };
      let occlusion = null;
      if (occlusionQuerySet) {
        occlusion = handles.lookup(occlusionQuerySet, "querySet");
        if (occlusion.state?.type !== QUERY_TYPE_OCCLUSION) throw new Error("GPU occlusion queries need an occlusion query set");
        descriptor.occlusionQuerySet = occlusion.value;
      }
      beginPass(handle, "renderPass", owner, (value) => value.beginRenderPass(descriptor), (state) => { if (occlusion) { state.occlusionSet = occlusion.state; state.occlusionUsed = new Set(); } });
    },
    renderSetViewport(passHandle, x, y, width, height, minDepth, maxDepth) { pass(passHandle, "renderPass").value.setViewport(x, y, width, height, minDepth, maxDepth); },
    renderSetScissor(passHandle, x, y, width, height) { pass(passHandle, "renderPass").value.setScissorRect(x, y, width, height); },
    renderSetPipeline(passHandle, pipeline) { const entry = pass(passHandle, "renderPass"); entry.value.setPipeline(ref(pipeline, "renderPipeline")); entry.state.pipeline = true; },
    renderSetBindGroup(passHandle, index, bindGroup, dynamicOffsets) { pass(passHandle, "renderPass").value.setBindGroup(index, ref(bindGroup, "bindGroup"), dynamicOffsets); },
    renderSetVertexBuffer(passHandle, slot, buffer, offset, size) { pass(passHandle, "renderPass").value.setVertexBuffer(slot, ref(buffer, "buffer"), integer(offset, "vertex offset"), size ? integer(size, "vertex size") : undefined); },
    renderSetIndexBuffer(passHandle, buffer, format, offset, size) { const entry = pass(passHandle, "renderPass"); entry.value.setIndexBuffer(ref(buffer, "buffer"), choice(enums.index, format), integer(offset, "index offset"), size ? integer(size, "index size") : undefined); entry.state.index = true; },
    renderSetStencilReference(passHandle, reference) { pass(passHandle, "renderPass").value.setStencilReference(reference); },
    renderSetBlendConstant(passHandle, r, g, b, a) { pass(passHandle, "renderPass").value.setBlendConstant([finite(r, "blend constant"), finite(g, "blend constant"), finite(b, "blend constant"), finite(a, "blend constant")]); },
    renderBeginOcclusionQuery(passHandle, index) {
      const entry = pass(passHandle, "renderPass"), state = entry.state;
      if (!state.occlusionSet) throw new Error("GPU render pass has no occlusion query set");
      if (state.occlusionActive) throw new Error("GPU occlusion query is already active");
      if (index >= state.occlusionSet.count || state.occlusionUsed.has(index)) throw new Error("invalid or reused GPU occlusion query index");
      entry.value.beginOcclusionQuery(index);
      state.occlusionUsed.add(index);
      state.occlusionActive = true;
    },
    renderEndOcclusionQuery(passHandle) {
      const entry = pass(passHandle, "renderPass");
      if (!entry.state.occlusionActive) throw new Error("GPU occlusion query is not active");
      entry.value.endOcclusionQuery();
      entry.state.occlusionActive = false;
    },
    renderDraw(passHandle, vertexCount, instanceCount, firstVertex, firstInstance) { drawable(passHandle, false).draw(vertexCount, instanceCount, firstVertex, firstInstance); },
    renderDrawIndexed(passHandle, indexCount, instanceCount, firstIndex, baseVertex, firstInstance) { drawable(passHandle, true).drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance); },
    renderDrawIndirect(passHandle, buffer, offset) { drawable(passHandle, false).drawIndirect(ref(buffer, "buffer"), integer(offset, "indirect offset")); },
    renderDrawIndexedIndirect(passHandle, buffer, offset) { drawable(passHandle, true).drawIndexedIndirect(ref(buffer, "buffer"), integer(offset, "indirect offset")); },
    endRenderPass(passHandle) { endPass(passHandle, "renderPass"); },
    copyBufferToBuffer(encoderHandle, source, sourceOffset, destination, destinationOffset, size) { encoder(encoderHandle).value.copyBufferToBuffer(ref(source, "buffer"), integer(sourceOffset, "copy offset"), ref(destination, "buffer"), integer(destinationOffset, "copy offset"), integer(size, "copy size")); },
    copyBufferToTexture(encoderHandle, source, sourceOffset, bytesPerRow, rowsPerImage, destination, mipLevel, originX, originY, originZ, aspect, width, height, depth) { encoder(encoderHandle).value.copyBufferToTexture({ buffer: ref(source, "buffer"), offset: integer(sourceOffset, "copy offset"), bytesPerRow, rowsPerImage }, { texture: ref(destination, "texture"), mipLevel, origin: [originX, originY, originZ], aspect: choice(enums.aspect, aspect) }, [width, height, depth]); },
    copyTextureToBuffer(encoderHandle, source, mipLevel, originX, originY, originZ, aspect, destination, offset, bytesPerRow, rowsPerImage, width, height, depth) {
      if (bytesPerRow % 256) throw new Error("GPU texture-to-buffer bytesPerRow must be a multiple of 256");
      encoder(encoderHandle).value.copyTextureToBuffer({ texture: ref(source, "texture"), mipLevel, origin: [originX, originY, originZ], aspect: choice(enums.aspect, aspect) }, { buffer: ref(destination, "buffer"), offset: integer(offset, "copy offset"), bytesPerRow, rowsPerImage: rowsPerImage || undefined }, [width, height, depth]);
    },
    copyTextureToTexture(encoderHandle, source, sourceMip, sourceX, sourceY, sourceZ, destination, destinationMip, destinationX, destinationY, destinationZ, width, height, depth) { encoder(encoderHandle).value.copyTextureToTexture({ texture: ref(source, "texture"), mipLevel: sourceMip, origin: [sourceX, sourceY, sourceZ] }, { texture: ref(destination, "texture"), mipLevel: destinationMip, origin: [destinationX, destinationY, destinationZ] }, [width, height, depth]); },
    clearBuffer(encoderHandle, buffer, offset, size) {
      const start = integer(offset, "clear offset"), length = integer(size, "clear size");
      if (start % 4 || length % 4) throw new Error("GPU clearBuffer offset and size must be multiples of 4");
      encoder(encoderHandle).value.clearBuffer(ref(buffer, "buffer"), start, length || undefined);
    },
    resolveQuerySet(encoderHandle, querySet, first, count, destination, offset) { encoder(encoderHandle).value.resolveQuerySet(ref(querySet, "querySet"), first, count, ref(destination, "buffer"), integer(offset, "query offset")); },
    finishCommandEncoder(handle, encoderHandle, label) {
      const owner = encoder(encoderHandle);
      create(handle, "commandBuffer", () => owner.value.finish({ label }), { submitted: false });
      encoderState(owner).phase = FINISHED;
    },
    queueSubmit(commandBuffers) {
      const queue = active().queue;
      const entries = commandBuffers.map((command) => handles.lookup(command, "commandBuffer"));
      if (new Set(entries).size !== entries.length) throw new Error("GPU command buffer listed twice in one submission");
      for (const entry of entries) if ((entry.state ??= { submitted: false }).submitted) throw new Error("GPU command buffer was already submitted");
      queue.submit(entries.map((entry) => entry.value));
      for (const entry of entries) entry.state.submitted = true;
    },
    writeBuffer(buffer, bufferOffset, data) {
      const target = unmappedBuffer(buffer), offset = integer(bufferOffset, "write offset");
      if (offset % 4 || data.length % 4) throw new Error("GPU writeBuffer offset and size must be multiples of 4");
      if (typeof target.size === "number" && offset + data.length > target.size) throw new Error("GPU writeBuffer outside buffer");
      const source = uploadRange(data);
      active().queue.writeBuffer(target, offset, source.memory, source.ptr, source.length);
      stats.uploadedBytes += source.length;
    },
    writeTexture(texture, mipLevel, originX, originY, originZ, aspect, data, bytesPerRow, rowsPerImage, width, height, depth) {
      const target = ref(texture, "texture");
      const source = uploadRange(data);
      active().queue.writeTexture({ texture: target, mipLevel, origin: [originX, originY, originZ], aspect: choice(enums.aspect, aspect) }, new Uint8Array(source.memory, source.ptr, source.length), { offset: 0, bytesPerRow, rowsPerImage }, [width, height, depth]);
      stats.uploadedBytes += source.length;
    },
    unmap(buffer) {
      const entry = handles.lookup(buffer, "buffer"), state = bufferState(entry);
      if (state.map === MAPPING) { cancel(entry.request, "GPU map cancelled by unmap"); return; }
      entry.value.unmap();
      state.map = UNMAPPED;
    },
    writeMappedBuffer(buffer, bufferOffset, data) {
      const entry = handles.lookup(buffer, "buffer");
      if (bufferState(entry).map !== MAPPED) throw new Error("GPU buffer is not mapped");
      const offset = integer(bufferOffset, "mapped offset");
      if (offset % 8 || data.length % 4) throw new Error("GPU mapped writes need an 8-byte offset and a size multiple of 4");
      const source = uploadRange(data);
      const mapped = entry.value.getMappedRange(offset, source.length);
      new Uint8Array(mapped).set(new Uint8Array(source.memory, source.ptr, source.length));
    },
    configureCanvas(format, usage, alphaMode, colorSpace) {
      const current = active();
      context = canvas.getContext("webgpu");
      if (!context) throw new Error("WebGPU canvas context unavailable");
      context.configure({ device: current, format: format || gpu.getPreferredCanvasFormat(), usage, alphaMode: choice(["opaque", "premultiplied"], alphaMode), colorSpace: choice(["srgb", "display-p3"], colorSpace) });
      configured = true;
    },
    getCurrentTexture(handle) { if (!context || !configured) throw new Error("GPU canvas not configured"); create(handle, "texture", () => context.getCurrentTexture()); },
    destroy(resource) { retireOwned(resource); handles.retire(resource, true); },
    release(resource) { retireOwned(resource); handles.retire(resource, false); },
    mapAsync(requestId, buffer, mode, offset, size, destination) {
      if (mode !== MAP_MODE_READ) throw new Error("GPU readback supports MAP_READ only");
      const entry = handles.lookup(buffer, "buffer"), resource = entry.value, state = bufferState(entry);
      const start = integer(offset, "map offset"), length = integer(size, "map size");
      if (start % 8 || length % 4 || length === 0) throw new Error("GPU map offset must be a multiple of 8 and its size a nonzero multiple of 4");
      if (typeof resource.size === "number" && start + length > resource.size) throw new Error("GPU map range outside buffer");
      if (state.map !== UNMAPPED) throw new Error("GPU buffer is mapped or has a pending map");
      if (destination.offset + destination.length > readbackLength || length > destination.length) throw new Error("GPU readback outside staging arena");
      const target = readbackBase + destination.offset;
      range(getMemory(), target, length);
      for (const other of pending.values()) if (other.readback && other.readback[0] < target + length && target < other.readback[1]) throw new Error("GPU readback range is in use by a pending request");
      request(requestId, GPU_EVENT_MAP_READY, buffer, async (current, record) => {
        await resource.mapAsync(mode, start, length);
        if (!current()) return;
        try {
          const memory = getMemory();
          range(memory, target, length);
          new Uint8Array(memory, target, length).set(new Uint8Array(resource.getMappedRange(start, length)));
        } finally {
          resource.unmap();
          state.map = UNMAPPED;
        }
        settle(requestId, record, GPU_EVENT_MAP_READY, GPU_STATUS_OK, { offset: destination.offset, length });
      }, {
        readback: [target, target + length],
        cleanup: (status) => {
          if (entry.request !== requestId) return;
          entry.request = 0;
          if (state.map === MAPPING) { state.map = UNMAPPED; if (status === GPU_STATUS_CANCELLED) resource.unmap(); }
        },
      });
      state.map = MAPPING;
      entry.request = requestId;
    },
    onSubmittedWorkDone(requestId) {
      const queue = active().queue;
      request(requestId, GPU_EVENT_WORK_DONE, 0, async (current, record) => { await queue.onSubmittedWorkDone(); if (current()) settle(requestId, record, GPU_EVENT_WORK_DONE, GPU_STATUS_OK); });
    },
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
      pending.clear();
      if (frameToken !== null) cancelRaf?.(frameToken);
      frameToken = null;
      observer?.disconnect(); media?.removeEventListener("change", changedDpr); scope.removeEventListener?.("resize", changedWindow);
      if (resizeFrame !== null) cancelRaf?.(resizeFrame);
      handles.clear(); context?.unconfigure(); device?.destroy(); device = null;
    },
    handles,
    stats,
    get device() { return device; },
    get adapter() { return adapter; },
    get idle() { return frameToken === null; },
    get pendingRequests() { return pending.size; },
  };
  return host;
}

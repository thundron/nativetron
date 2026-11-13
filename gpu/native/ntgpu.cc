// ntgpu facade over wgpu-native (C++17). See ntgpu.h for the contract and README.md for the implementation gaps
// this file works around. wgpu.h (implementation extensions) is used here only.
#include "ntgpu.h"

#include <webgpu/wgpu.h>

#include <atomic>
#include <cstddef>
#include <cstring>
#include <deque>
#include <mutex>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kDefaultEventCapacity = 256;
constexpr uint32_t kDefaultMessageLimit = 4096;

struct QueuedEvent {
  NtGpuEvent event;
  std::string message;
};

// One entry per pushed scope. wgpu-native only knows Validation and OutOfMemory filters and aborts the process on
// any other value, and it never raises Internal errors; Internal scopes are therefore tracked here and pop clean.
enum class ScopeKind : uint8_t { Native, EmulatedInternal };

std::string FromView(WGPUStringView view) {
  if (!view.data) return std::string();
  if (view.length == WGPU_STRLEN) return std::string(view.data);
  return std::string(view.data, view.length);
}

WGPUStringView View(const char *text) {
  WGPUStringView view;
  view.data = text;
  view.length = text ? WGPU_STRLEN : 0;
  return view;
}

}  // namespace

struct NtGpuContext {
  WGPUInstance instance = nullptr;
  WGPUAdapter adapter = nullptr;
  WGPUDevice device = nullptr;
  WGPUQueue queue = nullptr;

  // Device generation. lost_generation is the last generation whose DEVICE_LOST was emitted; callbacks may run on
  // other threads, so both are atomics.
  std::atomic<uint32_t> generation{0};
  std::atomic<uint32_t> lost_generation{0};
  std::atomic<uint32_t> pending{0};
  std::atomic<bool> closing{false};

  std::mutex mutex;  // guards events, dropped, and the request results below
  std::deque<QueuedEvent> events;
  uint64_t dropped = 0;
  uint32_t capacity = kDefaultEventCapacity;
  size_t message_limit = kDefaultMessageLimit;
  NtGpuWakeFn wake = nullptr;
  void *wake_user = nullptr;

  WGPUAdapter adapter_result = nullptr;
  WGPUDevice device_result = nullptr;
  std::atomic<uint32_t> requests_in_flight{0};

  std::vector<ScopeKind> scopes;
  std::string current_message;  // backs the last NtGpuEvent::message handed out
  std::string diag_message;     // backs the last NtGpuDiag::message
  std::string vendor, architecture, device_name, description;
  WGPUAdapterInfo info_cache{};
  bool info_valid = false;

  void Push(NtGpuEventKind kind, NtGpuStatus status, uint32_t detail, uint32_t gen, uint64_t token,
            std::string message) {
    if (closing.load()) return;
    bool was_empty = false;
    {
      std::lock_guard<std::mutex> lock(mutex);
      // Only uncaptured errors are droppable: completion and loss events are bounded by the outstanding
      // operations that produce them, and dropping one would leave a request without its completion.
      if (events.size() >= capacity && kind == NTGPU_EVENT_UNCAPTURED_ERROR) {
        ++dropped;
        return;
      }
      if (message.size() > message_limit) message.resize(message_limit);
      was_empty = events.empty();
      QueuedEvent queued;
      queued.event = NtGpuEvent{static_cast<uint32_t>(kind), static_cast<uint32_t>(status), detail, gen, token,
                                nullptr};
      queued.message = std::move(message);
      events.push_back(std::move(queued));
    }
    if (was_empty && wake) wake(wake_user);
  }

  // Emits DEVICE_LOST for gen exactly once.
  void Lost(uint32_t gen, WGPUDeviceLostReason reason, std::string message) {
    uint32_t seen = lost_generation.load();
    while (seen < gen) {
      if (lost_generation.compare_exchange_weak(seen, gen)) {
        Push(NTGPU_EVENT_DEVICE_LOST, NTGPU_ERR_DEVICE_LOST, static_cast<uint32_t>(reason), gen, 0,
             std::move(message));
        return;
      }
    }
  }

  bool Alive() const { return device && lost_generation.load() < generation.load(); }

  void ReleaseDevice() {
    if (!device) return;
    uint32_t gen = generation.load();
    // wgpu-native does not run the lost callback for destroy(); WebGPU does, so the facade emits it.
    Lost(gen, WGPUDeviceLostReason_Destroyed, "device destroyed");
    wgpuDeviceDestroy(device);
    if (queue) wgpuQueueRelease(queue);
    queue = nullptr;
    // Releasing the last reference waits for the GPU and fires outstanding map/work-done callbacks.
    wgpuDeviceRelease(device);
    device = nullptr;
    scopes.clear();
  }
};

namespace {

struct Op {
  NtGpuContext *ctx;
  uint64_t token;
  uint32_t generation;
};

NtGpuStatus SetDiag(NtGpuContext *ctx, NtGpuDiag *diag, NtGpuStatus status, WGPUErrorType type,
                    std::string message) {
  ctx->diag_message = std::move(message);
  if (diag) {
    diag->status = status;
    diag->error_type = type;
    diag->message = ctx->diag_message.c_str();
  }
  return status;
}

NtGpuStatus StatusOfError(WGPUErrorType type) {
  switch (type) {
    case WGPUErrorType_NoError: return NTGPU_OK;
    case WGPUErrorType_Validation: return NTGPU_ERR_VALIDATION;
    case WGPUErrorType_OutOfMemory: return NTGPU_ERR_OUT_OF_MEMORY;
    default: return NTGPU_ERR_INTERNAL;
  }
}

void OnAdapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void *user1,
               void *user2) {
  auto *ctx = static_cast<NtGpuContext *>(user1);
  uint64_t token = reinterpret_cast<uintptr_t>(user2);
  {
    std::lock_guard<std::mutex> lock(ctx->mutex);
    if (status == WGPURequestAdapterStatus_Success) ctx->adapter_result = adapter;
  }
  ctx->requests_in_flight.fetch_sub(1);
  ctx->Push(NTGPU_EVENT_ADAPTER, status == WGPURequestAdapterStatus_Success ? NTGPU_OK : NTGPU_ERR_UNAVAILABLE,
            static_cast<uint32_t>(status), 0, token, FromView(message));
}

void OnDevice(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void *user1, void *user2) {
  auto *ctx = static_cast<NtGpuContext *>(user1);
  (void)user2;
  std::lock_guard<std::mutex> lock(ctx->mutex);
  if (status == WGPURequestDeviceStatus_Success) ctx->device_result = device;
  else ctx->diag_message = FromView(message);
  ctx->requests_in_flight.fetch_sub(1);
}

void OnLost(WGPUDevice const *, WGPUDeviceLostReason reason, WGPUStringView message, void *user1, void *user2) {
  auto *ctx = static_cast<NtGpuContext *>(user1);
  uint32_t gen = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(user2));
  ctx->Lost(gen, reason, FromView(message));
}

void OnUncaptured(WGPUDevice const *, WGPUErrorType type, WGPUStringView message, void *user1, void *user2) {
  auto *ctx = static_cast<NtGpuContext *>(user1);
  uint32_t gen = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(user2));
  ctx->Push(NTGPU_EVENT_UNCAPTURED_ERROR, StatusOfError(type), static_cast<uint32_t>(type), gen, 0, FromView(message));
}

void OnMap(WGPUMapAsyncStatus status, WGPUStringView message, void *user1, void *) {
  Op *op = static_cast<Op *>(user1);
  op->ctx->pending.fetch_sub(1);
  op->ctx->Push(NTGPU_EVENT_MAP, status == WGPUMapAsyncStatus_Success ? NTGPU_OK : NTGPU_ERR_VALIDATION,
                static_cast<uint32_t>(status), op->generation, op->token, FromView(message));
  delete op;
}

void OnWorkDone(WGPUQueueWorkDoneStatus status, WGPUStringView message, void *user1, void *) {
  Op *op = static_cast<Op *>(user1);
  op->ctx->pending.fetch_sub(1);
  op->ctx->Push(NTGPU_EVENT_WORK_DONE, status == WGPUQueueWorkDoneStatus_Success ? NTGPU_OK : NTGPU_ERR_DEVICE_LOST,
                static_cast<uint32_t>(status), op->generation, op->token, FromView(message));
  delete op;
}

struct PopResult {
  bool done = false;
  WGPUPopErrorScopeStatus status = WGPUPopErrorScopeStatus_Error;
  WGPUErrorType type = WGPUErrorType_NoError;
  std::string message;
};

void OnPop(WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView message, void *user1, void *) {
  auto *result = static_cast<PopResult *>(user1);
  result->status = status;
  result->type = type;
  result->message = FromView(message);
  result->done = true;
}

// Implementations that complete callbacks only inside processEvents get one bounded drive here.
void Drive(NtGpuContext *ctx) {
  if (ctx->device) wgpuDevicePoll(ctx->device, 1, nullptr);
  else wgpuInstanceProcessEvents(ctx->instance);
}

void FillInfo(NtGpuContext *ctx, NtGpuCapabilities *out) {
  out->vendor = ctx->vendor.c_str();
  out->architecture = ctx->architecture.c_str();
  out->device = ctx->device_name.c_str();
  out->description = ctx->description.c_str();
  out->backend = ctx->info_cache.backendType;
  out->adapter_type = ctx->info_cache.adapterType;
  out->vendor_id = ctx->info_cache.vendorID;
  out->device_id = ctx->info_cache.deviceID;
}

void FillFeatures(const WGPUSupportedFeatures &features, NtGpuCapabilities *out) {
  out->feature_count = 0;
  for (size_t i = 0; i < features.featureCount && out->feature_count < NTGPU_MAX_FEATURES; ++i) {
    out->features[out->feature_count++] = features.features[i];
  }
}

NtGpuStatus LoadAdapterInfo(NtGpuContext *ctx) {
  WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
  if (wgpuAdapterGetInfo(ctx->adapter, &info) != WGPUStatus_Success) return NTGPU_ERR_INTERNAL;
  ctx->vendor = FromView(info.vendor);
  ctx->architecture = FromView(info.architecture);
  ctx->device_name = FromView(info.device);
  ctx->description = FromView(info.description);
  ctx->info_cache = info;
  ctx->info_cache.vendor = ctx->info_cache.architecture = ctx->info_cache.device = ctx->info_cache.description =
      WGPUStringView{nullptr, 0};
  wgpuAdapterInfoFreeMembers(info);
  ctx->info_valid = true;
  return NTGPU_OK;
}

struct FeatureName {
  WGPUFeatureName feature;
  const char *name;
};

constexpr FeatureName kFeatures[] = {
    {WGPUFeatureName_CoreFeaturesAndLimits, "core-features-and-limits"},
    {WGPUFeatureName_DepthClipControl, "depth-clip-control"},
    {WGPUFeatureName_Depth32FloatStencil8, "depth32float-stencil8"},
    {WGPUFeatureName_TextureCompressionBC, "texture-compression-bc"},
    {WGPUFeatureName_TextureCompressionBCSliced3D, "texture-compression-bc-sliced-3d"},
    {WGPUFeatureName_TextureCompressionETC2, "texture-compression-etc2"},
    {WGPUFeatureName_TextureCompressionASTC, "texture-compression-astc"},
    {WGPUFeatureName_TextureCompressionASTCSliced3D, "texture-compression-astc-sliced-3d"},
    {WGPUFeatureName_TimestampQuery, "timestamp-query"},
    {WGPUFeatureName_IndirectFirstInstance, "indirect-first-instance"},
    {WGPUFeatureName_ShaderF16, "shader-f16"},
    {WGPUFeatureName_RG11B10UfloatRenderable, "rg11b10ufloat-renderable"},
    {WGPUFeatureName_BGRA8UnormStorage, "bgra8unorm-storage"},
    {WGPUFeatureName_Float32Filterable, "float32-filterable"},
    {WGPUFeatureName_Float32Blendable, "float32-blendable"},
    {WGPUFeatureName_ClipDistances, "clip-distances"},
    {WGPUFeatureName_DualSourceBlending, "dual-source-blending"},
    {WGPUFeatureName_Subgroups, "subgroups"},
    {WGPUFeatureName_TextureFormatsTier1, "texture-formats-tier1"},
    {WGPUFeatureName_TextureFormatsTier2, "texture-formats-tier2"},
    {WGPUFeatureName_PrimitiveIndex, "primitive-index"},
    {WGPUFeatureName_TextureComponentSwizzle, "texture-component-swizzle"},
};

struct LimitField {
  const char *name;
  size_t offset;
  bool wide;
};

#define NTGPU_LIMIT(field, wide) {#field, offsetof(WGPULimits, field), wide}
constexpr LimitField kLimits[] = {
    NTGPU_LIMIT(maxTextureDimension1D, false),
    NTGPU_LIMIT(maxTextureDimension2D, false),
    NTGPU_LIMIT(maxTextureDimension3D, false),
    NTGPU_LIMIT(maxTextureArrayLayers, false),
    NTGPU_LIMIT(maxBindGroups, false),
    NTGPU_LIMIT(maxBindGroupsPlusVertexBuffers, false),
    NTGPU_LIMIT(maxBindingsPerBindGroup, false),
    NTGPU_LIMIT(maxDynamicUniformBuffersPerPipelineLayout, false),
    NTGPU_LIMIT(maxDynamicStorageBuffersPerPipelineLayout, false),
    NTGPU_LIMIT(maxSampledTexturesPerShaderStage, false),
    NTGPU_LIMIT(maxSamplersPerShaderStage, false),
    NTGPU_LIMIT(maxStorageBuffersPerShaderStage, false),
    NTGPU_LIMIT(maxStorageTexturesPerShaderStage, false),
    NTGPU_LIMIT(maxUniformBuffersPerShaderStage, false),
    NTGPU_LIMIT(maxUniformBufferBindingSize, true),
    NTGPU_LIMIT(maxStorageBufferBindingSize, true),
    NTGPU_LIMIT(minUniformBufferOffsetAlignment, false),
    NTGPU_LIMIT(minStorageBufferOffsetAlignment, false),
    NTGPU_LIMIT(maxVertexBuffers, false),
    NTGPU_LIMIT(maxBufferSize, true),
    NTGPU_LIMIT(maxVertexAttributes, false),
    NTGPU_LIMIT(maxVertexBufferArrayStride, false),
    NTGPU_LIMIT(maxInterStageShaderVariables, false),
    NTGPU_LIMIT(maxColorAttachments, false),
    NTGPU_LIMIT(maxColorAttachmentBytesPerSample, false),
    NTGPU_LIMIT(maxComputeWorkgroupStorageSize, false),
    NTGPU_LIMIT(maxComputeInvocationsPerWorkgroup, false),
    NTGPU_LIMIT(maxComputeWorkgroupSizeX, false),
    NTGPU_LIMIT(maxComputeWorkgroupSizeY, false),
    NTGPU_LIMIT(maxComputeWorkgroupSizeZ, false),
    NTGPU_LIMIT(maxComputeWorkgroupsPerDimension, false),
    NTGPU_LIMIT(maxImmediateSize, false),
};
#undef NTGPU_LIMIT

// Creation helper: validation + out-of-memory scopes around fn, first captured error wins.
template <typename Fn>
NtGpuStatus Scoped(NtGpuContext *ctx, NtGpuDiag *diag, Fn fn) {
  if (!ctx || !ctx->device) return SetDiag(ctx, diag, NTGPU_ERR_ARGUMENT, WGPUErrorType_Unknown, "no device");
  if (!ctx->Alive()) return SetDiag(ctx, diag, NTGPU_ERR_DEVICE_LOST, WGPUErrorType_Unknown, "device lost");
  ntgpu_scope_push(ctx, WGPUErrorFilter_Validation);
  ntgpu_scope_push(ctx, WGPUErrorFilter_OutOfMemory);
  fn();
  NtGpuDiag oom{}, validation{};
  NtGpuStatus a = ntgpu_scope_pop(ctx, &oom);
  std::string oom_message = oom.message ? oom.message : "";
  NtGpuStatus b = ntgpu_scope_pop(ctx, &validation);
  if (a != NTGPU_OK || b != NTGPU_OK) return SetDiag(ctx, diag, NTGPU_ERR_INTERNAL, WGPUErrorType_Internal,
                                                     "error scope bookkeeping failed");
  if (validation.status != NTGPU_OK) return SetDiag(ctx, diag, static_cast<NtGpuStatus>(validation.status),
                                                    static_cast<WGPUErrorType>(validation.error_type),
                                                    validation.message ? validation.message : "");
  if (oom.status != NTGPU_OK) return SetDiag(ctx, diag, static_cast<NtGpuStatus>(oom.status),
                                             static_cast<WGPUErrorType>(oom.error_type), oom_message);
  return SetDiag(ctx, diag, NTGPU_OK, WGPUErrorType_NoError, "");
}

}  // namespace

extern "C" {

NtGpuStatus ntgpu_context_create(const NtGpuContextOptions *options, NtGpuContext **out) {
  if (!out) return NTGPU_ERR_ARGUMENT;
  *out = nullptr;
  if (options && options->api_version != NTGPU_API_VERSION) return NTGPU_ERR_ARGUMENT;
  auto *ctx = new (std::nothrow) NtGpuContext();
  if (!ctx) return NTGPU_ERR_OUT_OF_MEMORY;
  if (options) {
    if (options->event_capacity) ctx->capacity = options->event_capacity;
    if (options->message_limit) ctx->message_limit = options->message_limit;
    ctx->wake = options->wake;
    ctx->wake_user = options->wake_user;
  }
  WGPUInstanceDescriptor descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
  ctx->instance = wgpuCreateInstance(&descriptor);
  if (!ctx->instance) {
    delete ctx;
    return NTGPU_ERR_UNAVAILABLE;
  }
  *out = ctx;
  return NTGPU_OK;
}

void ntgpu_context_destroy(NtGpuContext *ctx) {
  if (!ctx) return;
  ctx->closing.store(true);
  ctx->ReleaseDevice();
  if (ctx->adapter) wgpuAdapterRelease(ctx->adapter);
  if (ctx->instance) wgpuInstanceRelease(ctx->instance);
  delete ctx;
}

uint32_t ntgpu_implementation_version(void) { return wgpuGetVersion(); }
const char *ntgpu_implementation_name(void) { return "wgpu-native"; }

NtGpuStatus ntgpu_request_adapter(NtGpuContext *ctx, uint64_t token, WGPUPowerPreference power) {
  if (!ctx) return NTGPU_ERR_ARGUMENT;
  if (ctx->device) return NTGPU_ERR_ARGUMENT;  // adapter is fixed while a device exists
  if (ctx->adapter) {
    wgpuAdapterRelease(ctx->adapter);
    ctx->adapter = nullptr;
    ctx->info_valid = false;
  }
  {
    std::lock_guard<std::mutex> lock(ctx->mutex);
    ctx->adapter_result = nullptr;
  }
  WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
  options.powerPreference = power;
#if defined(__APPLE__)
  options.backendType = WGPUBackendType_Metal;
#endif
  WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.callback = OnAdapter;
  callback.userdata1 = ctx;
  callback.userdata2 = reinterpret_cast<void *>(static_cast<uintptr_t>(token));
  ctx->requests_in_flight.fetch_add(1);
  wgpuInstanceRequestAdapter(ctx->instance, &options, callback);
  if (ctx->requests_in_flight.load() != 0) wgpuInstanceProcessEvents(ctx->instance);
  if (ctx->requests_in_flight.load() != 0) return NTGPU_ERR_INTERNAL;
  std::lock_guard<std::mutex> lock(ctx->mutex);
  ctx->adapter = ctx->adapter_result;
  ctx->adapter_result = nullptr;
  if (!ctx->adapter) return NTGPU_ERR_UNAVAILABLE;
  return NTGPU_OK;
}

NtGpuStatus ntgpu_adapter_capabilities(NtGpuContext *ctx, NtGpuCapabilities *out) {
  if (!ctx || !out || !ctx->adapter) return NTGPU_ERR_ARGUMENT;
  if (!ctx->info_valid && LoadAdapterInfo(ctx) != NTGPU_OK) return NTGPU_ERR_INTERNAL;
  std::memset(out, 0, sizeof(*out));
  FillInfo(ctx, out);
  out->limits = WGPU_LIMITS_INIT;
  if (wgpuAdapterGetLimits(ctx->adapter, &out->limits) != WGPUStatus_Success) return NTGPU_ERR_INTERNAL;
  WGPUSupportedFeatures features = WGPU_SUPPORTED_FEATURES_INIT;
  wgpuAdapterGetFeatures(ctx->adapter, &features);
  FillFeatures(features, out);
  wgpuSupportedFeaturesFreeMembers(features);
  return NTGPU_OK;
}

NtGpuStatus ntgpu_request_device(NtGpuContext *ctx, uint64_t token, const WGPUFeatureName *required_features,
                                 size_t required_feature_count, const WGPULimits *required_limits) {
  if (!ctx || !ctx->adapter || (required_feature_count && !required_features)) return NTGPU_ERR_ARGUMENT;
  // wgpu-native silently ignores required features it cannot map (e.g. standard Subgroups, which it only offers
  // as a native feature) and creates the device anyway; WebGPU refuses. Check against the adapter first.
  {
    WGPUSupportedFeatures adapter_features = WGPU_SUPPORTED_FEATURES_INIT;
    wgpuAdapterGetFeatures(ctx->adapter, &adapter_features);
    std::string missing;
    for (size_t i = 0; i < required_feature_count; ++i) {
      bool found = false;
      for (size_t k = 0; k < adapter_features.featureCount && !found; ++k) {
        found = adapter_features.features[k] == required_features[i];
      }
      if (!found) {
        const char *name = ntgpu_feature_name(required_features[i]);
        missing += missing.empty() ? "" : ", ";
        missing += name ? name : std::to_string(static_cast<uint32_t>(required_features[i]));
      }
    }
    wgpuSupportedFeaturesFreeMembers(adapter_features);
    if (!missing.empty()) {
      ctx->Push(NTGPU_EVENT_DEVICE, NTGPU_ERR_UNAVAILABLE, 0, ctx->generation.load(), token,
                "adapter lacks required features: " + missing);
      return NTGPU_ERR_UNAVAILABLE;
    }
  }
  ctx->ReleaseDevice();
  uint32_t gen = ctx->generation.load() + 1;
  WGPUDeviceDescriptor descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
  descriptor.label = View("nativetron");
  descriptor.requiredFeatureCount = required_feature_count;
  descriptor.requiredFeatures = required_features;
  descriptor.requiredLimits = required_limits;
  descriptor.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
  descriptor.deviceLostCallbackInfo.callback = OnLost;
  descriptor.deviceLostCallbackInfo.userdata1 = ctx;
  descriptor.deviceLostCallbackInfo.userdata2 = reinterpret_cast<void *>(static_cast<uintptr_t>(gen));
  descriptor.uncapturedErrorCallbackInfo.callback = OnUncaptured;
  descriptor.uncapturedErrorCallbackInfo.userdata1 = ctx;
  descriptor.uncapturedErrorCallbackInfo.userdata2 = reinterpret_cast<void *>(static_cast<uintptr_t>(gen));
  WGPURequestDeviceCallbackInfo callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.callback = OnDevice;
  callback.userdata1 = ctx;
  {
    std::lock_guard<std::mutex> lock(ctx->mutex);
    ctx->device_result = nullptr;
    ctx->diag_message.clear();
  }
  ctx->requests_in_flight.fetch_add(1);
  wgpuAdapterRequestDevice(ctx->adapter, &descriptor, callback);
  if (ctx->requests_in_flight.load() != 0) wgpuInstanceProcessEvents(ctx->instance);
  WGPUDevice device;
  std::string message;
  {
    std::lock_guard<std::mutex> lock(ctx->mutex);
    device = ctx->device_result;
    ctx->device_result = nullptr;
    message = ctx->diag_message;
  }
  if (!device) {
    ctx->Push(NTGPU_EVENT_DEVICE, NTGPU_ERR_UNAVAILABLE, 0, ctx->generation.load(), token,
              message.empty() ? std::string("device request failed") : message);
    return NTGPU_ERR_UNAVAILABLE;
  }
  ctx->device = device;
  ctx->queue = wgpuDeviceGetQueue(device);
  ctx->generation.store(gen);
  ctx->Push(NTGPU_EVENT_DEVICE, NTGPU_OK, 0, gen, token, std::string());
  return NTGPU_OK;
}

NtGpuStatus ntgpu_device_capabilities(NtGpuContext *ctx, NtGpuCapabilities *out) {
  if (!ctx || !out || !ctx->device) return NTGPU_ERR_ARGUMENT;
  if (!ctx->info_valid && LoadAdapterInfo(ctx) != NTGPU_OK) return NTGPU_ERR_INTERNAL;
  std::memset(out, 0, sizeof(*out));
  FillInfo(ctx, out);  // wgpuDeviceGetAdapterInfo is unimplemented; the device's adapter is ctx->adapter
  out->limits = WGPU_LIMITS_INIT;
  if (wgpuDeviceGetLimits(ctx->device, &out->limits) != WGPUStatus_Success) return NTGPU_ERR_INTERNAL;
  WGPUSupportedFeatures features = WGPU_SUPPORTED_FEATURES_INIT;
  wgpuDeviceGetFeatures(ctx->device, &features);
  FillFeatures(features, out);
  wgpuSupportedFeaturesFreeMembers(features);
  return NTGPU_OK;
}

NtGpuStatus ntgpu_device_destroy(NtGpuContext *ctx) {
  if (!ctx || !ctx->device) return NTGPU_ERR_ARGUMENT;
  ctx->Lost(ctx->generation.load(), WGPUDeviceLostReason_Destroyed, "device destroyed");
  wgpuDeviceDestroy(ctx->device);
  return NTGPU_OK;
}

NtGpuStatus ntgpu_device_release(NtGpuContext *ctx) {
  if (!ctx || !ctx->device) return NTGPU_ERR_ARGUMENT;
  ctx->ReleaseDevice();
  return NTGPU_OK;
}

int ntgpu_device_alive(const NtGpuContext *ctx) { return ctx && ctx->Alive() ? 1 : 0; }
uint32_t ntgpu_device_generation(const NtGpuContext *ctx) { return ctx ? ctx->generation.load() : 0; }
WGPUInstance ntgpu_instance(const NtGpuContext *ctx) { return ctx ? ctx->instance : nullptr; }
WGPUAdapter ntgpu_adapter(const NtGpuContext *ctx) { return ctx ? ctx->adapter : nullptr; }
WGPUDevice ntgpu_device(const NtGpuContext *ctx) { return ctx ? ctx->device : nullptr; }
WGPUQueue ntgpu_queue(const NtGpuContext *ctx) { return ctx ? ctx->queue : nullptr; }

NtGpuStatus ntgpu_scope_push(NtGpuContext *ctx, WGPUErrorFilter filter) {
  if (!ctx || !ctx->device) return NTGPU_ERR_ARGUMENT;
  switch (filter) {
    case WGPUErrorFilter_Validation:
    case WGPUErrorFilter_OutOfMemory:
      wgpuDevicePushErrorScope(ctx->device, filter);
      ctx->scopes.push_back(ScopeKind::Native);
      return NTGPU_OK;
    case WGPUErrorFilter_Internal:
      ctx->scopes.push_back(ScopeKind::EmulatedInternal);
      return NTGPU_OK;
    default:
      return NTGPU_ERR_ARGUMENT;
  }
}

NtGpuStatus ntgpu_scope_pop(NtGpuContext *ctx, NtGpuDiag *out) {
  if (!ctx || !ctx->device) return NTGPU_ERR_ARGUMENT;
  if (ctx->scopes.empty()) {
    SetDiag(ctx, out, NTGPU_ERR_ARGUMENT, WGPUErrorType_Unknown, "error scope stack is empty");
    return NTGPU_ERR_ARGUMENT;
  }
  ScopeKind kind = ctx->scopes.back();
  ctx->scopes.pop_back();
  if (kind == ScopeKind::EmulatedInternal) {
    SetDiag(ctx, out, NTGPU_OK, WGPUErrorType_NoError, "");
    return NTGPU_OK;
  }
  PopResult result;
  WGPUPopErrorScopeCallbackInfo callback = WGPU_POP_ERROR_SCOPE_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.callback = OnPop;
  callback.userdata1 = &result;
  wgpuDevicePopErrorScope(ctx->device, callback);
  if (!result.done) Drive(ctx);
  if (!result.done) {
    // The callback would otherwise write into a dead stack frame later; this implementation never defers it.
    SetDiag(ctx, out, NTGPU_ERR_INTERNAL, WGPUErrorType_Internal, "popErrorScope did not complete");
    return NTGPU_ERR_INTERNAL;
  }
  if (result.status != WGPUPopErrorScopeStatus_Success) {
    SetDiag(ctx, out, NTGPU_ERR_INTERNAL, WGPUErrorType_Unknown, result.message);
    return NTGPU_OK;
  }
  SetDiag(ctx, out, StatusOfError(result.type), result.type, std::move(result.message));
  return NTGPU_OK;
}

uint32_t ntgpu_scope_depth(const NtGpuContext *ctx) { return ctx ? static_cast<uint32_t>(ctx->scopes.size()) : 0; }

NtGpuStatus ntgpu_compile_wgsl(NtGpuContext *ctx, const char *source, size_t length, const char *label,
                               WGPUShaderModule *out, NtGpuDiag *diag) {
  if (!out || !source) return NTGPU_ERR_ARGUMENT;
  *out = nullptr;
  WGPUShaderModule module = nullptr;
  NtGpuStatus status = Scoped(ctx, diag, [&] {
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source, length};
    WGPUShaderModuleDescriptor descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = View(label);
    module = wgpuDeviceCreateShaderModule(ctx->device, &descriptor);
  });
  if (status != NTGPU_OK) {
    if (module) wgpuShaderModuleRelease(module);
    return status;
  }
  *out = module;
  return NTGPU_OK;
}

NtGpuStatus ntgpu_create_compute_pipeline(NtGpuContext *ctx, WGPUShaderModule module, const char *entry_point,
                                          const WGPUConstantEntry *constants, size_t constant_count,
                                          WGPUPipelineLayout layout, WGPUComputePipeline *out, NtGpuDiag *diag) {
  if (!out || !module || (constant_count && !constants)) return NTGPU_ERR_ARGUMENT;
  *out = nullptr;
  WGPUComputePipeline pipeline = nullptr;
  NtGpuStatus status = Scoped(ctx, diag, [&] {
    WGPUComputePipelineDescriptor descriptor = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.compute.module = module;
    descriptor.compute.entryPoint = View(entry_point);
    descriptor.compute.constantCount = constant_count;
    descriptor.compute.constants = constants;
    pipeline = wgpuDeviceCreateComputePipeline(ctx->device, &descriptor);
  });
  if (status != NTGPU_OK) {
    if (pipeline) wgpuComputePipelineRelease(pipeline);
    return status;
  }
  *out = pipeline;
  return NTGPU_OK;
}

NtGpuStatus ntgpu_create_render_pipeline(NtGpuContext *ctx, const WGPURenderPipelineDescriptor *descriptor,
                                         WGPURenderPipeline *out, NtGpuDiag *diag) {
  if (!out || !descriptor) return NTGPU_ERR_ARGUMENT;
  *out = nullptr;
  WGPURenderPipeline pipeline = nullptr;
  NtGpuStatus status =
      Scoped(ctx, diag, [&] { pipeline = wgpuDeviceCreateRenderPipeline(ctx->device, descriptor); });
  if (status != NTGPU_OK) {
    if (pipeline) wgpuRenderPipelineRelease(pipeline);
    return status;
  }
  *out = pipeline;
  return NTGPU_OK;
}

NtGpuStatus ntgpu_map_async(NtGpuContext *ctx, WGPUBuffer buffer, WGPUMapMode mode, size_t offset, size_t size,
                            uint64_t token) {
  if (!ctx || !buffer || (mode != WGPUMapMode_Read && mode != WGPUMapMode_Write)) return NTGPU_ERR_ARGUMENT;
  if (!ctx->device) return NTGPU_ERR_ARGUMENT;
  if (!ctx->Alive()) return NTGPU_ERR_DEVICE_LOST;
  auto *op = new (std::nothrow) Op{ctx, token, ctx->generation.load()};
  if (!op) return NTGPU_ERR_OUT_OF_MEMORY;
  WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.callback = OnMap;
  callback.userdata1 = op;
  ctx->pending.fetch_add(1);
  // A refused map completes its callback with an error before returning (wgpu-core) and also raises a validation
  // error; capture it so it does not surface as an uncaptured error.
  NtGpuDiag ignored;
  Scoped(ctx, &ignored, [&] { wgpuBufferMapAsync(buffer, mode, offset, size, callback); });
  return NTGPU_OK;
}

NtGpuStatus ntgpu_work_done(NtGpuContext *ctx, uint64_t token) {
  if (!ctx || !ctx->queue) return NTGPU_ERR_ARGUMENT;
  if (!ctx->Alive()) return NTGPU_ERR_DEVICE_LOST;
  auto *op = new (std::nothrow) Op{ctx, token, ctx->generation.load()};
  if (!op) return NTGPU_ERR_OUT_OF_MEMORY;
  WGPUQueueWorkDoneCallbackInfo callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.callback = OnWorkDone;
  callback.userdata1 = op;
  ctx->pending.fetch_add(1);
  wgpuQueueOnSubmittedWorkDone(ctx->queue, callback);
  return NTGPU_OK;
}

uint32_t ntgpu_pending(const NtGpuContext *ctx) { return ctx ? ctx->pending.load() : 0; }

uint32_t ntgpu_process(NtGpuContext *ctx, int wait) {
  if (!ctx) return 0;
  if (ctx->pending.load() == 0) return 0;
  if (ctx->device) wgpuDevicePoll(ctx->device, wait ? 1 : 0, nullptr);
  else wgpuInstanceProcessEvents(ctx->instance);
  return ctx->pending.load();
}

NtGpuStatus ntgpu_report_error(NtGpuContext *ctx, WGPUErrorType type, const char *message) {
  if (!ctx || !ctx->device) return NTGPU_ERR_ARGUMENT;
  ctx->Push(NTGPU_EVENT_UNCAPTURED_ERROR, StatusOfError(type), static_cast<uint32_t>(type), ctx->generation.load(), 0,
            message ? message : "");
  return NTGPU_OK;
}

int ntgpu_next_event(NtGpuContext *ctx, NtGpuEvent *out) {
  if (!ctx || !out) return 0;
  std::lock_guard<std::mutex> lock(ctx->mutex);
  if (ctx->events.empty()) {
    if (!ctx->dropped) return 0;
    *out = NtGpuEvent{NTGPU_EVENT_OVERFLOW, NTGPU_ERR_INTERNAL, 0, ctx->generation.load(), ctx->dropped, ""};
    ctx->dropped = 0;
    return 1;
  }
  QueuedEvent &front = ctx->events.front();
  ctx->current_message = std::move(front.message);
  *out = front.event;
  out->message = ctx->current_message.c_str();
  ctx->events.pop_front();
  return 1;
}

uint32_t ntgpu_queued_events(NtGpuContext *ctx) {
  if (!ctx) return 0;
  std::lock_guard<std::mutex> lock(ctx->mutex);
  return static_cast<uint32_t>(ctx->events.size()) + (ctx->dropped ? 1u : 0u);
}

NtGpuStatus ntgpu_surface_from_metal_layer(NtGpuContext *ctx, void *layer, WGPUSurface *out) {
  if (!ctx || !layer || !out) return NTGPU_ERR_ARGUMENT;
  WGPUSurfaceSourceMetalLayer source = WGPU_SURFACE_SOURCE_METAL_LAYER_INIT;
  source.layer = layer;
  WGPUSurfaceDescriptor descriptor = WGPU_SURFACE_DESCRIPTOR_INIT;
  descriptor.nextInChain = &source.chain;
  *out = wgpuInstanceCreateSurface(ctx->instance, &descriptor);
  return *out ? NTGPU_OK : NTGPU_ERR_UNAVAILABLE;
}

NtGpuStatus ntgpu_surface_configure(NtGpuContext *ctx, WGPUSurface surface, WGPUTextureFormat format, uint32_t width,
                                    uint32_t height, WGPUPresentMode present_mode, WGPUCompositeAlphaMode alpha,
                                    WGPUTextureFormat *chosen) {
  if (!ctx || !surface || !ctx->adapter || !ctx->device || !width || !height) return NTGPU_ERR_ARGUMENT;
  if (!ctx->Alive()) return NTGPU_ERR_DEVICE_LOST;
  WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
  if (wgpuSurfaceGetCapabilities(surface, ctx->adapter, &caps) != WGPUStatus_Success || caps.formatCount == 0) {
    wgpuSurfaceCapabilitiesFreeMembers(caps);
    return NTGPU_ERR_UNAVAILABLE;
  }
  bool format_ok = format == WGPUTextureFormat_Undefined;
  for (size_t i = 0; i < caps.formatCount && !format_ok; ++i) format_ok = caps.formats[i] == format;
  bool present_ok = false;
  for (size_t i = 0; i < caps.presentModeCount && !present_ok; ++i) present_ok = caps.presentModes[i] == present_mode;
  bool alpha_ok = alpha == WGPUCompositeAlphaMode_Auto;
  for (size_t i = 0; i < caps.alphaModeCount && !alpha_ok; ++i) alpha_ok = caps.alphaModes[i] == alpha;
  WGPUTextureFormat use = format == WGPUTextureFormat_Undefined ? caps.formats[0] : format;
  wgpuSurfaceCapabilitiesFreeMembers(caps);
  if (!format_ok || !present_ok || !alpha_ok) return NTGPU_ERR_UNAVAILABLE;
  WGPUSurfaceConfiguration config = WGPU_SURFACE_CONFIGURATION_INIT;
  config.device = ctx->device;
  config.format = use;
  config.usage = WGPUTextureUsage_RenderAttachment;
  config.width = width;
  config.height = height;
  config.alphaMode = alpha;
  config.presentMode = present_mode;
  NtGpuDiag diag;
  NtGpuStatus status = Scoped(ctx, &diag, [&] { wgpuSurfaceConfigure(surface, &config); });
  if (status != NTGPU_OK) return status;
  if (chosen) *chosen = use;
  return NTGPU_OK;
}

const char *ntgpu_feature_name(WGPUFeatureName feature) {
  for (const FeatureName &entry : kFeatures) {
    if (entry.feature == feature) return entry.name;
  }
  return nullptr;
}

int ntgpu_feature_from_name(const char *name, WGPUFeatureName *out) {
  if (!name || !out) return 0;
  for (const FeatureName &entry : kFeatures) {
    if (std::strcmp(entry.name, name) == 0) {
      *out = entry.feature;
      return 1;
    }
  }
  return 0;
}

size_t ntgpu_limit_count(void) { return sizeof(kLimits) / sizeof(kLimits[0]); }

int ntgpu_limit_at(const WGPULimits *limits, size_t i, const char **name, uint64_t *value) {
  if (!limits || i >= ntgpu_limit_count()) return 0;
  const LimitField &field = kLimits[i];
  const auto *base = reinterpret_cast<const unsigned char *>(limits) + field.offset;
  uint64_t v;
  if (field.wide) {
    std::memcpy(&v, base, sizeof(v));
  } else {
    uint32_t narrow;
    std::memcpy(&narrow, base, sizeof(narrow));
    v = narrow;
  }
  if (name) *name = field.name;
  if (value) *value = v;
  bool undefined = field.wide ? v == WGPU_LIMIT_U64_UNDEFINED : v == WGPU_LIMIT_U32_UNDEFINED;
  return undefined ? 2 : 1;
}

namespace {
// Length of the UTF-8 sequence starting with byte c (1 for invalid lead bytes).
size_t Utf8Length(unsigned char c) {
  if (c >= 0xf0) return 4;
  if (c >= 0xe0) return 3;
  if (c >= 0xc0) return 2;
  return 1;
}
// Advances `count` code points from byte position pos (bounded by end), adding their UTF-16 length to *units.
size_t Advance(const char *s, size_t pos, size_t end, size_t count, uint32_t *units) {
  while (count-- > 0 && pos < end) {
    size_t n = Utf8Length(static_cast<unsigned char>(s[pos]));
    *units += n == 4 ? 2 : 1;
    pos += n;
  }
  return pos < end ? pos : end;
}
}  // namespace

int ntgpu_wgsl_location(const char *message, const char *source, size_t source_length, NtGpuSourceLocation *out) {
  if (!out) return 0;
  std::memset(out, 0, sizeof(*out));
  if (!message) return 0;
  std::string m(message);
  // Summary: text after the first "error: " (Naga reports "Shader 'x' parsing error: ..." / "validation error: ...").
  size_t e = m.find("error: ");
  if (e != std::string::npos) {
    size_t begin = e + 7, stop = m.find('\n', begin);
    out->summary = message + begin;
    out->summary_length = (stop == std::string::npos ? m.size() : stop) - begin;
  }
  size_t at = m.find("wgsl:");
  if (at == std::string::npos) return 0;
  unsigned long line = 0, column = 0;
  if (std::sscanf(message + at, "wgsl:%lu:%lu", &line, &column) != 2 || line == 0 || column == 0) return 0;
  out->line_num = static_cast<uint32_t>(line);
  if (!source) return 1;
  size_t pos = 0;
  for (unsigned long l = 1; l < line && pos < source_length; ++pos) {
    if (source[pos] == '\n') ++l;
  }
  // UTF-16 offset of the line start.
  uint32_t offset = 0;
  for (size_t p = 0; p < pos;) {
    size_t n = Utf8Length(static_cast<unsigned char>(source[p]));
    offset += n == 4 ? 2 : 1;
    p += n;
  }
  uint32_t in_line = 0;
  size_t start = Advance(source, pos, source_length, column - 1, &in_line);
  out->line_pos = in_line + 1;
  out->offset = offset + in_line;
  // Caret underline: the first run of '^' after the location gives the span in code points.
  size_t caret = m.find('^', at);
  size_t carets = 0;
  while (caret != std::string::npos && caret + carets < m.size() && m[caret + carets] == '^') ++carets;
  uint32_t length = 0;
  Advance(source, start, source_length, carets, &length);
  out->length = length;
  return 1;
}

const char *ntgpu_backend_name(WGPUBackendType backend) {
  switch (backend) {
    case WGPUBackendType_Null: return "null";
    case WGPUBackendType_WebGPU: return "webgpu";
    case WGPUBackendType_D3D11: return "d3d11";
    case WGPUBackendType_D3D12: return "d3d12";
    case WGPUBackendType_Metal: return "metal";
    case WGPUBackendType_Vulkan: return "vulkan";
    case WGPUBackendType_OpenGL: return "opengl";
    case WGPUBackendType_OpenGLES: return "opengles";
    default: return "undefined";
  }
}

const char *ntgpu_status_name(NtGpuStatus status) {
  switch (status) {
    case NTGPU_OK: return "ok";
    case NTGPU_ERR_ARGUMENT: return "argument";
    case NTGPU_ERR_UNAVAILABLE: return "unavailable";
    case NTGPU_ERR_DEVICE_LOST: return "device-lost";
    case NTGPU_ERR_VALIDATION: return "validation";
    case NTGPU_ERR_OUT_OF_MEMORY: return "out-of-memory";
    case NTGPU_ERR_INTERNAL: return "internal";
    case NTGPU_ERR_UNSUPPORTED: return "unsupported";
  }
  return "unknown";
}

}  // extern "C"

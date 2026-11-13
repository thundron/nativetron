// MOCK executor (recording double) implementing gpu/native/executor.h for host development and regression tests.
// It decodes every batch with the generated decoder (gpu/native-decoder.generated.h) and acknowledges requests
// synthetically, exactly like the prior wasm oracle harness: CAPABILITIES with a fixed desktop profile, empty
// SHADER_INFO, PIPELINE_READY, WORK_DONE, and MAP_READY with ZERO-FILLED readback bytes. Nothing is executed on a
// GPU and capture_rgba is unavailable: no image produced through this library is a render.
// The exported marker ntgpu_executor_is_mock lets hosts label every artifact as mock output.
#include "../executor.h"
#include "../../native-decoder.generated.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <type_traits>
#include <vector>

namespace gpu = nativetron::gpu;

extern "C" __attribute__((visibility("default"))) const int ntgpu_executor_is_mock = 1;

struct NtGpuExecutor {
  NtGpuExecutorOptions options{};
  uint32_t width = 64, height = 64;
  double dpr = 1;
  uint64_t batches = 0, operations = 0;
};

namespace {
const char *kCaps =
    "{\"type\":1,\"requestId\":%u,\"handle\":0,\"status\":0,\"available\":true,\"features\":[\"timestamp-query\",\"shader-f16\"],"
    "\"featureBits\":0,\"adapterFeatures\":[\"timestamp-query\",\"shader-f16\"],\"adapterFeatureBits\":0,\"limits\":{"
    "\"maxTextureDimension2D\":16384,\"maxStorageBuffersPerShaderStage\":10,\"maxStorageBufferBindingSize\":1073741824,"
    "\"maxBufferSize\":1073741824,\"maxComputeWorkgroupStorageSize\":32768,\"maxComputeInvocationsPerWorkgroup\":1024,"
    "\"maxBindGroups\":4,\"maxColorAttachments\":8},\"adapterLimits\":{},\"format\":\"bgra8unorm\",\"formatCode\":1,"
    "\"protocol\":{\"version\":3,\"identity\":3154268101}}";

struct Visitor {
  NtGpuExecutor *e;
  size_t readback_capacity;
  void emit(const std::string &json, const uint8_t *data = nullptr, size_t size = 0) {
    e->options.event(e->options.user, json.c_str(), data, size);
  }
  static std::string simple(unsigned type, uint32_t id, uint32_t handle, const char *tail = "") {
    char b[160];
    snprintf(b, sizeof b, "{\"type\":%u,\"requestId\":%u,\"handle\":%u,\"status\":0%s}", type, id, handle, tail);
    return b;
  }
  template <class Op> bool on(const Op &op) {
    e->operations++;
    if constexpr (std::is_same_v<Op, gpu::RequestFrameOp>) {
      if (e->options.frame_requested) e->options.frame_requested(e->options.user);
    } else if constexpr (std::is_same_v<Op, gpu::MapAsyncOp>) {
      std::vector<uint8_t> zeros(op.destination.length ? op.destination.length : 1, 0);
      char tail[96];
      snprintf(tail, sizeof tail, ",\"offset\":%u,\"length\":%u", op.destination.offset, op.destination.length);
      emit(simple(3, op.requestId, static_cast<uint32_t>(op.buffer), tail), zeros.data(), op.destination.length);
    } else if constexpr (Op::kRequest) {
      const uint32_t id = op.request_id(), handle = static_cast<uint32_t>(op.request_handle());
      switch (Op::kCompletes) {
        case gpu::Event::Capabilities: { char b[1024]; snprintf(b, sizeof b, kCaps, id); emit(b); break; }
        case gpu::Event::ShaderInfo: emit(simple(7, id, handle, ",\"messages\":[]")); break;
        case gpu::Event::PipelineReady: emit(simple(2, id, handle)); break;
        case gpu::Event::WorkDone: emit(simple(4, id, 0)); break;
        default: break;
      }
    }
    return true;
  }
  void on_skipped_request(const gpu::SkippedRequest &) {}
  void on_error(const gpu::ErrorReport &r) {
    char b[512];
    snprintf(b, sizeof b, "{\"type\":6,\"requestId\":%u,\"handle\":0,\"status\":1,\"message\":\"mock decode error: %s\"}", r.request_id,
             r.message ? r.message : "?");
    emit(b);
  }
};
}  // namespace

extern "C" {
__attribute__((visibility("default"))) int ntgpu_executor_create(const NtGpuExecutorOptions *o, NtGpuExecutor **out) {
  if (!out) return 0;
  *out = nullptr;
  if (!o || !o->event) return 0;
  auto *e = new NtGpuExecutor();
  e->options = *o;
  e->width = o->width ? o->width : 64;
  e->height = o->height ? o->height : 64;
  e->dpr = o->pixel_ratio > 0 ? o->pixel_ratio : 1;
  *out = e;
  return 1;  // nonzero = success, like submit and capture_rgba
}
__attribute__((visibility("default"))) void ntgpu_executor_destroy(NtGpuExecutor *e) { delete e; }
__attribute__((visibility("default"))) int ntgpu_executor_submit(NtGpuExecutor *e, const uint8_t *commands, size_t command_size,
                                                                 const uint8_t *, size_t, size_t readback_capacity) {
  e->batches++;
  Visitor v{e, readback_capacity};
  gpu::BatchResult r = gpu::decode_batch(commands, command_size, v);
  return r.outcome == gpu::BatchOutcome::Fatal ? 0 : 1;
}
__attribute__((visibility("default"))) void ntgpu_executor_process(NtGpuExecutor *) {}
__attribute__((visibility("default"))) size_t ntgpu_executor_pending(const NtGpuExecutor *) { return 0; }
__attribute__((visibility("default"))) void ntgpu_executor_resize(NtGpuExecutor *e, uint32_t w, uint32_t h, double dpr) {
  e->width = w; e->height = h; e->dpr = dpr;
}
__attribute__((visibility("default"))) int ntgpu_executor_capture_rgba(NtGpuExecutor *e, uint8_t *, size_t, uint32_t *, uint32_t *) {
  e->options.event(e->options.user,
                   "{\"type\":6,\"requestId\":0,\"handle\":0,\"status\":1,\"message\":\"capture unavailable: MOCK executor renders nothing\"}",
                   nullptr, 0);
  return 0;
}
}

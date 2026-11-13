/*
 * ntgpu — native WebGPU backend facade for nativetron (C ABI, implemented in C++17 over wgpu-native).
 *
 * The facade owns the instance/adapter/device/queue lifecycle, capability reporting, error-scope bookkeeping,
 * WGSL diagnostics and the asynchronous completion queue. A protocol decoder (generated from gpu/ops.json elsewhere)
 * obtains the raw webgpu.h handles from here and issues every other WebGPU call itself.
 *
 * Rules:
 *  - This header depends on the standard webgpu.h only. Implementation-specific (wgpu.h) calls stay inside ntgpu.cc,
 *    so guest-visible semantics never depend on a vendor extension.
 *  - Native callbacks never call into the host. They append an NtGpuEvent to a bounded queue and, when the queue
 *    turns non-empty, invoke the optional wake hook (from whichever thread the callback ran on). The host drains the
 *    queue on its own run loop with ntgpu_next_event and forwards events to the reactor there.
 *  - Nothing polls while idle. ntgpu_process() returns immediately when no asynchronous operation is outstanding;
 *    the host calls it only while ntgpu_pending() > 0 (after a submit with readbacks, mapAsync, work-done).
 *  - Not thread-safe except for the event queue and wake hook: one thread drives a context.
 */
#ifndef NTGPU_H
#define NTGPU_H

#include <stddef.h>
#include <stdint.h>
#include <webgpu/webgpu.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NTGPU_API_VERSION 1u

typedef struct NtGpuContext NtGpuContext;

typedef enum NtGpuStatus {
  NTGPU_OK = 0,
  NTGPU_ERR_ARGUMENT = 1,      /* bad argument or call order (no adapter, unbalanced scope, ...) */
  NTGPU_ERR_UNAVAILABLE = 2,   /* no adapter, device request refused, missing required feature/limit */
  NTGPU_ERR_DEVICE_LOST = 3,   /* device destroyed or lost; request a new device */
  NTGPU_ERR_VALIDATION = 4,    /* WebGPU validation error captured by an error scope */
  NTGPU_ERR_OUT_OF_MEMORY = 5, /* WebGPU out-of-memory error captured by an error scope */
  NTGPU_ERR_INTERNAL = 6,      /* WebGPU internal error or implementation failure */
  NTGPU_ERR_UNSUPPORTED = 7    /* operation this implementation does not provide (see README "gaps") */
} NtGpuStatus;

typedef enum NtGpuEventKind {
  NTGPU_EVENT_NONE = 0,
  NTGPU_EVENT_ADAPTER = 1,          /* status: NTGPU_OK or NTGPU_ERR_UNAVAILABLE */
  NTGPU_EVENT_DEVICE = 2,           /* status: NTGPU_OK or NTGPU_ERR_UNAVAILABLE; generation = new device */
  NTGPU_EVENT_DEVICE_LOST = 3,      /* detail = WGPUDeviceLostReason; emitted at most once per generation */
  NTGPU_EVENT_UNCAPTURED_ERROR = 4, /* detail = WGPUErrorType */
  NTGPU_EVENT_MAP = 5,              /* detail = WGPUMapAsyncStatus; status NTGPU_OK when mapped */
  NTGPU_EVENT_WORK_DONE = 6,        /* detail = WGPUQueueWorkDoneStatus */
  NTGPU_EVENT_OVERFLOW = 7          /* events were dropped because the queue was full; token = dropped count */
} NtGpuEventKind;

typedef struct NtGpuEvent {
  uint32_t kind;       /* NtGpuEventKind */
  uint32_t status;     /* NtGpuStatus */
  uint32_t detail;     /* webgpu.h enum value, see kind */
  uint32_t generation; /* device generation the event belongs to (0 = no device) */
  uint64_t token;      /* caller token passed to the originating request */
  const char *message; /* UTF-8, NUL-terminated, valid until the next ntgpu_next_event/ntgpu_context_destroy */
} NtGpuEvent;

typedef void (*NtGpuWakeFn)(void *user);

typedef struct NtGpuContextOptions {
  uint32_t api_version;     /* NTGPU_API_VERSION */
  uint32_t event_capacity;  /* bounded length for UNCAPTURED_ERROR events (completions are never dropped); 0 = 256 */
  uint32_t message_limit;   /* bytes kept per event message; 0 = 4096 */
  NtGpuWakeFn wake;         /* optional; called when the queue turns non-empty; must not call ntgpu_* */
  void *wake_user;
} NtGpuContextOptions;

/* Diagnostics of one error scope or creation call. message is owned by the context and valid until the next call
 * that fills an NtGpuDiag on the same context. */
typedef struct NtGpuDiag {
  uint32_t status;     /* NtGpuStatus */
  uint32_t error_type; /* WGPUErrorType */
  const char *message;
} NtGpuDiag;

#define NTGPU_MAX_FEATURES 96u

typedef struct NtGpuCapabilities {
  /* adapter info; strings owned by the context, valid until the adapter changes or the context is destroyed */
  const char *vendor;
  const char *architecture;
  const char *device;
  const char *description;
  WGPUBackendType backend;
  WGPUAdapterType adapter_type;
  uint32_t vendor_id;
  uint32_t device_id;
  WGPULimits limits;          /* adapter limits, or device limits for ntgpu_device_capabilities */
  uint32_t feature_count;
  WGPUFeatureName features[NTGPU_MAX_FEATURES]; /* includes implementation-specific values; see ntgpu_feature_name */
} NtGpuCapabilities;

/* ---- lifecycle ---- */
NtGpuStatus ntgpu_context_create(const NtGpuContextOptions *options, NtGpuContext **out);
/* Releases the queue, device, adapter and instance in that order. Outstanding map/work-done callbacks complete
 * (as aborted/errored) during the release and are discarded; the wake hook is not called after this begins. */
void ntgpu_context_destroy(NtGpuContext *ctx);
/* wgpu-native runtime version, (major<<24)|(minor<<16)|(patch<<8)|build. */
uint32_t ntgpu_implementation_version(void);
const char *ntgpu_implementation_name(void);

/* ---- adapter/device (results arrive as events; wgpu-native completes them before returning) ---- */
NtGpuStatus ntgpu_request_adapter(NtGpuContext *ctx, uint64_t token, WGPUPowerPreference power);
NtGpuStatus ntgpu_adapter_capabilities(NtGpuContext *ctx, NtGpuCapabilities *out);
/* required_limits may be NULL (defaults). The facade installs its own lost/uncaptured-error callbacks. A previous
 * device is destroyed first (its DEVICE_LOST event is emitted with reason Destroyed). */
NtGpuStatus ntgpu_request_device(NtGpuContext *ctx, uint64_t token, const WGPUFeatureName *required_features,
                                 size_t required_feature_count, const WGPULimits *required_limits);
NtGpuStatus ntgpu_device_capabilities(NtGpuContext *ctx, NtGpuCapabilities *out);
/* Explicit device.destroy(): marks the generation lost and emits DEVICE_LOST(Destroyed) once. */
NtGpuStatus ntgpu_device_destroy(NtGpuContext *ctx);
/* Destroys (DEVICE_LOST(Destroyed) once, if still alive) and releases the current device, so a lost device does
 * not pin the adapter. Outstanding map/work-done callbacks complete during the release and are queued as events of
 * the old generation. A new adapter and device may be requested afterwards. */
NtGpuStatus ntgpu_device_release(NtGpuContext *ctx);
int ntgpu_device_alive(const NtGpuContext *ctx);
uint32_t ntgpu_device_generation(const NtGpuContext *ctx);

/* Raw handles for the protocol decoder. Borrowed: do not release; they become invalid when the device generation
 * changes or the context is destroyed. NULL when absent. */
WGPUInstance ntgpu_instance(const NtGpuContext *ctx);
WGPUAdapter ntgpu_adapter(const NtGpuContext *ctx);
WGPUDevice ntgpu_device(const NtGpuContext *ctx);
WGPUQueue ntgpu_queue(const NtGpuContext *ctx);

/* ---- error scopes (balanced; popping an empty stack returns NTGPU_ERR_ARGUMENT instead of aborting) ---- */
NtGpuStatus ntgpu_scope_push(NtGpuContext *ctx, WGPUErrorFilter filter);
/* Completes synchronously. out->status is NTGPU_OK when the scope captured nothing. */
NtGpuStatus ntgpu_scope_pop(NtGpuContext *ctx, NtGpuDiag *out);
uint32_t ntgpu_scope_depth(const NtGpuContext *ctx);

/* ---- shaders and pipelines (diagnostics captured with validation+internal+out-of-memory scopes) ---- */
/* Shader-module stage only: WGSL parse + validation by the implementation's front end (Naga). Warnings are not
 * available (wgpu-native does not implement getCompilationInfo). *out is NULL unless status is NTGPU_OK. */
NtGpuStatus ntgpu_compile_wgsl(NtGpuContext *ctx, const char *source, size_t length, const char *label,
                               WGPUShaderModule *out, NtGpuDiag *diag);
/* Full pipeline stage (layout "auto" when layout is NULL): entry-point resolution, interface/layout validation and
 * backend code generation (MSL on Metal). */
NtGpuStatus ntgpu_create_compute_pipeline(NtGpuContext *ctx, WGPUShaderModule module, const char *entry_point,
                                          const WGPUConstantEntry *constants, size_t constant_count,
                                          WGPUPipelineLayout layout, WGPUComputePipeline *out, NtGpuDiag *diag);
NtGpuStatus ntgpu_create_render_pipeline(NtGpuContext *ctx, const WGPURenderPipelineDescriptor *descriptor,
                                         WGPURenderPipeline *out, NtGpuDiag *diag);

/* ---- asynchronous completion (results arrive as events) ---- */
/* mapAsync on a buffer the caller owns; the caller must keep the buffer alive until the MAP event. */
NtGpuStatus ntgpu_map_async(NtGpuContext *ctx, WGPUBuffer buffer, WGPUMapMode mode, size_t offset, size_t size,
                            uint64_t token);
NtGpuStatus ntgpu_work_done(NtGpuContext *ctx, uint64_t token);
/* Outstanding map/work-done operations of the current generation. */
uint32_t ntgpu_pending(const NtGpuContext *ctx);
/* Drives completions. wait=0: non-blocking progress. wait=1: block until the queue is idle (only when pending>0).
 * Returns the number still pending. Never polls when nothing is pending. */
uint32_t ntgpu_process(NtGpuContext *ctx, int wait);

/* Pops the oldest event into *out; returns 0 when the queue is empty. */
int ntgpu_next_event(NtGpuContext *ctx, NtGpuEvent *out);
uint32_t ntgpu_queued_events(NtGpuContext *ctx);

/* ---- presentation (host side only; standard webgpu.h surface source) ---- */
/* layer is a CAMetalLayer* (macOS/iOS). The surface is owned by the caller (wgpuSurfaceRelease). */
NtGpuStatus ntgpu_surface_from_metal_layer(NtGpuContext *ctx, void *layer, WGPUSurface *out);
/* Configures for the current device with the first supported format unless format is Undefined. */
NtGpuStatus ntgpu_surface_configure(NtGpuContext *ctx, WGPUSurface surface, WGPUTextureFormat format, uint32_t width,
                                    uint32_t height, WGPUPresentMode present_mode, WGPUCompositeAlphaMode alpha,
                                    WGPUTextureFormat *chosen);

/* ---- WGSL diagnostic locations ----
 * wgpu-native has no getCompilationInfo; shader errors arrive as scope messages whose Naga report contains
 * "wgsl:LINE:COLUMN" and a caret underline. This recovers GPUCompilationMessage-style fields from such a message:
 * 1-based line_num/line_pos and offset/length in UTF-16 code units of source (zeros when not found), plus the
 * one-line summary (pointer into message). Returns 1 when a location was found. Synthesized, not front-end data. */
typedef struct NtGpuSourceLocation {
  uint32_t line_num;
  uint32_t line_pos;
  uint32_t offset;
  uint32_t length;
  const char *summary;
  size_t summary_length;
} NtGpuSourceLocation;
int ntgpu_wgsl_location(const char *message, const char *source, size_t source_length, NtGpuSourceLocation *out);

/* ---- name tables (WebGPU JavaScript spellings, so a decoder can map protocol names) ---- */
/* Standard features: the JS name ("timestamp-query"). Implementation-specific ones: NULL. */
const char *ntgpu_feature_name(WGPUFeatureName feature);
int ntgpu_feature_from_name(const char *name, WGPUFeatureName *out);
size_t ntgpu_limit_count(void);
/* i-th WGPULimits field: JS name and value widened to 64 bits. Returns 0 when i is out of range, 2 when the
 * implementation left the field at its "undefined" sentinel (WGPU_LIMIT_U32/U64_UNDEFINED), else 1. */
int ntgpu_limit_at(const WGPULimits *limits, size_t i, const char **name, uint64_t *value);
const char *ntgpu_backend_name(WGPUBackendType backend);
const char *ntgpu_status_name(NtGpuStatus status);

#ifdef __cplusplus
}
#endif
#endif

#ifndef NTGPU_EXECUTOR_H
#define NTGPU_EXECUTOR_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Protocol-3 executor. All calls except wake are serialized by the owner.
 * Event JSON has the existing gpu/host.js onEvent shape. For MAP_READY,
 * data contains the readback bytes and JSON carries offset/length; data and
 * JSON are borrowed only until event() returns. Never call guest exports
 * from these callbacks: enqueue, then deliver after the current export.
 */
typedef struct NtGpuExecutor NtGpuExecutor;
typedef struct NtGpuExecutorOptions {
  void *user;
  void (*event)(void *user, const char *json, const uint8_t *data, size_t size);
  void (*frame_requested)(void *user);
  void (*wake)(void *user);
  void *metal_layer; /* optional CAMetalLayer, externally leased until destroy */
  uint32_t width, height; /* headless fallback dimensions; zero means 64 */
  double pixel_ratio; /* zero means 1 */
} NtGpuExecutorOptions;
int ntgpu_executor_create(const NtGpuExecutorOptions *options, NtGpuExecutor **out);
void ntgpu_executor_destroy(NtGpuExecutor *executor);
/* No borrowed submission pointer is retained after submit returns. Readback
 * staging is described by capacity, never retained as a writable guest pointer.
 * Nonzero means accepted; errors are also delivered through event().
 */
int ntgpu_executor_submit(NtGpuExecutor *executor, const uint8_t *commands, size_t command_size,
                          const uint8_t *uploads, size_t upload_size, size_t readback_capacity);
/* Drain pending native callbacks without a permanent idle polling loop. */
void ntgpu_executor_process(NtGpuExecutor *executor);
size_t ntgpu_executor_pending(const NtGpuExecutor *executor);
void ntgpu_executor_resize(NtGpuExecutor *executor, uint32_t width, uint32_t height, double pixel_ratio);
/* Explicit synchronous capture for probes, called outside any guest export.
 * RGBA8 top-left image; caller supplies width*height*4 bytes. Never an implicit
 * frame loop. Return zero with a diagnostic event if capture is unavailable.
 */
int ntgpu_executor_capture_rgba(NtGpuExecutor *executor, uint8_t *rgba, size_t capacity,
                              uint32_t *width, uint32_t *height);
/* Host-only GPU completion fence (not reachable from guest operations; no protocol change). It covers every
 * queue submission made by all earlier ntgpu_executor_submit calls (any number of batches, e.g. every flush of
 * one frame) and completes when the GPU has finished all of that work -- not when submit consumed the bytes.
 * Returns 1 when accepted: done(user, token, status) is then called exactly once, on the owner thread, later:
 * from ntgpu_executor_process (DONE or LOST; the wake callback announces it) or from ntgpu_executor_destroy
 * (CANCELLED). Never from inside fence()/submit() or a foreign thread. Fences complete in request order.
 * Returns 0 (done is never called) for a null/destroyed executor, a null callback, or when
 * NTGPU_EXECUTOR_MAX_FENCES fences are already outstanding (the embedding's bound; nothing is queued).
 * Awaiting a fence never blocks the owner: completion is observed by non-blocking native polls only while
 * fences are outstanding (no idle polling), so later submits keep pipelining with the GPU.
 * Like event(), done must only enqueue: never call executor functions or guest exports from it.
 * DONE: the work finished (or no device existed, so nothing was queued). LOST: the device was lost or released
 * before completion was observed (the work never finishes). Either way the work no longer occupies the GPU queue.
 * ntgpu_executor_pending counts outstanding fences.
 */
#define NTGPU_EXECUTOR_MAX_FENCES 16
enum { NTGPU_EXECUTOR_FENCE_DONE = 0, NTGPU_EXECUTOR_FENCE_LOST = 1, NTGPU_EXECUTOR_FENCE_CANCELLED = 2 };
typedef void (*NtGpuExecutorFenceFn)(void *user, uint64_t token, int status);
int ntgpu_executor_fence(NtGpuExecutor *executor, uint64_t token, NtGpuExecutorFenceFn done, void *user);
#ifdef __cplusplus
}
#endif
#endif

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
#ifdef __cplusplus
}
#endif
#endif

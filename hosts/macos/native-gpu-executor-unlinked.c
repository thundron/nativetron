// Placeholder for gpu/native/executor.h until an executor artifact is linked (NT_GPU_EXECUTOR_LIBS).
// Every create fails: the app reports "pending executor link" and never pretends to execute.
#include "NativeGPU-Bridging.h"
const char *nt_macos_gpu_executor_linkage(void) { return "unlinked"; }
int ntgpu_executor_create(const NtGpuExecutorOptions *options, NtGpuExecutor **out) {
  (void)options;
  if (out) *out = 0;
  return 0;
}
void ntgpu_executor_destroy(NtGpuExecutor *executor) { (void)executor; }
int ntgpu_executor_submit(NtGpuExecutor *executor, const uint8_t *commands, size_t command_size,
                          const uint8_t *uploads, size_t upload_size, size_t readback_capacity) {
  (void)executor; (void)commands; (void)command_size; (void)uploads; (void)upload_size; (void)readback_capacity;
  return 0;
}
void ntgpu_executor_process(NtGpuExecutor *executor) { (void)executor; }
size_t ntgpu_executor_pending(const NtGpuExecutor *executor) { (void)executor; return 0; }
void ntgpu_executor_resize(NtGpuExecutor *executor, uint32_t width, uint32_t height, double pixel_ratio) {
  (void)executor; (void)width; (void)height; (void)pixel_ratio;
}
int ntgpu_executor_capture_rgba(NtGpuExecutor *executor, uint8_t *rgba, size_t capacity, uint32_t *width, uint32_t *height) {
  (void)executor; (void)rgba; (void)capacity; (void)width; (void)height;
  return 0;
}
int ntgpu_executor_fence(NtGpuExecutor *executor, uint64_t token, NtGpuExecutorFenceFn done, void *user) {
  (void)executor; (void)token; (void)done; (void)user;
  return 0;
}

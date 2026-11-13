// Swift bridging header for the macOS host's native GPU integration. The executor C API is
// gpu/native/executor.h (owned by the executor lane); the host never includes ntgpu.h.
#ifndef NT_MACOS_NATIVE_GPU_BRIDGING_H
#define NT_MACOS_NATIVE_GPU_BRIDGING_H
#include "../../gpu/native/executor.h"
#ifdef __cplusplus
extern "C" {
#endif
/* "linked" when build.sh linked an executor artifact (NT_GPU_EXECUTOR_LIBS), else "unlinked":
 * the unlinked stub's ntgpu_executor_create always fails, so nothing is ever executed. */
const char *nt_macos_gpu_executor_linkage(void);
/* Test-only recording executor with the same contract (native-gpu-recorder.c). It executes nothing:
 * it hashes what crossed the wire and echoes bytes as readbacks. Reachable only through
 * --native-gpu-selftest=wire. */
int nt_recorder_executor_create(const NtGpuExecutorOptions *options, NtGpuExecutor **out);
void nt_recorder_executor_destroy(NtGpuExecutor *executor);
int nt_recorder_executor_submit(NtGpuExecutor *executor, const uint8_t *commands, size_t command_size,
                                const uint8_t *uploads, size_t upload_size, size_t readback_capacity);
void nt_recorder_executor_process(NtGpuExecutor *executor);
size_t nt_recorder_executor_pending(const NtGpuExecutor *executor);
void nt_recorder_executor_resize(NtGpuExecutor *executor, uint32_t width, uint32_t height, double pixel_ratio);
int nt_recorder_executor_capture_rgba(NtGpuExecutor *executor, uint8_t *rgba, size_t capacity,
                                      uint32_t *width, uint32_t *height);
#ifdef __cplusplus
}
#endif
#endif

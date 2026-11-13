#ifndef NTGPU_EXECUTOR_TEST_H
#define NTGPU_EXECUTOR_TEST_H
/* Test-only hooks of the native executor (not part of the shared executor.h embedding contract). */
#include "executor.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Destroys the device from outside the protocol, as the browser lanes do with `host.device.destroy()`: pending
 * requests settle LOST and DEVICE_LOST is emitted before this returns (completions already queued natively are
 * then dropped), matching GPUDevice.destroy() under the JS host. Returns 0 without a device. */
int ntgpu_executor_test_lose_device(NtGpuExecutor *executor);
/* Native polls performed so far (waiter thread, process() and capture). Constant while idle. */
uint64_t ntgpu_executor_test_polls(const NtGpuExecutor *executor);
/* Live protocol handles (including lost ones the guest has not retired yet). */
size_t ntgpu_executor_test_live_handles(const NtGpuExecutor *executor);
#ifdef __cplusplus
}
#endif
#endif

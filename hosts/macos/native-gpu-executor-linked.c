// Compiled when build.sh links an executor artifact through NT_GPU_EXECUTOR_LIBS.
#include "NativeGPU-Bridging.h"
const char *nt_macos_gpu_executor_linkage(void) { return "linked"; }

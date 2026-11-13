// TEST-ONLY recording executor for the --native-gpu-selftest=wire crossing check. It implements the
// gpu/native/executor.h contract shape (serialized calls, deferred delivery through wake + process, borrowed
// event data) but executes no GPU work: it hashes every submission it consumed and echoes upload bytes back as
// MAP_READY readbacks so the Worker can verify byte-exact crossing in both directions. Host fences model GPU
// completion that trails consumption: a submission tagged "HOLD" keeps every fence pending (as a long GPU frame
// would) until a submission tagged "RELS"; otherwise fences complete on the next process().
#include "NativeGPU-Bridging.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Pending {
  char json[512];
  uint8_t *data;
  size_t size;
  int frame;
} Pending;

typedef struct Fence {
  uint64_t token;
  NtGpuExecutorFenceFn done;
  void *user;
} Fence;

struct NtGpuExecutor {
  NtGpuExecutorOptions options;
  uint32_t submissions;
  Pending queue[64];
  size_t head, count;
  uint32_t width, height;
  Fence fences[NTGPU_EXECUTOR_MAX_FENCES];
  size_t fence_count;
  int hold;
};

static uint32_t fnv1a(const uint8_t *bytes, size_t size) {
  uint32_t hash = 2166136261u;
  for (size_t i = 0; i < size; i++) { hash ^= bytes[i]; hash *= 16777619u; }
  return hash;
}

static Pending *push(NtGpuExecutor *e) {
  if (e->count == 64) return NULL;
  Pending *p = &e->queue[(e->head + e->count++) % 64];
  memset(p, 0, sizeof *p);
  return p;
}

int nt_recorder_executor_create(const NtGpuExecutorOptions *options, NtGpuExecutor **out) {
  if (!options || !out || !options->event) return 0;
  NtGpuExecutor *e = calloc(1, sizeof *e);
  if (!e) return 0;
  e->options = *options;
  e->width = options->width ? options->width : 64;
  e->height = options->height ? options->height : 64;
  *out = e;
  return 1;
}

void nt_recorder_executor_destroy(NtGpuExecutor *e) {
  if (!e) return;
  for (size_t i = 0; i < e->fence_count; i++) e->fences[i].done(e->fences[i].user, e->fences[i].token, NTGPU_EXECUTOR_FENCE_CANCELLED);
  e->fence_count = 0;
  while (e->count) { free(e->queue[e->head].data); e->head = (e->head + 1) % 64; e->count--; }
  free(e);
}

static int marker(const uint8_t *commands, size_t size, const char *tag) {
  return size >= 4 && memcmp(commands, tag, 4) == 0;
}

int nt_recorder_executor_submit(NtGpuExecutor *e, const uint8_t *commands, size_t command_size,
                                const uint8_t *uploads, size_t upload_size, size_t readback_capacity) {
  if (!e) return 0;
  uint32_t n = ++e->submissions;
  Pending *done = push(e);
  if (!done) return 0;
  snprintf(done->json, sizeof done->json,
           "{\"type\":4,\"requestId\":%u,\"handle\":0,\"status\":0,\"commandBytes\":%zu,\"uploadBytes\":%zu,"
           "\"readbackCapacity\":%zu,\"commandHash\":%u,\"uploadHash\":%u,\"surface\":[%u,%u]}",
           n, command_size, upload_size, readback_capacity, fnv1a(commands, command_size), fnv1a(uploads, upload_size),
           e->width, e->height);
  if (upload_size) {
    size_t echo = marker(commands, command_size, "BIGR") ? (upload_size < 6291456 ? upload_size : 6291456)
                                                          : (upload_size < 4096 ? upload_size : 4096);
    Pending *map = push(e);
    if (map) {
      map->data = malloc(echo);
      if (map->data) {
        memcpy(map->data, uploads, echo);
        map->size = echo;
        snprintf(map->json, sizeof map->json,
                 "{\"type\":3,\"requestId\":%u,\"handle\":0,\"status\":0,\"offset\":0,\"length\":%zu}", 100000 + n, echo);
      } else e->count--;
    }
  }
  if (marker(commands, command_size, "LOST")) {
    Pending *lost = push(e);
    if (lost) snprintf(lost->json, sizeof lost->json,
                       "{\"type\":5,\"requestId\":0,\"handle\":0,\"status\":3,\"reason\":\"destroyed\",\"message\":\"recorder device lost\"}");
  }
  if (marker(commands, command_size, "HOLD")) e->hold = 1;
  if (marker(commands, command_size, "RELS")) e->hold = 0;
  if (marker(commands, command_size, "FRAM")) {
    Pending *frame = push(e);
    if (frame) frame->frame = 1;
  }
  if (e->options.wake) e->options.wake(e->options.user);
  return 1;
}

void nt_recorder_executor_process(NtGpuExecutor *e) {
  if (!e) return;
  while (e->count) {
    Pending p = e->queue[e->head];
    e->head = (e->head + 1) % 64;
    e->count--;
    if (p.frame) { if (e->options.frame_requested) e->options.frame_requested(e->options.user); }
    else e->options.event(e->options.user, p.json, p.data, p.size);
    free(p.data);
  }
  if (e->hold) return;
  size_t n = e->fence_count;
  e->fence_count = 0;
  for (size_t i = 0; i < n; i++) e->fences[i].done(e->fences[i].user, e->fences[i].token, NTGPU_EXECUTOR_FENCE_DONE);
}

int nt_recorder_executor_fence(NtGpuExecutor *e, uint64_t token, NtGpuExecutorFenceFn done, void *user) {
  if (!e || !done || e->fence_count == NTGPU_EXECUTOR_MAX_FENCES) return 0;
  e->fences[e->fence_count++] = (Fence){token, done, user};
  if (!e->hold && e->options.wake) e->options.wake(e->options.user);
  return 1;
}

size_t nt_recorder_executor_pending(const NtGpuExecutor *e) { return e ? e->count + e->fence_count : 0; }

void nt_recorder_executor_resize(NtGpuExecutor *e, uint32_t width, uint32_t height, double pixel_ratio) {
  (void)pixel_ratio;
  if (e) { e->width = width; e->height = height; }
}

int nt_recorder_executor_capture_rgba(NtGpuExecutor *e, uint8_t *rgba, size_t capacity, uint32_t *width, uint32_t *height) {
  (void)e; (void)rgba; (void)capacity; (void)width; (void)height;
  return 0;
}

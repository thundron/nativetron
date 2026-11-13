#ifndef NT_REACTOR_H
#define NT_REACTOR_H
/* Native reactor host: drives one engine reactor guest (house-planner's hp-engine, any scriptc library-mode
 * reactor with the gpuPresent/gpuReport/engineSend/engineOffer callbacks) against a protocol-3 GPU executor
 * (gpu/native/executor.h). Plain C so the Swift/ObjC platform hosts can reuse it as their shim: the setjmp
 * recovery frame lives in this C code directly around each guest export, so a guest trap never unwinds
 * through Swift or ObjC frames.
 *
 * Contract (see README.md):
 * - One owner thread. Every function except nt_reactor_wake_pending is called on it. Exports are serialized:
 *   calling an export while one is active returns NT_REACTOR_REENTRY without touching the guest.
 * - Guest callbacks never call guest exports. gpuPresent submits to the executor synchronously (the executor
 *   copies the borrowed spans before submit returns); executor events and frame requests raised during the
 *   export are queued and delivered by nt_reactor_pump after it returns.
 * - MAP_READY with data: hp_readback(offset, bytes) is called before the hp_event that completes the request.
 * - A guest trap (panic sink, wasm throw, crashed guest process) poisons the instance: every later export
 *   returns NT_REACTOR_POISONED. Recovery is a new instance (a new guest process, see guest-pipe), never a
 *   re-init of the poisoned image.
 */
#include <stddef.h>
#include <stdint.h>
#include "../executor.h"
#ifdef __cplusplus
extern "C" {
#endif

enum {
  NT_REACTOR_OK = 0,
  NT_REACTOR_POISONED = -1,   /* the guest trapped earlier (or now); the instance is unusable */
  NT_REACTOR_REENTRY = -2,    /* an export was requested while another one is active */
  NT_REACTOR_ERROR = -3,      /* host-side failure (allocation, executor refused, timeout) */
};

/* ── guest (engine exports) ─────────────────────────────────────────────── */
typedef enum { NT_EXPORT_START, NT_EXPORT_FRAME, NT_EXPORT_EVENT, NT_EXPORT_MESSAGE, NT_EXPORT_RECEIVE, NT_EXPORT_READBACK } NtExport;
typedef struct NtGuestCall {
  NtExport which;
  double args[5];        /* frame: time; event: type, requestId, handle, status, value; message: topic; readback: offset */
  const uint8_t *bytes;  /* event: info text (UTF-8); message: payload; receive: frame; readback: bytes */
  size_t size;
} NtGuestCall;

/* Callbacks a guest raises during an export. Spans are borrowed for the call. `readbacks` may be NULL when the
 * guest lives in another process (only its length crosses); `readback_sha256` is then the guest-side digest
 * when the trace asks for it (else NULL). */
typedef struct NtGuestSink {
  void *ctx;
  void (*present)(void *ctx, const uint8_t *batch, size_t batch_size, const uint8_t *uploads, size_t upload_size,
                  const uint8_t *readbacks, size_t readback_size, const uint8_t *readback_sha256);
  void (*report)(void *ctx, const uint8_t *utf8, size_t size);
  void (*send)(void *ctx, const uint8_t *frame, size_t size);
  uint8_t (*offer)(void *ctx, const uint8_t *frame, size_t size);
  void (*panic)(void *ctx, const uint8_t *message, size_t size); /* structured 0x01 text 0x1F code 0x1F symbol */
} NtGuestSink;

typedef struct NtGuest NtGuest;
typedef struct NtGuestOps {
  const char *kind; /* "native", "native-process", "wasm-process" */
  /* Register the sink and callbacks, then run the guest's init. Nonzero: failed (the guest is unusable). */
  int (*bind)(NtGuest *guest, const NtGuestSink *sink);
  /* One export. NT_REACTOR_OK with *result set, or NT_REACTOR_POISONED after a trap. */
  int (*call)(NtGuest *guest, const NtGuestCall *call, double *result);
  void (*destroy)(NtGuest *guest);
} NtGuestOps;
struct NtGuest { const NtGuestOps *ops; };

/* In-process native guest: `prefix` names the exports (hp_ → hp_init, hp_start …). `library` is a dylib path
 * opened RTLD_LOCAL, or NULL for symbols linked into the process image (static archive). */
int nt_guest_native_open(const char *library, const char *prefix, NtGuest **out, char *error, size_t error_size);
/* Guest in a child process speaking the guest pipe protocol (guest-pipe.c) on fds 3 (requests) and 4 (replies).
 * argv[0] is executed through PATH. `want_readback_sha` asks the child to digest the readback span per present. */
int nt_guest_process_open(char *const argv[], int want_readback_sha, NtGuest **out, char *error, size_t error_size);
/* The child side: serves `guest` (an in-process guest) over fds 3/4 until EOF. Returns the process exit code. */
int nt_guest_serve(NtGuest *guest, int request_fd, int reply_fd);

/* ── executor binding ───────────────────────────────────────────────────── */
typedef struct NtExecutorApi {
  int (*create)(const NtGpuExecutorOptions *, NtGpuExecutor **);
  void (*destroy)(NtGpuExecutor *);
  int (*submit)(NtGpuExecutor *, const uint8_t *, size_t, const uint8_t *, size_t, size_t);
  void (*process)(NtGpuExecutor *);
  size_t (*pending)(const NtGpuExecutor *);
  void (*resize)(NtGpuExecutor *, uint32_t, uint32_t, double);
  int (*capture_rgba)(NtGpuExecutor *, uint8_t *, size_t, uint32_t *, uint32_t *);
  const char *origin;  /* library path, or "linked" */
  int is_mock;         /* the library exports ntgpu_executor_is_mock (recording double, no pixels) */
} NtExecutorApi;
/* Resolves the seven ntgpu_executor_* symbols from a shared library (or the process image when path is NULL). */
int nt_executor_api_open(const char *path, NtExecutorApi *api, char *error, size_t error_size);

/* ── reactor ────────────────────────────────────────────────────────────── */
typedef struct NtReactor NtReactor;
typedef enum { NT_EVENT_ORDER_ARRIVAL = 0, NT_EVENT_ORDER_REQUEST = 1 } NtEventOrder;
typedef enum { NT_RESIZE_EVENT_AUTO = 0, NT_RESIZE_EVENT_HOST = 1, NT_RESIZE_EVENT_EXECUTOR = 2 } NtResizeEvent;

typedef struct NtReactorOptions {
  NtGuest *guest;               /* owned by the reactor after create */
  const NtExecutorApi *executor;
  void *metal_layer;            /* forwarded to the executor (NULL: headless) */
  uint32_t width, height;
  double pixel_ratio;
  NtEventOrder event_order;     /* order of a queued group of events delivered by one pump turn */
  NtResizeEvent resize_event;   /* who produces the RESIZE (type 8) event after nt_reactor_resize */
  void *user;
  /* Engine → application frames (ipc/engine.json header). Borrowed for the call. */
  void (*send)(void *user, const uint8_t *frame, size_t size);
  uint8_t (*offer)(void *user, const uint8_t *frame, size_t size); /* NULL: accepted */
  void (*report)(void *user, const uint8_t *utf8, size_t size);
  /* Executor wake (any thread): schedule a pump on the owner thread. NULL: the owner polls. */
  void (*wake)(void *user);
  /* Optional crossing trace (one text line per crossing, without newline). */
  void (*trace)(void *user, const char *line);
  int trace_readback_sha;       /* hash the whole readback span on every present (slow; trace comparisons only) */
} NtReactorOptions;

typedef struct NtReactorCounters {
  uint64_t exports, presents, batch_bytes, upload_bytes, submits_refused;
  uint64_t events_delivered, readbacks_delivered, readback_bytes, frames, frame_requests;
  uint64_t sends, offers, reports, executor_events, resize_events_synthesized, settle_waits, wakes;
  uint64_t max_queued_events;
} NtReactorCounters;

int nt_reactor_create(const NtReactorOptions *options, NtReactor **out, char *error, size_t error_size);
void nt_reactor_destroy(NtReactor *reactor);

int nt_reactor_start(NtReactor *reactor, double *result);
int nt_reactor_message(NtReactor *reactor, double topic, const uint8_t *payload, size_t size, double *result);
int nt_reactor_receive(NtReactor *reactor, const uint8_t *frame, size_t size, double *result);
/* Raw guarded readback export (tests and replays; normal readbacks come from MAP_READY events). */
int nt_reactor_readback(NtReactor *reactor, double offset, const uint8_t *bytes, size_t size, double *result);
/* Raw event injection (tests and replays); delivered in queue order by the next pump. */
int nt_reactor_queue_event(NtReactor *reactor, double type, double request_id, double handle, double status, double value,
                           const char *text, size_t text_size);
int nt_reactor_resize(NtReactor *reactor, uint32_t width, uint32_t height, double pixel_ratio);

typedef struct NtPumpOptions {
  uint32_t max_frames;     /* frames this pump may deliver */
  double frame_step_ms;    /* synthetic frame clock step (deterministic replays); 0 = 1000/60 */
  int settle;              /* wait for executor.pending() == 0 before declaring idle */
  uint32_t timeout_ms;     /* bound on a stall: executor waits without any event or frame (0 = 120000) */
  /* Stop early when this returns nonzero (checked after every delivered export). */
  int (*until)(void *ctx);
  void *until_ctx;
} NtPumpOptions;
typedef struct NtPumpResult { uint32_t events, frames; int idle, stopped, timed_out, frame_wanted; } NtPumpResult;
int nt_reactor_pump(NtReactor *reactor, const NtPumpOptions *options, NtPumpResult *result);
/* Delivers one frame now at the reactor's synthetic clock (+step). */
int nt_reactor_frame(NtReactor *reactor, double step_ms, double *result);

int nt_reactor_capture_rgba(NtReactor *reactor, uint8_t *rgba, size_t capacity, uint32_t *width, uint32_t *height);
int nt_reactor_poisoned(const NtReactor *reactor);
const char *nt_reactor_panic_text(const NtReactor *reactor); /* last trap message ("" if none) */
const char *nt_reactor_last_executor_diagnostic(const NtReactor *reactor);
void nt_reactor_counters(const NtReactor *reactor, NtReactorCounters *out);
double nt_reactor_clock(const NtReactor *reactor);
/* Thread-safe: nonzero when the executor called wake since the last pump. */
int nt_reactor_wake_pending(NtReactor *reactor);

#ifdef __cplusplus
}
#endif
#endif

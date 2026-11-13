/* In-process native guest: a scriptc library-mode reactor (static archive linked into the image, or a dylib).
 * The setjmp recovery frame is here, directly around each export; the panic sink longjmps to it. Only C and
 * guest frames lie between them (the reactor callbacks return before the guest can trap). A trapped image is
 * poisoned for good: no export, and no hp_init, is ever called on it again (the runtime would abort). */
#include "reactor.h"
#include <dlfcn.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*SinkFn)(void *ctx, const uint8_t *msg, size_t len, uint64_t addr);
typedef struct {
  void (*init)(void);
  void (*sink)(SinkFn, void *);
  int32_t (*callback)(const char *, void (*)(void), void *);
  double (*start)(void);
  double (*frame)(double);
  double (*event)(double, double, double, double, double, const uint8_t *, size_t);
  double (*message)(double, const uint8_t *, size_t);
  double (*receive)(const uint8_t *, size_t);
  double (*readback)(double, const uint8_t *, size_t);
} Api;

typedef struct {
  NtGuest base;
  void *library;
  Api api;
  NtGuestSink sink;
  jmp_buf *recover;
  int poisoned, bound;
} Native;

static void cb_present(void *ctx, const uint8_t *b, size_t bn, const uint8_t *u, size_t un, const uint8_t *r, size_t rn) {
  Native *g = ctx;
  g->sink.present(g->sink.ctx, b, bn, u, un, r, rn, NULL);
}
static void cb_report(void *ctx, const uint8_t *s, size_t n) { Native *g = ctx; g->sink.report(g->sink.ctx, s, n); }
static void cb_send(void *ctx, const uint8_t *s, size_t n) { Native *g = ctx; g->sink.send(g->sink.ctx, s, n); }
static uint8_t cb_offer(void *ctx, const uint8_t *s, size_t n) { Native *g = ctx; return g->sink.offer(g->sink.ctx, s, n); }
static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)addr;
  Native *g = ctx;
  g->poisoned = 1;
  if (g->sink.panic) g->sink.panic(g->sink.ctx, msg, len);
  if (g->recover) longjmp(*g->recover, 1);
  /* A trap outside any guarded export: returning would resume the faulting guest. */
  fprintf(stderr, "nt-reactor: guest trapped outside a guarded export; aborting\n");
  abort();
}

static int native_bind(NtGuest *base, const NtGuestSink *s) {
  Native *g = (Native *)base;
  g->sink = *s;
  /* Sink and callbacks first (pure stores, legal before init), then init. */
  g->api.sink(sink, g);
  int rc = 0;
  rc |= g->api.callback("gpuPresent", (void (*)(void))cb_present, g);
  rc |= g->api.callback("gpuReport", (void (*)(void))cb_report, g);
  rc |= g->api.callback("engineSend", (void (*)(void))cb_send, g);
  rc |= g->api.callback("engineOffer", (void (*)(void))cb_offer, g);
  if (rc) return -1;
  jmp_buf jb;
  g->recover = &jb;
  if (setjmp(jb)) { g->recover = NULL; return -1; }
  g->api.init();
  g->recover = NULL;
  g->bound = 1;
  return 0;
}

static int native_call(NtGuest *base, const NtGuestCall *c, double *result) {
  Native *g = (Native *)base;
  if (g->poisoned || !g->bound) return NT_REACTOR_POISONED;
  jmp_buf jb;
  volatile double r = 0;
  g->recover = &jb;
  if (setjmp(jb)) { g->recover = NULL; g->poisoned = 1; return NT_REACTOR_POISONED; }
  switch (c->which) {
    case NT_EXPORT_START: r = g->api.start(); break;
    case NT_EXPORT_FRAME: r = g->api.frame(c->args[0]); break;
    case NT_EXPORT_EVENT: r = g->api.event(c->args[0], c->args[1], c->args[2], c->args[3], c->args[4], c->bytes, c->size); break;
    case NT_EXPORT_MESSAGE: r = g->api.message(c->args[0], c->bytes, c->size); break;
    case NT_EXPORT_RECEIVE: r = g->api.receive(c->bytes, c->size); break;
    case NT_EXPORT_READBACK: r = g->api.readback(c->args[0], c->bytes, c->size); break;
  }
  g->recover = NULL;
  *result = r;
  return NT_REACTOR_OK;
}

static void native_destroy(NtGuest *base) {
  Native *g = (Native *)base;
  /* Never dlclose: a poisoned image's heap was abandoned mid-call, and a healthy one may hold runtime threads'
   * state; process exit reclaims it. A fresh instance after a trap is a new process (guest-pipe). */
  free(g);
}

static const NtGuestOps NATIVE_OPS = {"native", native_bind, native_call, native_destroy};

int nt_guest_native_open(const char *library, const char *prefix, NtGuest **out, char *err, size_t errn) {
  *out = NULL;
  if (!prefix || !*prefix) prefix = "hp_";
  void *h = library ? dlopen(library, RTLD_NOW | RTLD_LOCAL) : RTLD_DEFAULT;
  if (!h) { snprintf(err, errn, "dlopen %s: %s", library, dlerror()); return -1; }
  Native *g = calloc(1, sizeof *g);
  if (!g) { snprintf(err, errn, "out of memory"); return -1; }
  g->base.ops = &NATIVE_OPS;
  g->library = library ? h : NULL;
  char name[128];
#define SYM(field, suffix) \
  snprintf(name, sizeof name, "%s%s", prefix, suffix); \
  *(void **)&g->api.field = dlsym(h, name); \
  if (!g->api.field) { snprintf(err, errn, "%s: missing export %s", library ? library : "(process image)", name); free(g); return -1; }
  SYM(init, "init") SYM(sink, "sink") SYM(callback, "callback") SYM(start, "start") SYM(frame, "frame") SYM(event, "event")
  SYM(message, "message") SYM(receive, "receive") SYM(readback, "readback")
#undef SYM
  *out = &g->base;
  return 0;
}

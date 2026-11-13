/* Native reactor host core: guarded, serialized guest exports; executor events and frame requests queued while an
 * export runs and delivered after it (readback before MAP_READY); the event mapping of engine/reactor.js deliver(). */
#include "reactor.h"
#include "json.h"
#include <CommonCrypto/CommonDigest.h>
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct Item {
  double type, request_id, handle, status, value;
  char *text; size_t text_size;
  uint8_t *data; size_t data_size;
  int readback; double offset;
  uint64_t seq;
} Item;

struct NtReactor {
  NtReactorOptions o;
  NtGuest *guest;
  NtExecutorApi api;
  NtGpuExecutor *executor;
  int active, poisoned, frame_wanted, in_capture;
  Item *queue; size_t head, count, cap;
  uint64_t seq;
  double clock;
  char panic[4096];
  char diagnostic[1024];
  NtReactorCounters c;
  pthread_mutex_t lock;
  pthread_cond_t cond;
  atomic_int woken;
};

/* ── trace helpers ────────────────────────────────────────────────────────── */
static void trace_line(NtReactor *r, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void trace_line(NtReactor *r, const char *fmt, ...) {
  if (!r->o.trace) return;
  char buf[512];
  va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
  r->o.trace(r->o.user, buf);
}
static void sha_hex(const uint8_t *p, size_t n, char out[65]) {
  unsigned char d[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX ctx; CC_SHA256_Init(&ctx);
  while (n > 0) { CC_LONG k = n > 0x40000000 ? 0x40000000 : (CC_LONG)n; CC_SHA256_Update(&ctx, p, k); p += k; n -= k; }
  CC_SHA256_Final(d, &ctx);
  for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", d[i]);
}
static void digest_hex(const uint8_t d[32], char out[65]) { for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", d[i]); }
static void trace_hex(NtReactor *r, const char *prefix, const uint8_t *p, size_t n) {
  if (!r->o.trace) return;
  size_t pl = strlen(prefix);
  char *buf = malloc(pl + 2 * n + 2);
  if (!buf) return;
  memcpy(buf, prefix, pl);
  if (n == 0) { buf[pl] = '-'; buf[pl + 1] = 0; }
  else { for (size_t i = 0; i < n; i++) snprintf(buf + pl + 2 * i, 3, "%02x", p[i]); }
  r->o.trace(r->o.user, buf);
  free(buf);
}
static void bits(double x, char out[17]) { uint64_t u; memcpy(&u, &x, 8); snprintf(out, 17, "%016llx", (unsigned long long)u); }

/* ── queue ───────────────────────────────────────────────────────────────── */
static int push(NtReactor *r, Item *it) {
  if (r->count == r->cap) {
    size_t cap = r->cap ? r->cap * 2 : 64;
    Item *q = malloc(cap * sizeof *q);
    if (!q) return -1;
    for (size_t i = 0; i < r->count; i++) q[i] = r->queue[(r->head + i) % r->cap];
    free(r->queue); r->queue = q; r->head = 0; r->cap = cap;
  }
  it->seq = r->seq++;
  r->queue[(r->head + r->count) % r->cap] = *it;
  r->count++;
  if (r->count > r->c.max_queued_events) r->c.max_queued_events = r->count;
  return 0;
}
static Item *at(NtReactor *r, size_t i) { return &r->queue[(r->head + i) % r->cap]; }
static void item_free(Item *it) { free(it->text); free(it->data); }
/* NT_EVENT_ORDER_REQUEST: the lowest request id first (id 0 first), arrival order among equals. */
static void order_queue(NtReactor *r) {
  if (r->o.event_order != NT_EVENT_ORDER_REQUEST || r->count < 2) return;
  for (size_t i = 1; i < r->count; i++) {
    Item x = *at(r, i);
    size_t j = i;
    while (j > 0) {
      Item *p = at(r, j - 1);
      if (p->request_id < x.request_id || (p->request_id == x.request_id && p->seq < x.seq)) break;
      *at(r, j) = *p; j--;
    }
    *at(r, j) = x;
  }
}

static char *dup_bytes(const void *p, size_t n) {
  char *d = malloc(n + 1);
  if (!d) return NULL;
  if (n) memcpy(d, p, n);
  d[n] = 0;
  return d;
}

/* engine/reactor.js deliver(): event JSON → (type, requestId, handle, status, value, text). */
static void executor_event(void *user, const char *json, const uint8_t *data, size_t size) {
  NtReactor *r = user;
  size_t n = json ? strlen(json) : 0;
  r->c.executor_events++;
  if (r->in_capture) { snprintf(r->diagnostic, sizeof r->diagnostic, "%s", json ? json : ""); return; }
  Item it = {0};
  NtJsonSpan v;
  int available = 0;
  if (nt_json_member(json, n, "type", &v)) nt_json_number(v, &it.type);
  if (nt_json_member(json, n, "requestId", &v)) nt_json_number(v, &it.request_id);
  if (nt_json_member(json, n, "handle", &v)) nt_json_number(v, &it.handle);
  if (nt_json_member(json, n, "status", &v)) nt_json_number(v, &it.status);
  int has_offset = nt_json_member(json, n, "offset", &v) && nt_json_number(v, &it.offset);
  if (data || (it.type == 3 && has_offset)) {
    it.readback = 1;
    it.data = malloc(size ? size : 1);
    if (!it.data) { r->c.submits_refused++; return; }
    if (size) memcpy(it.data, data, size);
    it.data_size = size;
  }
  if (it.type == 1 && nt_json_member(json, n, "available", &v) && nt_json_bool(v, &available) && available) {
    NtJsonSpan f;
    it.value = nt_json_member(json, n, "features", &f) && nt_json_array_has_string(f, "timestamp-query") ? 1 : 0;
    it.text = dup_bytes(json, n); it.text_size = n;
  } else if (it.type == 7) {
    if (nt_json_member(json, n, "messages", &v)) { it.text = dup_bytes(v.p, v.n); it.text_size = v.n; }
  } else if (it.type == 8) {
    double w = 0, h = 0, dpr = 0;
    if (nt_json_member(json, n, "dpr", &v)) nt_json_number(v, &dpr);
    if (nt_json_member(json, n, "width", &v)) nt_json_number(v, &w);
    if (nt_json_member(json, n, "height", &v)) nt_json_number(v, &h);
    it.value = dpr;
    char buf[96];
    int k = snprintf(buf, sizeof buf, "{\"width\":%.17g,\"height\":%.17g}", w, h);
    it.text = dup_bytes(buf, (size_t)k); it.text_size = (size_t)k;
  } else if (nt_json_member(json, n, "message", &v) || nt_json_member(json, n, "reason", &v)) {
    char *s = malloc(v.n + 1);
    long k = s ? nt_json_string(v, s, v.n + 1) : -1;
    if (k >= 0) { it.text = s; it.text_size = (size_t)k; } else free(s);
  }
  if (!it.text) { it.text = dup_bytes("", 0); it.text_size = 0; }
  if (push(r, &it)) item_free(&it);
}
static void executor_frame_requested(void *user) { NtReactor *r = user; r->frame_wanted = 1; r->c.frame_requests++; }
static void executor_wake(void *user) {
  NtReactor *r = user;
  pthread_mutex_lock(&r->lock);
  atomic_store(&r->woken, 1);
  pthread_cond_broadcast(&r->cond);
  pthread_mutex_unlock(&r->lock);
  if (r->o.wake) r->o.wake(r->o.user);
}

/* ── guest callbacks (inside an export) ───────────────────────────────────── */
static void on_present(void *ctx, const uint8_t *b, size_t bn, const uint8_t *u, size_t un, const uint8_t *rb, size_t rn,
                       const uint8_t *rsha) {
  NtReactor *r = ctx;
  uint64_t index = r->c.presents++;
  r->c.batch_bytes += bn; r->c.upload_bytes += un;
  if (r->o.trace) {
    char hb[65], hu[65], hr[65];
    sha_hex(b, bn, hb); sha_hex(u, un, hu);
    if (r->o.trace_readback_sha && rb) sha_hex(rb, rn, hr);
    else if (r->o.trace_readback_sha && rsha) digest_hex(rsha, hr);
    else hr[0] = 0;
    if (hr[0]) trace_line(r, "present %llu b=%zu:%s u=%zu:%s r=%zu:%s", (unsigned long long)index, bn, hb, un, hu, rn, hr);
    else trace_line(r, "present %llu b=%zu:%s u=%zu:%s r=%zu", (unsigned long long)index, bn, hb, un, hu, rn);
  }
  if (!r->api.submit(r->executor, b, bn, u, un, rn)) r->c.submits_refused++;
}
static void on_report(void *ctx, const uint8_t *s, size_t n) {
  NtReactor *r = ctx;
  r->c.reports++;
  trace_hex(r, "report ", s, n);
  if (r->o.report) r->o.report(r->o.user, s, n);
}
static void on_send(void *ctx, const uint8_t *s, size_t n) {
  NtReactor *r = ctx;
  r->c.sends++;
  if (r->o.trace) { char h[65]; sha_hex(s, n, h); trace_line(r, "send %zu:%s", n, h); }
  if (r->o.send) r->o.send(r->o.user, s, n);
}
static uint8_t on_offer(void *ctx, const uint8_t *s, size_t n) {
  NtReactor *r = ctx;
  r->c.offers++;
  if (r->o.trace) { char h[65]; sha_hex(s, n, h); trace_line(r, "offer %zu:%s", n, h); }
  return r->o.offer ? r->o.offer(r->o.user, s, n) : 1;
}
static void on_panic(void *ctx, const uint8_t *m, size_t n) {
  NtReactor *r = ctx;
  size_t k = n < sizeof r->panic - 1 ? n : sizeof r->panic - 1;
  memcpy(r->panic, m, k); r->panic[k] = 0;
  for (size_t i = 0; i < k; i++) if (r->panic[i] == 0x1f) r->panic[i] = '|'; else if (r->panic[i] == 0x01) r->panic[i] = '^';
  trace_hex(r, "panic ", m, n);
}

/* ── exports ──────────────────────────────────────────────────────────────── */
static const char *export_name(NtExport w) {
  static const char *names[] = {"start", "frame", "event", "message", "receive", "readback"};
  return names[w];
}
static int guarded(NtReactor *r, const NtGuestCall *call, double *out) {
  if (r->poisoned) return NT_REACTOR_POISONED;
  if (r->active) return NT_REACTOR_REENTRY;
  r->active = 1;
  r->c.exports++;
  double result = 0;
  int rc = r->guest->ops->call(r->guest, call, &result);
  r->active = 0;
  if (rc != NT_REACTOR_OK) {
    r->poisoned = 1;
    if (!r->panic[0]) snprintf(r->panic, sizeof r->panic, "guest trapped in %s (no sink message)", export_name(call->which));
    return NT_REACTOR_POISONED;
  }
  if (r->o.trace) { char b[17]; bits(result, b); trace_line(r, "ret %s %s", export_name(call->which), b); }
  if (out) *out = result;
  return NT_REACTOR_OK;
}

int nt_reactor_start(NtReactor *r, double *res) {
  NtGuestCall c = {.which = NT_EXPORT_START};
  return guarded(r, &c, res);
}
int nt_reactor_message(NtReactor *r, double topic, const uint8_t *p, size_t n, double *res) {
  NtGuestCall c = {.which = NT_EXPORT_MESSAGE, .args = {topic}, .bytes = p, .size = n};
  return guarded(r, &c, res);
}
int nt_reactor_receive(NtReactor *r, const uint8_t *p, size_t n, double *res) {
  NtGuestCall c = {.which = NT_EXPORT_RECEIVE, .bytes = p, .size = n};
  return guarded(r, &c, res);
}
int nt_reactor_readback(NtReactor *r, double offset, const uint8_t *p, size_t n, double *res) {
  NtGuestCall c = {.which = NT_EXPORT_READBACK, .args = {offset}, .bytes = p, .size = n};
  return guarded(r, &c, res);
}
int nt_reactor_frame(NtReactor *r, double step, double *res) {
  r->clock += step > 0 ? step : 1000.0 / 60.0;
  r->c.frames++;
  NtGuestCall c = {.which = NT_EXPORT_FRAME, .args = {r->clock}};
  return guarded(r, &c, res);
}
int nt_reactor_queue_event(NtReactor *r, double type, double rid, double handle, double status, double value, const char *text, size_t n) {
  Item it = {.type = type, .request_id = rid, .handle = handle, .status = status, .value = value};
  it.text = dup_bytes(text ? text : "", text ? n : 0); it.text_size = text ? n : 0;
  if (!it.text || push(r, &it)) { free(it.text); return NT_REACTOR_ERROR; }
  return NT_REACTOR_OK;
}
int nt_reactor_resize(NtReactor *r, uint32_t w, uint32_t h, double dpr) {
  if (r->active) return NT_REACTOR_REENTRY;
  uint64_t before = r->seq;
  r->api.resize(r->executor, w, h, dpr);
  if (r->o.resize_event == NT_RESIZE_EVENT_EXECUTOR) return NT_REACTOR_OK;
  if (r->o.resize_event == NT_RESIZE_EVENT_AUTO) {
    r->api.process(r->executor);
    for (size_t i = 0; i < r->count; i++) if (at(r, i)->seq >= before && at(r, i)->type == 8) return NT_REACTOR_OK;
  }
  char buf[96];
  int k = snprintf(buf, sizeof buf, "{\"width\":%u,\"height\":%u}", w, h);
  r->c.resize_events_synthesized++;
  return nt_reactor_queue_event(r, 8, 0, 0, 0, dpr, buf, (size_t)k);
}

static int deliver(NtReactor *r) {
  Item it = *at(r, 0);
  r->head = (r->head + 1) % r->cap; r->count--;
  int rc = NT_REACTOR_OK;
  if (it.readback) {
    NtGuestCall c = {.which = NT_EXPORT_READBACK, .args = {it.offset}, .bytes = it.data, .size = it.data_size};
    rc = guarded(r, &c, NULL);
    if (rc == NT_REACTOR_OK) { r->c.readbacks_delivered++; r->c.readback_bytes += it.data_size; }
  }
  if (rc == NT_REACTOR_OK) {
    NtGuestCall c = {.which = NT_EXPORT_EVENT, .args = {it.type, it.request_id, it.handle, it.status, it.value},
                     .bytes = (const uint8_t *)it.text, .size = it.text_size};
    rc = guarded(r, &c, NULL);
    if (rc == NT_REACTOR_OK) r->c.events_delivered++;
  }
  item_free(&it);
  return rc;
}

static uint64_t now_ms(void) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}
static void wait_wake(NtReactor *r, unsigned ms) {
  pthread_mutex_lock(&r->lock);
  if (!atomic_load(&r->woken)) {
    struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_nsec += (long)ms * 1000000L;
    while (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
    pthread_cond_timedwait(&r->cond, &r->lock, &ts);
  }
  if (atomic_exchange(&r->woken, 0)) r->c.wakes++;
  pthread_mutex_unlock(&r->lock);
}

int nt_reactor_pump(NtReactor *r, const NtPumpOptions *o, NtPumpResult *res) {
  NtPumpResult out = {0};
  if (r->active) return NT_REACTOR_REENTRY;
  double step = o && o->frame_step_ms > 0 ? o->frame_step_ms : 1000.0 / 60.0;
  uint32_t max_frames = o ? o->max_frames : 0;
  /* The timeout bounds a stall (no event, no frame), not the whole pump. */
  const uint64_t stall_ms = o && o->timeout_ms ? o->timeout_ms : 120000;
  uint64_t deadline = now_ms() + stall_ms;
  int rc = NT_REACTOR_OK;
  int ordered = 0;
  for (;;) {
    if (r->poisoned) { rc = NT_REACTOR_POISONED; break; }
    if (r->count) {
      if (!ordered) { order_queue(r); ordered = 1; }
      rc = deliver(r);
      out.events++;
      deadline = now_ms() + stall_ms;
      if (rc) break;
      if (!r->count) ordered = 0;
      if (o && o->until && o->until(o->until_ctx)) { out.stopped = 1; break; }
      continue;
    }
    /* No queued event: let the executor deliver its completions before anything else happens. */
    r->api.process(r->executor);
    if (r->count) continue;
    /* Lockstep (settle): every outstanding GPU request completes, and its event is delivered, before the next
     * frame. Deterministic event sets per frame, so native and wasm guests see the same sequence. */
    if (o && o->settle && r->api.pending(r->executor) > 0) {
      if (now_ms() > deadline) { out.timed_out = 1; rc = NT_REACTOR_ERROR; break; }
      r->c.settle_waits++;
      wait_wake(r, 2);
      continue;
    }
    if (r->frame_wanted && out.frames < max_frames) {
      r->frame_wanted = 0;
      out.frames++;
      deadline = now_ms() + stall_ms;
      rc = nt_reactor_frame(r, step, NULL);
      if (rc) break;
      if (o && o->until && o->until(o->until_ctx)) { out.stopped = 1; break; }
      continue;
    }
    out.idle = !(o && o->settle) || r->api.pending(r->executor) == 0;
    break;
  }
  out.frame_wanted = r->frame_wanted;
  if (res) *res = out;
  return rc;
}

int nt_reactor_capture_rgba(NtReactor *r, uint8_t *rgba, size_t cap, uint32_t *w, uint32_t *h) {
  if (r->active) return 0;
  r->diagnostic[0] = 0;
  r->in_capture = 1;
  int ok = r->api.capture_rgba(r->executor, rgba, cap, w, h);
  r->in_capture = 0;
  return ok;
}
int nt_reactor_poisoned(const NtReactor *r) { return r->poisoned; }
const char *nt_reactor_panic_text(const NtReactor *r) { return r->panic; }
const char *nt_reactor_last_executor_diagnostic(const NtReactor *r) { return r->diagnostic; }
void nt_reactor_counters(const NtReactor *r, NtReactorCounters *out) { *out = r->c; }
double nt_reactor_clock(const NtReactor *r) { return r->clock; }
int nt_reactor_wake_pending(NtReactor *r) { return atomic_load(&r->woken); }

int nt_reactor_create(const NtReactorOptions *o, NtReactor **out, char *err, size_t errn) {
  *out = NULL;
  if (!o || !o->guest || !o->executor) { snprintf(err, errn, "guest and executor are required"); return NT_REACTOR_ERROR; }
  NtReactor *r = calloc(1, sizeof *r);
  if (!r) { snprintf(err, errn, "out of memory"); return NT_REACTOR_ERROR; }
  r->o = *o; r->api = *o->executor; r->guest = o->guest; r->clock = 1000;
  pthread_mutex_init(&r->lock, NULL); pthread_cond_init(&r->cond, NULL);
  NtGpuExecutorOptions eo = {.user = r, .event = executor_event, .frame_requested = executor_frame_requested, .wake = executor_wake,
                             .metal_layer = o->metal_layer, .width = o->width, .height = o->height, .pixel_ratio = o->pixel_ratio};
  /* executor.h leaves create's return convention open (the executor returns 1 like submit/capture): success is a
   * non-NULL executor. */
  int erc = r->api.create(&eo, &r->executor);
  if (!r->executor) {
    snprintf(err, errn, "ntgpu_executor_create failed (%d)", erc);
    r->guest = NULL; nt_reactor_destroy(r);
    return NT_REACTOR_ERROR;
  }
  NtGuestSink sink = {.ctx = r, .present = on_present, .report = on_report, .send = on_send, .offer = on_offer, .panic = on_panic};
  if (r->guest->ops->bind(r->guest, &sink)) {
    snprintf(err, errn, "guest bind/init failed: %s", r->panic[0] ? r->panic : "(no message)");
    r->poisoned = 1;
  }
  *out = r;
  return r->poisoned ? NT_REACTOR_POISONED : NT_REACTOR_OK;
}

void nt_reactor_destroy(NtReactor *r) {
  if (!r) return;
  /* The guest goes first: a native guest's callbacks must not outlive the executor they submit to. */
  if (r->guest) r->guest->ops->destroy(r->guest);
  if (r->executor) r->api.destroy(r->executor);
  while (r->count) { Item it = *at(r, 0); r->head = (r->head + 1) % r->cap; r->count--; item_free(&it); }
  free(r->queue);
  pthread_mutex_destroy(&r->lock); pthread_cond_destroy(&r->cond);
  free(r);
}

/* ── executor binding ─────────────────────────────────────────────────────── */
int nt_executor_api_open(const char *path, NtExecutorApi *api, char *err, size_t errn) {
  memset(api, 0, sizeof *api);
  void *h = path ? dlopen(path, RTLD_NOW | RTLD_LOCAL) : RTLD_DEFAULT;
  if (!h) { snprintf(err, errn, "dlopen %s: %s", path, dlerror()); return -1; }
#define SYM(field, name) \
  *(void **)&api->field = dlsym(h, name); \
  if (!api->field) { snprintf(err, errn, "%s: missing symbol %s", path ? path : "(process)", name); return -1; }
  SYM(create, "ntgpu_executor_create") SYM(destroy, "ntgpu_executor_destroy") SYM(submit, "ntgpu_executor_submit")
  SYM(process, "ntgpu_executor_process") SYM(pending, "ntgpu_executor_pending") SYM(resize, "ntgpu_executor_resize")
  SYM(capture_rgba, "ntgpu_executor_capture_rgba")
#undef SYM
  api->is_mock = dlsym(h, "ntgpu_executor_is_mock") != NULL;
  api->origin = path ? path : "linked";
  return 0;
}

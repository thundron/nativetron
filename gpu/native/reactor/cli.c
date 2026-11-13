/* nt-reactor: standalone native reactor host process.
 *
 *   nt-reactor run      --engine <spec> --executor-lib <dylib|linked> --script <file> --out <dir> [options]
 *   nt-reactor selftest --engine <spec> --executor-lib <mock dylib>          guard / poison / restart checks
 *   nt-reactor guest    --engine native:<dylib|linked> [--prefix hp_]        serve a guest on fds 3/4 (child mode)
 *
 * Engine spec: native:<dylib> | native:linked (archive linked into this binary) | native-process:<dylib>
 *              | wasm:<dir with hp-engine.mjs + hp-engine.wasm> (Node/V8 child running gpu/native/reactor/wasm-guest.mjs)
 * Options: --prefix hp_  --width 640 --height 400 --dpr 1  --event-order arrival|request  --resize-event auto|host|executor
 *          --no-settle  --timeout-ms N  --frame-step-ms 16.666…  --trace <file> [--trace-readback-sha]
 *          --node <node binary>  --wasm-guest <wasm-guest.mjs>
 * No timing is measured or reported: timepoints.csv carries raw monotonic nanoseconds per step for later
 * uncontended analysis only.
 */
#include "reactor.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <mach/mach_time.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef NT_REACTOR_SOURCE_DIR
#define NT_REACTOR_SOURCE_DIR "."
#endif

enum { K_COMMAND = 1, K_RESULT = 2, K_ERROR = 3, K_EVENT = 4, K_REPORT = 5, K_STATE = 6, K_BULK = 7 };
enum { LANE_NATIVE = 0, LANE_UI = 1, LANE_ENGINE = 2 };
enum { E_CAPTURE_DATA = 100, E_GI = 101, E_STATUS = 102, STATUS_F64 = 12 };

typedef struct { uint32_t rid; uint8_t kind; uint32_t topic; uint8_t *payload; size_t size; } Result;
typedef struct { uint32_t rid; uint8_t *bytes; size_t cap, received, end; uint32_t chunks; } Capture;
typedef struct { uint32_t topic; double kind; uint64_t count; } EventCount;

typedef struct {
  const char *engine, *prefix, *executor_lib, *script, *out, *trace_path, *node, *wasm_guest;
  uint32_t width, height; double dpr, frame_step;
  NtEventOrder order; NtResizeEvent resize_event;
  int settle, trace_sha; uint32_t timeout_ms;
} Args;

typedef struct {
  Args a;
  NtReactor *r;
  NtExecutorApi api;
  FILE *trace, *log, *tp;
  Result *results; size_t nresults;
  Capture *captures; size_t ncaptures;
  EventCount *events; size_t nevents;
  double status[STATUS_F64]; uint64_t states;
  char script_dir[1024];
  int reentry_probe, reentry_rc;
  uint64_t step_index;
  char captures_json[65536]; size_t captures_json_n;
  int failures;
  unsigned divergences;
} App;

static void die(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  fputs("nt-reactor: ", stderr); vfprintf(stderr, fmt, ap); fputc('\n', stderr);
  va_end(ap);
  exit(2);
}
static uint64_t now_ns(void) {
  static mach_timebase_info_data_t tb;
  if (!tb.denom) mach_timebase_info(&tb);
  return mach_absolute_time() * tb.numer / tb.denom;
}
static void sha_hex(const uint8_t *p, size_t n, char out[65]) {
  unsigned char d[32]; CC_SHA256_CTX c; CC_SHA256_Init(&c);
  for (size_t at = 0; at < n;) { CC_LONG k = n - at > 0x40000000 ? 0x40000000 : (CC_LONG)(n - at); CC_SHA256_Update(&c, p + at, k); at += k; }
  CC_SHA256_Final(d, &c);
  for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", d[i]);
}
static uint32_t rd32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static double rdf64(const uint8_t *p) { double v; memcpy(&v, p, 8); return v; }

/* ── engine → application frames ─────────────────────────────────────────── */
static Capture *capture_for(App *A, uint32_t rid) {
  for (size_t i = 0; i < A->ncaptures; i++) if (A->captures[i].rid == rid) return &A->captures[i];
  A->captures = realloc(A->captures, (A->ncaptures + 1) * sizeof *A->captures);
  Capture *c = &A->captures[A->ncaptures++];
  memset(c, 0, sizeof *c); c->rid = rid;
  return c;
}
static void on_frame(App *A, const uint8_t *f, size_t n, const char *via) {
  if (n < 16 || f[0] != 1) { fprintf(A->log, "%s malformed %zu\n", via, n); return; }
  uint8_t kind = f[1];
  uint32_t rid = rd32(f + 4), topic = rd32(f + 8), len = rd32(f + 12);
  const uint8_t *p = f + 16;
  if (len != n - 16) { fprintf(A->log, "%s bad-length %zu\n", via, n); return; }
  if (kind == K_RESULT || kind == K_ERROR) {
    A->results = realloc(A->results, (A->nresults + 1) * sizeof *A->results);
    Result *r = &A->results[A->nresults++];
    r->rid = rid; r->kind = kind; r->topic = topic; r->size = len; r->payload = malloc(len ? len : 1); memcpy(r->payload, p, len);
    char h[65]; sha_hex(p, len, h);
    fprintf(A->log, "%s %s rid=%u topic=%u len=%u sha=%s", via, kind == K_RESULT ? "result" : "error", rid, topic, len, h);
    if (len <= 256) { fputs(" text=", A->log); for (uint32_t i = 0; i < len; i++) fputc(p[i] >= 32 && p[i] < 127 ? p[i] : '.', A->log); }
    fputc('\n', A->log);
  } else if (kind == K_BULK && topic == E_CAPTURE_DATA && len >= 4) {
    Capture *c = capture_for(A, rid);
    size_t off = rd32(p), m = len - 4;
    if (off + m > c->cap) {
      size_t cap = c->cap ? c->cap : 1 << 20;
      while (cap < off + m) cap *= 2;
      c->bytes = realloc(c->bytes, cap); memset(c->bytes + c->cap, 0, cap - c->cap); c->cap = cap;
    }
    memcpy(c->bytes + off, p + 4, m);
    c->received += m; c->chunks++;
    if (off + m > c->end) c->end = off + m;
    fprintf(A->log, "%s capture-chunk rid=%u offset=%zu len=%zu\n", via, rid, off, m);
  } else if (kind == K_STATE && topic == E_STATUS && len >= STATUS_F64 * 8) {
    for (int i = 0; i < STATUS_F64; i++) A->status[i] = rdf64(p + 8 * i);
    A->states++;
  } else if (kind == K_EVENT) {
    double k = len >= 8 ? rdf64(p) : -1;
    size_t i;
    for (i = 0; i < A->nevents; i++) if (A->events[i].topic == topic && A->events[i].kind == k) break;
    if (i == A->nevents) { A->events = realloc(A->events, (A->nevents + 1) * sizeof *A->events); A->events[i] = (EventCount){topic, k, 0}; A->nevents++; }
    A->events[i].count++;
    fprintf(A->log, "%s event topic=%u", via, topic);
    for (uint32_t j = 0; j + 8 <= len && j < 64; j += 8) fprintf(A->log, " %.17g", rdf64(p + j));
    fputc('\n', A->log);
  } else if (kind == K_STATE) {
    A->states++;
  } else {
    fprintf(A->log, "%s kind=%u rid=%u topic=%u len=%u\n", via, kind, rid, topic, len);
  }
}
static void app_send(void *u, const uint8_t *f, size_t n) {
  App *A = u;
  on_frame(A, f, n, "send");
  if (A->reentry_probe) { A->reentry_probe = 0; A->reentry_rc = nt_reactor_message(A->r, 18, NULL, 0, NULL); }
}
static uint8_t app_offer(void *u, const uint8_t *f, size_t n) { on_frame(u, f, n, "offer"); return 1; }
static void app_report(void *u, const uint8_t *s, size_t n) { App *A = u; fprintf(A->log, "report %.*s\n", (int)n, (const char *)s); }
static void app_trace(void *u, const char *line) { App *A = u; if (A->trace) { fputs(line, A->trace); fputc('\n', A->trace); } }

/* ── guests ───────────────────────────────────────────────────────────────── */
static const char *self_path(void) {
  static char buf[4096];
  uint32_t n = sizeof buf;
  if (_NSGetExecutablePath(buf, &n)) return "nt-reactor";
  return buf;
}
static NtGuest *open_guest(const Args *a, char *kind, size_t kn) {
  char err[1024];
  NtGuest *g = NULL;
  if (strncmp(a->engine, "native:", 7) == 0) {
    const char *lib = a->engine + 7;
    if (nt_guest_native_open(strcmp(lib, "linked") == 0 ? NULL : lib, a->prefix, &g, err, sizeof err)) die("%s", err);
    snprintf(kind, kn, "native");
  } else if (strncmp(a->engine, "native-process:", 15) == 0) {
    char *argv[] = {(char *)self_path(), "guest", "--engine", NULL, "--prefix", (char *)a->prefix, NULL};
    char spec[2048]; snprintf(spec, sizeof spec, "native:%s", a->engine + 15); argv[3] = spec;
    if (nt_guest_process_open(argv, a->trace_sha, &g, err, sizeof err)) die("%s", err);
    snprintf(kind, kn, "native-process");
  } else if (strncmp(a->engine, "wasm:", 5) == 0) {
    char *argv[] = {(char *)a->node, (char *)a->wasm_guest, (char *)(a->engine + 5), (char *)a->prefix, NULL};
    if (nt_guest_process_open(argv, a->trace_sha, &g, err, sizeof err)) die("%s", err);
    snprintf(kind, kn, "wasm-process");
  } else die("unknown engine spec %s", a->engine);
  return g;
}

static void make_reactor(App *A) {
  char err[1024], kind[64];
  NtGuest *g = open_guest(&A->a, kind, sizeof kind);
  NtReactorOptions o = {
    .guest = g, .executor = &A->api, .width = A->a.width, .height = A->a.height, .pixel_ratio = A->a.dpr,
    .event_order = A->a.order, .resize_event = A->a.resize_event, .user = A,
    .send = app_send, .offer = app_offer, .report = app_report, .trace = A->trace ? app_trace : NULL,
    .trace_readback_sha = A->a.trace_sha,
  };
  int rc = nt_reactor_create(&o, &A->r, err, sizeof err);
  if (rc == NT_REACTOR_ERROR) die("%s", err);
  if (rc == NT_REACTOR_POISONED) fprintf(stderr, "nt-reactor: %s\n", err);
}

/* ── script payloads ─────────────────────────────────────────────────────── */
typedef struct { uint8_t *p; size_t n; } Bytes;
static Bytes read_file(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) die("open %s: %s", path, strerror(errno));
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  Bytes b = {malloc(n ? (size_t)n : 1), (size_t)n};
  if (n && fread(b.p, 1, (size_t)n, f) != (size_t)n) die("read %s", path);
  fclose(f);
  return b;
}
static Bytes payload(App *A, const char *s) {
  Bytes b = {malloc(1), 0};
  if (!s || strcmp(s, "-") == 0) return b;
  free(b.p);
  if (s[0] == '@') {
    char path[2048];
    if (s[1] == '/') snprintf(path, sizeof path, "%s", s + 1); else snprintf(path, sizeof path, "%s/%s", A->script_dir, s + 1);
    return read_file(path);
  }
  if (strncmp(s, "hex:", 4) == 0) {
    size_t n = strlen(s + 4) / 2;
    b.p = malloc(n ? n : 1); b.n = n;
    for (size_t i = 0; i < n; i++) { unsigned v; sscanf(s + 4 + 2 * i, "%2x", &v); b.p[i] = (uint8_t)v; }
    return b;
  }
  if (strncmp(s, "u32:", 4) == 0 || strncmp(s, "f64:", 4) == 0) {
    int f64 = s[0] == 'f';
    b.p = malloc(strlen(s) * 8 + 8); b.n = 0;
    for (const char *q = s + 4; *q;) {
      char *end;
      if (f64) { double v = strtod(q, &end); memcpy(b.p + b.n, &v, 8); b.n += 8; }
      else { uint32_t v = (uint32_t)strtoul(q, &end, 0); memcpy(b.p + b.n, &v, 4); b.n += 4; }
      if (end == q) die("bad payload %s", s);
      q = *end == ',' ? end + 1 : end;
    }
    return b;
  }
  if (strncmp(s, "text:", 5) == 0) { b.n = strlen(s + 5); b.p = malloc(b.n + 1); memcpy(b.p, s + 5, b.n); return b; }
  die("bad payload %s (use -, @file, hex:, u32:, f64:, text:)", s);
  return b;
}
static Bytes engine_frame(uint8_t kind, uint32_t rid, uint32_t topic, Bytes p) {
  Bytes f = {malloc(16 + p.n), 16 + p.n};
  uint8_t h[16] = {1, kind, LANE_UI, LANE_ENGINE};
  memcpy(h + 4, &rid, 4); memcpy(h + 8, &topic, 4); uint32_t n = (uint32_t)p.n; memcpy(h + 12, &n, 4);
  memcpy(f.p, h, 16); if (p.n) memcpy(f.p + 16, p.p, p.n);
  return f;
}

/* ── conditions ──────────────────────────────────────────────────────────── */
typedef struct { App *A; uint32_t rid; uint32_t topic; double kind; int any; uint64_t base; } Cond;
static Result *result_for(App *A, uint32_t rid) {
  for (size_t i = A->nresults; i-- > 0;) if (A->results[i].rid == rid) return &A->results[i];
  return NULL;
}
static int has_result(void *c) { Cond *k = c; return result_for(k->A, k->rid) != NULL; }
static uint64_t event_count(App *A, uint32_t topic, double kind, int any) {
  uint64_t n = 0;
  for (size_t i = 0; i < A->nevents; i++) if (A->events[i].topic == topic && (any || A->events[i].kind == kind)) n += A->events[i].count;
  return n;
}
static int has_event(void *c) { Cond *k = c; return event_count(k->A, k->topic, k->kind, k->any) > k->base; }
/* A status frame newer than the step's start with every bit of the mask in STATUS_FLAGS (index 6). */
static int has_status(void *c) { Cond *k = c; return k->A->states > k->base && ((uint32_t)k->A->status[6] & k->rid) == k->rid; }

static int pump_until(App *A, uint32_t frames, int (*until)(void *), void *ctx, const char *what) {
  NtPumpOptions o = {.max_frames = frames, .frame_step_ms = A->a.frame_step, .settle = A->a.settle, .timeout_ms = A->a.timeout_ms,
                     .until = until, .until_ctx = ctx};
  NtPumpResult res;
  int rc = nt_reactor_pump(A->r, &o, &res);
  fprintf(A->log, "pump %s events=%u frames=%u idle=%d stopped=%d timed_out=%d frame_wanted=%d rc=%d\n", what, res.events, res.frames,
          res.idle, res.stopped, res.timed_out, res.frame_wanted, rc);
  if (rc) return rc;
  if (until && !until(ctx)) {
    fprintf(stderr, "nt-reactor: %s not reached (frames %u/%u, idle=%d, frame wanted=%d)\n", what, res.frames, frames, res.idle, res.frame_wanted);
    return NT_REACTOR_ERROR;
  }
  return NT_REACTOR_OK;
}

/* ── captures ─────────────────────────────────────────────────────────────── */
static void json_append(App *A, const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  int k = vsnprintf(A->captures_json + A->captures_json_n, sizeof A->captures_json - A->captures_json_n, fmt, ap);
  va_end(ap);
  if (k > 0) A->captures_json_n += (size_t)k;
  if (A->captures_json_n >= sizeof A->captures_json) A->captures_json_n = sizeof A->captures_json - 1;
}
static void write_bytes(const char *path, const uint8_t *p, size_t n) {
  FILE *f = fopen(path, "wb");
  if (!f || (n && fwrite(p, 1, n, f) != n)) die("write %s", path);
  fclose(f);
}
static void write_status_json(App *A, FILE *f) {
  fputs("[", f);
  for (int i = 0; i < STATUS_F64; i++) fprintf(f, "%s%.17g", i ? "," : "", A->status[i]);
  fputs("]", f);
}
static void capture_meta(App *A, const char *name, const char *source, uint32_t w, uint32_t h, const char *extra, const char *sha,
                         const char *file) {
  char path[2048]; snprintf(path, sizeof path, "%s/%s.json", A->a.out, name);
  FILE *f = fopen(path, "w");
  if (!f) die("write %s", path);
  fprintf(f, "{\"name\":\"%s\",\"source\":\"%s\",\"width\":%u,\"height\":%u,\"file\":\"%s\",\"sha256\":\"%s\",%s"
             "\"executor\":{\"origin\":\"%s\",\"mock\":%s},\"engine\":\"%s\",\"clock\":%.17g,\"status\":",
          name, source, w, h, file, sha, extra, A->api.origin, A->api.is_mock ? "true" : "false", A->a.engine, nt_reactor_clock(A->r));
  write_status_json(A, f);
  fputs("}\n", f);
  fclose(f);
  json_append(A, "%s{\"name\":\"%s\",\"source\":\"%s\",\"width\":%u,\"height\":%u,\"sha256\":\"%s\"}", A->captures_json_n ? "," : "",
              name, source, w, h, sha);
}
static int capture_engine(App *A, uint32_t rid, const char *name) {
  Result *r = result_for(A, rid);
  if (!r) { fprintf(stderr, "nt-reactor: capture %s: no result for request %u\n", name, rid); return -1; }
  if (r->kind != K_RESULT || r->size < 12) { fprintf(stderr, "nt-reactor: capture %s: request %u failed (%.*s)\n", name, rid, (int)r->size, r->payload); return -1; }
  uint32_t w = rd32(r->payload), h = rd32(r->payload + 4), bgra = rd32(r->payload + 8);
  uint32_t codec = r->size >= 20 ? rd32(r->payload + 12) : 0, encoded = r->size >= 20 ? rd32(r->payload + 16) : 0;
  Capture *c = capture_for(A, rid);
  size_t want = codec ? encoded : (size_t)w * h * 4;
  if (c->end < want) { fprintf(stderr, "nt-reactor: capture %s: %zu of %zu bytes\n", name, c->end, want); return -1; }
  char path[2048], sha[65], extra[512];
  if (codec == 0) {
    if (bgra == 1) for (size_t i = 0; i < want; i += 4) { uint8_t t = c->bytes[i]; c->bytes[i] = c->bytes[i + 2]; c->bytes[i + 2] = t; }
    snprintf(path, sizeof path, "%s/%s.rgba", A->a.out, name);
    write_bytes(path, c->bytes, want);
  } else {
    snprintf(path, sizeof path, "%s/%s.enc", A->a.out, name);
    write_bytes(path, c->bytes, want);
  }
  sha_hex(c->bytes, want, sha);
  snprintf(extra, sizeof extra, "\"request\":%u,\"bgra\":%u,\"codec\":%u,\"bytes\":%zu,\"chunks\":%u,", rid, bgra, codec, want, c->chunks);
  capture_meta(A, name, "engine-T_CAPTURE", w, h, extra, sha, codec ? "enc" : "rgba");
  fprintf(stderr, "nt-reactor: capture %s %ux%u codec=%u%s sha256=%s\n", name, w, h, codec, A->api.is_mock ? " (MOCK executor: not a render)" : "", sha);
  return 0;
}
static int capture_executor(App *A, const char *name, uint32_t w, uint32_t h) {
  size_t cap = (size_t)w * h * 4;
  uint8_t *rgba = calloc(1, cap ? cap : 4);
  uint32_t ow = 0, oh = 0;
  int ok = nt_reactor_capture_rgba(A->r, rgba, cap, &ow, &oh);
  if (!ok && ow && oh && (size_t)ow * oh * 4 > cap) {
    cap = (size_t)ow * oh * 4; free(rgba); rgba = calloc(1, cap);
    ok = nt_reactor_capture_rgba(A->r, rgba, cap, &ow, &oh);
  }
  if (!ok) {
    fprintf(stderr, "nt-reactor: executor capture %s unavailable: %s\n", name, nt_reactor_last_executor_diagnostic(A->r));
    json_append(A, "%s{\"name\":\"%s\",\"source\":\"executor\",\"unavailable\":true}", A->captures_json_n ? "," : "", name);
    free(rgba);
    return 1; /* not a failure of the run: recorded as unavailable */
  }
  char path[2048], sha[65];
  snprintf(path, sizeof path, "%s/%s.rgba", A->a.out, name);
  write_bytes(path, rgba, (size_t)ow * oh * 4);
  sha_hex(rgba, (size_t)ow * oh * 4, sha);
  capture_meta(A, name, "executor-capture_rgba", ow, oh, "\"bgra\":0,\"codec\":0,", sha, "rgba");
  free(rgba);
  return 0;
}

/* ── script ──────────────────────────────────────────────────────────────── */
static int run_script(App *A) {
  FILE *f = fopen(A->a.script, "r");
  if (!f) die("open %s", A->a.script);
  char *line = NULL; size_t cap = 0; ssize_t len;
  unsigned lineno = 0;
  uint32_t cur_w = A->a.width, cur_h = A->a.height; double cur_dpr = A->a.dpr;
  while ((len = getline(&line, &cap, f)) >= 0) {
    lineno++;
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    char *tok[12] = {0}; int nt = 0;
    for (char *save = NULL, *t = strtok_r(line, " \t", &save); t && nt < 12; t = strtok_r(NULL, " \t", &save)) tok[nt++] = t;
    if (!nt || tok[0][0] == '#') continue;
    const char *op = tok[0];
    uint64_t t0 = now_ns();
    NtReactorCounters c0; nt_reactor_counters(A->r, &c0);
    int rc = 0;
    double ret = 0;
    if (strcmp(op, "start") == 0) rc = nt_reactor_start(A->r, &ret);
    else if (strcmp(op, "message") == 0 && nt >= 2) { Bytes b = payload(A, tok[2]); rc = nt_reactor_message(A->r, atof(tok[1]), b.p, b.n, &ret); free(b.p); }
    else if (strcmp(op, "receive") == 0 && nt >= 2) { Bytes b = payload(A, tok[1]); rc = nt_reactor_receive(A->r, b.p, b.n, &ret); free(b.p); }
    else if ((strcmp(op, "command") == 0 || strcmp(op, "bulk") == 0 || strcmp(op, "state") == 0) && nt >= 3) {
      Bytes b = payload(A, nt > 3 ? tok[3] : "-");
      uint8_t kind = op[0] == 'c' ? K_COMMAND : op[0] == 'b' ? K_BULK : K_STATE;
      Bytes fr = engine_frame(kind, (uint32_t)strtoul(tok[2], NULL, 0), (uint32_t)strtoul(tok[1], NULL, 0), b);
      rc = nt_reactor_receive(A->r, fr.p, fr.n, &ret);
      free(b.p); free(fr.p);
    } else if (strcmp(op, "event") == 0 && nt >= 7) {
      Bytes b = payload(A, tok[6]);
      rc = nt_reactor_queue_event(A->r, atof(tok[1]), atof(tok[2]), atof(tok[3]), atof(tok[4]), atof(tok[5]), (const char *)b.p, b.n);
      free(b.p);
    } else if (strcmp(op, "resize") == 0 && nt >= 4) {
      cur_w = (uint32_t)atoi(tok[1]); cur_h = (uint32_t)atoi(tok[2]); cur_dpr = atof(tok[3]);
      rc = nt_reactor_resize(A->r, cur_w, cur_h, cur_dpr);
    } else if (strcmp(op, "pump") == 0) rc = pump_until(A, nt > 1 ? (uint32_t)atoi(tok[1]) : 6, NULL, NULL, "pump");
    else if (strcmp(op, "wait-result") == 0 && nt >= 2) {
      Cond k = {.A = A, .rid = (uint32_t)strtoul(tok[1], NULL, 0)};
      char what[64]; snprintf(what, sizeof what, "result %u", k.rid);
      rc = has_result(&k) ? 0 : pump_until(A, nt > 2 ? (uint32_t)atoi(tok[2]) : 600, has_result, &k, what);
      Result *r = result_for(A, k.rid);
      if (!rc && r && r->kind == K_ERROR) { fprintf(stderr, "nt-reactor: request %u failed: %.*s\n", k.rid, (int)r->size, r->payload); }
    } else if (strcmp(op, "wait-event") == 0 && nt >= 3) {
      Cond k = {.A = A, .topic = (uint32_t)strtoul(tok[1], NULL, 0), .any = strcmp(tok[2], "*") == 0, .kind = atof(tok[2])};
      k.base = event_count(A, k.topic, k.kind, k.any);
      char what[64]; snprintf(what, sizeof what, "event %u/%s", k.topic, tok[2]);
      rc = pump_until(A, nt > 3 ? (uint32_t)atoi(tok[3]) : 600, has_event, &k, what);
    } else if (strcmp(op, "wait-status") == 0 && nt >= 2) {
      Cond k = {.A = A, .rid = (uint32_t)strtoul(tok[1], NULL, 0), .base = A->states};
      char what[64]; snprintf(what, sizeof what, "status flags %s", tok[1]);
      /* An engine that is already settled and idle sends no new status: settled + idle also satisfies the wait. */
      NtPumpOptions po = {.max_frames = nt > 2 ? (uint32_t)atoi(tok[2]) : 600, .frame_step_ms = A->a.frame_step, .settle = A->a.settle,
                          .timeout_ms = A->a.timeout_ms, .until = has_status, .until_ctx = &k};
      NtPumpResult res;
      rc = nt_reactor_pump(A->r, &po, &res);
      fprintf(A->log, "pump %s events=%u frames=%u idle=%d stopped=%d frame_wanted=%d rc=%d\n", what, res.events, res.frames, res.idle, res.stopped, res.frame_wanted, rc);
      if (!rc && !has_status(&k) && !(res.idle && !res.frame_wanted && ((uint32_t)A->status[6] & k.rid) == k.rid)) {
        fprintf(stderr, "nt-reactor: %s not reached (frames %u, idle=%d, flags=%u)\n", what, res.frames, res.idle, (uint32_t)A->status[6]);
        rc = NT_REACTOR_ERROR;
      }
    } else if (strcmp(op, "sync-frames") == 0 && nt >= 2) {
      /* Frame-synchronous replay: run frames until the engine's cumulative frame count (E_STATUS[0]) reaches the
       * count the recorded page had seen before its next frame, never beyond. An engine that goes idle earlier is
       * logged as a divergence (soft). */
      double want = atof(tok[1]);
      Cond k = {.A = A};
      double have = A->status[0];
      uint32_t need = want > have ? (uint32_t)(want - have) : 0;
      NtPumpOptions po = {.max_frames = need, .frame_step_ms = A->a.frame_step, .settle = A->a.settle, .timeout_ms = A->a.timeout_ms};
      NtPumpResult res;
      (void)k;
      rc = nt_reactor_pump(A->r, &po, &res);
      for (int guard = 0; !rc && A->status[0] < want && res.frames > 0 && guard < 100000; guard++) {
        need = (uint32_t)(want - A->status[0]); po.max_frames = need;
        rc = nt_reactor_pump(A->r, &po, &res);
      }
      fprintf(A->log, "sync-frames want=%.0f have=%.0f now=%.0f%s rc=%d\n", want, have, A->status[0], A->status[0] < want ? " DIVERGED(engine idle earlier)" : "", rc);
      if (A->status[0] < want) A->divergences++;
    } else if (strcmp(op, "capture-engine") == 0 && nt >= 3) rc = capture_engine(A, (uint32_t)strtoul(tok[1], NULL, 0), tok[2]);
    else if (strcmp(op, "capture-executor") == 0 && nt >= 2) {
      uint32_t pw = (uint32_t)(cur_w * (cur_dpr > 1 ? cur_dpr : 1) + 0.5), ph = (uint32_t)(cur_h * (cur_dpr > 1 ? cur_dpr : 1) + 0.5);
      rc = capture_executor(A, tok[1], pw, ph) < 0 ? -1 : 0;
    } else if (strcmp(op, "mark") == 0) rc = 0;
    else if (strcmp(op, "expect-poisoned") == 0) rc = nt_reactor_poisoned(A->r) ? 0 : -1;
    else die("%s:%u: unknown step %s", A->a.script, lineno, op);
    NtReactorCounters c1; nt_reactor_counters(A->r, &c1);
    if (A->tp)
      fprintf(A->tp, "%llu,%u,%s,%s,%llu,%llu,%llu,%llu,%llu\n", (unsigned long long)A->step_index, lineno, op, nt > 1 && op[0] == 'm' && op[1] == 'a' ? tok[1] : "",
              (unsigned long long)t0, (unsigned long long)now_ns(), (unsigned long long)(c1.frames - c0.frames),
              (unsigned long long)(c1.events_delivered - c0.events_delivered), (unsigned long long)(c1.presents - c0.presents));
    A->step_index++;
    if (rc) {
      fprintf(stderr, "nt-reactor: %s:%u: step '%s' failed (%d)%s%s\n", A->a.script, lineno, op, rc,
              nt_reactor_poisoned(A->r) ? ": guest poisoned: " : "", nt_reactor_poisoned(A->r) ? nt_reactor_panic_text(A->r) : "");
      A->failures++;
      break;
    }
  }
  free(line);
  fclose(f);
  return A->failures ? 1 : 0;
}

static void write_run_json(App *A, int code) {
  char path[2048]; snprintf(path, sizeof path, "%s/run.json", A->a.out);
  FILE *f = fopen(path, "w");
  if (!f) return;
  NtReactorCounters c; nt_reactor_counters(A->r, &c);
  fprintf(f, "{\n \"ok\": %s,\n \"engine\": \"%s\",\n \"prefix\": \"%s\",\n \"executor\": {\"origin\": \"%s\", \"mock\": %s},\n", code == 0 ? "true" : "false",
          A->a.engine, A->a.prefix, A->api.origin, A->api.is_mock ? "true" : "false");
  fprintf(f, " \"script\": \"%s\",\n \"flags\": {\"width\": %u, \"height\": %u, \"dpr\": %.17g, \"eventOrder\": \"%s\", \"resizeEvent\": \"%s\", \"settle\": %s, "
             "\"frameStepMs\": %.17g, \"timeoutMs\": %u, \"traceReadbackSha\": %s},\n",
          A->a.script, A->a.width, A->a.height, A->a.dpr, A->a.order == NT_EVENT_ORDER_REQUEST ? "request" : "arrival",
          A->a.resize_event == NT_RESIZE_EVENT_HOST ? "host" : A->a.resize_event == NT_RESIZE_EVENT_EXECUTOR ? "executor" : "auto",
          A->a.settle ? "true" : "false", A->a.frame_step, A->a.timeout_ms, A->a.trace_sha ? "true" : "false");
  fprintf(f, " \"poisoned\": %s,\n \"panic\": \"", nt_reactor_poisoned(A->r) ? "true" : "false");
  for (const char *p = nt_reactor_panic_text(A->r); *p; p++) { if (*p == '"' || *p == '\\') fputc('\\', f); if ((unsigned char)*p >= 32) fputc(*p, f); }
  fprintf(f, "\",\n \"counters\": {\"exports\": %llu, \"presents\": %llu, \"batchBytes\": %llu, \"uploadBytes\": %llu, \"submitsRefused\": %llu, "
             "\"eventsDelivered\": %llu, \"readbacksDelivered\": %llu, \"readbackBytes\": %llu, \"frames\": %llu, \"frameRequests\": %llu, "
             "\"sends\": %llu, \"offers\": %llu, \"reports\": %llu, \"executorEvents\": %llu, \"resizeEventsSynthesized\": %llu, "
             "\"settleWaits\": %llu, \"wakes\": %llu, \"maxQueuedEvents\": %llu, \"engineStates\": %llu},\n",
          (unsigned long long)c.exports, (unsigned long long)c.presents, (unsigned long long)c.batch_bytes, (unsigned long long)c.upload_bytes,
          (unsigned long long)c.submits_refused, (unsigned long long)c.events_delivered, (unsigned long long)c.readbacks_delivered,
          (unsigned long long)c.readback_bytes, (unsigned long long)c.frames, (unsigned long long)c.frame_requests, (unsigned long long)c.sends,
          (unsigned long long)c.offers, (unsigned long long)c.reports, (unsigned long long)c.executor_events,
          (unsigned long long)c.resize_events_synthesized, (unsigned long long)c.settle_waits, (unsigned long long)c.wakes,
          (unsigned long long)c.max_queued_events, (unsigned long long)A->states);
  fprintf(f, " \"frameSyncDivergences\": %u,\n", A->divergences);
  fputs(" \"engineStatus\": ", f); write_status_json(A, f);
  fputs(",\n \"engineEvents\": [", f);
  for (size_t i = 0; i < A->nevents; i++) fprintf(f, "%s{\"topic\": %u, \"kind\": %.17g, \"count\": %llu}", i ? ", " : "", A->events[i].topic, A->events[i].kind, (unsigned long long)A->events[i].count);
  fputs("],\n \"results\": [", f);
  for (size_t i = 0; i < A->nresults; i++) fprintf(f, "%s{\"request\": %u, \"topic\": %u, \"ok\": %s, \"bytes\": %zu}", i ? ", " : "", A->results[i].rid, A->results[i].topic, A->results[i].kind == K_RESULT ? "true" : "false", A->results[i].size);
  fprintf(f, "],\n \"captures\": [%.*s]\n}\n", (int)A->captures_json_n, A->captures_json);
  fclose(f);
}

static void parse_args(Args *a, int argc, char **argv, int from) {
  *a = (Args){.prefix = "hp_", .width = 640, .height = 400, .dpr = 1, .settle = 1, .timeout_ms = 120000, .frame_step = 1000.0 / 60.0,
              .node = getenv("NT_NODE") ? getenv("NT_NODE") : "node", .wasm_guest = NT_REACTOR_SOURCE_DIR "/wasm-guest.mjs"};
  for (int i = from; i < argc; i++) {
    const char *k = argv[i];
#define VAL() (i + 1 < argc ? argv[++i] : (die("%s needs a value", k), ""))
    if (!strcmp(k, "--engine")) a->engine = VAL();
    else if (!strcmp(k, "--prefix")) a->prefix = VAL();
    else if (!strcmp(k, "--executor-lib")) a->executor_lib = VAL();
    else if (!strcmp(k, "--script")) a->script = VAL();
    else if (!strcmp(k, "--out")) a->out = VAL();
    else if (!strcmp(k, "--trace")) a->trace_path = VAL();
    else if (!strcmp(k, "--trace-readback-sha")) a->trace_sha = 1;
    else if (!strcmp(k, "--node")) a->node = VAL();
    else if (!strcmp(k, "--wasm-guest")) a->wasm_guest = VAL();
    else if (!strcmp(k, "--width")) a->width = (uint32_t)atoi(VAL());
    else if (!strcmp(k, "--height")) a->height = (uint32_t)atoi(VAL());
    else if (!strcmp(k, "--dpr")) a->dpr = atof(VAL());
    else if (!strcmp(k, "--frame-step-ms")) a->frame_step = atof(VAL());
    else if (!strcmp(k, "--timeout-ms")) a->timeout_ms = (uint32_t)atoi(VAL());
    else if (!strcmp(k, "--no-settle")) a->settle = 0;
    else if (!strcmp(k, "--event-order")) { const char *v = VAL(); a->order = !strcmp(v, "request") ? NT_EVENT_ORDER_REQUEST : NT_EVENT_ORDER_ARRIVAL; }
    else if (!strcmp(k, "--resize-event")) { const char *v = VAL(); a->resize_event = !strcmp(v, "host") ? NT_RESIZE_EVENT_HOST : !strcmp(v, "executor") ? NT_RESIZE_EVENT_EXECUTOR : NT_RESIZE_EVENT_AUTO; }
    else die("unknown option %s", k);
#undef VAL
  }
  if (!a->engine) die("--engine is required");
}

static int open_executor(App *A) {
  char err[1024];
  const char *lib = A->a.executor_lib;
  if (!lib) die("--executor-lib is required (a real executor dylib, 'linked', or the mock for development)");
  if (nt_executor_api_open(strcmp(lib, "linked") == 0 ? NULL : lib, &A->api, err, sizeof err)) die("%s", err);
  if (A->api.is_mock) fprintf(stderr, "nt-reactor: executor %s is the MOCK (recording double): no GPU work, no pixels\n", lib);
  return 0;
}

/* ── selftest: guards, poison, process restart ───────────────────────────── */
static int check(App *A, int ok, const char *what) {
  printf("%s %s\n", ok ? "PASS" : "FAIL", what);
  if (!ok) A->failures++;
  return ok;
}
static void boot(App *A) {
  NtPumpOptions o = {.max_frames = 6, .settle = 1, .timeout_ms = 30000};
  nt_reactor_start(A->r, NULL); nt_reactor_pump(A->r, &o, NULL);
  uint8_t dev[8] = {1, 0, 0, 0, 0, 0, 0, 0};
  nt_reactor_message(A->r, 18, dev, 8, NULL); nt_reactor_pump(A->r, &o, NULL);
}
static int selftest(App *A) {
  make_reactor(A);
  boot(A);
  check(A, !nt_reactor_poisoned(A->r), "boot (start, T_DEVICE, CAPABILITIES) leaves the guest healthy");
  /* Reentry: an export requested from inside a guest callback is refused by the host, the guest is not entered. */
  A->reentry_probe = 1; A->reentry_rc = 0;
  uint8_t pl[4] = {0};
  Bytes fr = engine_frame(K_COMMAND, 77, 5 /* T_STATS */, (Bytes){pl, 0});
  nt_reactor_receive(A->r, fr.p, fr.n, NULL);
  free(fr.p);
  check(A, A->reentry_probe == 0 && A->reentry_rc == NT_REACTOR_REENTRY && !nt_reactor_poisoned(A->r),
        "export from inside engineSend is refused (NT_REACTOR_REENTRY), guest not entered, still healthy");
  /* Trap: a readback outside the arena throws inside the guest → sink → longjmp / process reply → poisoned. */
  uint8_t four[4] = {1, 2, 3, 4};
  int rc = nt_reactor_readback(A->r, 1e12, four, 4, NULL);
  check(A, rc == NT_REACTOR_POISONED && nt_reactor_poisoned(A->r), "guest trap (readback out of range) poisons the instance");
  printf("     panic: %s\n", nt_reactor_panic_text(A->r));
  check(A, strstr(nt_reactor_panic_text(A->r), "SC4013") || strstr(nt_reactor_panic_text(A->r), "readback") || strstr(nt_reactor_panic_text(A->r), "panic"),
        "trap message delivered through the sink");
  check(A, nt_reactor_start(A->r, NULL) == NT_REACTOR_POISONED, "later exports refused without entering the poisoned guest (no abort)");
  NtPumpOptions o = {.max_frames = 1};
  check(A, nt_reactor_pump(A->r, &o, NULL) == NT_REACTOR_POISONED, "pump refuses a poisoned guest");
  nt_reactor_destroy(A->r); A->r = NULL;
  if (strncmp(A->a.engine, "native:", 7) == 0) {
    /* The poisoned image stays loaded (never dlclose'd); dlopen of the same path returns it and hp_init would abort. */
    printf("SKIP restart in-process: a trapped image cannot be re-initialized; restart with native-process:/wasm: (new process)\n");
    return A->failures ? 1 : 0;
  }
  /* Restart: a new instance (a new guest process) runs normally. */
  make_reactor(A);
  boot(A);
  check(A, !nt_reactor_poisoned(A->r), "fresh instance (new guest process) after a trap boots normally");
  nt_reactor_destroy(A->r); A->r = NULL;
  /* A guest process that dies is detected (EOF/exit status), not waited on forever. */
  const char *saved = A->a.engine;
  A->a.engine = strncmp(saved, "wasm:", 5) == 0 ? "wasm:/nonexistent-nt-reactor-guest" : "native-process:/nonexistent-nt-reactor-guest.dylib";
  make_reactor(A);
  check(A, nt_reactor_poisoned(A->r) && (strstr(nt_reactor_panic_text(A->r), "exited") || strstr(nt_reactor_panic_text(A->r), "threw")),
        "a guest process that fails or exits poisons the reactor with its exit reason");
  printf("     panic: %.200s\n", nt_reactor_panic_text(A->r));
  nt_reactor_destroy(A->r); A->r = NULL;
  A->a.engine = saved;
  return A->failures ? 1 : 0;
}

int main(int argc, char **argv) {
  if (argc < 2) die("usage: nt-reactor run|selftest|guest … (see cli.c)");
  App A = {0};
  parse_args(&A.a, argc, argv, 2);
  const char *cmd = argv[1];
  if (!strcmp(cmd, "guest")) {
    char err[1024];
    NtGuest *g = NULL;
    if (strncmp(A.a.engine, "native:", 7)) die("guest mode serves native:<dylib|linked> only");
    const char *lib = A.a.engine + 7;
    if (nt_guest_native_open(strcmp(lib, "linked") == 0 ? NULL : lib, A.a.prefix, &g, err, sizeof err)) die("%s", err);
    return nt_guest_serve(g, 3, 4);
  }
  open_executor(&A);
  if (!strcmp(cmd, "selftest")) {
    A.log = fopen("/dev/null", "w");
    return selftest(&A);
  }
  if (strcmp(cmd, "run")) die("unknown command %s", cmd);
  if (!A.a.script || !A.a.out) die("run needs --script and --out");
  char mk[2048]; snprintf(mk, sizeof mk, "%s", A.a.out);
  for (char *p = mk + 1; *p; p++) if (*p == '/') { *p = 0; mkdir(mk, 0755); *p = '/'; }
  mkdir(mk, 0755);
  char path[2048];
  snprintf(path, sizeof path, "%s/engine-log.txt", A.a.out); A.log = fopen(path, "w");
  snprintf(path, sizeof path, "%s/timepoints.csv", A.a.out); A.tp = fopen(path, "w");
  if (!A.log || !A.tp) die("cannot write into %s", A.a.out);
  fputs("step,line,op,label,t_start_ns,t_end_ns,frames,events,presents\n", A.tp);
  if (A.a.trace_path) { A.trace = fopen(A.a.trace_path, "w"); if (!A.trace) die("write %s", A.a.trace_path); }
  char sd[2048]; snprintf(sd, sizeof sd, "%s", A.a.script); snprintf(A.script_dir, sizeof A.script_dir, "%s", dirname(sd));
  make_reactor(&A);
  int code = nt_reactor_poisoned(A.r) ? 1 : run_script(&A);
  write_run_json(&A, code);
  if (A.trace) fclose(A.trace);
  fclose(A.log); fclose(A.tp);
  nt_reactor_destroy(A.r);
  fprintf(stderr, "nt-reactor: %s (%s)\n", code ? "FAILED" : "ok", A.a.out);
  return code;
}

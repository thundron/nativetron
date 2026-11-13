/* Guest in a child process. The parent drives exports over fd 3 of the child and reads callbacks and the return
 * from fd 4 of the child, synchronously: one export at a time, callbacks in guest order, an offer waits for the
 * parent's answer. A crash, EOF or trap poisons the guest; recovery is a new process (no leaked images or threads).
 *
 * Frame: u32 length (of what follows), u8 tag, payload. All integers little-endian.
 *   parent → child  'B' u8 want_readback_sha                      bind (sink + callbacks + init)
 *                   'C' u8 export, f64 args[5], u32 n, bytes       call
 *                   'O' u8 accepted                                answer to an offer
 *   child → parent  'p' u32 bn, batch, u32 un, uploads, u64 readback_size, u8 has_sha, [32-byte sha]
 *                   'r' utf8      'i' trace/info text (stderr)
 *                   's' frame     'o' frame (then waits for 'O')
 *                   'x' panic message   'R' f64 result   'P' trapped   'E' error text
 */
#include "reactor.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int write_all(int fd, const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t k = write(fd, b, n);
    if (k < 0) { if (errno == EINTR) continue; return -1; }
    b += k; n -= (size_t)k;
  }
  return 0;
}
static int read_all(int fd, void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    ssize_t k = read(fd, b, n);
    if (k < 0) { if (errno == EINTR) continue; return -1; }
    if (k == 0) return -1;
    b += k; n -= (size_t)k;
  }
  return 0;
}
typedef struct { uint8_t *p; size_t n, cap; } Buf;
static int buf_reserve(Buf *b, size_t n) {
  if (n <= b->cap) return 0;
  size_t cap = b->cap ? b->cap : 4096;
  while (cap < n) cap *= 2;
  uint8_t *p = realloc(b->p, cap);
  if (!p) return -1;
  b->p = p; b->cap = cap;
  return 0;
}
static int send_frame(int fd, uint8_t tag, const void *a, size_t an, const void *b, size_t bn) {
  uint32_t len = (uint32_t)(1 + an + bn);
  uint8_t head[5];
  memcpy(head, &len, 4); head[4] = tag;
  if (write_all(fd, head, 5)) return -1;
  if (an && write_all(fd, a, an)) return -1;
  if (bn && write_all(fd, b, bn)) return -1;
  return 0;
}
static int recv_frame(int fd, uint8_t *tag, Buf *b) {
  uint8_t head[5];
  if (read_all(fd, head, 5)) return -1;
  uint32_t len; memcpy(&len, head, 4);
  if (len < 1) return -1;
  *tag = head[4];
  if (buf_reserve(b, len - 1)) return -1;
  b->n = len - 1;
  return b->n ? read_all(fd, b->p, b->n) : 0;
}

/* ── parent side ─────────────────────────────────────────────────────────── */
typedef struct {
  NtGuest base;
  pid_t pid;
  int to_child, from_child;
  int want_sha, poisoned;
  NtGuestSink sink;
  Buf in;
  char argv0[256];
} Proc;

static void proc_died(Proc *g, const char *where) {
  g->poisoned = 1;
  char msg[512];
  int status = 0;
  pid_t w = 0;
  /* EOF usually means the child is exiting: give it a bounded moment to be reaped for its exit reason. */
  for (int i = 0; i < 200 && (w = waitpid(g->pid, &status, WNOHANG)) == 0; i++) usleep(10000);
  if (w == g->pid) {
    g->pid = 0;
    if (WIFSIGNALED(status)) snprintf(msg, sizeof msg, "guest process %s died in %s (signal %d)", g->argv0, where, WTERMSIG(status));
    else snprintf(msg, sizeof msg, "guest process %s exited in %s (status %d)", g->argv0, where, WEXITSTATUS(status));
  } else snprintf(msg, sizeof msg, "guest process %s stopped answering in %s", g->argv0, where);
  if (g->sink.panic) g->sink.panic(g->sink.ctx, (const uint8_t *)msg, strlen(msg));
}

/* Reads child frames until the return ('R'), a trap ('P') or failure. */
static int proc_wait(Proc *g, double *result, const char *where) {
  for (;;) {
    uint8_t tag;
    if (recv_frame(g->from_child, &tag, &g->in)) { proc_died(g, where); return NT_REACTOR_POISONED; }
    uint8_t *p = g->in.p; size_t n = g->in.n;
    switch (tag) {
      case 'p': {
        uint32_t bn, un; uint64_t rn; uint8_t has;
        if (n < 4) goto bad;
        memcpy(&bn, p, 4);
        if (n < 8 + (size_t)bn) goto bad;
        memcpy(&un, p + 4 + bn, 4);
        if (n < 8 + (size_t)bn + un + 9) goto bad;
        memcpy(&rn, p + 8 + bn + un, 8);
        has = p[16 + bn + un];
        if (has && n < 8 + (size_t)bn + un + 9 + 32) goto bad;
        g->sink.present(g->sink.ctx, p + 4, bn, p + 8 + bn, un, NULL, (size_t)rn, has ? p + 17 + bn + un : NULL);
        break;
      }
      case 'r': g->sink.report(g->sink.ctx, p, n); break;
      case 'i': fprintf(stderr, "[guest] %.*s\n", (int)n, (const char *)p); break;
      case 's': g->sink.send(g->sink.ctx, p, n); break;
      case 'o': {
        uint8_t ok = g->sink.offer(g->sink.ctx, p, n);
        if (send_frame(g->to_child, 'O', &ok, 1, NULL, 0)) { proc_died(g, where); return NT_REACTOR_POISONED; }
        break;
      }
      case 'x': if (g->sink.panic) g->sink.panic(g->sink.ctx, p, n); break;
      case 'R': if (n != 8) goto bad; memcpy(result, p, 8); return NT_REACTOR_OK;
      case 'P': g->poisoned = 1; return NT_REACTOR_POISONED;
      case 'E': if (g->sink.panic) g->sink.panic(g->sink.ctx, p, n); g->poisoned = 1; return NT_REACTOR_POISONED;
      default: goto bad;
    }
  }
bad:
  { const char *m = "guest pipe protocol violation"; if (g->sink.panic) g->sink.panic(g->sink.ctx, (const uint8_t *)m, strlen(m)); }
  g->poisoned = 1;
  return NT_REACTOR_POISONED;
}

static int proc_bind(NtGuest *base, const NtGuestSink *s) {
  Proc *g = (Proc *)base;
  g->sink = *s;
  uint8_t want = (uint8_t)g->want_sha;
  if (send_frame(g->to_child, 'B', &want, 1, NULL, 0)) { proc_died(g, "bind"); return -1; }
  double r;
  return proc_wait(g, &r, "bind") == NT_REACTOR_OK ? 0 : -1;
}
static int proc_call(NtGuest *base, const NtGuestCall *c, double *result) {
  Proc *g = (Proc *)base;
  if (g->poisoned) return NT_REACTOR_POISONED;
  uint8_t head[1 + 40 + 4];
  head[0] = (uint8_t)c->which;
  memcpy(head + 1, c->args, 40);
  uint32_t n = (uint32_t)c->size;
  memcpy(head + 41, &n, 4);
  if (send_frame(g->to_child, 'C', head, sizeof head, c->bytes, c->size)) { proc_died(g, "call"); return NT_REACTOR_POISONED; }
  return proc_wait(g, result, "call");
}
static void proc_destroy(NtGuest *base) {
  Proc *g = (Proc *)base;
  if (g->to_child >= 0) close(g->to_child);
  if (g->from_child >= 0) close(g->from_child);
  if (g->pid > 0) {
    int status;
    /* EOF on fd 3 ends a healthy child; a stuck one is killed after a grace period. */
    for (int i = 0; i < 200; i++) { if (waitpid(g->pid, &status, WNOHANG) == g->pid) { g->pid = 0; break; } usleep(10000); }
    if (g->pid > 0) { kill(g->pid, SIGKILL); waitpid(g->pid, &status, 0); }
  }
  free(g->in.p);
  free(g);
}
static const NtGuestOps PROC_OPS = {"process", proc_bind, proc_call, proc_destroy};

int nt_guest_process_open(char *const argv[], int want_sha, NtGuest **out, char *err, size_t errn) {
  *out = NULL;
  int down[2], up[2];
  if (pipe(down) || pipe(up)) { snprintf(err, errn, "pipe: %s", strerror(errno)); return -1; }
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, down[0], 3);
  posix_spawn_file_actions_adddup2(&fa, up[1], 4);
  posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", 0, 0);
  int fds[] = {down[0], down[1], up[0], up[1]};
  for (int i = 0; i < 4; i++) if (fds[i] > 4) posix_spawn_file_actions_addclose(&fa, fds[i]);
  pid_t pid;
  int rc = posix_spawnp(&pid, argv[0], &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  close(down[0]); close(up[1]);
  if (rc) { close(down[1]); close(up[0]); snprintf(err, errn, "spawn %s: %s", argv[0], strerror(rc)); return -1; }
  signal(SIGPIPE, SIG_IGN);
  Proc *g = calloc(1, sizeof *g);
  g->base.ops = &PROC_OPS;
  g->pid = pid; g->to_child = down[1]; g->from_child = up[0]; g->want_sha = want_sha;
  snprintf(g->argv0, sizeof g->argv0, "%s", argv[0]);
  *out = &g->base;
  return 0;
}

/* ── child side: serve an in-process guest ───────────────────────────────── */
typedef struct { int in, out, want_sha; Buf buf; } Server;

static void s_present(void *ctx, const uint8_t *b, size_t bn, const uint8_t *u, size_t un, const uint8_t *r, size_t rn, const uint8_t *sha) {
  (void)sha;
  Server *s = ctx;
  uint32_t b32 = (uint32_t)bn, u32 = (uint32_t)un;
  uint64_t r64 = rn;
  uint8_t digest[32]; uint8_t has = 0;
  if (s->want_sha && r) {
    CC_SHA256_CTX c; CC_SHA256_Init(&c);
    for (size_t at = 0; at < rn;) { CC_LONG k = rn - at > 0x40000000 ? 0x40000000 : (CC_LONG)(rn - at); CC_SHA256_Update(&c, r + at, k); at += k; }
    CC_SHA256_Final(digest, &c); has = 1;
  }
  uint32_t len = (uint32_t)(1 + 4 + bn + 4 + un + 8 + 1 + (has ? 32 : 0));
  uint8_t head[5]; memcpy(head, &len, 4); head[4] = 'p';
  write_all(s->out, head, 5); write_all(s->out, &b32, 4); if (bn) write_all(s->out, b, bn);
  write_all(s->out, &u32, 4); if (un) write_all(s->out, u, un);
  write_all(s->out, &r64, 8); write_all(s->out, &has, 1); if (has) write_all(s->out, digest, 32);
}
static void s_report(void *ctx, const uint8_t *p, size_t n) { Server *s = ctx; send_frame(s->out, 'r', p, n, NULL, 0); }
static void s_send(void *ctx, const uint8_t *p, size_t n) { Server *s = ctx; send_frame(s->out, 's', p, n, NULL, 0); }
static uint8_t s_offer(void *ctx, const uint8_t *p, size_t n) {
  Server *s = ctx;
  if (send_frame(s->out, 'o', p, n, NULL, 0)) _exit(3);
  uint8_t tag;
  Buf b = {0};
  if (recv_frame(s->in, &tag, &b) || tag != 'O' || b.n != 1) _exit(3);
  uint8_t ok = b.p[0];
  free(b.p);
  return ok;
}
static void s_panic(void *ctx, const uint8_t *p, size_t n) { Server *s = ctx; send_frame(s->out, 'x', p, n, NULL, 0); }

int nt_guest_serve(NtGuest *guest, int in, int out) {
  signal(SIGPIPE, SIG_IGN);
  Server s = {.in = in, .out = out};
  NtGuestSink sink = {.ctx = &s, .present = s_present, .report = s_report, .send = s_send, .offer = s_offer, .panic = s_panic};
  int bound = 0, poisoned = 0;
  for (;;) {
    uint8_t tag;
    if (recv_frame(in, &tag, &s.buf)) break;
    if (tag == 'B' && !bound) {
      s.want_sha = s.buf.n && s.buf.p[0];
      bound = 1;
      if (guest->ops->bind(guest, &sink)) { poisoned = 1; send_frame(out, 'P', NULL, 0, NULL, 0); }
      else { double z = 0; send_frame(out, 'R', &z, 8, NULL, 0); }
    } else if (tag == 'C' && bound) {
      if (poisoned || s.buf.n < 45) { send_frame(out, 'P', NULL, 0, NULL, 0); continue; }
      NtGuestCall c = {0};
      c.which = (NtExport)s.buf.p[0];
      memcpy(c.args, s.buf.p + 1, 40);
      uint32_t n; memcpy(&n, s.buf.p + 41, 4);
      if (s.buf.n != 45 + (size_t)n) { send_frame(out, 'E', "bad call", 8, NULL, 0); continue; }
      /* Copy: an offer answer reuses the receive buffer while the export runs. */
      uint8_t *bytes = malloc(n ? n : 1);
      if (n) memcpy(bytes, s.buf.p + 45, n);
      c.bytes = bytes; c.size = n;
      double r = 0;
      int rc = guest->ops->call(guest, &c, &r);
      free(bytes);
      if (rc) { poisoned = 1; send_frame(out, 'P', NULL, 0, NULL, 0); }
      else send_frame(out, 'R', &r, 8, NULL, 0);
    } else {
      send_frame(out, 'E', "unexpected frame", 16, NULL, 0);
    }
  }
  free(s.buf.p);
  return poisoned ? 1 : 0;
}

// Exercises hosts/android/jni/nt_control_host.c against the real scriptc
// nt-control archive built for the development host. The Android JNI layer
// is a thin copy wrapper over these calls.
#include "nt_control_host.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
#define CHECK(cond) do { if (!(cond)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

static uint32_t u32(const uint8_t *b) { return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24; }
static void put32(uint8_t *b, uint32_t v) { for (int i = 0; i < 4; i++) b[i] = (uint8_t)(v >> (i * 8)); }

static size_t frame(uint8_t *out, uint8_t kind, uint8_t source, uint8_t target, uint32_t topic, const char *payload) {
  size_t length = strlen(payload);
  memset(out, 0, 16);
  out[0] = 1; out[1] = kind; out[2] = source; out[3] = target;
  put32(out + 8, topic); put32(out + 12, (uint32_t)length);
  memcpy(out + 16, payload, length);
  return 16 + length;
}

struct probe { int status; };
static void *other_command(void *arg) {
  uint8_t *out; size_t length;
  ((struct probe *)arg)->status = nt_host_command(1, NULL, 0, &out, &length);
  return NULL;
}
static void *other_open(void *arg) { ((struct probe *)arg)->status = nt_host_open(); return NULL; }
static void *owner_session(void *arg) {
  struct probe *probe = arg;
  uint8_t *out; size_t length;
  probe->status = nt_host_open();
  if (probe->status == NT_HOST_OK) probe->status = nt_host_command(7, (const uint8_t *)"x", 1, &out, &length);
  if (probe->status == NT_HOST_OK) { probe->status = length == 17 && u32(out + 8) == 7 ? NT_HOST_OK : NT_HOST_PROTOCOL; nt_host_free(out); }
  if (probe->status == NT_HOST_OK) probe->status = nt_host_close();
  return NULL;
}
static int on_thread(void *(*fn)(void *)) {
  struct probe probe = { -1 };
  pthread_t thread;
  pthread_create(&thread, NULL, fn, &probe);
  pthread_join(thread, NULL);
  return probe.status;
}

int main(void) {
  uint8_t *out = NULL; size_t length = 0;
  uint8_t buffer[16 + 65536];

  CHECK(nt_host_command(1, NULL, 0, &out, &length) == NT_HOST_CLOSED);
  CHECK(nt_host_collect() == NT_HOST_CLOSED);
  CHECK(nt_host_close() == NT_HOST_OK);
  CHECK(nt_host_open() == NT_HOST_OK);
  CHECK(nt_host_open() == NT_HOST_OK);

  CHECK(nt_host_command(1, NULL, 0, &out, &length) == NT_HOST_OK);
  const uint8_t expected[16] = { 1, 1, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0 };
  CHECK(length == 16 && out && memcmp(out, expected, 16) == 0);
  nt_host_free(out);

  CHECK(nt_host_command(4294967295u, (const uint8_t *)"abc", 3, &out, &length) == NT_HOST_OK);
  CHECK(length == 19 && u32(out + 8) == 4294967295u && u32(out + 12) == 3 && memcmp(out + 16, "abc", 3) == 0);
  nt_host_free(out);

  memset(buffer, 0x5a, sizeof buffer);
  CHECK(nt_host_command(9, buffer, 65536, &out, &length) == NT_HOST_OK);
  CHECK(length == 16 + 65536 && u32(out + 12) == 65536 && out[16] == 0x5a && out[length - 1] == 0x5a);
  nt_host_free(out);
  CHECK(nt_host_command(9, buffer, 65537, &out, &length) == NT_HOST_TOO_LARGE && out == NULL);
  CHECK(nt_host_command(1, NULL, 3, &out, &length) == NT_HOST_REFUSED);

  size_t n = frame(buffer, 5, 2, 0, 0, "GPU_COLOUR_CHANGED");
  CHECK(nt_host_receive(buffer, n, &out, &length) == NT_HOST_OK);
  CHECK(length == n && memcmp(out, buffer, n) == 0);
  nt_host_free(out);
  n = frame(buffer, 1, 0, 2, 1, "");
  CHECK(nt_host_receive(buffer, n, &out, &length) == NT_HOST_REFUSED && out == NULL);
  n = frame(buffer, 5, 1, 0, 0, "ui");
  CHECK(nt_host_receive(buffer, n, &out, &length) == NT_HOST_REFUSED);
  n = frame(buffer, 5, 2, 0, 0, "x"); buffer[0] = 2;
  CHECK(nt_host_receive(buffer, n, &out, &length) == NT_HOST_REFUSED);
  n = frame(buffer, 5, 2, 0, 0, "xy"); put32(buffer + 12, 1);
  CHECK(nt_host_receive(buffer, n, &out, &length) == NT_HOST_REFUSED);
  n = frame(buffer, 9, 2, 0, 0, "");
  CHECK(nt_host_receive(buffer, n, &out, &length) == NT_HOST_REFUSED);
  CHECK(nt_host_receive(buffer, 15, &out, &length) == NT_HOST_REFUSED);
  CHECK(nt_host_receive(NULL, 0, &out, &length) == NT_HOST_REFUSED);
  CHECK(nt_host_receive(buffer, 16 + 65537, &out, &length) == NT_HOST_TOO_LARGE);

  CHECK(on_thread(other_command) == NT_HOST_WRONG_THREAD);
  CHECK(on_thread(other_open) == NT_HOST_BUSY);

  for (int i = 0; i < 20000; i++) {
    if (nt_host_command((uint32_t)i, (const uint8_t *)"loop", 4, &out, &length) != NT_HOST_OK || length != 20) { failures++; break; }
    nt_host_free(out);
    n = frame(buffer, 5, 2, 0, (uint32_t)i, "report");
    if (nt_host_receive(buffer, n, &out, &length) != NT_HOST_OK || length != n) { failures++; break; }
    nt_host_free(out);
    if (i % 1000 == 0 && nt_host_collect() != NT_HOST_OK) { failures++; break; }
  }

  CHECK(nt_host_close() == NT_HOST_OK);
  CHECK(nt_host_command(1, NULL, 0, &out, &length) == NT_HOST_CLOSED);
  CHECK(on_thread(owner_session) == NT_HOST_OK);
  CHECK(nt_host_open() == NT_HOST_OK);
  CHECK(nt_host_command(2, NULL, 0, &out, &length) == NT_HOST_OK && length == 16 && u32(out + 8) == 2);
  nt_host_free(out);
  CHECK(nt_host_close() == NT_HOST_OK);
  CHECK(!nt_host_is_poisoned() && nt_host_panic(&length) == NULL);

  if (failures) { fprintf(stderr, "control host test: %d failure(s)\n", failures); return 1; }
  puts("control host test: ok");
  return 0;
}

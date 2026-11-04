// Ownership rules for the scriptc nt-control static library (ipc/control-profile.json):
// - one owner thread calls every nt_control_* symbol; others are refused;
// - controlSend/controlReceive are synchronous, userdata-first and borrow their
//   bytes, so each delivery is copied before the export returns and handed to
//   the platform only after it returns (no reentry, no outbound FFI);
// - a trap poisons the library; the sink records the diagnostic and unwinds to
//   the host frame below the entry (the documented survival pattern). No
//   library symbol is called afterwards, because a poisoned entry aborts.
#include "nt_control_host.h"
#include "control.generated.h"

#include <pthread.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>

enum { CHANNEL_SEND = 1, CHANNEL_RECEIVE = 2 };
#define PANIC_LIMIT 4096u

struct delivery {
  int expected;      // channel the active export may deliver on, 0 when idle
  int count;
  int violation;
  int no_memory;
  uint8_t *bytes;
  size_t length;
};

static pthread_mutex_t state_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_t owner;
static int opened, poisoned, in_call;
static struct delivery active;
static jmp_buf *volatile active_jump;
static uint8_t panic_bytes[PANIC_LIMIT];
static size_t panic_length;
static const int send_channel = CHANNEL_SEND, receive_channel = CHANNEL_RECEIVE;

static void on_delivery(void *userdata, const uint8_t *bytes, size_t length) {
  int channel = userdata ? *(const int *)userdata : 0;
  if (active.expected == 0 || channel != active.expected || ++active.count != 1 || length > NT_HOST_MAX_FRAME || (length && !bytes)) {
    active.violation = 1;
    return;
  }
  uint8_t *copy = malloc(length ? length : 1);
  if (!copy) { active.no_memory = 1; return; }
  if (length) memcpy(copy, bytes, length);
  active.bytes = copy;
  active.length = length;
}

static void on_panic(void *userdata, const uint8_t *bytes, size_t length, uint64_t address) {
  (void)userdata; (void)address;
  poisoned = 1;
  panic_length = length < PANIC_LIMIT ? length : PANIC_LIMIT;
  if (bytes && panic_length) memcpy(panic_bytes, bytes, panic_length);
  jmp_buf *jump = active_jump;
  if (jump) longjmp(*jump, 1);
  // No host frame to unwind to: scriptc aborts when the sink returns.
}

// Serialises state transitions; contention means a second thread raced the
// owner, which is refused rather than blocked.
static int enter(int require_open) {
  if (pthread_mutex_trylock(&state_lock) != 0) return NT_HOST_BUSY;
  int status = NT_HOST_OK;
  if (poisoned) status = NT_HOST_POISONED;
  else if (in_call) status = NT_HOST_BUSY;
  else if (require_open && !opened) status = NT_HOST_CLOSED;
  else if (opened && !pthread_equal(owner, pthread_self())) status = require_open ? NT_HOST_WRONG_THREAD : NT_HOST_BUSY;
  if (status != NT_HOST_OK) pthread_mutex_unlock(&state_lock);
  return status;
}

static void reset_delivery(int expected) {
  free(active.bytes);
  memset(&active, 0, sizeof active);
  active.expected = expected;
}

int nt_host_open(void) {
  int status = enter(0);
  if (status != NT_HOST_OK) return status;
  if (opened) { pthread_mutex_unlock(&state_lock); return NT_HOST_OK; }
  jmp_buf jump;
  in_call = 1;
  if (setjmp(jump) != 0) {
    active_jump = NULL; in_call = 0;
    pthread_mutex_unlock(&state_lock);
    return NT_HOST_POISONED;
  }
  active_jump = &jump;
  nt_control_sink(on_panic, NULL);
  int registered = nt_control_set_callback("controlSend", (void (*)(void))on_delivery, (void *)&send_channel) == 0 &&
    nt_control_set_callback("controlReceive", (void (*)(void))on_delivery, (void *)&receive_channel) == 0;
  if (registered) nt_control_init();
  active_jump = NULL;
  in_call = 0;
  if (registered) { owner = pthread_self(); opened = 1; }
  pthread_mutex_unlock(&state_lock);
  return registered ? NT_HOST_OK : NT_HOST_PROTOCOL;
}

int nt_host_close(void) {
  int status = enter(1);
  if (status == NT_HOST_CLOSED) return NT_HOST_OK;
  if (status == NT_HOST_POISONED) {
    // Ownership is released so a later owner sees POISONED, not WRONG_THREAD.
    if (pthread_mutex_trylock(&state_lock) != 0) return NT_HOST_BUSY;
    opened = 0; pthread_mutex_unlock(&state_lock); return NT_HOST_OK;
  }
  if (status != NT_HOST_OK) return status;
  reset_delivery(0);
  opened = 0;
  pthread_mutex_unlock(&state_lock);
  return NT_HOST_OK;
}

static int call(int channel, double topic, const uint8_t *bytes, size_t length, uint8_t **out, size_t *out_length) {
  if (out) *out = NULL;
  if (out_length) *out_length = 0;
  if (!out || !out_length || (length && !bytes)) return NT_HOST_REFUSED;
  int status = enter(1);
  if (status != NT_HOST_OK) return status;
  jmp_buf jump;
  volatile double result = 1;
  reset_delivery(channel);
  in_call = 1;
  if (setjmp(jump) != 0) {
    active_jump = NULL; in_call = 0; opened = 0;
    reset_delivery(0);
    pthread_mutex_unlock(&state_lock);
    return NT_HOST_POISONED;
  }
  active_jump = &jump;
  static const uint8_t empty[1] = { 0 };
  const uint8_t *data = length ? bytes : empty;
  result = channel == CHANNEL_SEND ? nt_control_command(topic, data, length) : nt_control_receive(data, length);
  active_jump = NULL;
  in_call = 0;
  if (active.no_memory) status = NT_HOST_NO_MEMORY;
  else if (active.violation) status = NT_HOST_PROTOCOL;
  else if (result == 1 && active.count == 0) status = NT_HOST_REFUSED;
  else if (result != 0 || active.count != 1) status = NT_HOST_PROTOCOL;
  if (status == NT_HOST_OK) {
    *out = active.bytes; *out_length = active.length;
    active.bytes = NULL;
  }
  reset_delivery(0);
  pthread_mutex_unlock(&state_lock);
  return status;
}

int nt_host_command(uint32_t topic, const uint8_t *payload, size_t length, uint8_t **frame, size_t *frame_length) {
  if (frame) *frame = NULL;
  if (frame_length) *frame_length = 0;
  if (length > NT_HOST_MAX_FRAME - 16u) return NT_HOST_TOO_LARGE;
  return call(CHANNEL_SEND, (double)topic, payload, length, frame, frame_length);
}

int nt_host_receive(const uint8_t *frame, size_t length, uint8_t **routed, size_t *routed_length) {
  if (routed) *routed = NULL;
  if (routed_length) *routed_length = 0;
  if (length > NT_HOST_MAX_FRAME) return NT_HOST_TOO_LARGE;
  return call(CHANNEL_RECEIVE, 0, frame, length, routed, routed_length);
}

int nt_host_collect(void) {
  int status = enter(1);
  if (status != NT_HOST_OK) return status;
  jmp_buf jump;
  in_call = 1;
  if (setjmp(jump) != 0) {
    active_jump = NULL; in_call = 0; opened = 0;
    pthread_mutex_unlock(&state_lock);
    return NT_HOST_POISONED;
  }
  active_jump = &jump;
  nt_control_collect();
  active_jump = NULL;
  in_call = 0;
  pthread_mutex_unlock(&state_lock);
  return NT_HOST_OK;
}

void nt_host_free(uint8_t *bytes) { free(bytes); }

const uint8_t *nt_host_panic(size_t *length) {
  if (length) *length = panic_length;
  return panic_length ? panic_bytes : NULL;
}

int nt_host_is_poisoned(void) { return poisoned; }

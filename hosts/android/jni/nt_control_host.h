// Android host adapter for the scriptc nt-control static library.
// Platform-neutral C so the same ownership/copy/panic rules run in host tests.
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

enum {
  NT_HOST_OK = 0,
  NT_HOST_REFUSED = 1,        // nt_control_* returned 1: invalid input or routing
  NT_HOST_WRONG_THREAD = 2,   // called off the owner thread
  NT_HOST_CLOSED = 3,         // not opened, or already closed
  NT_HOST_POISONED = 4,       // a scriptc trap was delivered; the library is unusable
  NT_HOST_PROTOCOL = 5,       // export result and callback delivery disagree
  NT_HOST_NO_MEMORY = 6,
  NT_HOST_BUSY = 7,           // already open on another owner, or reentered
  NT_HOST_TOO_LARGE = 8,
};

// Engine header (16) + engine maximum payload (65536), from ipc/engine.json.
#define NT_HOST_MAX_FRAME (16u + 65536u)

// Bind the calling thread as the only owner, register the panic sink and both
// profile callbacks, then run nt_control_init. Reopening after close re-runs
// init on the (possibly new) owner thread.
int nt_host_open(void);
// Release ownership. No library call happens after this until the next open.
int nt_host_close(void);
// nt_control_command(topic, payload). On NT_HOST_OK *frame receives a
// malloc'd copy of the single controlSend frame; release with nt_host_free.
int nt_host_command(uint32_t topic, const uint8_t *payload, size_t length, uint8_t **frame, size_t *frame_length);
// nt_control_receive(frame). On NT_HOST_OK *routed receives a copy of the
// controlReceive delivery (the validated engine→native frame).
int nt_host_receive(const uint8_t *frame, size_t length, uint8_t **routed, size_t *routed_length);
int nt_host_collect(void);
void nt_host_free(uint8_t *bytes);
// Copy of the last trap diagnostic (structured scriptc bytes), or NULL.
const uint8_t *nt_host_panic(size_t *length);
int nt_host_is_poisoned(void);

#ifdef __cplusplus
}
#endif

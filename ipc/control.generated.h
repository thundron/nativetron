// generated from ipc/control-profile.json by ipc/generate-control.mjs — do not edit
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// scriptc host callbacks receive userdata first. The runtime is single-thread-owned.
typedef void (*nt_control_bytes_callback)(void *userdata, const uint8_t *bytes, size_t length);
typedef void (*nt_control_panic_callback)(void *userdata, const uint8_t *bytes, size_t length, uint64_t address);
void nt_control_init(void);
void nt_control_collect(void);
void nt_control_sink(nt_control_panic_callback callback, void *userdata);
int32_t nt_control_set_callback(const char *name, void (*callback)(void), void *userdata);
double nt_control_command(double arg0, const uint8_t *arg1, size_t arg1_length);
double nt_control_receive(const uint8_t *arg0, size_t arg0_length);
#ifdef __cplusplus
}
#endif

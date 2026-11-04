#pragma once
#include <stdint.h>
// WinRT event-token ABI; Zig's MinGW headers omit the Windows SDK declaration.
typedef struct EventRegistrationToken {
  int64_t value;
} EventRegistrationToken;

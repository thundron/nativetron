// generated from i18n/catalogue.json by i18n/generate.mjs — do not edit
// Native/static-library adapter for the i18n pull formatting contract (see i18n/README.md).
// Bind the profile callbacks
//   localeFormatBegin: params [f64, string, string, f64, f64] returns f64
//   localeFormatByte:  params [f64] returns f64
// to nt_i18n_format_begin / nt_i18n_format_byte with a nt_i18n_format_state * as userdata, and pass
// both bindings to pullLocaleFormatter(...). Callbacks are synchronous on the owning thread and copy
// the borrowed locale/unit strings before returning; they never call back into the library.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#ifdef __cplusplus
extern "C" {
#endif
#define NT_I18N_MAX_FORMATTED_BYTES 512
#define NT_I18N_FORMAT_OVERFLOW (-1)
#define NT_I18N_FORMAT_UNSUPPORTED (-2)
#define NT_I18N_LOCALE_COUNT 3
#define NT_I18N_UNIT_COUNT 7
static const char *const nt_i18n_locales[NT_I18N_LOCALE_COUNT] = { "en", "fr", "pl" };
static const char *const nt_i18n_units[NT_I18N_UNIT_COUNT] = { "millimeter", "centimeter", "meter", "kilometer", "inch", "foot", "liter" };

// Platform formatter: write at most capacity UTF-8 bytes of value formatted for locale (unit is empty for
// a plain number) with 0..maximum_fraction_digits fraction digits, grouping on, standard notation, short
// unit display. Return the byte count, NT_I18N_FORMAT_OVERFLOW, or NT_I18N_FORMAT_UNSUPPORTED.
// locale and unit are NUL-terminated copies valid only during the call.
typedef int32_t (*nt_i18n_platform_format)(void *context, double value, const char *locale, const char *unit, int32_t maximum_fraction_digits, uint8_t *output, size_t capacity);

typedef struct nt_i18n_format_state {
  nt_i18n_platform_format format;
  void *context;
  int32_t length; // staged bytes, or -1 when nothing is staged
  uint8_t bytes[NT_I18N_MAX_FORMATTED_BYTES];
} nt_i18n_format_state;

static inline void nt_i18n_format_state_init(nt_i18n_format_state *state, nt_i18n_platform_format format, void *context) {
  state->format = format; state->context = context; state->length = -1;
}

static inline int nt_i18n_copy_token(char *target, size_t capacity, const uint8_t *bytes, size_t length) {
  if (length >= capacity || (length && !bytes)) return 0;
  for (size_t i = 0; i < length; i++) if (bytes[i] == 0) return 0;
  if (length) memcpy(target, bytes, length);
  target[length] = 0;
  return 1;
}

static inline int nt_i18n_listed(const char *const *values, size_t count, const char *value) {
  for (size_t i = 0; i < count; i++) if (strcmp(values[i], value) == 0) return 1;
  return 0;
}

static inline double nt_i18n_format_begin(void *userdata, double value, const uint8_t *locale, size_t locale_length, const uint8_t *unit, size_t unit_length, double digits, double capacity) {
  nt_i18n_format_state *state = (nt_i18n_format_state *)userdata;
  char locale_text[36], unit_text[36];
  state->length = -1;
  if (!state->format || !(value == value) || value - value != 0) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!(digits >= 0 && digits <= 20 && digits == (double)(int32_t)digits)) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!(capacity >= 0 && capacity <= 1048576 && capacity == (double)(size_t)capacity)) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!nt_i18n_copy_token(locale_text, sizeof locale_text, locale, locale_length) || !nt_i18n_copy_token(unit_text, sizeof unit_text, unit, unit_length)) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!nt_i18n_listed(nt_i18n_locales, NT_I18N_LOCALE_COUNT, locale_text) || (unit_text[0] && !nt_i18n_listed(nt_i18n_units, NT_I18N_UNIT_COUNT, unit_text))) return NT_I18N_FORMAT_UNSUPPORTED;
  size_t limit = (size_t)capacity < NT_I18N_MAX_FORMATTED_BYTES ? (size_t)capacity : NT_I18N_MAX_FORMATTED_BYTES;
  int32_t length = state->format(state->context, value, locale_text, unit_text, (int32_t)digits, state->bytes, limit);
  if (length == NT_I18N_FORMAT_OVERFLOW || length == NT_I18N_FORMAT_UNSUPPORTED) return length;
  if (length < 0 || (size_t)length > limit) return NT_I18N_FORMAT_OVERFLOW;
  state->length = length;
  return length;
}

// Returns staged byte index (0..255), or -1 when the index is outside the staged result.
static inline double nt_i18n_format_byte(void *userdata, double index) {
  nt_i18n_format_state *state = (nt_i18n_format_state *)userdata;
  if (state->length < 0 || !(index >= 0 && index < state->length) || index != (double)(int32_t)index) return -1;
  return state->bytes[(int32_t)index];
}
#ifdef __cplusplus
}
#endif

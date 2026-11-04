// Native static-library harness for the compiled i18n fixture. It links fixture.lib.a, binds the
// generated pull-formatting adapter, and executes line commands from stdin:
//   start | stop | locale TAG | count N | plural N | items N | lookup KEY | wrong | format N UNIT|- DIGITS
// The platform formatter here is a transport probe, not a localisation implementation: it prints
// C-locale digits tagged with the locale and unit, joined by U+2009 so multi-byte UTF-8 crosses the
// boundary. Values 666, 777 and 888 select invalid UTF-8, unsupported and oversize results.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../native/nt_i18n_format.generated.h"

typedef void (*nt_text_callback)(void *userdata, const uint8_t *bytes, size_t length);
typedef void (*nt_panic_callback)(void *userdata, const uint8_t *bytes, size_t length, uint64_t address);
void nt_i18n_init(void);
void nt_i18n_collect(void);
void nt_i18n_set_panic_sink(nt_panic_callback callback, void *userdata);
int32_t nt_i18n_set_callback(const char *name, void (*callback)(void), void *userdata);
double nt_i18n_start(void);
double nt_i18n_stop_rendering(void);
double nt_i18n_switch_locale(const uint8_t *tag, size_t length);
double nt_i18n_set_count(double value);
double nt_i18n_plural(double value);
double nt_i18n_item_count(double value);
double nt_i18n_lookup(const uint8_t *key, size_t length);
double nt_i18n_wrong_argument(void);
double nt_i18n_format(double value, const uint8_t *unit, size_t length, double digits);

static void print_line(const char *prefix, const uint8_t *bytes, size_t length) {
  fputs(prefix, stdout);
  fwrite(bytes, 1, length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
static void rendered(void *userdata, const uint8_t *bytes, size_t length) { (void)userdata; print_line("R ", bytes, length); }
static void reply(void *userdata, const uint8_t *bytes, size_t length) { (void)userdata; print_line("A ", bytes, length); }
static void panic_sink(void *userdata, const uint8_t *bytes, size_t length, uint64_t address) {
  (void)userdata; (void)address;
  print_line("PANIC ", bytes, length);
  exit(3);
}

static int32_t probe_format(void *context, double value, const char *locale, const char *unit, int32_t digits, uint8_t *output, size_t capacity) {
  int *calls = (int *)context;
  ++*calls;
  if (value == 666) { if (capacity < 1) return NT_I18N_FORMAT_OVERFLOW; output[0] = 0xff; return 1; }
  if (value == 777) return NT_I18N_FORMAT_UNSUPPORTED;
  if (value == 888) return (int32_t)capacity + 1;
  char number[64];
  snprintf(number, sizeof number, "%.*f", digits, value);
  char *dot = strchr(number, '.');
  if (dot) {
    size_t end = strlen(number);
    while (end > 0 && number[end - 1] == '0') number[--end] = 0;
    if (number[end - 1] == '.') number[end - 1] = 0;
  }
  char text[160];
  int length = snprintf(text, sizeof text, unit[0] ? "%s\xe2\x80\x89%s\xe2\x80\x89%s" : "%s\xe2\x80\x89%s", number, locale, unit);
  if (length < 0 || (size_t)length > capacity) return NT_I18N_FORMAT_OVERFLOW;
  memcpy(output, text, (size_t)length);
  return length;
}

int main(void) {
  static nt_i18n_format_state state;
  int calls = 0;
  nt_i18n_format_state_init(&state, probe_format, &calls);
  nt_i18n_set_panic_sink(panic_sink, NULL);
  if (nt_i18n_set_callback("rendered", (void (*)(void))rendered, NULL) || nt_i18n_set_callback("reply", (void (*)(void))reply, NULL) ||
      nt_i18n_set_callback("localeFormatBegin", (void (*)(void))nt_i18n_format_begin, &state) ||
      nt_i18n_set_callback("localeFormatByte", (void (*)(void))nt_i18n_format_byte, &state) ||
      nt_i18n_set_callback("missingChannel", (void (*)(void))reply, NULL) != -1) {
    fputs("callback registration failed\n", stderr);
    return 2;
  }
  nt_i18n_init();
  char line[512];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    char command[32] = "", word[256] = "";
    double number = 0, digits = 0;
    if (sscanf(line, "%31s", command) != 1) continue;
    const char *rest = line + strlen(command) + (line[strlen(command)] ? 1 : 0);
    if (!strcmp(command, "start")) printf("A started %g\n", nt_i18n_start());
    else if (!strcmp(command, "stop")) printf("A stopped %g\n", nt_i18n_stop_rendering());
    else if (!strcmp(command, "locale")) nt_i18n_switch_locale((const uint8_t *)rest, strlen(rest));
    else if (!strcmp(command, "count")) nt_i18n_set_count(strtod(rest, NULL));
    else if (!strcmp(command, "plural")) nt_i18n_plural(strtod(rest, NULL));
    else if (!strcmp(command, "items")) nt_i18n_item_count(strtod(rest, NULL));
    else if (!strcmp(command, "lookup")) nt_i18n_lookup((const uint8_t *)rest, strlen(rest));
    else if (!strcmp(command, "wrong")) nt_i18n_wrong_argument();
    else if (!strcmp(command, "format") && sscanf(rest, "%lf %255s %lf", &number, word, &digits) == 3) {
      const char *unit = strcmp(word, "-") ? word : "";
      nt_i18n_format(number, (const uint8_t *)unit, strlen(unit), digits);
    } else if (!strcmp(command, "calls")) printf("A calls %d\n", calls);
    else { printf("A unknown %s\n", command); }
    fflush(stdout);
    nt_i18n_collect();
  }
  return 0;
}

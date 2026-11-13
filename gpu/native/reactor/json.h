#ifndef NT_REACTOR_JSON_H
#define NT_REACTOR_JSON_H
/* Minimal JSON reader for executor event objects: finds top-level members of one object and decodes scalars.
 * No allocation; spans point into the caller's text. */
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { const char *p; size_t n; } NtJsonSpan;
/* Raw value of top-level member `key` (string values include their quotes). Returns 1 when found. */
int nt_json_member(const char *json, size_t size, const char *key, NtJsonSpan *value);
int nt_json_number(NtJsonSpan value, double *out);
int nt_json_bool(NtJsonSpan value, int *out);
/* Decodes a JSON string value (with quotes) into UTF-8; returns the decoded length (truncated to cap - 1, NUL
 * terminated), or -1 when the value is not a string. */
long nt_json_string(NtJsonSpan value, char *out, size_t cap);
/* 1 when the array value contains the string element `text`. */
int nt_json_array_has_string(NtJsonSpan array, const char *text);
#ifdef __cplusplus
}
#endif
#endif

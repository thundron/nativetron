#include "json.h"
#include <stdlib.h>
#include <string.h>

static size_t ws(const char *s, size_t n, size_t i) {
  while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  return i;
}
/* End (exclusive) of the string starting at s[i] == '"', or 0 when unterminated. */
static size_t string_end(const char *s, size_t n, size_t i) {
  for (i++; i < n; i++) {
    if (s[i] == '\\') { i++; continue; }
    if (s[i] == '"') return i + 1;
  }
  return 0;
}
/* End (exclusive) of the value starting at s[i], or 0 when malformed. */
static size_t value_end(const char *s, size_t n, size_t i) {
  if (i >= n) return 0;
  if (s[i] == '"') return string_end(s, n, i);
  if (s[i] == '{' || s[i] == '[') {
    int depth = 0;
    for (; i < n; i++) {
      char c = s[i];
      if (c == '"') { size_t e = string_end(s, n, i); if (!e) return 0; i = e - 1; continue; }
      if (c == '{' || c == '[') depth++;
      else if (c == '}' || c == ']') { if (--depth == 0) return i + 1; }
    }
    return 0;
  }
  size_t j = i;
  while (j < n && s[j] != ',' && s[j] != '}' && s[j] != ']' && s[j] != ' ' && s[j] != '\n' && s[j] != '\r' && s[j] != '\t') j++;
  return j > i ? j : 0;
}

int nt_json_member(const char *s, size_t n, const char *key, NtJsonSpan *value) {
  size_t i = ws(s, n, 0), klen = strlen(key);
  if (i >= n || s[i] != '{') return 0;
  i = ws(s, n, i + 1);
  while (i < n && s[i] != '}') {
    if (s[i] != '"') return 0;
    size_t ke = string_end(s, n, i);
    if (!ke) return 0;
    int match = ke - i - 2 == klen && memcmp(s + i + 1, key, klen) == 0;
    i = ws(s, n, ke);
    if (i >= n || s[i] != ':') return 0;
    i = ws(s, n, i + 1);
    size_t ve = value_end(s, n, i);
    if (!ve) return 0;
    if (match) { value->p = s + i; value->n = ve - i; return 1; }
    i = ws(s, n, ve);
    if (i < n && s[i] == ',') i = ws(s, n, i + 1);
  }
  return 0;
}

int nt_json_number(NtJsonSpan v, double *out) {
  if (!v.n || v.n > 63) return 0;
  char buf[64];
  memcpy(buf, v.p, v.n); buf[v.n] = 0;
  char *end = NULL;
  double x = strtod(buf, &end);
  if (end == buf || *end) return 0;
  *out = x;
  return 1;
}

int nt_json_bool(NtJsonSpan v, int *out) {
  if (v.n == 4 && memcmp(v.p, "true", 4) == 0) { *out = 1; return 1; }
  if (v.n == 5 && memcmp(v.p, "false", 5) == 0) { *out = 0; return 1; }
  return 0;
}

static int hex4(const char *p, unsigned *out) {
  unsigned v = 0;
  for (int k = 0; k < 4; k++) {
    char c = p[k]; v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
    else return 0;
  }
  *out = v;
  return 1;
}

long nt_json_string(NtJsonSpan v, char *out, size_t cap) {
  if (v.n < 2 || v.p[0] != '"' || v.p[v.n - 1] != '"' || cap == 0) return -1;
  size_t o = 0;
#define PUT(c) do { if (o + 1 < cap) out[o] = (char)(c); o++; } while (0)
  for (size_t i = 1; i + 1 < v.n; i++) {
    char c = v.p[i];
    if (c != '\\') { PUT(c); continue; }
    if (++i + 1 > v.n - 1) break;
    switch (v.p[i]) {
      case 'n': PUT('\n'); break; case 't': PUT('\t'); break; case 'r': PUT('\r'); break;
      case 'b': PUT('\b'); break; case 'f': PUT('\f'); break;
      case 'u': {
        unsigned cp;
        if (i + 4 >= v.n || !hex4(v.p + i + 1, &cp)) return -1;
        i += 4;
        if (cp >= 0xd800 && cp < 0xdc00 && i + 6 < v.n && v.p[i + 1] == '\\' && v.p[i + 2] == 'u') {
          unsigned lo;
          if (hex4(v.p + i + 3, &lo) && lo >= 0xdc00 && lo < 0xe000) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i += 6; }
          else cp = 0xfffd;
        } else if (cp >= 0xd800 && cp < 0xe000) cp = 0xfffd;
        if (cp < 0x80) PUT(cp);
        else if (cp < 0x800) { PUT(0xc0 | (cp >> 6)); PUT(0x80 | (cp & 63)); }
        else if (cp < 0x10000) { PUT(0xe0 | (cp >> 12)); PUT(0x80 | ((cp >> 6) & 63)); PUT(0x80 | (cp & 63)); }
        else { PUT(0xf0 | (cp >> 18)); PUT(0x80 | ((cp >> 12) & 63)); PUT(0x80 | ((cp >> 6) & 63)); PUT(0x80 | (cp & 63)); }
        break;
      }
      default: PUT(v.p[i]); break;
    }
  }
#undef PUT
  out[o < cap ? o : cap - 1] = 0;
  return (long)(o < cap ? o : cap - 1);
}

int nt_json_array_has_string(NtJsonSpan a, const char *text) {
  size_t n = a.n, i = ws(a.p, n, 0), tl = strlen(text);
  if (i >= n || a.p[i] != '[') return 0;
  i = ws(a.p, n, i + 1);
  while (i < n && a.p[i] != ']') {
    size_t e = value_end(a.p, n, i);
    if (!e) return 0;
    if (a.p[i] == '"' && e - i - 2 == tl && memcmp(a.p + i + 1, text, tl) == 0) return 1;
    i = ws(a.p, n, e);
    if (i < n && a.p[i] == ',') i = ws(a.p, n, i + 1);
  }
  return 0;
}

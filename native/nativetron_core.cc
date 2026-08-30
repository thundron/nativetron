#include "webview/webview.h"

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <cstddef>
#include <cstdint>
#include <string>

namespace {
webview::webview *g_w = nullptr;

using nt_msg_cb = void (*)(const uint8_t *, size_t, void *);
nt_msg_cb g_msg_cb = nullptr;
void *g_msg_ctx = nullptr;
bool g_quit = false;

std::string sv(const uint8_t *p, size_t n) {
  return std::string(reinterpret_cast<const char *>(p), n);
}
} // namespace

extern "C" {

void nt_init(void) {
  if (g_w) {
    return;
  }
  g_w = new webview::webview(/*debug=*/false, /*window=*/nullptr);
  g_w->bind("__nt_ipc", [](std::string req) -> std::string {
    if (g_msg_cb) {
      g_msg_cb(reinterpret_cast<const uint8_t *>(req.data()), req.size(),
               g_msg_ctx);
    }
    return ""; // resolve the page-side promise with nothing
  });
}

void nt_add_init(const uint8_t *s, size_t n) {
  if (g_w) {
    g_w->init(sv(s, n));
  }
}

void nt_set_title(const uint8_t *s, size_t n) {
  if (g_w) {
    g_w->set_title(sv(s, n));
  }
}

void nt_set_size(int32_t w, int32_t h) {
  if (g_w) {
    g_w->set_size(w, h, WEBVIEW_HINT_NONE);
  }
}

void nt_set_html(const uint8_t *s, size_t n) {
  if (g_w) {
    g_w->set_html(sv(s, n));
  }
}

// Ops cross as base64 inside a constant call. The evaluated source is
// `window.__nt.applyB64("<[A-Za-z0-9+/=]*>")`, so no operand character can
// close the string literal: escaping correctness stops being load-bearing.
void nt_send_ops(const uint8_t *b, size_t n) {
  if (!g_w) return;
  static const char *T =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string js;
  js.reserve(((n + 2) / 3) * 4 + 32);
  js += "window.__nt.applyB64(\"";
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    uint32_t v = (uint32_t)b[i] << 16 | (uint32_t)b[i + 1] << 8 | b[i + 2];
    js += T[(v >> 18) & 63];
    js += T[(v >> 12) & 63];
    js += T[(v >> 6) & 63];
    js += T[v & 63];
  }
  if (i < n) {
    uint32_t v = (uint32_t)b[i] << 16 | (i + 1 < n ? (uint32_t)b[i + 1] << 8 : 0);
    js += T[(v >> 18) & 63];
    js += T[(v >> 12) & 63];
    js += (i + 1 < n) ? T[(v >> 6) & 63] : '=';
    js += '=';
  }
  js += "\")";
  g_w->eval(js);
}

void nt_eval(const uint8_t *s, size_t n) {
  if (g_w) {
    g_w->eval(sv(s, n));
  }
}

void nt_on_message(nt_msg_cb cb, void *ctx) {
  g_msg_cb = cb;
  g_msg_ctx = ctx;
}

void nt_run(void) {
  if (g_w) {
    g_w->run();
  }
}

#if defined(__APPLE__)
int nt_pump(void) {
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id app = NSApplication_get_sharedApplication();
  id until = objc::msg_send<id>(objc::get_class("NSDate"),
                                objc::selector("distantPast"));
  id mode = NSRunLoopMode::NSDefaultRunLoopMode();
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.004, true);
  int n = 0;
  for (;;) {
    id ev = NSApplication_nextEventMatchingMask(
        app, static_cast<NSEventMask>(~0ULL), until, mode, true);
    if (!ev) {
      break;
    }
    NSApplication_sendEvent(app, ev);
    n++;
    if (n > 256) {
      break;
    }
  }
  objc::msg_send<void>(objc::get_class("CATransaction"),
                       objc::selector("flush"));
  return g_quit ? 1 : 0;
}

void nt_activate(void) {
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id app = NSApplication_get_sharedApplication();
  objc::msg_send<void>(app, objc::selector("finishLaunching"));
  NSApplication_activateIgnoringOtherApps(app, true);
}
#else
int nt_pump(void) { return g_quit ? 1 : 0; }
void nt_activate(void) {}
#endif

void nt_terminate(void) {
  g_quit = true;
  if (g_w) {
    g_w->terminate();
  }
}

} // extern "C"

// nativetron native core — a thin modern-C++ wrapper over the webview library
// (WKWebView / WebView2 / WebKitGTK) exposing a scriptc-FFI-friendly C ABI.
//
// Strings cross the FFI boundary as (const uint8_t* ptr, size_t len); they are
// borrowed for the duration of the call. The inbound message callback is a
// scriptc "retained" callback: we store it and invoke it later, on the UI
// thread, whenever the page posts a message.
#include "webview/webview.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace {
webview::webview *g_w = nullptr;

// scriptc retained callback: (bytes ptr, len, context)
using nt_msg_cb = void (*)(const uint8_t *, size_t, void *);
nt_msg_cb g_msg_cb = nullptr;
void *g_msg_ctx = nullptr;

std::string sv(const uint8_t *p, size_t n) {
  return std::string(reinterpret_cast<const char *>(p), n);
}
} // namespace

extern "C" {

// Create the singleton window + webview. The page reaches native code by
// calling window.__nt_ipc(<string>); the argument arrives here as a JSON
// array string (webview wraps bound-call args as JSON).
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

// native -> page: run JS in the page (used to push DOM mutations).
void nt_eval(const uint8_t *s, size_t n) {
  if (g_w) {
    g_w->eval(sv(s, n));
  }
}

// register the retained inbound-message callback.
void nt_on_message(nt_msg_cb cb, void *ctx) {
  g_msg_cb = cb;
  g_msg_ctx = ctx;
}

// enter the UI event loop (blocks until the window closes / terminate()).
void nt_run(void) {
  if (g_w) {
    g_w->run();
  }
}

void nt_terminate(void) {
  if (g_w) {
    g_w->terminate();
  }
}

} // extern "C"

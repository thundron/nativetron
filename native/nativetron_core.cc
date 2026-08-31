#include "webview/webview.h"

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <string>

namespace {
webview::webview *g_w = nullptr;

using nt_msg_cb = void (*)(const uint8_t *, size_t, void *);
using nt_text_cb = void (*)(const uint8_t *, size_t, void *);
nt_msg_cb g_msg_cb = nullptr;
void *g_msg_ctx = nullptr;
bool g_quit = false;
bool g_dirty = false;

std::string sv(const uint8_t *p, size_t n) {
  return std::string(reinterpret_cast<const char *>(p), n);
}

void text_result(nt_text_cb cb, void *ctx, const std::string &value) {
  cb(reinterpret_cast<const uint8_t *>(value.data()), value.size(), ctx);
}

#if defined(__APPLE__)
id native_window() {
  if (!g_w) return nullptr;
  auto result = g_w->window();
  if (!result.ok()) return nullptr;
  return static_cast<id>(result.value());
}

std::string native_text(id value) {
  if (!value) return "";
  const char *text = webview::detail::cocoa::NSString_get_UTF8String(value);
  return text ? std::string(text) : std::string();
}
#endif
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

void nt_window_action(int32_t action) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id window = native_window();
  if (!window) return;
  switch (action) {
    case 1:
      objc::msg_send<void>(window, objc::selector("miniaturize:"), nullptr);
      break;
    case 2:
      if (!objc::msg_send<bool>(window, objc::selector("isZoomed"))) {
        objc::msg_send<void>(window, objc::selector("zoom:"), nullptr);
      }
      break;
    case 3:
      objc::msg_send<void>(window, objc::selector("toggleFullScreen:"), nullptr);
      break;
    case 4:
      objc::msg_send<void>(window, objc::selector("deminiaturize:"), nullptr);
      objc::msg_send<void>(window, objc::selector("makeKeyAndOrderFront:"), nullptr);
      break;
    case 6:
      objc::msg_send<void>(window, objc::selector("makeKeyAndOrderFront:"), nullptr);
      break;
    case 5:
      objc::msg_send<void>(window, objc::selector("orderOut:"), nullptr);
      break;
    case 7:
      objc::msg_send<void>(window, objc::selector("close"));
      g_quit = true;
      break;
  }
#else
  (void)action;
#endif
}

int32_t nt_window_state(void) {
#if defined(__APPLE__)
  using namespace webview::detail;
  id window = native_window();
  if (!window) return 0;
  int32_t state = 0;
  if (objc::msg_send<bool>(window, objc::selector("isMiniaturized"))) state |= 1;
  if (objc::msg_send<bool>(window, objc::selector("isZoomed"))) state |= 2;
  if (objc::msg_send<bool>(window, objc::selector("isVisible"))) state |= 4;
  if (objc::msg_send<bool>(window, objc::selector("isKeyWindow"))) state |= 8;
  auto style = objc::msg_send<unsigned long>(window, objc::selector("styleMask"));
  if ((style & (1UL << 14)) != 0) state |= 16;
  return state;
#else
  return 0;
#endif
}

void nt_clipboard_write(const uint8_t *s, size_t n) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id pasteboard = objc::msg_send<id>(objc::get_class("NSPasteboard"),
                                     objc::selector("generalPasteboard"));
  objc::msg_send<long>(pasteboard, objc::selector("clearContents"));
  id type = NSString_stringWithUTF8String("public.utf8-plain-text");
  id value = NSString_stringWithUTF8String(sv(s, n));
  objc::msg_send<bool>(pasteboard, objc::selector("setString:forType:"), value, type);
#else
  (void)s;
  (void)n;
#endif
}

void nt_clipboard_read(nt_text_cb cb, void *ctx) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id pasteboard = objc::msg_send<id>(objc::get_class("NSPasteboard"),
                                     objc::selector("generalPasteboard"));
  id type = NSString_stringWithUTF8String("public.utf8-plain-text");
  id value = objc::msg_send<id>(pasteboard, objc::selector("stringForType:"), type);
  text_result(cb, ctx, native_text(value));
#else
  text_result(cb, ctx, "");
#endif
}

int32_t nt_open_external(const uint8_t *s, size_t n) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  if (n == 0) return 0;
  objc::autoreleasepool arp;
  id url = NSURL_URLWithString(sv(s, n));
  if (!url) return 0;
  id workspace = objc::msg_send<id>(objc::get_class("NSWorkspace"),
                                     objc::selector("sharedWorkspace"));
  return objc::msg_send<bool>(workspace, objc::selector("openURL:"), url) ? 1 : 0;
#else
  (void)s;
  (void)n;
  return 0;
#endif
}

void nt_open_dialog(int32_t directories, int32_t multiple, nt_text_cb cb, void *ctx) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id panel = NSOpenPanel_openPanel();
  NSOpenPanel_set_canChooseFiles(panel, directories == 0);
  NSOpenPanel_set_canChooseDirectories(panel, directories != 0);
  NSOpenPanel_set_allowsMultipleSelection(panel, multiple != 0);
  if (NSSavePanel_runModal(panel) != NSModalResponseOK) {
    text_result(cb, ctx, "");
    return;
  }
  id urls = NSOpenPanel_get_URLs(panel);
  auto count = objc::msg_send<unsigned long>(urls, objc::selector("count"));
  std::string result;
  for (unsigned long i = 0; i < count; i++) {
    id url = objc::msg_send<id>(urls, objc::selector("objectAtIndex:"), i);
    id path = objc::msg_send<id>(url, objc::selector("path"));
    if (!result.empty()) result += '\n';
    result += native_text(path);
  }
  text_result(cb, ctx, result);
#else
  (void)directories;
  (void)multiple;
  text_result(cb, ctx, "");
#endif
}

void nt_save_dialog(nt_text_cb cb, void *ctx) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  objc::autoreleasepool arp;
  id panel = objc::msg_send<id>(objc::get_class("NSSavePanel"),
                                 objc::selector("savePanel"));
  if (NSSavePanel_runModal(panel) != NSModalResponseOK) {
    text_result(cb, ctx, "");
    return;
  }
  id url = objc::msg_send<id>(panel, objc::selector("URL"));
  id path = objc::msg_send<id>(url, objc::selector("path"));
  text_result(cb, ctx, native_text(path));
#else
  text_result(cb, ctx, "");
#endif
}

int32_t nt_notify(const uint8_t *title, size_t title_n,
                  const uint8_t *body, size_t body_n) {
#if defined(__APPLE__)
  using namespace webview::detail;
  using namespace webview::detail::cocoa;
  if (title_n == 0) return 0;
  objc::autoreleasepool arp;
  id note = objc::msg_send<id>(objc::get_class("NSUserNotification"),
                                objc::selector("alloc"));
  note = objc::msg_send<id>(note, objc::selector("init"));
  objc::msg_send<void>(note, objc::selector("setTitle:"),
                       NSString_stringWithUTF8String(sv(title, title_n)));
  objc::msg_send<void>(note, objc::selector("setInformativeText:"),
                       NSString_stringWithUTF8String(sv(body, body_n)));
  id center = objc::msg_send<id>(objc::get_class("NSUserNotificationCenter"),
                                  objc::selector("defaultUserNotificationCenter"));
  objc::msg_send<void>(center, objc::selector("deliverNotification:"), note);
  objc::msg_send<void>(note, objc::selector("release"));
  return 1;
#else
  (void)title;
  (void)title_n;
  (void)body;
  (void)body_n;
  return 0;
#endif
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
  g_dirty = true;
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
  g_dirty = true;
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
  // A Core Animation commit is only needed when something was drawn or
  // evaluated; flushing every tick keeps the window awake for nothing.
  if (g_dirty || n > 0) {
    objc::msg_send<void>(objc::get_class("CATransaction"),
                         objc::selector("flush"));
    g_dirty = false;
  }
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

// Portable WebView2 host policy: origin, asset paths, MIME/headers, IPC
// validation, rate limits, DPI arithmetic, command routing and the self-test
// state machine. No Win32 dependencies, so hosts/windows/policy.test.cc runs it
// natively on any build machine; main.cc applies it on Windows.
#pragma once
#include "../../ipc/engine.generated.h"
#include "../../native/assets.generated.h"
#include "webview/detail/json.hh"
#include <cstdint>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

namespace nt_windows {

// Virtual origin. Requests are answered natively from WebResourceRequested;
// no folder mapping, DNS or network access is involved. `.localhost` avoids
// the `.local` mDNS navigation delay documented for WebView2 virtual hosts.
constexpr const char *origin = "https://nativetron.localhost";
const char *const entry = NT_ASSET_ENTRY;
constexpr size_t max_path_bytes = 512;
constexpr size_t max_asset_bytes = 64u << 20;
constexpr size_t max_assets = 4096;
constexpr size_t max_ipc_request_bytes = 90000;
constexpr size_t max_log_bytes = 2048;
constexpr unsigned default_timeout_ms = 15000;

// Process exit codes. Mirrored by hosts/windows/acceptance.ps1; verify.test.mjs
// keeps both tables identical.
enum exit_code : int {
  exit_ok = 0,
  exit_config = 1,           // bad arguments, missing/invalid engine-assets, planted loader DLL
  exit_runtime_missing = 2,  // no installed WebView2 runtime
  exit_init_failed = 3,      // window, environment or controller creation failed
  exit_timeout = 4,          // self-test did not finish in time
  exit_gpu_unavailable = 5,  // page reported GPU_UNAVAILABLE (no WebGPU adapter)
  exit_engine_failed = 6,    // GPU_ERROR / GPU_READBACK_FAILED reports
  exit_webview_failed = 7,   // navigation failure or WebView2 process failure
  exit_closed = 8,           // window closed before self-test completion
  exit_internal = 9,         // unexpected exception
  exit_policy_failed = 10,   // isolation, MIME, offline, DPR or lifecycle probe failed
};

inline const char *exit_name(int code) {
  switch (code) {
  case exit_ok: return "ok";
  case exit_config: return "config";
  case exit_runtime_missing: return "runtime-missing";
  case exit_init_failed: return "init-failed";
  case exit_timeout: return "timeout";
  case exit_gpu_unavailable: return "gpu-unavailable";
  case exit_engine_failed: return "engine-failed";
  case exit_webview_failed: return "webview-failed";
  case exit_closed: return "closed";
  case exit_internal: return "internal";
  case exit_policy_failed: return "policy-failed";
  }
  return "unknown";
}

// ---------------------------------------------------------------- options

struct options {
  bool selftest = false;
  bool lifecycle = false;  // self-test additionally minimises/restores and reloads
  bool isolated = true;    // COOP/COEP/CORP headers; matches the macOS/iOS hosts
  bool log = false;        // forward console/browser log and window events to stderr
  bool debug = false;      // DevTools and browser accelerators
  unsigned timeout_ms = default_timeout_ms;
};

inline bool parse_unsigned(const std::string &text, unsigned &out) {
  if (text.empty() || text.size() > 7) return false;
  unsigned value = 0;
  for (char c : text) {
    if (c < '0' || c > '9') return false;
    value = value * 10 + unsigned(c - '0');
  }
  out = value;
  return true;
}

inline bool parse_options(const std::vector<std::string> &args, options &out, std::string &error) {
  out = options{};
  std::set<std::string> seen;
  for (const auto &arg : args) {
    const auto key = arg.substr(0, arg.find('='));
    if (!seen.insert(key).second) { error = "duplicate option " + key; return false; }
    if (arg == "--selftest") out.selftest = true;
    else if (arg == "--selftest=lifecycle") { out.selftest = true; out.lifecycle = true; }
    else if (arg == "--no-isolation") out.isolated = false;
    else if (arg == "--log") out.log = true;
    else if (arg == "--debug") out.debug = true;
    else if (key == "--timeout-ms") {
      unsigned value = 0;
      if (arg.size() <= key.size() + 1 || !parse_unsigned(arg.substr(key.size() + 1), value) || value < 1000 || value > 600000) {
        error = "--timeout-ms must be 1000..600000"; return false;
      }
      out.timeout_ms = value;
    } else { error = "unknown option " + arg; return false; }
  }
  if (out.selftest) out.log = true;
  if (seen.count("--timeout-ms") && !out.selftest) { error = "--timeout-ms requires --selftest"; return false; }
  return true;
}

inline const char *usage() {
  return "usage: engine-windows.exe [--selftest|--selftest=lifecycle] [--timeout-ms=N] [--no-isolation] [--log] [--debug]";
}

// ---------------------------------------------------------------- requests

enum class request_class { local, malformed, external };

struct classified_request {
  request_class kind = request_class::external;
  std::string path;  // allowlist key such as "engine/page.html"
};

inline int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

inline bool segment_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
}

// Validates a relative asset key. Segments are restricted to [A-Za-z0-9._-];
// ".", "..", empty segments and trailing dots (Windows strips them, creating
// aliases) are refused. Separators are always '/'.
inline bool valid_asset_key(const std::string &path) {
  if (path.empty() || path.size() > max_path_bytes) return false;
  size_t start = 0;
  while (start <= path.size()) {
    const size_t end = path.find('/', start);
    const std::string segment = path.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (segment.empty() || segment == "." || segment == ".." || segment.back() == '.') return false;
    for (char c : segment) if (!segment_char(c)) return false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

// Classifies a canonical WebView2 request URI. Anything not exactly on the
// virtual origin (other scheme, host suffix tricks, ports, userinfo) is
// external and refused offline. Percent escapes may only encode segment
// characters; encoded separators, NUL/control bytes and dot segments are
// malformed rather than normalised.
inline classified_request classify(const std::string &uri) {
  classified_request out;
  const std::string prefix = std::string(origin) + "/";
  if (uri.compare(0, prefix.size(), prefix) != 0) return out;
  out.kind = request_class::malformed;
  std::string raw = uri.substr(prefix.size());
  const size_t cut = raw.find_first_of("?#");
  if (cut != std::string::npos) raw.resize(cut);
  if (raw.size() > max_path_bytes) return out;
  std::string path;
  for (size_t i = 0; i < raw.size(); i++) {
    char c = raw[i];
    if (c == '%') {
      if (i + 2 >= raw.size()) return out;
      const int hi = hex_digit(raw[i + 1]), lo = hex_digit(raw[i + 2]);
      if (hi < 0 || lo < 0) return out;
      c = static_cast<char>(hi * 16 + lo);
      if (!segment_char(c)) return out;
      i += 2;
    } else if (c != '/' && !segment_char(c)) {
      return out;
    }
    path += c;
  }
  if (path.empty()) path = entry;
  if (!valid_asset_key(path)) return out;
  out.kind = request_class::local;
  out.path = path;
  return out;
}

inline bool is_local_document(const std::string &uri) {
  return classify(uri).kind == request_class::local;
}

inline std::string extension(const std::string &path) {
  const size_t slash = path.rfind('/');
  const size_t dot = path.rfind('.');
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) return "";
  std::string ext = path.substr(dot + 1);
  for (auto &c : ext) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return ext;
}

// Only these types are ever served; other files in engine-assets are ignored.
inline std::string mime_for(const std::string &path) {
  const auto ext = extension(path);
  if (ext == "html") return "text/html; charset=utf-8";
  if (ext == "js" || ext == "mjs") return "text/javascript; charset=utf-8";
  if (ext == "wasm") return "application/wasm";
  if (ext == "json") return "application/json";
  if (ext == "css") return "text/css; charset=utf-8";
  if (ext == "wgsl" || ext == "txt") return "text/plain; charset=utf-8";
  if (ext == "png") return "image/png";
  if (ext == "svg") return "image/svg+xml";
  return "";
}

constexpr const char *content_security_policy = "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

inline bool method_allowed(const std::string &method) { return method == "GET" || method == "HEAD"; }

struct response_plan {
  int status = 404;
  const char *reason = "Not Found";
  std::string mime;
  bool body = false;
};

// Decides the native response for one request given the startup allowlist.
inline response_plan plan_response(const std::string &method, const std::string &uri, const std::set<std::string> &allowlist) {
  response_plan plan;
  const auto request = classify(uri);
  if (request.kind == request_class::external) { plan.status = 403; plan.reason = "Offline"; plan.mime = "text/plain; charset=utf-8"; return plan; }
  if (request.kind == request_class::malformed) { plan.status = 400; plan.reason = "Bad Request"; plan.mime = "text/plain; charset=utf-8"; return plan; }
  if (!method_allowed(method)) { plan.status = 405; plan.reason = "Method Not Allowed"; plan.mime = "text/plain; charset=utf-8"; return plan; }
  const char *declared = nt_asset_mime(request.path.c_str());
  const std::string mime = declared ? std::string(declared) + (std::string(declared).rfind("text/", 0) == 0 ? "; charset=utf-8" : "") : "";
  if (mime.empty() || !allowlist.count(request.path)) { plan.mime = "text/plain; charset=utf-8"; return plan; }
  plan.status = 200; plan.reason = "OK"; plan.mime = mime; plan.body = method == "GET";
  return plan;
}

// CRLF-separated header block for ICoreWebView2Environment::CreateWebResourceResponse.
inline std::string response_headers(const response_plan &plan, bool isolated) {
  std::string headers = "Content-Type: " + plan.mime + "\r\n";
  headers += "X-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n";
  // connect-src keeps fetch/XHR/WebSocket/EventSource on the bundle origin in
  // documents and workers (WebSocket handshakes bypass WebResourceRequested).
  headers += "Content-Security-Policy: " + std::string(content_security_policy) + "\r\n";
  headers += "Cross-Origin-Resource-Policy: same-origin";
  if (isolated) headers += "\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp";
  if (plan.status == 405) headers += "\r\nAllow: GET, HEAD";
  return headers;
}

// ---------------------------------------------------------------- IPC

// The webview binding delivers its JSON parameter array; accept exactly
// ["<generated engine envelope>"] carrying an engine→native frame.
inline bool decode_ipc_request(const std::string &request, std::vector<uint8_t> &bytes) {
  bytes.clear();
  if (request.size() > max_ipc_request_bytes || request.size() < 4 || request.front() != '[' || request.back() != ']') return false;
  const auto envelope = webview::detail::json_parse(request, "", 0);
  const auto encoded = webview::detail::json_parse(envelope, "frame", 0);
  if (encoded.empty() || envelope != nt_engine::envelope(encoded)) return false;
  if (request != "[" + webview::detail::json_escape(envelope) + "]") return false;
  auto decoded = nt_engine::from_base64(encoded);
  if (!nt_engine::from_engine_to_native(decoded)) return false;
  bytes = std::move(decoded);
  return true;
}

inline std::string frame_payload(const std::vector<uint8_t> &bytes) {
  return std::string(bytes.begin() + nt_engine::header_bytes, bytes.end());
}

// Native→engine COMMAND (requestId 0) delivered to the page bridge. The
// generated base64 alphabet needs no further escaping inside a JS string.
inline std::string command_script(uint32_t topic) {
  return "window.__nt_engine_receive&&window.__nt_engine_receive(\"" + nt_engine::base64(nt_engine::command(topic)) + "\")";
}

// Page-controlled text is logged on one line with control bytes replaced, so
// it cannot forge host marker lines.
inline std::string sanitize(const std::string &text, size_t limit = max_log_bytes) {
  std::string out;
  for (size_t i = 0; i < text.size() && out.size() < limit; i++) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    out += (c < 0x20 || c == 0x7f) ? '?' : static_cast<char>(c);
  }
  if (text.size() > limit) out += "...";
  return out;
}

class rate_limiter {
public:
  explicit rate_limiter(size_t per_second = nt_engine::max_rate) : limit_(per_second) {}
  bool allow(uint64_t now_ms) {
    if (!started_ || now_ms - window_ >= 1000) { started_ = true; window_ = now_ms; count_ = 0; }
    return ++count_ <= limit_;
  }
private:
  size_t limit_;
  uint64_t window_ = 0;
  size_t count_ = 0;
  bool started_ = false;
};

// ---------------------------------------------------------------- menu

enum command_id : unsigned { command_none = 0, command_change_colour = 1, command_quit = 2 };
constexpr uint32_t topic_change_colour = 1;

struct menu_item { command_id id; const char *label; };
// "\t" separates the displayed accelerator; AcceleratorKeyPressed implements it.
constexpr menu_item engine_menu[] = {
  {command_change_colour, "Change clear colour\tCtrl+R"},
  {command_none, nullptr},  // separator
  {command_quit, "Quit\tCtrl+Q"},
};

inline command_id accelerator(unsigned virtual_key, bool control, bool shift, bool alt) {
  if (!control || shift || alt) return command_none;
  if (virtual_key == 'R') return command_change_colour;
  if (virtual_key == 'Q') return command_quit;
  return command_none;
}

// ---------------------------------------------------------------- DPI

inline int scale(int value, int to_dpi, int from_dpi) {
  if (from_dpi <= 0) return value;
  const int64_t product = int64_t(value) * to_dpi;
  return int((product + (product >= 0 ? from_dpi / 2 : -from_dpi / 2)) / from_dpi);
}

inline double device_pixel_ratio(int dpi) { return dpi > 0 ? dpi / 96.0 : 1.0; }

struct size2 { int width; int height; };

// Outer window size that yields `client` given the current window and
// client rectangles; accounts for menu bars and DPI-dependent frames.
inline size2 frame_for_client(size2 client, size2 window_now, size2 client_now) {
  return {client.width + (window_now.width - client_now.width), client.height + (window_now.height - client_now.height)};
}

// ---------------------------------------------------------------- probe

// Expression evaluated through DevTools Runtime.evaluate (awaitPromise) after
// the engine passes, gathering page-side evidence for headers/MIME/offline/DPR.
inline const char *probe_expression() {
  return "(async()=>{const h=async(p)=>{const x=await fetch(p,{cache:'no-store'});"
         "return{status:x.status,type:x.headers.get('content-type')||'',coop:x.headers.get('cross-origin-opener-policy')||'',"
         "coep:x.headers.get('cross-origin-embedder-policy')||'',nosniff:x.headers.get('x-content-type-options')||''}};"
         "const s=async(p)=>{try{return(await fetch(p,{cache:'no-store'})).status}catch(e){return -1}};"
         "const r={origin:location.origin,isolated:self.crossOriginIsolated===true,dpr:devicePixelRatio,"
         "gpu:!!navigator.gpu,worker:typeof Worker==='function',offscreen:typeof OffscreenCanvas==='function'};"
         "r.wasm=await h('/engine/.scriptc/ui.wasm');r.module=await h('/engine/host.js');"
         "r.missing=await s('/engine/missing.js');r.malformed=await s('/engine/%5cpage.html');"
         "r.connect=await s('https://example.com/');"
         "r.external=await new Promise(f=>{const i=new Image();i.onload=()=>f('loaded');i.onerror=()=>f('blocked');"
         "i.src='https://example.com/nativetron-offline-probe.png'});"
         "r.websocket=await new Promise(f=>{try{const w=new WebSocket('wss://example.com/');const t=setTimeout(()=>{w.close();f('timeout')},3000);"
         "w.onopen=()=>{clearTimeout(t);w.close();f('open')};w.onerror=()=>{clearTimeout(t);f('blocked')}}catch(e){f('blocked')}});"
         "return JSON.stringify(r)})()";
}

inline std::string probe_params() {
  return "{\"expression\":" + webview::detail::json_escape(probe_expression()) + ",\"awaitPromise\":true,\"returnByValue\":true}";
}

struct probe_verdict { bool ok; std::string reason; };

// `response` is the Runtime.evaluate result JSON. `blocked_delta` counts
// external requests the native handler refused while the probe ran.
inline probe_verdict check_probe(const std::string &response, bool isolated, double rasterization_scale, unsigned blocked_delta) {
  using webview::detail::json_parse;
  if (!json_parse(response, "exceptionDetails", 0).empty()) return {false, "probe threw"};
  const auto value = json_parse(json_parse(response, "result", 0), "value", 0);
  if (value.empty()) return {false, "probe returned no value"};
  if (json_parse(value, "origin", 0) != origin) return {false, "unexpected origin"};
  const auto wasm = json_parse(value, "wasm", 0), module = json_parse(value, "module", 0);
  if (json_parse(wasm, "status", 0) != "200" || json_parse(wasm, "type", 0) != "application/wasm") return {false, "wasm MIME"};
  if (json_parse(module, "status", 0) != "200" || json_parse(module, "type", 0) != "text/javascript; charset=utf-8") return {false, "module MIME"};
  if (json_parse(wasm, "nosniff", 0) != "nosniff") return {false, "nosniff header"};
  const bool coop = json_parse(module, "coop", 0) == "same-origin", coep = json_parse(module, "coep", 0) == "require-corp";
  if (isolated != (coop && coep) || (!isolated && (coop || coep))) return {false, "isolation headers"};
  if ((json_parse(value, "isolated", 0) == "true") != isolated) return {false, "crossOriginIsolated"};
  if (json_parse(value, "missing", 0) != "404") return {false, "missing asset status"};
  if (json_parse(value, "malformed", 0) != "400") return {false, "malformed path status"};
  if (json_parse(value, "external", 0) != "blocked" || blocked_delta == 0) return {false, "external request not refused natively"};
  if (json_parse(value, "connect", 0) != "-1") return {false, "external fetch not refused"};
  if (json_parse(value, "websocket", 0) == "open") return {false, "external WebSocket opened"};
  if (rasterization_scale > 0) {
    const double dpr = std::atof(json_parse(value, "dpr", 0).c_str());
    if (dpr <= 0 || dpr - rasterization_scale > 0.02 || rasterization_scale - dpr > 0.02) return {false, "devicePixelRatio does not match rasterization scale"};
  }
  return {true, value};
}

// ---------------------------------------------------------------- self-test

enum class action { none, press_menu, run_probe, lifecycle, reload, pass, fail };

struct step { action next; int code; std::string marker; };

// Engine readback → native menu command → colour change → page probe →
// (lifecycle: minimise/restore, reload, engine restart, second readback) → pass.
class selftest {
public:
  explicit selftest(bool lifecycle) : lifecycle_(lifecycle) {}
  enum class phase { readback, colour, probe, lifecycle, restart_mode, restart_readback, done };
  phase current() const { return phase_; }

  step on_report(const std::string &report) {
    if (phase_ == phase::done) return {action::none, 0, ""};
    if (report.rfind("GPU_UNAVAILABLE", 0) == 0) return finish(exit_gpu_unavailable, "ENGINE_WINDOWS_UNAVAILABLE");
    if (report.rfind("GPU_ERROR", 0) == 0 || report == "GPU_READBACK_FAILED") return finish(exit_engine_failed, "ENGINE_WINDOWS_FAILED engine");
    if (report.rfind("ENGINE_MODE ", 0) == 0) {
      if (phase_ == phase::restart_mode) phase_ = phase::restart_readback;
      return {action::none, 0, ""};
    }
    if (report == "GPU_READBACK_OK 4096") {
      if (phase_ == phase::readback) { phase_ = phase::colour; return {action::press_menu, 0, ""}; }
      if (phase_ == phase::restart_readback) return finish(exit_ok, "ENGINE_WINDOWS_OK");
      return {action::none, 0, ""};
    }
    if (report == "GPU_COLOUR_CHANGED" && phase_ == phase::colour) { phase_ = phase::probe; return {action::run_probe, 0, ""}; }
    return {action::none, 0, ""};
  }

  step on_probe(const probe_verdict &verdict) {
    if (phase_ != phase::probe) return {action::none, 0, ""};
    if (!verdict.ok) return finish(exit_policy_failed, "ENGINE_WINDOWS_FAILED policy " + verdict.reason);
    if (!lifecycle_) return finish(exit_ok, "ENGINE_WINDOWS_OK");
    phase_ = phase::lifecycle;
    return {action::lifecycle, 0, ""};
  }

  // Minimise must hide the controller, restore must show it again.
  step on_lifecycle(bool hidden_when_minimised, bool visible_when_restored) {
    if (phase_ != phase::lifecycle) return {action::none, 0, ""};
    if (!hidden_when_minimised || !visible_when_restored) return finish(exit_policy_failed, "ENGINE_WINDOWS_FAILED policy controller visibility");
    phase_ = phase::restart_mode;
    return {action::reload, 0, ""};
  }

  step on_navigation_failed() { return finish(exit_webview_failed, "ENGINE_WINDOWS_FAILED navigation"); }
  step on_process_failed(const std::string &kind) { return finish(exit_webview_failed, "ENGINE_WINDOWS_FAILED process " + kind); }
  step on_menu_unavailable() { return finish(exit_policy_failed, "ENGINE_WINDOWS_FAILED policy menu disabled"); }
  step on_timeout() { return finish(exit_timeout, "ENGINE_WINDOWS_TIMEOUT"); }
  step on_closed() { return finish(exit_closed, "ENGINE_WINDOWS_CLOSED"); }

private:
  step finish(int code, std::string marker) {
    if (phase_ == phase::done) return {action::none, 0, ""};
    phase_ = phase::done;
    return {code == exit_ok ? action::pass : action::fail, code, std::move(marker)};
  }
  bool lifecycle_;
  phase phase_ = phase::readback;
};

}  // namespace nt_windows

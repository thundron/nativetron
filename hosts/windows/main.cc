// nativetron Windows WebView2 engine host.
//
// Serves the allowlisted engine-assets bundle on a virtual HTTPS origin from
// WebResourceRequested (MIME types, optional COOP/COEP isolation headers),
// refuses every other request/navigation offline, bridges the generated
// engine IPC envelope, owns the native Engine menu and window/DPR lifecycle,
// and exposes a self-test with stable exit codes (see policy.h).
#include "webview/webview.h"
#include "../../ipc/engine.generated.h"
#include "policy.h"
#include <shlwapi.h>
#include <atomic>
#include <cstdio>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace nt_windows;
using webview::detail::narrow_string;
using webview::detail::widen_string;

// ------------------------------------------------------------------ COM glue

template <class T> class com_ptr {
public:
  com_ptr() = default;
  com_ptr(const com_ptr &) = delete;
  com_ptr &operator=(const com_ptr &) = delete;
  com_ptr(com_ptr &&other) noexcept : p_(std::exchange(other.p_, nullptr)) {}
  com_ptr &operator=(com_ptr &&other) noexcept { if (this != &other) { reset(); p_ = std::exchange(other.p_, nullptr); } return *this; }
  ~com_ptr() { reset(); }
  T *get() const { return p_; }
  T *operator->() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }
  T **put() { reset(); return &p_; }
  void reset() { if (p_) { p_->Release(); p_ = nullptr; } }
  void retain(T *value) { reset(); p_ = value; if (p_) p_->AddRef(); }
  template <class U> com_ptr<U> query(const IID &iid) const {
    com_ptr<U> out;
    if (p_) p_->QueryInterface(iid, reinterpret_cast<void **>(out.put()));
    return out;
  }
private:
  T *p_ = nullptr;
};

// One refcounted handler class for every WebView2 callback interface.
template <class I, class... A> class callback final : public I {
public:
  callback(const IID &iid, std::function<HRESULT(A...)> fn) : iid_(iid), fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **out) override {
    if (!out) return E_POINTER;
    if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, iid_)) { *out = static_cast<I *>(this); AddRef(); return S_OK; }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override { const ULONG count = --refs_; if (!count) delete this; return count; }
  HRESULT STDMETHODCALLTYPE Invoke(A... args) override {
    try { return fn_(args...); } catch (...) { return E_FAIL; }
  }
private:
  std::atomic<ULONG> refs_{1};
  const IID &iid_;
  std::function<HRESULT(A...)> fn_;
};

template <class I, class... A, class F> com_ptr<I> make_callback(const IID &iid, F fn) {
  com_ptr<I> out;
  *out.put() = new callback<I, A...>(iid, std::function<HRESULT(A...)>(std::move(fn)));
  return out;
}

struct co_string {
  LPWSTR value = nullptr;
  co_string() = default;
  co_string(const co_string &) = delete;
  co_string &operator=(const co_string &) = delete;
  ~co_string() { CoTaskMemFree(value); }
  LPWSTR *put() { CoTaskMemFree(value); value = nullptr; return &value; }
  std::string str() const { return value ? narrow_string(value) : std::string(); }
};

void emit(const std::string &line) { std::cout << line << std::endl; }
void diagnostic(const std::string &line) { std::cerr << line << std::endl; }

std::string hresult(HRESULT hr) {
  char text[16];
  std::snprintf(text, sizeof text, "0x%08lx", static_cast<unsigned long>(hr));
  return text;
}

// ------------------------------------------------------------------ assets

bool same_prefix(const std::wstring &path, const std::wstring &prefix) {
  return path.size() > prefix.size() &&
         CompareStringOrdinal(path.c_str(), static_cast<int>(prefix.size()), prefix.c_str(), static_cast<int>(prefix.size()), TRUE) == CSTR_EQUAL;
}

std::wstring final_path(HANDLE handle) {
  std::wstring buffer(1024, L'\0');
  const DWORD length = GetFinalPathNameByHandleW(handle, &buffer[0], static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED);
  if (!length || length >= buffer.size()) return {};
  buffer.resize(length);
  return buffer;
}

class asset_index {
public:
  bool open(const std::wstring &root, std::string &error) {
    root_ = root;
    HANDLE handle = CreateFileW(root.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) { error = "engine-assets directory missing"; return false; }
    BY_HANDLE_FILE_INFORMATION info{};
    const bool directory = GetFileInformationByHandle(handle, &info) && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
    final_root_ = final_path(handle);
    CloseHandle(handle);
    if (!directory || final_root_.empty()) { error = "engine-assets is not a readable directory"; return false; }
    if (!scan(root_, "", 0, error)) return false;
    if (!keys_.count(entry)) { error = std::string("engine-assets lacks ") + entry; return false; }
    return true;
  }

  const std::set<std::string> &keys() const { return keys_; }

  // Opens without following reparse points and re-checks the resolved path
  // so a junction swapped in after startup cannot escape the bundle.
  bool read(const std::string &key, std::vector<uint8_t> &bytes) const {
    bytes.clear();
    if (!keys_.count(key)) return false;
    std::wstring relative = widen_string(key);
    for (auto &c : relative) if (c == L'/') c = L'\\';
    const std::wstring path = root_ + L"\\" + relative;
    HANDLE handle = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return false;
    BY_HANDLE_FILE_INFORMATION info{};
    bool ok = GetFileInformationByHandle(handle, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
              info.nFileSizeHigh == 0 && info.nFileSizeLow <= max_asset_bytes && same_prefix(final_path(handle), final_root_ + L"\\");
    if (ok) {
      bytes.resize(info.nFileSizeLow);
      DWORD offset = 0;
      while (ok && offset < bytes.size()) {
        DWORD got = 0;
        ok = ReadFile(handle, bytes.data() + offset, static_cast<DWORD>(bytes.size()) - offset, &got, nullptr) && got > 0;
        offset += got;
      }
    }
    CloseHandle(handle);
    if (!ok) bytes.clear();
    return ok;
  }

private:
  bool scan(const std::wstring &directory, const std::string &prefix, int depth, std::string &error) {
    if (depth > 16) { error = "engine-assets nesting too deep"; return false; }
    WIN32_FIND_DATAW data{};
    HANDLE find = FindFirstFileExW((directory + L"\\*").c_str(), FindExInfoBasic, &data, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
    if (find == INVALID_HANDLE_VALUE) return true;
    bool ok = true;
    do {
      const std::wstring name = data.cFileName;
      if (name == L"." || name == L"..") continue;
      const std::string key = prefix + narrow_string(name);
      if (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { diagnostic("ASSET_SKIPPED reparse-point " + sanitize(key, 256)); continue; }
      if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        if (valid_asset_key(key)) ok = scan(directory + L"\\" + name, key + "/", depth + 1, error);
        continue;
      }
      if (!valid_asset_key(key) || mime_for(key).empty()) continue;
      if (data.nFileSizeHigh || data.nFileSizeLow > max_asset_bytes) { error = "asset too large: " + sanitize(key, 256); ok = false; break; }
      if (keys_.size() >= max_assets) { error = "too many assets"; ok = false; break; }
      keys_.insert(key);
    } while (ok && FindNextFileW(find, &data));
    FindClose(find);
    return ok;
  }

  std::wstring root_, final_root_;
  std::set<std::string> keys_;
};

// ------------------------------------------------------------------ host

constexpr UINT_PTR timer_timeout = 1, timer_menu = 2, timer_minimised = 3, timer_restored = 4;
constexpr int initial_width = 900, initial_height = 700;
constexpr int max_render_recoveries = 3;

class host;
host *active_host = nullptr;

const char *process_failure_name(COREWEBVIEW2_PROCESS_FAILED_KIND kind) {
  switch (kind) {
  case COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED: return "browser";
  case COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED: return "render";
  case COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE: return "render-unresponsive";
  case COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED: return "frame-render";
  case COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED: return "gpu";
  case COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED: return "utility";
  default: return "other";
  }
}

class host {
public:
  explicit host(const options &opt) : opt_(opt), selftest_(opt.lifecycle) {}
  host(const host &) = delete;
  host &operator=(const host &) = delete;
  ~host() { teardown(); }

  int run() {
    if (!locate_assets()) return exit_config;
    try {
      browser_ = std::make_unique<webview::webview>(opt_.debug, nullptr);
    } catch (const webview::exception &error) {
      const bool missing = error.error().code() == WEBVIEW_ERROR_MISSING_DEPENDENCY;
      emit(std::string("ENGINE_WINDOWS_FAILED ") + (missing ? "runtime-missing " : "init ") + sanitize(error.what(), 256));
      return missing ? exit_runtime_missing : exit_init_failed;
    }
    active_host = this;
    if (!attach()) { emit("ENGINE_WINDOWS_FAILED init controller"); return exit_init_failed; }
    configure_settings();
    if (!install_handlers()) { emit("ENGINE_WINDOWS_FAILED init handlers"); return exit_init_failed; }
    if (!install_menu()) { emit("ENGINE_WINDOWS_FAILED init menu"); return exit_init_failed; }
    original_proc_ = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(window_, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&host::window_proc)));
    if (!original_proc_) { emit("ENGINE_WINDOWS_FAILED init subclass"); return exit_init_failed; }
    browser_->set_title("nativetron GPU engine");
    browser_->set_size(initial_width, initial_height, WEBVIEW_HINT_NONE);
    dpi_ = webview::detail::get_window_dpi(window_);
    fit_client({scale(initial_width, dpi_, 96), scale(initial_height, dpi_, 96)});
    log_dpi("initial");
    if (!install_bridge()) { emit("ENGINE_WINDOWS_FAILED init bridge"); return exit_init_failed; }
    if (opt_.log) enable_page_logging();
    if (opt_.selftest) SetTimer(window_, timer_timeout, opt_.timeout_ms, nullptr);
    browser_->navigate(std::string(origin) + "/" + entry);
    browser_->run();
    teardown();
    return exit_code_;
  }

private:
  // ---------------------------------------------------------------- startup

  bool locate_assets() {
    std::wstring executable(MAX_PATH, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, &executable[0], MAX_PATH);
    if (!length || length >= MAX_PATH) { emit("ENGINE_WINDOWS_FAILED config executable path"); return false; }
    executable.resize(length);
    const std::wstring directory = executable.substr(0, executable.find_last_of(L"\\/"));
    // webview/webview prefers a WebView2Loader.dll found on the DLL search path
    // over its built-in loader; the package ships none, so refuse a planted one.
    if (GetFileAttributesW((directory + L"\\WebView2Loader.dll").c_str()) != INVALID_FILE_ATTRIBUTES) {
      emit("ENGINE_WINDOWS_FAILED config WebView2Loader.dll beside the executable is not part of the package");
      return false;
    }
    std::string error;
    if (!assets_.open(directory + L"\\engine-assets", error)) { emit("ENGINE_WINDOWS_FAILED config " + error); return false; }
    diagnostic("ASSETS " + std::to_string(assets_.keys().size()) + " allowlisted");
    return true;
  }

  bool attach() {
    auto window = browser_->window();
    auto controller = browser_->browser_controller();
    if (!window.ok() || !controller.ok()) return false;
    window_ = static_cast<HWND>(window.value());
    controller_.retain(static_cast<ICoreWebView2Controller *>(controller.value()));
    if (FAILED(controller_->get_CoreWebView2(web_.put())) || !web_) return false;
    auto web2 = web_.query<ICoreWebView2_2>(IID_ICoreWebView2_2);
    if (!web2 || FAILED(web2->get_Environment(environment_.put())) || !environment_) return false;
    co_string version;
    if (SUCCEEDED(environment_->get_BrowserVersionString(version.put()))) emit("WEBVIEW2_VERSION " + sanitize(version.str(), 64));
    controller_->put_ZoomFactor(1.0);
    return true;
  }

  void configure_settings() {
    com_ptr<ICoreWebView2Settings> settings;
    if (FAILED(web_->get_Settings(settings.put())) || !settings) return;
    settings->put_AreHostObjectsAllowed(FALSE);
    settings->put_IsWebMessageEnabled(TRUE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(opt_.debug ? TRUE : FALSE);
    if (auto s3 = settings.query<ICoreWebView2Settings3>(IID_ICoreWebView2Settings3)) s3->put_AreBrowserAcceleratorKeysEnabled(opt_.debug ? TRUE : FALSE);
    if (auto s4 = settings.query<ICoreWebView2Settings4>(IID_ICoreWebView2Settings4)) { s4->put_IsPasswordAutosaveEnabled(FALSE); s4->put_IsGeneralAutofillEnabled(FALSE); }
    if (auto s5 = settings.query<ICoreWebView2Settings5>(IID_ICoreWebView2Settings5)) s5->put_IsPinchZoomEnabled(FALSE);
    if (auto s6 = settings.query<ICoreWebView2Settings6>(IID_ICoreWebView2Settings6)) s6->put_IsSwipeNavigationEnabled(FALSE);
    // SmartScreen reputation checks contact Microsoft services.
    if (auto s8 = settings.query<ICoreWebView2Settings8>(IID_ICoreWebView2Settings8)) s8->put_IsReputationCheckingRequired(FALSE);
  }

  bool install_handlers() {
    auto web22 = web_.query<ICoreWebView2_22>(IID_ICoreWebView2_22);
    HRESULT filtered = web22 ? web22->AddWebResourceRequestedFilterWithRequestSourceKinds(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL)
                             : web_->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    if (FAILED(filtered)) return false;

    auto requests = make_callback<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2 *, ICoreWebView2WebResourceRequestedEventArgs *>(
        IID_ICoreWebView2WebResourceRequestedEventHandler, [this](ICoreWebView2 *, ICoreWebView2WebResourceRequestedEventArgs *args) { return on_request(args); });
    if (FAILED(web_->add_WebResourceRequested(requests.get(), &request_token_))) return false;
    request_registered_ = true;

    auto navigation = make_callback<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *>(
        IID_ICoreWebView2NavigationStartingEventHandler, [this](ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *args) { return on_navigation(args, true); });
    if (FAILED(web_->add_NavigationStarting(navigation.get(), &navigation_token_))) return false;
    navigation_registered_ = true;

    auto frames = make_callback<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *>(
        IID_ICoreWebView2NavigationStartingEventHandler, [this](ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *args) { return on_navigation(args, false); });
    if (FAILED(web_->add_FrameNavigationStarting(frames.get(), &frame_token_))) return false;
    frame_registered_ = true;

    auto completed = make_callback<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2 *, ICoreWebView2NavigationCompletedEventArgs *>(
        IID_ICoreWebView2NavigationCompletedEventHandler, [this](ICoreWebView2 *, ICoreWebView2NavigationCompletedEventArgs *args) { return on_completed(args); });
    if (FAILED(web_->add_NavigationCompleted(completed.get(), &completed_token_))) return false;
    completed_registered_ = true;

    auto popups = make_callback<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *>(
        IID_ICoreWebView2NewWindowRequestedEventHandler, [this](ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *args) {
          args->put_Handled(TRUE);  // handled without a NewWindow: no popup is created
          if (opt_.log) diagnostic("POPUP_BLOCKED");
          return S_OK;
        });
    if (FAILED(web_->add_NewWindowRequested(popups.get(), &popup_token_))) return false;
    popup_registered_ = true;

    auto failures = make_callback<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2 *, ICoreWebView2ProcessFailedEventArgs *>(
        IID_ICoreWebView2ProcessFailedEventHandler, [this](ICoreWebView2 *, ICoreWebView2ProcessFailedEventArgs *args) { return on_process_failed(args); });
    if (FAILED(web_->add_ProcessFailed(failures.get(), &process_token_))) return false;
    process_registered_ = true;

    if (auto web4 = web_.query<ICoreWebView2_4>(IID_ICoreWebView2_4)) {
      auto downloads = make_callback<ICoreWebView2DownloadStartingEventHandler, ICoreWebView2 *, ICoreWebView2DownloadStartingEventArgs *>(
          IID_ICoreWebView2DownloadStartingEventHandler, [this](ICoreWebView2 *, ICoreWebView2DownloadStartingEventArgs *args) {
            args->put_Cancel(TRUE);
            args->put_Handled(TRUE);
            if (opt_.log) diagnostic("DOWNLOAD_BLOCKED");
            return S_OK;
          });
      if (SUCCEEDED(web4->add_DownloadStarting(downloads.get(), &download_token_))) download_registered_ = true;
    }

    auto keys = make_callback<ICoreWebView2AcceleratorKeyPressedEventHandler, ICoreWebView2Controller *, ICoreWebView2AcceleratorKeyPressedEventArgs *>(
        IID_ICoreWebView2AcceleratorKeyPressedEventHandler, [this](ICoreWebView2Controller *, ICoreWebView2AcceleratorKeyPressedEventArgs *args) { return on_key(args); });
    if (FAILED(controller_->add_AcceleratorKeyPressed(keys.get(), &key_token_))) return false;
    key_registered_ = true;

    if (auto controller3 = controller_.query<ICoreWebView2Controller3>(IID_ICoreWebView2Controller3)) {
      auto scaled = make_callback<ICoreWebView2RasterizationScaleChangedEventHandler, ICoreWebView2Controller *, IUnknown *>(
          IID_ICoreWebView2RasterizationScaleChangedEventHandler, [this](ICoreWebView2Controller *, IUnknown *) { log_dpi("rasterization"); return S_OK; });
      if (SUCCEEDED(controller3->add_RasterizationScaleChanged(scaled.get(), &scale_token_))) scale_registered_ = true;
    }
    return true;
  }

  bool install_menu() {
    menu_bar_ = CreateMenu();
    engine_menu_ = CreatePopupMenu();
    if (!menu_bar_ || !engine_menu_) return false;
    for (const auto &item : engine_menu) {
      const bool ok = item.label ? AppendMenuW(engine_menu_, MF_STRING | (item.id == command_change_colour ? MF_GRAYED : 0), item.id, widen_string(item.label).c_str())
                                 : AppendMenuW(engine_menu_, MF_SEPARATOR, 0, nullptr);
      if (!ok) return false;
    }
    if (!AppendMenuW(menu_bar_, MF_POPUP, reinterpret_cast<UINT_PTR>(engine_menu_), L"&Engine")) return false;
    if (!SetMenu(window_, menu_bar_)) return false;
    menu_attached_ = true;  // destroyed with the window from here on
    return true;
  }

  bool install_bridge() {
    return browser_->bind("__nt_ipc", [this](const std::string &request) -> std::string {
      if (closing_) return "";
      if (!inbound_.allow(GetTickCount64())) { if (opt_.log) diagnostic("IPC_DROPPED rate"); return ""; }
      std::vector<uint8_t> bytes;
      if (!decode_ipc_request(request, bytes)) { diagnostic("IPC_REJECTED frame"); return ""; }
      if (!source_is_local()) { diagnostic("IPC_REJECTED source"); return ""; }
      const std::string report = frame_payload(bytes);
      emit("REPORT " + sanitize(report));
      if (report.rfind("ENGINE_MODE ", 0) == 0) set_engine_ready(true);
      if (opt_.selftest) apply(selftest_.on_report(report));
      return "";
    }).ok();
  }

  // Console API, uncaught exceptions and browser log entries (including
  // COEP/CORP and offline network failures) go to stderr.
  void enable_page_logging() {
    const std::pair<const wchar_t *, const char *> events[] = {
        {L"Runtime.consoleAPICalled", "CONSOLE"}, {L"Runtime.exceptionThrown", "PAGE_EXCEPTION"}, {L"Log.entryAdded", "BROWSER_LOG"}};
    for (const auto &event : events) {
      com_ptr<ICoreWebView2DevToolsProtocolEventReceiver> receiver;
      if (FAILED(web_->GetDevToolsProtocolEventReceiver(event.first, receiver.put())) || !receiver) continue;
      const std::string label = event.second;
      auto handler = make_callback<ICoreWebView2DevToolsProtocolEventReceivedEventHandler, ICoreWebView2 *, ICoreWebView2DevToolsProtocolEventReceivedEventArgs *>(
          IID_ICoreWebView2DevToolsProtocolEventReceivedEventHandler, [this, label](ICoreWebView2 *, ICoreWebView2DevToolsProtocolEventReceivedEventArgs *args) {
            co_string json;
            if (!closing_ && SUCCEEDED(args->get_ParameterObjectAsJson(json.put()))) diagnostic(label + " " + sanitize(json.str()));
            return S_OK;
          });
      EventRegistrationToken token{};
      if (SUCCEEDED(receiver->add_DevToolsProtocolEventReceived(handler.get(), &token))) receivers_.push_back({std::move(receiver), token});
    }
    for (const wchar_t *method : {L"Runtime.enable", L"Log.enable"}) {
      auto done = make_callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
          IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, [](HRESULT hr, LPCWSTR) {
            if (FAILED(hr)) diagnostic("DEVTOOLS_FAILED " + hresult(hr));
            return S_OK;
          });
      web_->CallDevToolsProtocolMethod(method, L"{}", done.get());
    }
  }

  // ---------------------------------------------------------------- events

  HRESULT on_request(ICoreWebView2WebResourceRequestedEventArgs *args) {
    com_ptr<ICoreWebView2WebResourceRequest> request;
    if (FAILED(args->get_Request(request.put())) || !request) return S_OK;
    co_string uri, method;
    request->get_Uri(uri.put());
    request->get_Method(method.put());
    const std::string target = uri.str();
    response_plan plan = plan_response(method.str(), target, assets_.keys());
    std::vector<uint8_t> body;
    if (plan.status == 403) {
      blocked_++;
      diagnostic("OFFLINE_BLOCKED " + sanitize(target, 256));
    } else if (plan.status == 200 && plan.body && !assets_.read(classify(target).path, body)) {
      plan = response_plan{};
      plan.mime = "text/plain; charset=utf-8";
    } else if (plan.status != 200 && opt_.log) {
      diagnostic("ASSET_REFUSED " + std::to_string(plan.status) + " " + sanitize(target, 256));
    }
    com_ptr<IStream> stream;
    if (plan.body) {
      static const uint8_t empty = 0;
      *stream.put() = SHCreateMemStream(body.empty() ? &empty : body.data(), static_cast<UINT>(body.size()));
      if (!stream) { plan = response_plan{}; plan.status = 500; plan.reason = "Internal Server Error"; plan.mime = "text/plain; charset=utf-8"; }
    }
    com_ptr<ICoreWebView2WebResourceResponse> response;
    const std::wstring reason = widen_string(plan.reason), headers = widen_string(response_headers(plan, opt_.isolated));
    if (SUCCEEDED(environment_->CreateWebResourceResponse(stream.get(), plan.status, reason.c_str(), headers.c_str(), response.put())) && response) {
      args->put_Response(response.get());
    } else {
      diagnostic("RESPONSE_FAILED " + sanitize(target, 256));
    }
    return S_OK;
  }

  HRESULT on_navigation(ICoreWebView2NavigationStartingEventArgs *args, bool main_frame) {
    co_string uri;
    args->get_Uri(uri.put());
    const std::string target = uri.str();
    if (!is_local_document(target)) {
      args->put_Cancel(TRUE);
      blocked_++;
      diagnostic(std::string(main_frame ? "NAVIGATION_BLOCKED " : "FRAME_BLOCKED ") + sanitize(target, 256));
      return S_OK;
    }
    if (main_frame) {
      set_engine_ready(false);  // a new document must announce ENGINE_MODE again
      if (opt_.log) diagnostic("NAVIGATION_STARTING " + sanitize(target, 256));
    }
    return S_OK;
  }

  HRESULT on_completed(ICoreWebView2NavigationCompletedEventArgs *args) {
    BOOL success = FALSE;
    args->get_IsSuccess(&success);
    if (success) { if (opt_.log) diagnostic("NAVIGATION_COMPLETED"); return S_OK; }
    COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
    args->get_WebErrorStatus(&status);
    diagnostic("NAVIGATION_FAILED status=" + std::to_string(static_cast<int>(status)));
    if (status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED) return S_OK;  // our own refusals and reload replacement
    if (opt_.selftest) apply(selftest_.on_navigation_failed());
    return S_OK;
  }

  HRESULT on_process_failed(ICoreWebView2ProcessFailedEventArgs *args) {
    COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED;
    args->get_ProcessFailedKind(&kind);
    const std::string name = process_failure_name(kind);
    diagnostic("PROCESS_FAILED " + name);
    const bool browser = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
    const bool render = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE;
    if (opt_.selftest && (browser || render)) { apply(selftest_.on_process_failed(name)); return S_OK; }
    if (browser) { finish(exit_webview_failed, "ENGINE_WINDOWS_FAILED process browser"); return S_OK; }
    if (render) {
      if (++render_recoveries_ > max_render_recoveries) { finish(exit_webview_failed, "ENGINE_WINDOWS_FAILED process render"); return S_OK; }
      set_engine_ready(false);
      web_->Reload();
    }
    return S_OK;
  }

  HRESULT on_key(ICoreWebView2AcceleratorKeyPressedEventArgs *args) {
    COREWEBVIEW2_KEY_EVENT_KIND kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP;
    UINT key = 0;
    args->get_KeyEventKind(&kind);
    args->get_VirtualKey(&key);
    if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
    const command_id command = accelerator(key, GetKeyState(VK_CONTROL) < 0, GetKeyState(VK_SHIFT) < 0, GetKeyState(VK_MENU) < 0);
    if (command == command_none) return S_OK;
    args->put_Handled(TRUE);
    PostMessageW(window_, WM_COMMAND, MAKEWPARAM(command, 1), 0);
    return S_OK;
  }

  static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    host *self = active_host;
    if (!self || window != self->window_ || !self->original_proc_) return DefWindowProcW(window, message, wparam, lparam);
    return self->handle(window, message, wparam, lparam);
  }

  LRESULT handle(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    const WNDPROC original = original_proc_;
    switch (message) {
    case WM_COMMAND:
      if (lparam == 0 && (HIWORD(wparam) == 0 || HIWORD(wparam) == 1)) {
        if (LOWORD(wparam) == command_change_colour) { send_command(topic_change_colour); return 0; }
        if (LOWORD(wparam) == command_quit) { PostMessageW(window, WM_CLOSE, 0, 0); return 0; }
      }
      break;
    case WM_TIMER:
      if (wparam == timer_timeout) { KillTimer(window, timer_timeout); apply(selftest_.on_timeout()); return 0; }
      if (wparam == timer_menu) { KillTimer(window, timer_menu); press_menu(); return 0; }
      if (wparam == timer_minimised) { KillTimer(window, timer_minimised); lifecycle_minimised(); return 0; }
      if (wparam == timer_restored) { KillTimer(window, timer_restored); lifecycle_restored(); return 0; }
      break;
    case WM_CLOSE:
      if (opt_.selftest) apply(selftest_.on_closed());
      break;
    case WM_SIZE: {
      const LRESULT result = CallWindowProcW(original, window, message, wparam, lparam);
      // Hidden controllers stop rendering and timers throttle while minimised.
      if (controller_ && !closing_) controller_->put_IsVisible(wparam == SIZE_MINIMIZED ? FALSE : TRUE);
      if (opt_.log && (wparam == SIZE_MINIMIZED || wparam == SIZE_RESTORED || wparam == SIZE_MAXIMIZED))
        diagnostic(std::string("WINDOW_STATE ") + (wparam == SIZE_MINIMIZED ? "minimized" : wparam == SIZE_MAXIMIZED ? "maximized" : "restored"));
      return result;
    }
    case WM_MOVE:
    case WM_MOVING: {
      const LRESULT result = CallWindowProcW(original, window, message, wparam, lparam);
      if (controller_ && !closing_) controller_->NotifyParentWindowPositionChanged();
      return result;
    }
    case 0x02E0 /* WM_DPICHANGED */: {
      RECT client{};
      GetClientRect(window, &client);
      const int previous = dpi_, next = HIWORD(wparam);
      const LRESULT result = CallWindowProcW(original, window, message, wparam, lparam);
      // webview/webview sizes the frame without the menu bar; restore the
      // DPI-scaled client area so the page keeps its logical size.
      if (previous > 0 && next > 0 && !IsIconic(window)) fit_client({scale(client.right - client.left, next, previous), scale(client.bottom - client.top, next, previous)});
      dpi_ = next;
      log_dpi("changed");
      return result;
    }
    default:
      break;
    }
    return CallWindowProcW(original, window, message, wparam, lparam);
  }

  // ---------------------------------------------------------------- actions

  void apply(const step &next) {
    switch (next.next) {
    case action::none: return;
    case action::press_menu: SetTimer(window_, timer_menu, 250, nullptr); return;
    case action::run_probe: run_probe(); return;
    case action::lifecycle: ShowWindow(window_, SW_MINIMIZE); SetTimer(window_, timer_minimised, 300, nullptr); return;
    case action::reload: set_engine_ready(false); web_->Reload(); return;
    case action::pass:
    case action::fail: finish(next.code, next.marker); return;
    }
  }

  // Exercises the real menu command path: the item must be enabled, and the
  // posted WM_COMMAND is identical to a menu click.
  void press_menu() {
    const UINT state = GetMenuState(engine_menu_, command_change_colour, MF_BYCOMMAND);
    if (state == static_cast<UINT>(-1) || (state & (MF_GRAYED | MF_DISABLED))) { apply(selftest_.on_menu_unavailable()); return; }
    emit("MENU_PRESSED change-colour");
    PostMessageW(window_, WM_COMMAND, MAKEWPARAM(command_change_colour, 0), 0);
  }

  void lifecycle_minimised() {
    BOOL visible = TRUE;
    controller_->get_IsVisible(&visible);
    hidden_when_minimised_ = !visible && IsIconic(window_);
    ShowWindow(window_, SW_RESTORE);
    SetTimer(window_, timer_restored, 300, nullptr);
  }

  void lifecycle_restored() {
    BOOL visible = FALSE;
    controller_->get_IsVisible(&visible);
    emit(std::string("LIFECYCLE minimise=") + (hidden_when_minimised_ ? "hidden" : "visible") + " restore=" + (visible ? "visible" : "hidden"));
    apply(selftest_.on_lifecycle(hidden_when_minimised_, visible && !IsIconic(window_)));
  }

  void run_probe() {
    const unsigned before = blocked_;
    const double raster = rasterization_scale();
    auto done = make_callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
        IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, [this, before, raster](HRESULT hr, LPCWSTR json) {
          if (closing_) return S_OK;
          if (FAILED(hr) || !json) { apply(selftest_.on_probe({false, "devtools " + hresult(hr)})); return S_OK; }
          const std::string response = narrow_string(json);
          emit("PROBE " + sanitize(response));
          apply(selftest_.on_probe(check_probe(response, opt_.isolated, raster, blocked_ - before)));
          return S_OK;
        });
    const std::wstring params = widen_string(probe_params());
    if (FAILED(web_->CallDevToolsProtocolMethod(L"Runtime.evaluate", params.c_str(), done.get()))) apply(selftest_.on_probe({false, "devtools unavailable"}));
  }

  void send_command(uint32_t topic) {
    if (!engine_ready_) { emit("COMMAND_IGNORED engine-not-ready"); return; }
    if (!outbound_.allow(GetTickCount64())) { diagnostic("COMMAND_DROPPED rate"); return; }
    browser_->eval(command_script(topic));
    emit("COMMAND topic=" + std::to_string(topic));
  }

  void set_engine_ready(bool ready) {
    engine_ready_ = ready;
    if (engine_menu_ && !closing_) {
      EnableMenuItem(engine_menu_, command_change_colour, MF_BYCOMMAND | (ready ? MF_ENABLED : MF_GRAYED));
      DrawMenuBar(window_);
    }
  }

  bool source_is_local() const {
    co_string source;
    return SUCCEEDED(web_->get_Source(source.put())) && is_local_document(source.str());
  }

  double rasterization_scale() const {
    double value = 0;
    if (auto controller3 = controller_.query<ICoreWebView2Controller3>(IID_ICoreWebView2Controller3)) controller3->get_RasterizationScale(&value);
    return value;
  }

  void log_dpi(const char *why) {
    char text[96];
    std::snprintf(text, sizeof text, "WINDOWS_DPI %s dpi=%d dpr=%.3f rasterization=%.3f", why, dpi_, device_pixel_ratio(dpi_), rasterization_scale());
    emit(text);
  }

  void fit_client(size2 client) {
    RECT window{}, current{};
    if (!GetWindowRect(window_, &window) || !GetClientRect(window_, &current)) return;
    const size2 frame = frame_for_client(client, {window.right - window.left, window.bottom - window.top}, {current.right - current.left, current.bottom - current.top});
    SetWindowPos(window_, nullptr, 0, 0, frame.width, frame.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE);
  }

  void finish(int code, const std::string &marker) {
    if (finished_) return;
    finished_ = true;
    exit_code_ = code;
    emit(marker + " exit=" + std::to_string(code) + " (" + exit_name(code) + ")");
    if (browser_) browser_->terminate();
  }

  // ---------------------------------------------------------------- teardown

  // Unregisters every handler before the webview releases its controller, so
  // no callback can reach a host that is being destroyed.
  void teardown() {
    if (torn_down_) return;
    torn_down_ = true;
    closing_ = true;
    if (window_ && IsWindow(window_)) {
      for (UINT_PTR timer : {timer_timeout, timer_menu, timer_minimised, timer_restored}) KillTimer(window_, timer);
      if (original_proc_) SetWindowLongPtrW(window_, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(original_proc_));
    }
    for (auto &entry : receivers_) entry.first->remove_DevToolsProtocolEventReceived(entry.second);
    receivers_.clear();
    if (web_) {
      if (request_registered_) web_->remove_WebResourceRequested(request_token_);
      if (navigation_registered_) web_->remove_NavigationStarting(navigation_token_);
      if (frame_registered_) web_->remove_FrameNavigationStarting(frame_token_);
      if (completed_registered_) web_->remove_NavigationCompleted(completed_token_);
      if (popup_registered_) web_->remove_NewWindowRequested(popup_token_);
      if (process_registered_) web_->remove_ProcessFailed(process_token_);
      if (download_registered_) if (auto web4 = web_.query<ICoreWebView2_4>(IID_ICoreWebView2_4)) web4->remove_DownloadStarting(download_token_);
    }
    if (controller_) {
      if (key_registered_) controller_->remove_AcceleratorKeyPressed(key_token_);
      if (scale_registered_) if (auto controller3 = controller_.query<ICoreWebView2Controller3>(IID_ICoreWebView2Controller3)) controller3->remove_RasterizationScaleChanged(scale_token_);
      controller_->Close();
    }
    environment_.reset();
    web_.reset();
    controller_.reset();
    if (!menu_attached_) {
      if (engine_menu_) DestroyMenu(engine_menu_);
      if (menu_bar_) DestroyMenu(menu_bar_);
    }
    engine_menu_ = menu_bar_ = nullptr;
    browser_.reset();  // destroys the window (and attached menu) if it still exists
    window_ = nullptr;
    if (active_host == this) active_host = nullptr;
  }

  options opt_;
  selftest selftest_;
  asset_index assets_;
  std::unique_ptr<webview::webview> browser_;
  HWND window_ = nullptr;
  WNDPROC original_proc_ = nullptr;
  HMENU menu_bar_ = nullptr, engine_menu_ = nullptr;
  bool menu_attached_ = false;
  com_ptr<ICoreWebView2Controller> controller_;
  com_ptr<ICoreWebView2> web_;
  com_ptr<ICoreWebView2Environment> environment_;
  std::vector<std::pair<com_ptr<ICoreWebView2DevToolsProtocolEventReceiver>, EventRegistrationToken>> receivers_;
  EventRegistrationToken request_token_{}, navigation_token_{}, frame_token_{}, completed_token_{}, popup_token_{}, process_token_{}, download_token_{}, key_token_{}, scale_token_{};
  bool request_registered_ = false, navigation_registered_ = false, frame_registered_ = false, completed_registered_ = false, popup_registered_ = false,
       process_registered_ = false, download_registered_ = false, key_registered_ = false, scale_registered_ = false;
  rate_limiter inbound_, outbound_;
  unsigned blocked_ = 0;
  int dpi_ = 96;
  int render_recoveries_ = 0;
  int exit_code_ = exit_ok;
  bool engine_ready_ = false, hidden_when_minimised_ = false, finished_ = false, closing_ = false, torn_down_ = false;
};

}  // namespace

int main(int argc, char **argv) {
  SetConsoleOutputCP(CP_UTF8);
  options opt;
  std::string error;
  if (!parse_options(std::vector<std::string>(argv + 1, argv + argc), opt, error)) {
    std::cerr << error << "\n" << usage() << std::endl;
    return exit_config;
  }
  try {
    host app(opt);
    return app.run();
  } catch (const std::exception &failure) {
    emit(std::string("ENGINE_WINDOWS_FAILED internal ") + sanitize(failure.what(), 256));
  } catch (...) {
    emit("ENGINE_WINDOWS_FAILED internal");
  }
  return exit_internal;
}

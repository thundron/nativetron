#include "webview/webview.h"
#include "../../ipc/engine.generated.h"
#include <filesystem>
#include <iostream>
#include <string>

static webview::webview *view;
static WNDPROC original_proc;
static bool selftest;
static int test_result = 2;

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_COMMAND && LOWORD(wparam) == 1) {
    view->eval("window.__nt_engine_receive(\"" + nt_engine::base64(nt_engine::command(1)) + "\")");
    return 0;
  }
  if (message == WM_TIMER && wparam == 1) { std::cerr << "ENGINE_WINDOWS_TIMEOUT\n"; view->terminate(); return 0; }
  return CallWindowProcW(original_proc, window, message, wparam, lparam);
}

class OfflineRequests final : public ICoreWebView2WebResourceRequestedEventHandler {
  ULONG refs = 1;
  ICoreWebView2Environment *environment;
public:
  explicit OfflineRequests(ICoreWebView2Environment *env) : environment(env) { environment->AddRef(); }
  ~OfflineRequests() { environment->Release(); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **out) override {
    if (IsEqualIID(iid, __uuidof(IUnknown)) || IsEqualIID(iid, IID_ICoreWebView2WebResourceRequestedEventHandler)) { *out = this; AddRef(); return S_OK; }
    *out = nullptr; return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { ULONG count = --refs; if (!count) delete this; return count; }
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 *, ICoreWebView2WebResourceRequestedEventArgs *args) override {
    ICoreWebView2WebResourceRequest *request = nullptr;
    if (FAILED(args->get_Request(&request))) return E_FAIL;
    LPWSTR uri = nullptr;
    request->get_Uri(&uri); request->Release();
    const bool local = uri && std::wstring(uri).rfind(L"https://nativetron.local/", 0) == 0;
    CoTaskMemFree(uri);
    if (!local) {
      ICoreWebView2WebResourceResponse *response = nullptr;
      if (SUCCEEDED(environment->CreateWebResourceResponse(nullptr, 403, L"Offline", L"Content-Type: text/plain", &response))) {
        args->put_Response(response); response->Release();
      }
    }
    return S_OK;
  }
};

int main(int argc, char **argv) {
  try {
    selftest = argc > 1 && std::string(argv[1]) == "--selftest";
    wchar_t executable[MAX_PATH];
    if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) return 1;
    const auto assets = std::filesystem::path(executable).parent_path() / L"engine-assets";
    if (!std::filesystem::is_directory(assets)) { std::cerr << "engine-assets directory missing\n"; return 1; }
    webview::webview browser(false, nullptr);
    view = &browser;
    browser.set_title("nativetron GPU engine"); browser.set_size(900, 700, WEBVIEW_HINT_NONE);
    auto controller_result = browser.browser_controller();
    if (!controller_result.ok()) return 1;
    auto *controller = static_cast<ICoreWebView2Controller *>(controller_result.value());
    ICoreWebView2 *web = nullptr; controller->get_CoreWebView2(&web);
    ICoreWebView2_3 *mapping = nullptr;
    if (FAILED(web->QueryInterface(IID_ICoreWebView2_3, reinterpret_cast<void **>(&mapping)))) { web->Release(); return 1; }
    HRESULT mapped = mapping->SetVirtualHostNameToFolderMapping(L"nativetron.local", assets.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    mapping->Release();
    if (FAILED(mapped)) { web->Release(); return 1; }
    ICoreWebView2_2 *second = nullptr;
    ICoreWebView2Environment *environment = nullptr;
    if (FAILED(web->QueryInterface(IID_ICoreWebView2_2, reinterpret_cast<void **>(&second)))) { web->Release(); return 1; }
    second->get_Environment(&environment); second->Release();
    if (!environment) { web->Release(); return 1; }
    auto *offline = new OfflineRequests(environment); environment->Release();
    EventRegistrationToken token;
    web->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    web->add_WebResourceRequested(offline, &token); offline->Release(); web->Release();
    HWND window = static_cast<HWND>(browser.window().value());
    HMENU menu = CreateMenu(), engine = CreatePopupMenu();
    AppendMenuW(engine, MF_STRING, 1, L"Change clear colour"); AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(engine), L"Engine"); SetMenu(window, menu);
    original_proc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(window_proc)));
    browser.bind("__nt_ipc", [window](std::string request) -> std::string {
      static ULONGLONG window_start = 0;
      static size_t messages = 0;
      const auto now = GetTickCount64();
      if (now - window_start >= 1000) { window_start = now; messages = 0; }
      if (++messages > nt_engine::max_rate || request.size() > 90000) return "";
      const auto envelope = webview::detail::json_parse(request, "", 0);
      const auto encoded = webview::detail::json_parse(envelope, "frame", 0);
      if (envelope != nt_engine::envelope(encoded) || request != "[" + webview::detail::json_escape(envelope) + "]") return "";
      const auto bytes = nt_engine::from_base64(encoded);
      if (!nt_engine::from_engine_to_native(bytes)) return "";
      const std::string report(bytes.begin() + nt_engine::header_bytes, bytes.end());
      std::cout << report << std::endl;
      if (selftest && report == "GPU_READBACK_OK 4096") PostMessageW(window, WM_COMMAND, 1, 0);
      if (selftest && report == "GPU_COLOUR_CHANGED") { std::cout << "ENGINE_WINDOWS_OK" << std::endl; test_result = 0; view->terminate(); }
      return "";
    });
    if (selftest) SetTimer(window, 1, 15000, nullptr);
    browser.navigate("https://nativetron.local/engine/page.html"); browser.run();
    KillTimer(window, 1);
    return selftest ? test_result : 0;
  } catch (const std::exception &error) { std::cerr << error.what() << std::endl; return 1; }
}

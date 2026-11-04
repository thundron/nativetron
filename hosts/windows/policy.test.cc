// Native (build-machine) tests for the portable WebView2 host policy.
// Run through hosts/windows/verify.test.mjs or hosts/windows/build.sh --check.
#include "policy.h"
#include <cstdio>
#include <cstring>

using namespace nt_windows;
static int failures = 0, checks = 0;
#define CHECK(condition)                                                        \
  do {                                                                          \
    checks++;                                                                   \
    if (!(condition)) { failures++; std::fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #condition); } \
  } while (0)

static std::string url(const std::string &path) { return std::string(origin) + path; }

static std::string ipc(const std::vector<uint8_t> &frame) {
  return "[" + webview::detail::json_escape(nt_engine::envelope(nt_engine::base64(frame))) + "]";
}

static std::vector<uint8_t> report_frame(const std::string &text, uint8_t source = 2, uint8_t target = 0) {
  std::vector<uint8_t> bytes(nt_engine::header_bytes);
  bytes[0] = 1; bytes[1] = 5; bytes[2] = source; bytes[3] = target;
  const uint32_t length = static_cast<uint32_t>(text.size());
  for (int i = 0; i < 4; i++) bytes[12 + i] = static_cast<uint8_t>(length >> (8 * i));
  bytes.insert(bytes.end(), text.begin(), text.end());
  return bytes;
}

static void test_options() {
  options o; std::string error;
  CHECK(parse_options({}, o, error) && !o.selftest && o.isolated && !o.log && o.timeout_ms == default_timeout_ms);
  CHECK(parse_options({"--selftest"}, o, error) && o.selftest && !o.lifecycle && o.log);
  CHECK(parse_options({"--selftest=lifecycle", "--timeout-ms=30000", "--no-isolation"}, o, error) && o.lifecycle && o.timeout_ms == 30000 && !o.isolated);
  CHECK(!parse_options({"--timeout-ms=999", "--selftest"}, o, error));
  CHECK(!parse_options({"--timeout-ms=600001", "--selftest"}, o, error));
  CHECK(!parse_options({"--timeout-ms=", "--selftest"}, o, error));
  CHECK(!parse_options({"--timeout-ms=1e4", "--selftest"}, o, error));
  CHECK(!parse_options({"--timeout-ms=5000"}, o, error));
  CHECK(!parse_options({"--selftest", "--selftest"}, o, error));
  CHECK(!parse_options({"--selftest", "--selftest=lifecycle"}, o, error));
  CHECK(!parse_options({"--bogus"}, o, error) && error.find("--bogus") != std::string::npos);
  CHECK(!parse_options({"selftest"}, o, error));
}

static void test_classify() {
  auto local = [](const std::string &uri, const std::string &path) {
    const auto r = classify(uri);
    return r.kind == request_class::local && r.path == path;
  };
  CHECK(local(url("/"), entry));
  CHECK(local(url("/engine/page.html"), "engine/page.html"));
  CHECK(local(url("/engine/page.html?main"), "engine/page.html"));
  CHECK(local(url("/engine/page.html#x"), "engine/page.html"));
  CHECK(local(url("/engine/.scriptc/ui.wasm"), "engine/.scriptc/ui.wasm"));
  CHECK(local(url("/engine/p%61ge.html"), "engine/page.html"));
  for (const char *bad : {"/engine/../secret", "/engine/./page.html", "/engine//page.html", "/engine/", "/..", "/.",
                          "/engine/%2e%2e/x", "/engine%2fpage.html", "/engine%2Fpage.html", "/engine/%5cpage.html",
                          "/engine\\page.html", "/engine/page.html%00", "/engine/page.html%", "/engine/page.html%4",
                          "/engine/page.html%zz", "/C:/Windows/win.ini", "/engine/page.html:stream", "/engine/page.html.",
                          "/engine/page.html%2e", "/engine/ page.html", "/engine/p\xc3\xa4ge.html", "/engine/%c3%a4.html",
                          "/engine/page.html%0a"}) {
    CHECK(classify(url(bad)).kind == request_class::malformed);
  }
  CHECK(classify(url("/" + std::string(max_path_bytes + 1, 'a'))).kind == request_class::malformed);
  for (const char *external : {"https://example.com/", "http://nativetron.localhost/engine/page.html",
                               "https://nativetron.localhost.evil.com/engine/page.html", "https://nativetron.localhost:8443/engine/page.html",
                               "https://nativetron.localhost", "https://user@nativetron.localhost/", "file:///C:/Windows/win.ini",
                               "ws://nativetron.localhost/", "data:text/html,hi", "https://NATIVETRON.localhost/", "about:blank", ""}) {
    CHECK(classify(external).kind == request_class::external);
  }
  CHECK(is_local_document(url("/engine/page.html")));
  CHECK(!is_local_document("https://example.com/engine/page.html"));
}

static void test_mime_and_headers() {
  CHECK(mime_for("engine/page.html") == "text/html; charset=utf-8");
  CHECK(mime_for("engine/host.js") == "text/javascript; charset=utf-8");
  CHECK(mime_for("engine/.scriptc/ui.mjs") == "text/javascript; charset=utf-8");
  CHECK(mime_for("engine/.scriptc/ui.wasm") == "application/wasm");
  CHECK(mime_for("x/UI.WASM") == "application/wasm");
  CHECK(mime_for("a/b.json") == "application/json");
  CHECK(mime_for("a/b.wgsl") == "text/plain; charset=utf-8");
  CHECK(mime_for("a/b.png") == "image/png");
  CHECK(mime_for("a/b.exe").empty());
  CHECK(mime_for("a/b.dll").empty());
  CHECK(mime_for("a/noext").empty());
  CHECK(mime_for(".scriptc/noext").empty());

  const std::set<std::string> allow{"engine/page.html", "engine/.scriptc/ui.wasm", "engine/notes.bin"};
  auto p = plan_response("GET", url("/"), allow);
  CHECK(p.status == 200 && p.body && p.mime == "text/html; charset=utf-8");
  p = plan_response("HEAD", url("/engine/.scriptc/ui.wasm"), allow);
  CHECK(p.status == 200 && !p.body && p.mime == "application/wasm");
  CHECK(plan_response("POST", url("/engine/page.html"), allow).status == 405);
  CHECK(plan_response("OPTIONS", url("/engine/page.html"), allow).status == 405);
  CHECK(plan_response("GET", url("/engine/host.js"), allow).status == 404);
  CHECK(plan_response("GET", url("/engine/notes.bin"), allow).status == 404);  // allowlisted name, unserved type
  CHECK(plan_response("GET", url("/engine/../engine/page.html"), allow).status == 400);
  CHECK(plan_response("GET", "https://example.com/", allow).status == 403);
  CHECK(!plan_response("GET", "https://example.com/", allow).body);

  const auto isolated = response_headers(plan_response("GET", url("/"), allow), true);
  CHECK(isolated.find("Content-Type: text/html; charset=utf-8\r\n") == 0);
  CHECK(isolated.find("Cross-Origin-Opener-Policy: same-origin") != std::string::npos);
  CHECK(isolated.find("Cross-Origin-Embedder-Policy: require-corp") != std::string::npos);
  CHECK(isolated.find("Cross-Origin-Resource-Policy: same-origin") != std::string::npos);
  CHECK(isolated.find("X-Content-Type-Options: nosniff") != std::string::npos);
  CHECK(isolated.find("Cache-Control: no-store") != std::string::npos);
  CHECK(isolated.find("Access-Control-Allow-Origin") == std::string::npos);
  CHECK(isolated.find("Content-Security-Policy: connect-src 'self';") != std::string::npos);
  CHECK(isolated.find("script-src") == std::string::npos && isolated.find("default-src") == std::string::npos);
  CHECK(isolated.find("\n\r\n") == std::string::npos && isolated.back() != '\n');
  const auto plain = response_headers(plan_response("GET", url("/"), allow), false);
  CHECK(plain.find("Cross-Origin-Opener-Policy") == std::string::npos && plain.find("Cross-Origin-Embedder-Policy") == std::string::npos);
  CHECK(response_headers(plan_response("POST", url("/"), allow), true).find("Allow: GET, HEAD") != std::string::npos);

  CHECK(valid_asset_key("engine/.scriptc/ui.wasm"));
  CHECK(!valid_asset_key("engine\\page.html"));
  CHECK(!valid_asset_key("/engine/page.html"));
  CHECK(!valid_asset_key("engine/page.html/"));
}

static void test_ipc() {
  std::vector<uint8_t> bytes;
  CHECK(decode_ipc_request(ipc(report_frame("GPU_READBACK_OK 4096")), bytes) && frame_payload(bytes) == "GPU_READBACK_OK 4096");
  CHECK(decode_ipc_request(ipc(report_frame("")), bytes) && frame_payload(bytes).empty());
  CHECK(!decode_ipc_request(ipc(report_frame("x", 1, 0)), bytes) && bytes.empty());   // UI → native is not routed here
  CHECK(!decode_ipc_request(ipc(report_frame("x", 2, 1)), bytes));                    // engine → UI
  auto truncated = report_frame("abc"); truncated.pop_back();
  CHECK(!decode_ipc_request(ipc(truncated), bytes));
  auto version = report_frame("abc"); version[0] = 2;
  CHECK(!decode_ipc_request(ipc(version), bytes));
  const std::string good = ipc(report_frame("ok"));
  CHECK(!decode_ipc_request(good.substr(0, good.size() - 1), bytes));
  CHECK(!decode_ipc_request("[" + good.substr(1, good.size() - 2) + ",1]", bytes));
  CHECK(!decode_ipc_request("[\"{\\\"ntEngine\\\":2,\\\"frame\\\":\\\"AQUCAAAAAAAAAAAAAAAAAA==\\\"}\"]", bytes));
  CHECK(!decode_ipc_request("[\"{\\\"frame\\\":\\\"AQUCAAAAAAAAAAAAAAAAAA==\\\",\\\"ntEngine\\\":1}\"]", bytes));
  CHECK(!decode_ipc_request("[{\"ntEngine\":1,\"frame\":\"AQUCAAAAAAAAAAAAAAAAAA==\"}]", bytes));
  CHECK(decode_ipc_request("[\"{\\\"ntEngine\\\":1,\\\"frame\\\":\\\"AQUCAAAAAAAAAAAAAAAAAA==\\\"}\"]", bytes));
  CHECK(!decode_ipc_request("[\"{\\\"ntEngine\\\":1,\\\"frame\\\":\\\"AQUCAAAAAAAAAAAAAAAAAA=\\\"}\"]", bytes));
  CHECK(!decode_ipc_request(std::string(max_ipc_request_bytes + 1, '['), bytes));
  CHECK(!decode_ipc_request("", bytes) && !decode_ipc_request("[]", bytes));
  CHECK(decode_ipc_request(ipc(report_frame(std::string(nt_engine::max_payload, 'x'))), bytes));
  CHECK(!decode_ipc_request(ipc(report_frame(std::string(nt_engine::max_payload + 1, 'x'))), bytes));

  const auto script = command_script(topic_change_colour);
  CHECK(script == "window.__nt_engine_receive&&window.__nt_engine_receive(\"AQEAAgAAAAABAAAAAAAAAA==\")");
  const auto command = nt_engine::command(topic_change_colour);
  CHECK(command.size() == nt_engine::header_bytes && command[0] == 1 && command[1] == 1 && command[2] == 0 && command[3] == 2);
  CHECK(nt_engine::read_u32(command, 4) == 0 && nt_engine::read_u32(command, 8) == 1 && nt_engine::read_u32(command, 12) == 0);

  CHECK(sanitize("REPORT\nENGINE_WINDOWS_OK\r") == "REPORT?ENGINE_WINDOWS_OK?");
  CHECK(sanitize(std::string(10, 'a'), 4) == "aaaa...");
  CHECK(sanitize(std::string("a\0b", 3)) == "a?b");

  rate_limiter limit(3);
  CHECK(limit.allow(5000) && limit.allow(5001) && limit.allow(5999) && !limit.allow(5999));
  CHECK(limit.allow(6000));
  rate_limiter engine_rate;
  size_t accepted = 0;
  for (int i = 0; i < 100; i++) accepted += engine_rate.allow(100) ? 1 : 0;
  CHECK(accepted == nt_engine::max_rate);
}

static void test_menu_dpi() {
  CHECK(accelerator('K', true, false, false) == command_change_colour);
  CHECK(accelerator('Q', true, false, false) == command_quit);
  CHECK(accelerator('K', false, false, false) == command_none);
  CHECK(accelerator('K', true, true, false) == command_none);
  CHECK(accelerator('K', true, false, true) == command_none);
  CHECK(accelerator('R', true, false, false) == command_none);
  CHECK(engine_menu[0].id == command_change_colour && std::strstr(engine_menu[0].label, "Ctrl+K"));
  CHECK(engine_menu[1].label == nullptr && engine_menu[2].id == command_quit);

  CHECK(scale(900, 96, 96) == 900 && scale(900, 144, 96) == 1350 && scale(700, 120, 96) == 875);
  CHECK(scale(1350, 96, 144) == 900 && scale(875, 96, 120) == 700 && scale(5, 96, 0) == 5);
  CHECK(scale(901, 144, 96) == 1352);  // 1351.5 rounds half away from zero
  CHECK(device_pixel_ratio(96) == 1.0 && device_pixel_ratio(144) == 1.5 && device_pixel_ratio(0) == 1.0);
  const auto frame = frame_for_client({900, 700}, {916, 759}, {900, 681});
  CHECK(frame.width == 916 && frame.height == 778);
}

static std::string probe_result(const std::string &value) {
  return "{\"result\":{\"type\":\"string\",\"value\":" + webview::detail::json_escape(value) + "}}";
}

static std::string probe_value(bool isolated_headers, bool isolated_page, const char *wasm_type = "application/wasm", const char *external = "blocked", const char *dpr = "1.5",
                               int connect = -1, const char *websocket = "blocked") {
  const std::string coop = isolated_headers ? "same-origin" : "", coep = isolated_headers ? "require-corp" : "";
  return std::string("{\"origin\":\"https://nativetron.localhost\",\"isolated\":") + (isolated_page ? "true" : "false") +
         ",\"dpr\":" + dpr + ",\"gpu\":true,\"worker\":true,\"offscreen\":true," +
         "\"wasm\":{\"status\":200,\"type\":\"" + wasm_type + "\",\"coop\":\"" + coop + "\",\"coep\":\"" + coep + "\",\"nosniff\":\"nosniff\"}," +
         "\"module\":{\"status\":200,\"type\":\"text/javascript; charset=utf-8\",\"coop\":\"" + coop + "\",\"coep\":\"" + coep + "\",\"nosniff\":\"nosniff\"}," +
         "\"missing\":404,\"malformed\":400,\"connect\":" + std::to_string(connect) + ",\"external\":\"" + external + "\",\"websocket\":\"" + websocket + "\"}";
}

static void test_probe() {
  CHECK(check_probe(probe_result(probe_value(true, true)), true, 1.5, 1).ok);
  CHECK(check_probe(probe_result(probe_value(false, false)), false, 1.5, 1).ok);
  CHECK(check_probe(probe_result(probe_value(true, true)), true, 0, 1).ok);  // scale unknown: DPR not compared
  CHECK(!check_probe(probe_result(probe_value(true, false)), true, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(false, false)), true, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true)), false, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true, "application/octet-stream")), true, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true, "application/wasm", "loaded")), true, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true)), true, 1.5, 0).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true, "application/wasm", "blocked", "1.25")), true, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true, "application/wasm", "blocked", "1.5", 200)), true, 1.5, 1).ok);
  CHECK(!check_probe(probe_result(probe_value(true, true, "application/wasm", "blocked", "1.5", -1, "open")), true, 1.5, 1).ok);
  CHECK(check_probe(probe_result(probe_value(true, true, "application/wasm", "blocked", "1.5", -1, "timeout")), true, 1.5, 1).ok);
  CHECK(!check_probe("{\"exceptionDetails\":{\"text\":\"x\"},\"result\":{}}", true, 1.5, 1).ok);
  CHECK(!check_probe("{}", true, 1.5, 1).ok);
  CHECK(probe_params().find("\"awaitPromise\":true") != std::string::npos);
  CHECK(webview::detail::json_parse(probe_params(), "expression", 0) == probe_expression());
}

static void test_selftest() {
  selftest basic(false);
  CHECK(basic.on_report("ENGINE_MODE worker").next == action::none);
  CHECK(basic.on_report("GPU_COLOUR_CHANGED").next == action::none);  // out of order: ignored
  CHECK(basic.on_report("GPU_READBACK_OK 4096").next == action::press_menu);
  CHECK(basic.on_report("GPU_READBACK_OK 4096").next == action::none);
  CHECK(basic.on_report("GPU_COLOUR_CHANGED").next == action::run_probe);
  auto done = basic.on_probe({true, ""});
  CHECK(done.next == action::pass && done.code == exit_ok && done.marker == "ENGINE_WINDOWS_OK");
  CHECK(basic.on_timeout().next == action::none && basic.on_closed().next == action::none);

  selftest life(true);
  life.on_report("GPU_READBACK_OK 4096");
  life.on_report("GPU_COLOUR_CHANGED");
  CHECK(life.on_probe({true, ""}).next == action::lifecycle);
  CHECK(life.on_lifecycle(true, true).next == action::reload);
  CHECK(life.on_report("GPU_READBACK_OK 4096").next == action::none);  // needs a fresh ENGINE_MODE first
  CHECK(life.on_report("ENGINE_MODE main").next == action::none);
  done = life.on_report("GPU_READBACK_OK 4096");
  CHECK(done.next == action::pass && done.code == exit_ok);

  selftest hidden(true);
  hidden.on_report("GPU_READBACK_OK 4096"); hidden.on_report("GPU_COLOUR_CHANGED"); hidden.on_probe({true, ""});
  CHECK(hidden.on_lifecycle(false, true).code == exit_policy_failed);

  selftest gpu(false);
  CHECK(gpu.on_report("GPU_UNAVAILABLE navigator.gpu unavailable").code == exit_gpu_unavailable);
  selftest engine(false);
  CHECK(engine.on_report("GPU_READBACK_FAILED").code == exit_engine_failed);
  selftest error(false);
  CHECK(error.on_report("GPU_ERROR device lost").code == exit_engine_failed);
  selftest policy(false);
  policy.on_report("GPU_READBACK_OK 4096"); policy.on_report("GPU_COLOUR_CHANGED");
  const auto failed = policy.on_probe({false, "wasm MIME"});
  CHECK(failed.code == exit_policy_failed && failed.marker == "ENGINE_WINDOWS_FAILED policy wasm MIME");
  selftest timeout(false);
  CHECK(timeout.on_timeout().code == exit_timeout);
  CHECK(timeout.on_report("GPU_READBACK_OK 4096").next == action::none);
  selftest closed(false);
  CHECK(closed.on_closed().code == exit_closed);
  selftest nav(false);
  CHECK(nav.on_navigation_failed().code == exit_webview_failed);
  selftest process(false);
  CHECK(process.on_process_failed("render").marker == "ENGINE_WINDOWS_FAILED process render");
  selftest menu(false);
  menu.on_report("GPU_READBACK_OK 4096");
  CHECK(menu.on_menu_unavailable().code == exit_policy_failed);

  CHECK(std::string(exit_name(exit_policy_failed)) == "policy-failed" && std::string(exit_name(42)) == "unknown");
}

// Extra arguments are packaged asset keys: every one must be servable.
static void test_packaged(int argc, char **argv) {
  std::set<std::string> keys;
  for (int i = 1; i < argc; i++) {
    const std::string key = argv[i];
    const bool servable = valid_asset_key(key) && !mime_for(key).empty();
    if (!servable) std::fprintf(stderr, "unservable packaged asset %s\n", argv[i]);
    CHECK(servable);
    keys.insert(key);
  }
  if (argc > 1) {
    CHECK(keys.count(entry) == 1);
    for (const auto &key : keys) CHECK(plan_response("GET", url("/" + key), keys).status == 200);
  }
}

int main(int argc, char **argv) {
  test_packaged(argc, argv);
  test_options();
  test_classify();
  test_mime_and_headers();
  test_ipc();
  test_menu_dpi();
  test_probe();
  test_selftest();
  std::printf("windows policy: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}

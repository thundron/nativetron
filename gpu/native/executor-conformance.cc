// ntgpu-executor-conformance: gpu/conformance.ts compiled natively by scriptc (library mode, conformance-profile.json)
// and driven exactly as gpu/conformance-host.js drives the wasm reactor, but against the native executor.
// Events are recorded, then delivered to the guest only after the current export returned (readback bytes first,
// then the event), never from inside gpuPresent. The run walks the phases of gpu/conformance-test.mjs and writes a
// JSON log ({"phase"}, {"event"}, {"report"} lines) that executor-conformance.test.mjs checks with the same rules.
//   ntgpu-executor-conformance [--log FILE] [--timeout-ms N]
#include "executor.h"
#include "executor-test.h"

#include <chrono>
#include <condition_variable>
#include <csetjmp>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

extern "C" {
typedef void (*NtconfSink)(void *ctx, const uint8_t *message, size_t length, uint64_t address);
void ntconf_init(void);
void ntconf_sink(NtconfSink sink, void *ctx);
int32_t ntconf_callback(const char *name, void (*fn)(void), void *ctx);
double ntconf_start(void);
double ntconf_step(double phase);
double ntconf_event(double type, double request_id, double handle, double status, double value, const uint8_t *text,
                    size_t length);
double ntconf_readback(double offset, const uint8_t *bytes, size_t length);
}

namespace {

struct Pending {
  std::string json;
  std::vector<uint8_t> data;
  bool has_data = false;
};

struct Host {
  NtGpuExecutor *executor = nullptr;
  std::deque<Pending> inbox;
  std::mutex mutex;
  std::condition_variable cv;
  uint64_t wakes = 0;
  FILE *log = nullptr;
  std::vector<std::string> reports;
  int presents = 0;
  bool in_export = false;
  std::jmp_buf *recover = nullptr;
};
Host host;

void log_line(const std::string &line) {
  std::fputs(line.c_str(), host.log);
  std::fputc('\n', host.log);
  std::fflush(host.log);
}

std::string escape(const std::string &text) {
  std::string out = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += static_cast<char>(c);
  }
  return out + "\"";
}

double field(const std::string &json, const char *name, double fallback = 0) {
  const std::string key = std::string("\"") + name + "\":";
  const size_t at = json.find(key);
  if (at == std::string::npos) return fallback;
  return std::strtod(json.c_str() + at + key.size(), nullptr);
}

void on_event(void *, const char *json, const uint8_t *data, size_t size) {
  Pending pending;
  pending.json = json;
  if (data) {
    pending.has_data = true;
    pending.data.assign(data, data + size);
  }
  log_line(std::string("{\"event\":") + json + "}");
  host.inbox.push_back(std::move(pending));
}
void on_frame(void *) {}
void on_wake(void *) {
  {
    std::lock_guard<std::mutex> lock(host.mutex);
    ++host.wakes;
  }
  host.cv.notify_all();
}

void present(void *, const uint8_t *batch, size_t batch_size, const uint8_t *uploads, size_t upload_size,
             const uint8_t *, size_t readback_size) {
  ++host.presents;
  // The readback span is described by its capacity only; the executor never writes guest memory.
  ntgpu_executor_submit(host.executor, batch, batch_size, uploads, upload_size, readback_size);
}
void report(void *, const uint8_t *text, size_t length) {
  const std::string line(reinterpret_cast<const char *>(text), length);
  host.reports.push_back(line);
  log_line("{\"report\":" + escape(line) + "}");
  std::fprintf(stderr, "report: %s\n", line.c_str());
}
void sink(void *, const uint8_t *message, size_t length, uint64_t) {
  std::string text(reinterpret_cast<const char *>(message), length);
  for (char &c : text) if (c == 0x1f || c == 0x01) c = ' ';
  log_line("{\"trap\":" + escape(text) + "}");
  std::fprintf(stderr, "guest trap: %s\n", text.c_str());
  if (host.recover) std::longjmp(*host.recover, 1);
  std::abort();
}

template <class Fn>
bool guest(Fn fn) {
  std::jmp_buf jb;
  host.recover = &jb;
  if (setjmp(jb) != 0) {
    host.recover = nullptr;
    return false;
  }
  fn();
  host.recover = nullptr;
  return true;
}

// Delivers recorded events after the export returned, as conformance-host.js does on a microtask.
bool deliver() {
  while (!host.inbox.empty()) {
    Pending event = std::move(host.inbox.front());
    host.inbox.pop_front();
    const double type = field(event.json, "type");
    const bool ok = guest([&] {
      if (event.has_data) ntconf_readback(field(event.json, "offset"), event.data.data(), event.data.size());
      const double value = type == 1 ? field(event.json, "featureBits") : 0;
      ntconf_event(type, field(event.json, "requestId"), field(event.json, "handle"), field(event.json, "status"), value,
                   reinterpret_cast<const uint8_t *>(event.json.data()), event.json.size());
    });
    if (!ok) return false;
  }
  return true;
}

// Runs until no event is queued and the executor has nothing pending; waits on the wake signal, never polls.
bool pump(long timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  for (;;) {
    if (!deliver()) return false;
    ntgpu_executor_process(host.executor);
    if (!host.inbox.empty()) continue;
    if (ntgpu_executor_pending(host.executor) == 0) return true;
    std::unique_lock<std::mutex> lock(host.mutex);
    const uint64_t seen = host.wakes;
    if (!host.cv.wait_until(lock, deadline, [&] { return host.wakes != seen; })) {
      lock.unlock();
      ntgpu_executor_process(host.executor);
      if (host.inbox.empty() && ntgpu_executor_pending(host.executor)) return false;
    }
  }
}

}  // namespace

int main(int argc, char **argv) {
  const char *log_path = "conformance-native.jsonl";
  long timeout = 20000;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!std::strcmp(argv[i], "--log")) log_path = argv[i + 1];
    else if (!std::strcmp(argv[i], "--timeout-ms")) timeout = std::atol(argv[i + 1]);
  }
  host.log = std::fopen(log_path, "w");
  if (!host.log) return 2;
  NtGpuExecutorOptions options = {};
  options.event = on_event;
  options.frame_requested = on_frame;
  options.wake = on_wake;
  options.width = 4;
  options.height = 4;
  options.pixel_ratio = 1;
  if (!ntgpu_executor_create(&options, &host.executor)) return 2;
  ntconf_sink(sink, nullptr);
  if (ntconf_callback("gpuPresent", reinterpret_cast<void (*)(void)>(present), nullptr) != 0 ||
      ntconf_callback("gpuReport", reinterpret_cast<void (*)(void)>(report), nullptr) != 0) {
    std::fprintf(stderr, "callback registration failed\n");
    return 2;
  }
  int status = 0;
  auto phase = [&](int number, const char *name) { log_line("{\"phase\":" + std::to_string(number) + ",\"name\":" + escape(name) + "}"); };
  phase(0, "start");
  if (!guest([] { ntconf_init(); ntconf_start(); }) || !pump(timeout)) status = 1;
  const char *names[] = {"", "render readback", "state rejections", "cancellations", "guest device destruction", "restart",
                         "external loss"};
  for (int step = 1; step <= 6 && status == 0; ++step) {
    phase(step, names[step]);
    if (!guest([&] { ntconf_step(step); })) { status = 1; break; }
    if (step == 6) ntgpu_executor_test_lose_device(host.executor);
    if (!pump(timeout)) { status = 1; break; }
  }
  phase(7, status == 0 ? "done" : "failed");
  log_line("{\"presents\":" + std::to_string(host.presents) + ",\"pending\":" +
           std::to_string(ntgpu_executor_pending(host.executor)) + ",\"live\":" +
           std::to_string(ntgpu_executor_test_live_handles(host.executor)) + "}");
  ntgpu_executor_destroy(host.executor);
  std::fclose(host.log);
  return status;
}

// ntgpu-executor-driver: a line protocol around the native executor for executor.test.mjs and the shader corpus
// run. It plays the embedding: event/frame callbacks only enqueue; the queue is written to stdout after the call
// that produced it returns; the wake callback (any thread) only signals a condition variable.
//
// stdin commands (one per line; binary payloads follow their line):
//   submit <commandBytes> <uploadBytes> <readbackCapacity>   then commandBytes + uploadBytes raw bytes
//   claim <commandBytes> <uploadClaim> <readbackClaim>       submit with arena sizes claimed but not backed (limits)
//   wait <timeoutMs>      process() whenever woken until pending()==0 (no polling here: blocks on the wake signal)
//   process | resize <w> <h> <dpr> | capture | lose | stats | sleep <ms> | quit
// Options: --width W --height H --dpr R (headless canvas size), --metal-layer (lease a window-less CAMetalLayer).
// stdout: {"event":{...},"bytes":N,"hash":"fnv1a32","data":"base64 (<=64 KiB)"} lines, {"frame":1} lines, then one
// result line per command ({"submit":rc,...}, {"wait":"idle"|"timeout",...}, ...).
#include "executor.h"
#include "executor-test.h"

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

extern "C" void *ntgpu_executor_driver_layer(uint32_t width, uint32_t height);
extern "C" void ntgpu_executor_driver_layer_release(void *layer);

namespace {

std::string base64(const uint8_t *data, size_t size) {
  static const char *table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  for (size_t i = 0; i < size; i += 3) {
    uint32_t v = static_cast<uint32_t>(data[i]) << 16;
    if (i + 1 < size) v |= static_cast<uint32_t>(data[i + 1]) << 8;
    if (i + 2 < size) v |= data[i + 2];
    out += table[(v >> 18) & 63];
    out += table[(v >> 12) & 63];
    out += i + 1 < size ? table[(v >> 6) & 63] : '=';
    out += i + 2 < size ? table[v & 63] : '=';
  }
  return out;
}

std::string fnv1a32(const uint8_t *data, size_t size) {
  uint32_t hash = 0x811c9dc5u;
  for (size_t i = 0; i < size; ++i) {
    hash ^= data[i];
    hash *= 0x01000193u;
  }
  char buffer[9];
  std::snprintf(buffer, sizeof buffer, "%08x", hash);
  return buffer;
}

struct Embedding {
  std::vector<std::string> queue;  // written after the executor call returns
  std::mutex mutex;
  std::condition_variable cv;
  uint64_t wakes = 0;
  uint64_t frames = 0;
};

void on_event(void *user, const char *json, const uint8_t *data, size_t size) {
  auto *e = static_cast<Embedding *>(user);
  std::string line = "{\"event\":";
  line += json;
  if (data) {
    line += ",\"bytes\":" + std::to_string(size) + ",\"hash\":\"" + fnv1a32(data, size) + "\"";
    if (size <= 65536) line += ",\"data\":\"" + base64(data, size) + "\"";
  }
  line += "}";
  e->queue.push_back(std::move(line));
}
void on_frame(void *user) {
  auto *e = static_cast<Embedding *>(user);
  ++e->frames;
  e->queue.push_back("{\"frame\":1}");
}
void on_wake(void *user) {
  auto *e = static_cast<Embedding *>(user);
  {
    std::lock_guard<std::mutex> lock(e->mutex);
    ++e->wakes;
  }
  e->cv.notify_all();
}

void flush(Embedding &e, const std::string &result) {
  for (const auto &line : e.queue) std::cout << line << '\n';
  e.queue.clear();
  std::cout << result << '\n';
  std::cout.flush();
}

bool read_exact(std::vector<uint8_t> &out, size_t size) {
  out.resize(size);
  size_t got = 0;
  while (got < size) {
    std::cin.read(reinterpret_cast<char *>(out.data() + got), static_cast<std::streamsize>(size - got));
    const std::streamsize n = std::cin.gcount();
    if (n <= 0) return false;
    got += static_cast<size_t>(n);
  }
  return true;
}

}  // namespace

int main(int argc, char **argv) {
  uint32_t width = 64, height = 64;
  double dpr = 1;
  bool layer = false;
  for (int i = 1; i < argc; ++i) {
    const bool value = i + 1 < argc;
    if (!std::strcmp(argv[i], "--metal-layer")) layer = true;
    else if (value && !std::strcmp(argv[i], "--width")) width = static_cast<uint32_t>(std::atoi(argv[++i]));
    else if (value && !std::strcmp(argv[i], "--height")) height = static_cast<uint32_t>(std::atoi(argv[++i]));
    else if (value && !std::strcmp(argv[i], "--dpr")) dpr = std::atof(argv[++i]);
  }
  std::ios::sync_with_stdio(false);
  Embedding embedding;
  NtGpuExecutorOptions options = {};
  options.user = &embedding;
  options.event = on_event;
  options.frame_requested = on_frame;
  options.wake = on_wake;
  options.width = width;
  options.height = height;
  options.pixel_ratio = dpr;
  // The embedding leases the layer to the executor until ntgpu_executor_destroy returns.
  options.metal_layer = layer ? ntgpu_executor_driver_layer(width, height) : nullptr;
  NtGpuExecutor *executor = nullptr;
  if (!ntgpu_executor_create(&options, &executor)) {
    std::cout << "{\"ready\":0}" << std::endl;
    return 2;
  }
  flush(embedding, "{\"ready\":1}");
  std::string line;
  std::vector<uint8_t> commands, uploads;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string command;
    in >> command;
    if (command == "submit" || command == "claim") {
      size_t command_size = 0, upload_size = 0, readback = 0;
      in >> command_size >> upload_size >> readback;
      if (!read_exact(commands, command_size)) break;
      int rc;
      if (command == "submit") {
        if (!read_exact(uploads, upload_size)) break;
        rc = ntgpu_executor_submit(executor, commands.data(), commands.size(), uploads.data(), upload_size, readback);
      } else {
        static uint8_t dummy[16];
        rc = ntgpu_executor_submit(executor, commands.data(), commands.size(), dummy, upload_size, readback);
      }
      flush(embedding, "{\"submit\":" + std::to_string(rc) + ",\"pending\":" +
                           std::to_string(ntgpu_executor_pending(executor)) + "}");
    } else if (command == "wait") {
      long timeout = 10000;
      in >> timeout;
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
      bool idle = false;
      uint64_t seen;
      {
        std::lock_guard<std::mutex> lock(embedding.mutex);
        seen = embedding.wakes;
      }
      for (;;) {
        ntgpu_executor_process(executor);
        for (const auto &queued : embedding.queue) std::cout << queued << '\n';
        embedding.queue.clear();
        if (ntgpu_executor_pending(executor) == 0) {
          idle = true;
          break;
        }
        std::unique_lock<std::mutex> lock(embedding.mutex);
        if (!embedding.cv.wait_until(lock, deadline, [&] { return embedding.wakes != seen; })) break;
        seen = embedding.wakes;
      }
      flush(embedding, std::string("{\"wait\":\"") + (idle ? "idle" : "timeout") + "\",\"pending\":" +
                           std::to_string(ntgpu_executor_pending(executor)) + ",\"wakes\":" + std::to_string(seen) + "}");
    } else if (command == "process") {
      ntgpu_executor_process(executor);
      flush(embedding, "{\"process\":1,\"pending\":" + std::to_string(ntgpu_executor_pending(executor)) + "}");
    } else if (command == "resize") {
      uint32_t w = 0, h = 0;
      double r = 1;
      in >> w >> h >> r;
      ntgpu_executor_resize(executor, w, h, r);
      flush(embedding, "{\"resize\":1}");
    } else if (command == "capture") {
      uint32_t w = 0, h = 0;
      std::vector<uint8_t> rgba(size_t(1) << 26);  // up to 4096x4096
      const int rc = ntgpu_executor_capture_rgba(executor, rgba.data(), rgba.size(), &w, &h);
      std::string result = "{\"capture\":" + std::to_string(rc) + ",\"width\":" + std::to_string(w) +
                           ",\"height\":" + std::to_string(h);
      if (rc) result += ",\"rgba\":\"" + base64(rgba.data(), static_cast<size_t>(w) * h * 4) + "\"";
      flush(embedding, result + "}");
    } else if (command == "lose") {
      const int rc = ntgpu_executor_test_lose_device(executor);
      flush(embedding, "{\"lose\":" + std::to_string(rc) + "}");
    } else if (command == "stats") {
      uint64_t wakes;
      {
        std::lock_guard<std::mutex> lock(embedding.mutex);
        wakes = embedding.wakes;
      }
      flush(embedding, "{\"polls\":" + std::to_string(ntgpu_executor_test_polls(executor)) + ",\"wakes\":" +
                           std::to_string(wakes) + ",\"frames\":" + std::to_string(embedding.frames) +
                           ",\"live\":" + std::to_string(ntgpu_executor_test_live_handles(executor)) +
                           ",\"pending\":" + std::to_string(ntgpu_executor_pending(executor)) + "}");
    } else if (command == "sleep") {
      long ms = 0;
      in >> ms;
      std::unique_lock<std::mutex> lock(embedding.mutex);
      embedding.cv.wait_for(lock, std::chrono::milliseconds(ms), [] { return false; });
      lock.unlock();
      flush(embedding, "{\"sleep\":1}");
    } else if (command == "quit") {
      break;
    } else if (!command.empty()) {
      flush(embedding, "{\"unknown\":1}");
    }
  }
  ntgpu_executor_destroy(executor);
  ntgpu_executor_driver_layer_release(options.metal_layer);
  flush(embedding, "{\"quit\":1}");
  return 0;
}

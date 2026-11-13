// Test driver for gpu/native-decoder.generated.h, run by gpu/native-decoder.test.mjs.
//   native-decoder-test trace <fixtures> <out>  decodes every fixture batch and writes a canonical trace
//   native-decoder-test meta <out>              writes the generated tables for comparison with ops.json
// Both visitor styles (template and VisitorAdapter behind the abstract Visitor) must produce the same trace.
#include "native-decoder.generated.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <set>
#include <string>
#include <vector>

namespace gpu = nativetron::gpu;

static_assert(gpu::handle_slot(gpu::make_handle(0xfffffu, 0xfffu)) == 0xfffffu, "slot");
static_assert(gpu::handle_generation(gpu::make_handle(5u, 0xfffu)) == 0xfffu, "generation");
static_assert(gpu::handle_value(gpu::make_handle(3u, 1u)) == (1u << gpu::kHandleSlotBits) + 3u, "handle");
static_assert(gpu::kHandleSlotBits + gpu::kHandleGenerationBits == 32u, "handle width");
static_assert(gpu::range_within(0xffffffffu, 0xffffffffu, 0x1fffffffeull) && !gpu::range_within(0xffffffffu, 1u, 0xffffffffull), "64-bit range");

namespace {

uint32_t fnv1a(const std::string& text) {
  uint32_t hash = 0x811c9dc5u;
  for (const char c : text) { hash ^= static_cast<uint8_t>(c); hash *= 0x01000193u; }
  return hash;
}
std::string hex32(uint32_t value) { char buffer[16]; std::snprintf(buffer, sizeof buffer, "%08x", value); return buffer; }
std::string hex_bytes(const std::string& bytes) {
  std::string out;
  for (const char c : bytes) { char buffer[4]; std::snprintf(buffer, sizeof buffer, "%02x", static_cast<unsigned>(static_cast<uint8_t>(c))); out += buffer; }
  return out;
}

std::string format(uint32_t value) { return std::to_string(value); }
std::string format(int32_t value) { return std::to_string(value); }
std::string format(bool value) { return value ? "1" : "0"; }
std::string format(gpu::Handle value) { return std::to_string(gpu::handle_value(value)); }
std::string format(double value) {
  if (std::isnan(value)) return "nan";
  uint64_t bits; std::memcpy(&bits, &value, sizeof bits);
  char buffer[24]; std::snprintf(buffer, sizeof buffer, "%016llx", static_cast<unsigned long long>(bits));
  return buffer;
}
std::string format(float value) { return format(static_cast<double>(value)); }
std::string format(const gpu::Str& value) {
  const std::string text = value.text();
  const bool exact = value.is_exact_text();
  std::string out = text.size() <= 64 ? hex_bytes(text) : "#" + std::to_string(text.size()) + ":" + hex32(fnv1a(text));
  if (exact != (text == std::string(value.bytes()))) out += "!exact-mismatch";
  return out;
}
template <class T> std::string format(const gpu::WireArray<T>& values) {
  std::string joined;
  for (uint32_t i = 0; i < values.size(); i++) { if (i) joined += ","; joined += format(values[i]); }
  if (values.size() <= 16) return "[" + joined + "]";
  return "[" + std::to_string(values.size()) + "#" + hex32(fnv1a(joined)) + "]";
}
std::string format(const gpu::UploadRange& value) { return std::to_string(value.offset) + ":" + std::to_string(value.length); }
std::string format(const gpu::ReadbackRange& value) { return std::to_string(value.offset) + ":" + std::to_string(value.length); }

struct Recorder {
  std::set<uint32_t> rejects;
  std::string trace;
  uint32_t calls = 0;

  template <class Op> bool on(const Op& op) {
    trace += "call ";
    trace += Op::kName;
    op.visit_fields([this](const char* name, const auto& value) { trace += " "; trace += name; trace += "="; trace += format(value); });
    trace += "\n";
    return rejects.count(calls++) == 0;
  }
  void on_skipped_request(const gpu::SkippedRequest& skipped) {
    trace += "skip " + std::to_string(skipped.request_id) + " " + std::to_string(static_cast<uint32_t>(skipped.completion)) + " " + format(skipped.handle) + "\n";
  }
  void on_error(const gpu::ErrorReport& report) {
    if (report.fatal) trace += "error fatal " + std::to_string(report.request_id) + " " + format(report.handle) + " " + report.message + "\n";
    else trace += "error reject " + std::to_string(report.request_id) + " " + format(report.handle) + "\n";
  }
};

uint32_t read_u32(const std::vector<uint8_t>& data, size_t& at) {
  if (at + 4 > data.size()) { std::fprintf(stderr, "bad fixture file\n"); std::exit(2); }
  const uint32_t value = gpu::wire::load_u32(data.data() + at);
  at += 4;
  return value;
}

// Checks that BatchResult agrees with what the visitor saw.
std::string check_result(const gpu::BatchResult& result, const std::string& trace) {
  const bool fatal = trace.find("error fatal") != std::string::npos;
  const bool rejected = trace.find("error reject") != std::string::npos;
  std::string out;
  if ((result.outcome == gpu::BatchOutcome::Fatal) != fatal) out += "!outcome-fatal ";
  if (result.rejected != rejected) out += "!rejected ";
  if (!fatal && (result.outcome == gpu::BatchOutcome::Rejected) != rejected) out += "!outcome-rejected ";
  if (fatal != (gpu::decode_error_message(result.error) != nullptr)) out += "!error ";
  return out;
}

int trace(const char* fixtures, const char* output) {
  std::ifstream in(fixtures, std::ios::binary);
  const std::vector<uint8_t> data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  size_t at = 0;
  if (read_u32(data, at) != 0x4647544eu) { std::fprintf(stderr, "bad fixture magic\n"); return 2; }
  const uint32_t count = read_u32(data, at);
  std::string out;
  for (uint32_t index = 0; index < count; index++) {
    Recorder direct;
    const uint32_t rejects = read_u32(data, at);
    for (uint32_t i = 0; i < rejects; i++) direct.rejects.insert(read_u32(data, at));
    const uint32_t length = read_u32(data, at);
    if (at + length > data.size()) { std::fprintf(stderr, "bad fixture length\n"); return 2; }
    // Offset by one byte so every multi-byte operand is misaligned.
    std::vector<uint8_t> storage(static_cast<size_t>(length) + 1);
    if (length) std::memcpy(storage.data() + 1, data.data() + at, length);
    at += length;
    Recorder erased;
    erased.rejects = direct.rejects;
    const gpu::BatchResult result = gpu::decode_batch(storage.data() + 1, length, direct);
    gpu::VisitorAdapter<Recorder> adapter(erased);
    gpu::Visitor& visitor = adapter;
    const gpu::BatchResult again = gpu::decode_batch(storage.data() + 1, length, visitor);
    out += "case " + std::to_string(index) + "\n" + direct.trace + "result " + (result.ok() ? "1" : "0") + "\n";
    if (erased.trace != direct.trace || again.ok() != result.ok() || again.operations != result.operations) out += "!adapter-mismatch\n";
    const std::string inconsistent = check_result(result, direct.trace);
    if (!inconsistent.empty()) out += inconsistent + "\n";
  }
  std::ofstream(output, std::ios::binary) << out;
  return 0;
}

int meta(const char* output) {
  std::string out;
  uint8_t header[gpu::kProtocolHeaderBytes];
  out += "header " + hex_bytes(std::string(reinterpret_cast<const char*>(header), gpu::write_protocol_header(header))) + "\n";
  out += "preflight " + std::to_string(static_cast<int>(gpu::preflight_batch(header, sizeof header))) + "\n";
  out += "limits " + std::to_string(gpu::kMaxBatchBytes) + " " + std::to_string(gpu::kMaxUploadBytes) + " " + std::to_string(gpu::kMaxReadbackBytes) + " " +
         std::to_string(gpu::kMaxArrayLength) + " " + std::to_string(gpu::kMaxPendingRequests) + " " + std::to_string(gpu::kOperationCount) + "\n";
  for (uint32_t code = 0; code < 256; code++) {
    const gpu::OperationInfo* info = gpu::operation_info(static_cast<uint8_t>(code));
    if (!info) continue;
    out += "op " + std::to_string(code) + " " + info->name + " " + format(info->control) + " " + format(info->request) + " " +
           std::to_string(static_cast<uint32_t>(info->completes)) + " " + (info->result ? info->result : "-") + "\n";
  }
  for (uint32_t code = 1; code < 16; code++) {
    const char* name = gpu::event_name(static_cast<gpu::Event>(code));
    if (name) out += "event " + std::to_string(code) + " " + name + " " + format(gpu::event_is_terminal(static_cast<gpu::Event>(code))) + "\n";
  }
  for (const auto& entry : gpu::kEnums) {
    out += std::string("enum ") + entry.name;
    for (uint32_t i = 0; i <= entry.size; i++) { const char* value = entry.at(i); out += " "; out += value ? value : "-"; }
    out += "\n";
  }
  for (const auto& entry : gpu::kRecords) {
    out += std::string("record ") + entry.name;
    for (uint32_t i = 0; i < entry.width; i++) { out += " "; out += entry.fields[i]; }
    out += "\n";
  }
  for (const char* feature : gpu::kFeatures) out += std::string("feature ") + feature + "\n";
  for (const auto& limit : gpu::kLimits) out += std::string("limit ") + (limit.name ? limit.name : "-") + " " + std::to_string(static_cast<int>(limit.limit_class)) + "\n";
  for (int error = 1; gpu::decode_error_message(static_cast<gpu::DecodeError>(error)); error++) out += std::string("failure ") + gpu::decode_error_message(static_cast<gpu::DecodeError>(error)) + "\n";
  out += "record-field " + std::to_string(gpu::record::DepthStencil::kWidth) + " " + std::to_string(gpu::record::DepthStencil::kDepthBiasClamp) + " " +
         std::to_string(gpu::constants::RECORD_DEPTH_STENCIL_WIDTH) + "\n";
  std::ofstream(output, std::ios::binary) << out;
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 4 && std::strcmp(argv[1], "trace") == 0) return trace(argv[2], argv[3]);
  if (argc == 3 && std::strcmp(argv[1], "meta") == 0) return meta(argv[2]);
  std::fprintf(stderr, "usage: native-decoder-test trace <fixtures> <out> | meta <out>\n");
  return 2;
}

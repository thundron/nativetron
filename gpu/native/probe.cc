// ntgpu-probe: capability report, WGSL module/pipeline validation, and GPU correctness proofs for the ntgpu facade.
// Output is one JSON document on stdout. Exit status: 0 pass, 1 a checked stage failed, 2 usage/environment error.
// GPU work here is correctness only; nothing is timed.
#include "ntgpu.h"

#include <webgpu/wgpu.h>  // only for naming implementation-specific features in reports

#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

// Implemented in probe-surface-darwin.mm.
extern "C" int ntgpu_probe_surface(NtGpuContext *ctx, std::string *report_json);
extern "C" const char *ntgpu_probe_format_name(uint32_t format);

namespace {

// ---------------------------------------------------------------------------------------------------------------
// JSON output
std::string Quote(const std::string &s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

class Json {
 public:
  Json &Begin(char open) { Sep(); out_ += open; first_.push_back(true); return *this; }
  Json &End(char close) { out_ += close; first_.pop_back(); return *this; }
  Json &Key(const std::string &k) { Sep(); out_ += Quote(k) + ":"; pending_value_ = true; return *this; }
  Json &Str(const std::string &v) { Sep(); out_ += Quote(v); return *this; }
  Json &Num(uint64_t v) { Sep(); out_ += std::to_string(v); return *this; }
  Json &Bool(bool v) { Sep(); out_ += v ? "true" : "false"; return *this; }
  Json &Raw(const std::string &v) { Sep(); out_ += v; return *this; }
  Json &Null() { Sep(); out_ += "null"; return *this; }
  const std::string &str() const { return out_; }

 private:
  void Sep() {
    if (pending_value_) { pending_value_ = false; return; }
    if (!first_.empty()) {
      if (!first_.back()) out_ += ",";
      first_.back() = false;
    }
  }
  std::string out_;
  std::vector<bool> first_;
  bool pending_value_ = false;
};

// ---------------------------------------------------------------------------------------------------------------
// Context helpers

struct Options {
  WGPUPowerPreference power = WGPUPowerPreference_HighPerformance;
  std::vector<WGPUFeatureName> features;
  bool all_features = false;
  bool adapter_limits = false;
};

struct Session {
  NtGpuContext *ctx = nullptr;
  std::string error;
  ~Session() { ntgpu_context_destroy(ctx); }
};

// Implementation-specific feature names, for reports only (the facade exposes standard names).
const char *NativeFeatureName(uint32_t f) {
  switch (f) {
    case WGPUNativeFeature_Immediates: return "immediates";
    case WGPUNativeFeature_TextureAdapterSpecificFormatFeatures: return "texture-adapter-specific-format-features";
    case WGPUNativeFeature_VertexWritableStorage: return "vertex-writable-storage";
    case WGPUNativeFeature_TextureBindingArray: return "texture-binding-array";
    case WGPUNativeFeature_SampledTextureAndStorageBufferArrayNonUniformIndexing:
      return "sampled-texture-and-storage-buffer-array-non-uniform-indexing";
    case WGPUNativeFeature_StorageResourceBindingArray: return "storage-resource-binding-array";
    case WGPUNativeFeature_PartiallyBoundBindingArray: return "partially-bound-binding-array";
    case WGPUNativeFeature_TextureFormat16bitNorm: return "texture-format-16bit-norm";
    case WGPUNativeFeature_TextureCompressionAstcHdr: return "texture-compression-astc-hdr";
    case WGPUNativeFeature_MappablePrimaryBuffers: return "mappable-primary-buffers";
    case WGPUNativeFeature_StorageTextureArrayNonUniformIndexing: return "storage-texture-array-non-uniform-indexing";
    case WGPUNativeFeature_AddressModeClampToZero: return "address-mode-clamp-to-zero";
    case WGPUNativeFeature_AddressModeClampToBorder: return "address-mode-clamp-to-border";
    case WGPUNativeFeature_PolygonModeLine: return "polygon-mode-line";
    case WGPUNativeFeature_ClearTexture: return "clear-texture";
    case WGPUNativeFeature_Multiview: return "multiview";
    case WGPUNativeFeature_RayQuery: return "ray-query";
    case WGPUNativeFeature_Subgroup: return "subgroup";
    case WGPUNativeFeature_SubgroupBarrier: return "subgroup-barrier";
    case WGPUNativeFeature_TimestampQueryInsideEncoders: return "timestamp-query-inside-encoders";
    case WGPUNativeFeature_ShaderInt64: return "shader-int64";
    case WGPUNativeFeature_ShaderFloat32Atomic: return "shader-float32-atomic";
    case WGPUNativeFeature_TextureAtomic: return "texture-atomic";
    case WGPUNativeFeature_ShaderInt64AtomicMinMax: return "shader-int64-atomic-min-max";
    case WGPUNativeFeature_TextureInt64Atomic: return "texture-int64-atomic";
    case WGPUNativeFeature_ShaderBarycentrics: return "shader-barycentrics";
    case WGPUNativeFeature_CooperativeMatrix: return "cooperative-matrix";
    case WGPUNativeFeature_MemoryDecorationCoherent: return "memory-decoration-coherent";
    default: return nullptr;
  }
}

std::string FeatureLabel(WGPUFeatureName f) {
  const char *name = ntgpu_feature_name(f);
  if (name) return name;
  if (const char *native = NativeFeatureName(static_cast<uint32_t>(f))) return std::string("native:") + native;
  char buf[32];
  std::snprintf(buf, sizeof buf, "native:0x%08x", static_cast<unsigned>(f));
  return buf;
}

void DrainEvents(NtGpuContext *ctx, std::vector<NtGpuEvent> *seen, std::vector<std::string> *messages) {
  NtGpuEvent ev;
  while (ntgpu_next_event(ctx, &ev)) {
    if (seen) seen->push_back(ev);
    if (messages) messages->push_back(ev.message ? ev.message : "");
  }
}

bool Open(const Options &opt, Session *s, const NtGpuContextOptions *ctx_options = nullptr) {
  NtGpuContextOptions defaults{};
  defaults.api_version = NTGPU_API_VERSION;
  if (ntgpu_context_create(ctx_options ? ctx_options : &defaults, &s->ctx) != NTGPU_OK) {
    s->error = "instance creation failed";
    return false;
  }
  if (ntgpu_request_adapter(s->ctx, 1, opt.power) != NTGPU_OK) {
    s->error = "no adapter";
    return false;
  }
  NtGpuCapabilities adapter;
  ntgpu_adapter_capabilities(s->ctx, &adapter);
  std::vector<WGPUFeatureName> features = opt.features;
  if (opt.all_features) {
    for (uint32_t i = 0; i < adapter.feature_count; ++i) {
      if (ntgpu_feature_name(adapter.features[i])) features.push_back(adapter.features[i]);
    }
  }
  for (WGPUFeatureName f : opt.features) {
    bool have = false;
    for (uint32_t i = 0; i < adapter.feature_count; ++i) have = have || adapter.features[i] == f;
    if (!have) {
      s->error = "adapter lacks required feature " + FeatureLabel(f);
      return false;
    }
  }
  const WGPULimits *limits = opt.adapter_limits ? &adapter.limits : nullptr;
  if (ntgpu_request_device(s->ctx, 2, features.data(), features.size(), limits) != NTGPU_OK) {
    std::vector<std::string> messages;
    DrainEvents(s->ctx, nullptr, &messages);
    s->error = "device request failed: " + (messages.empty() ? std::string() : messages.back());
    return false;
  }
  DrainEvents(s->ctx, nullptr, nullptr);  // ADAPTER, DEVICE
  return true;
}

void CapsJson(Json &j, const NtGpuCapabilities &caps) {
  j.Begin('{');
  j.Key("vendor").Str(caps.vendor).Key("architecture").Str(caps.architecture);
  j.Key("device").Str(caps.device).Key("description").Str(caps.description);
  j.Key("backend").Str(ntgpu_backend_name(caps.backend));
  j.Key("adapterType").Num(caps.adapter_type).Key("vendorId").Num(caps.vendor_id).Key("deviceId").Num(caps.device_id);
  j.Key("features").Begin('[');
  for (uint32_t i = 0; i < caps.feature_count; ++i) j.Str(FeatureLabel(caps.features[i]));
  j.End(']');
  j.Key("limits").Begin('{');
  for (size_t i = 0; i < ntgpu_limit_count(); ++i) {
    const char *name;
    uint64_t value;
    if (ntgpu_limit_at(&caps.limits, i, &name, &value) == 2) j.Key(name).Null();  // not reported by implementation
    else j.Key(name).Num(value);
  }
  j.End('}');
  j.End('}');
}

std::string VersionString() {
  uint32_t v = ntgpu_implementation_version();
  char buf[64];
  std::snprintf(buf, sizeof buf, "%u.%u.%u.%u", v >> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  return buf;
}

void Header(Json &j, const char *command) {
  j.Key("tool").Str("ntgpu-probe").Key("command").Str(command);
  j.Key("implementation").Str(ntgpu_implementation_name()).Key("implementationVersion").Str(VersionString());
}

int Fail(Json &j, const std::string &error) {
  j.Key("ok").Bool(false).Key("error").Str(error);
  j.End('}');
  std::printf("%s\n", j.str().c_str());
  return 2;
}

// ---------------------------------------------------------------------------------------------------------------
// caps

int CmdCaps(const Options &opt) {
  Json j;
  j.Begin('{');
  Header(j, "caps");
  Session s;
  if (!Open(opt, &s)) return Fail(j, s.error);
  NtGpuCapabilities adapter, device;
  ntgpu_adapter_capabilities(s.ctx, &adapter);
  ntgpu_device_capabilities(s.ctx, &device);
  j.Key("power").Str(opt.power == WGPUPowerPreference_LowPower ? "low-power" : "high-performance");
  j.Key("adapter");
  CapsJson(j, adapter);
  j.Key("device");
  CapsJson(j, device);
  j.Key("deviceLimitsRequested").Str(opt.adapter_limits ? "adapter" : "default");
  j.Key("ok").Bool(true);
  j.End('}');
  std::printf("%s\n", j.str().c_str());
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// shader

struct Entry {
  std::string name;
  std::string stage;   // compute | vertex | fragment
  std::string source;  // lexical | argument
};

// Lexical entry-point discovery: '@compute'/'@vertex'/'@fragment' attribute followed by 'fn NAME'. Comments are
// skipped. This is not a WGSL parser; the implementation's front end remains the authority (pipeline creation
// rejects a wrong entry name).
std::vector<Entry> DiscoverEntries(const std::string &src) {
  std::string clean;
  clean.reserve(src.size());
  for (size_t i = 0; i < src.size();) {
    if (src.compare(i, 2, "//") == 0) {
      while (i < src.size() && src[i] != '\n') ++i;
    } else if (src.compare(i, 2, "/*") == 0) {
      int depth = 0;
      do {
        if (src.compare(i, 2, "/*") == 0) { ++depth; i += 2; }
        else if (src.compare(i, 2, "*/") == 0) { --depth; i += 2; }
        else ++i;
      } while (depth > 0 && i < src.size());
      clean += ' ';
    } else {
      clean += src[i++];
    }
  }
  auto ident = [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_'; };
  std::vector<Entry> out;
  const char *stages[] = {"compute", "vertex", "fragment"};
  for (size_t i = 0; i < clean.size(); ++i) {
    if (clean[i] != '@') continue;
    size_t j = i + 1;
    while (j < clean.size() && std::isspace(static_cast<unsigned char>(clean[j]))) ++j;
    size_t k = j;
    while (k < clean.size() && ident(clean[k])) ++k;
    std::string word = clean.substr(j, k - j);
    const char *stage = nullptr;
    for (const char *s : stages) if (word == s) stage = s;
    if (!stage) continue;
    // find the next 'fn' token before any ';' or '{'
    for (size_t p = k; p + 2 < clean.size(); ++p) {
      if (clean[p] == ';' || clean[p] == '{') break;
      if (clean.compare(p, 2, "fn") == 0 && (p == 0 || !ident(clean[p - 1])) && !ident(clean[p + 2])) {
        size_t q = p + 2;
        while (q < clean.size() && std::isspace(static_cast<unsigned char>(clean[q]))) ++q;
        size_t r = q;
        while (r < clean.size() && ident(clean[r])) ++r;
        if (r > q) out.push_back({clean.substr(q, r - q), stage, "lexical"});
        break;
      }
    }
  }
  return out;
}

struct NameValue {
  const char *name;
  uint32_t value;
};

const NameValue kTextureFormats[] = {
    {"r8unorm", WGPUTextureFormat_R8Unorm}, {"r8snorm", WGPUTextureFormat_R8Snorm},
    {"r8uint", WGPUTextureFormat_R8Uint}, {"r8sint", WGPUTextureFormat_R8Sint},
    {"r16uint", WGPUTextureFormat_R16Uint}, {"r16sint", WGPUTextureFormat_R16Sint},
    {"r16float", WGPUTextureFormat_R16Float}, {"rg8unorm", WGPUTextureFormat_RG8Unorm},
    {"rg8snorm", WGPUTextureFormat_RG8Snorm}, {"rg8uint", WGPUTextureFormat_RG8Uint},
    {"rg8sint", WGPUTextureFormat_RG8Sint}, {"r32float", WGPUTextureFormat_R32Float},
    {"r32uint", WGPUTextureFormat_R32Uint}, {"r32sint", WGPUTextureFormat_R32Sint},
    {"rg16uint", WGPUTextureFormat_RG16Uint}, {"rg16sint", WGPUTextureFormat_RG16Sint},
    {"rg16float", WGPUTextureFormat_RG16Float}, {"rgba8unorm", WGPUTextureFormat_RGBA8Unorm},
    {"rgba8unorm-srgb", WGPUTextureFormat_RGBA8UnormSrgb}, {"rgba8snorm", WGPUTextureFormat_RGBA8Snorm},
    {"rgba8uint", WGPUTextureFormat_RGBA8Uint}, {"rgba8sint", WGPUTextureFormat_RGBA8Sint},
    {"bgra8unorm", WGPUTextureFormat_BGRA8Unorm}, {"bgra8unorm-srgb", WGPUTextureFormat_BGRA8UnormSrgb},
    {"rgb10a2uint", WGPUTextureFormat_RGB10A2Uint}, {"rgb10a2unorm", WGPUTextureFormat_RGB10A2Unorm},
    {"rg11b10ufloat", WGPUTextureFormat_RG11B10Ufloat}, {"rg32float", WGPUTextureFormat_RG32Float},
    {"rg32uint", WGPUTextureFormat_RG32Uint}, {"rg32sint", WGPUTextureFormat_RG32Sint},
    {"rgba16uint", WGPUTextureFormat_RGBA16Uint}, {"rgba16sint", WGPUTextureFormat_RGBA16Sint},
    {"rgba16float", WGPUTextureFormat_RGBA16Float}, {"rgba32float", WGPUTextureFormat_RGBA32Float},
    {"rgba32uint", WGPUTextureFormat_RGBA32Uint}, {"rgba32sint", WGPUTextureFormat_RGBA32Sint},
    {"stencil8", WGPUTextureFormat_Stencil8}, {"depth16unorm", WGPUTextureFormat_Depth16Unorm},
    {"depth24plus", WGPUTextureFormat_Depth24Plus}, {"depth24plus-stencil8", WGPUTextureFormat_Depth24PlusStencil8},
    {"depth32float", WGPUTextureFormat_Depth32Float},
    {"depth32float-stencil8", WGPUTextureFormat_Depth32FloatStencil8},
};

const NameValue kVertexFormats[] = {
    {"uint8", WGPUVertexFormat_Uint8}, {"uint8x2", WGPUVertexFormat_Uint8x2}, {"uint8x4", WGPUVertexFormat_Uint8x4},
    {"sint8", WGPUVertexFormat_Sint8}, {"sint8x2", WGPUVertexFormat_Sint8x2}, {"sint8x4", WGPUVertexFormat_Sint8x4},
    {"unorm8", WGPUVertexFormat_Unorm8}, {"unorm8x2", WGPUVertexFormat_Unorm8x2},
    {"unorm8x4", WGPUVertexFormat_Unorm8x4}, {"snorm8", WGPUVertexFormat_Snorm8},
    {"snorm8x2", WGPUVertexFormat_Snorm8x2}, {"snorm8x4", WGPUVertexFormat_Snorm8x4},
    {"uint16", WGPUVertexFormat_Uint16}, {"uint16x2", WGPUVertexFormat_Uint16x2},
    {"uint16x4", WGPUVertexFormat_Uint16x4}, {"sint16", WGPUVertexFormat_Sint16},
    {"sint16x2", WGPUVertexFormat_Sint16x2}, {"sint16x4", WGPUVertexFormat_Sint16x4},
    {"unorm16", WGPUVertexFormat_Unorm16}, {"unorm16x2", WGPUVertexFormat_Unorm16x2},
    {"unorm16x4", WGPUVertexFormat_Unorm16x4}, {"snorm16", WGPUVertexFormat_Snorm16},
    {"snorm16x2", WGPUVertexFormat_Snorm16x2}, {"snorm16x4", WGPUVertexFormat_Snorm16x4},
    {"float16", WGPUVertexFormat_Float16}, {"float16x2", WGPUVertexFormat_Float16x2},
    {"float16x4", WGPUVertexFormat_Float16x4}, {"float32", WGPUVertexFormat_Float32},
    {"float32x2", WGPUVertexFormat_Float32x2}, {"float32x3", WGPUVertexFormat_Float32x3},
    {"float32x4", WGPUVertexFormat_Float32x4}, {"uint32", WGPUVertexFormat_Uint32},
    {"uint32x2", WGPUVertexFormat_Uint32x2}, {"uint32x3", WGPUVertexFormat_Uint32x3},
    {"uint32x4", WGPUVertexFormat_Uint32x4}, {"sint32", WGPUVertexFormat_Sint32},
    {"sint32x2", WGPUVertexFormat_Sint32x2}, {"sint32x3", WGPUVertexFormat_Sint32x3},
    {"sint32x4", WGPUVertexFormat_Sint32x4}, {"unorm10-10-10-2", WGPUVertexFormat_Unorm10_10_10_2},
    {"unorm8x4-bgra", WGPUVertexFormat_Unorm8x4BGRA},
};

const NameValue kTopologies[] = {
    {"point-list", WGPUPrimitiveTopology_PointList}, {"line-list", WGPUPrimitiveTopology_LineList},
    {"line-strip", WGPUPrimitiveTopology_LineStrip}, {"triangle-list", WGPUPrimitiveTopology_TriangleList},
    {"triangle-strip", WGPUPrimitiveTopology_TriangleStrip},
};

template <size_t N>
const char *NameOf(const NameValue (&table)[N], uint32_t value) {
  for (const NameValue &e : table) if (e.value == value) return e.name;
  return "other";
}

template <size_t N>
bool Lookup(const NameValue (&table)[N], const std::string &name, uint32_t *out) {
  for (const NameValue &e : table) {
    if (name == e.name) {
      *out = e.value;
      return true;
    }
  }
  return false;
}

struct VertexBuffer {
  uint64_t stride = 0;
  bool instance = false;
  std::vector<WGPUVertexAttribute> attributes;
};

// STRIDE[/instance]:LOC=FORMAT@OFFSET[,LOC=FORMAT@OFFSET...]   ("STRIDE:" alone = buffer without attributes)
bool ParseVertexBuffer(const std::string &spec, VertexBuffer *out, std::string *error) {
  size_t colon = spec.find(':');
  std::string head = spec.substr(0, colon);
  if (head.size() > 9 && head.compare(head.size() - 9, 9, "/instance") == 0) {
    out->instance = true;
    head.resize(head.size() - 9);
  }
  char *end = nullptr;
  out->stride = std::strtoull(head.c_str(), &end, 10);
  if (head.empty() || *end) { *error = "bad --vbuf stride in " + spec; return false; }
  if (colon == std::string::npos) return true;
  std::stringstream rest(spec.substr(colon + 1));
  std::string item;
  while (std::getline(rest, item, ',')) {
    if (item.empty()) continue;
    size_t eq = item.find('='), at = item.find('@');
    if (eq == std::string::npos) { *error = "bad --vbuf attribute " + item; return false; }
    WGPUVertexAttribute a{};
    a.shaderLocation = static_cast<uint32_t>(std::strtoul(item.substr(0, eq).c_str(), nullptr, 10));
    std::string fmt = item.substr(eq + 1, at == std::string::npos ? std::string::npos : at - eq - 1);
    uint32_t v;
    if (!Lookup(kVertexFormats, fmt, &v)) { *error = "unknown vertex format " + fmt; return false; }
    a.format = static_cast<WGPUVertexFormat>(v);
    a.offset = at == std::string::npos ? 0 : std::strtoull(item.substr(at + 1).c_str(), nullptr, 10);
    out->attributes.push_back(a);
  }
  return true;
}

struct ShaderArgs {
  std::vector<std::string> files;
  std::vector<Entry> entries;
  std::string render_vs, render_fs;
  std::vector<WGPUTextureFormat> targets;
  WGPUTextureFormat depth = WGPUTextureFormat_Undefined;
  WGPUPrimitiveTopology topology = WGPUPrimitiveTopology_TriangleList;
  std::vector<VertexBuffer> vbufs;
  std::vector<std::pair<std::string, double>> constants;
  bool module_only = false;
};

bool ReadFile(const std::string &path, std::string *out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  std::stringstream ss;
  ss << in.rdbuf();
  *out = ss.str();
  return true;
}

void DiagJson(Json &j, const NtGpuDiag &d, NtGpuStatus status) {
  j.Key("ok").Bool(status == NTGPU_OK);
  j.Key("status").Str(ntgpu_status_name(status));
  if (status != NTGPU_OK) j.Key("message").Str(d.message ? d.message : "");
}

// Returns true when every requested stage passed.
bool ShaderFile(Session &s, const ShaderArgs &a, const std::string &path, Json &j) {
  j.Begin('{');
  j.Key("file").Str(path);
  std::string src;
  if (!ReadFile(path, &src)) {
    j.Key("module").Begin('{').Key("ok").Bool(false).Key("status").Str("io").Key("message").Str("cannot read file");
    j.End('}').End('}');
    return false;
  }
  std::vector<Entry> lexical = DiscoverEntries(src);
  j.Key("entryPoints").Begin('[');
  for (const Entry &e : lexical) j.Begin('{').Key("name").Str(e.name).Key("stage").Str(e.stage).End('}');
  j.End(']');
  j.Key("entryPointDiscovery").Str("lexical scan (not front-end reflection)");

  // Stage 1: shader module (WGSL parse + Naga validation).
  WGPUShaderModule module = nullptr;
  NtGpuDiag diag{};
  NtGpuStatus st = ntgpu_compile_wgsl(s.ctx, src.data(), src.size(), path.c_str(), &module, &diag);
  j.Key("module").Begin('{');
  j.Key("stage").Str("shader-module");
  DiagJson(j, diag, st);
  NtGpuSourceLocation loc{};
  if (st != NTGPU_OK && ntgpu_wgsl_location(diag.message, src.data(), src.size(), &loc)) {
    j.Key("location").Begin('{').Key("lineNum").Num(loc.line_num).Key("linePos").Num(loc.line_pos);
    j.Key("offset").Num(loc.offset).Key("length").Num(loc.length).Key("synthesized").Bool(true).End('}');
  }
  if (st != NTGPU_OK && loc.summary) j.Key("summary").Str(std::string(loc.summary, loc.summary_length));
  j.End('}');
  bool ok = st == NTGPU_OK;
  if (!ok || a.module_only) {
    j.Key("pipelines").Begin('[').End(']');
    if (module) wgpuShaderModuleRelease(module);
    j.End('}');
    return ok;
  }

  std::vector<WGPUConstantEntry> constants;
  for (const auto &c : a.constants) {
    WGPUConstantEntry e = WGPU_CONSTANT_ENTRY_INIT;
    e.key = WGPUStringView{c.first.c_str(), c.first.size()};
    e.value = c.second;
    constants.push_back(e);
  }

  // Stage 2: full pipelines (entry resolution, layout/interface validation, MSL generation and Metal compile).
  std::vector<Entry> compute;
  bool explicit_entries = !a.entries.empty() || !a.render_vs.empty();
  if (explicit_entries) {
    for (const Entry &e : a.entries) compute.push_back(e);
  } else {
    for (const Entry &e : lexical) if (e.stage == "compute") compute.push_back(e);
  }
  j.Key("pipelines").Begin('[');
  for (const Entry &e : compute) {
    WGPUComputePipeline pipeline = nullptr;
    NtGpuDiag pd{};
    NtGpuStatus ps = ntgpu_create_compute_pipeline(s.ctx, module, e.name.c_str(), constants.data(),
                                                   constants.size(), nullptr, &pipeline, &pd);
    j.Begin('{').Key("stage").Str("compute-pipeline").Key("entry").Str(e.name).Key("layout").Str("auto");
    DiagJson(j, pd, ps);
    j.End('}');
    ok = ok && ps == NTGPU_OK;
    if (pipeline) wgpuComputePipelineRelease(pipeline);
  }
  if (!a.render_vs.empty()) {
    std::vector<WGPUVertexBufferLayout> layouts;
    for (const VertexBuffer &vb : a.vbufs) {
      WGPUVertexBufferLayout l = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
      l.stepMode = vb.instance ? WGPUVertexStepMode_Instance : WGPUVertexStepMode_Vertex;
      l.arrayStride = vb.stride;
      l.attributeCount = vb.attributes.size();
      l.attributes = vb.attributes.data();
      layouts.push_back(l);
    }
    std::vector<WGPUColorTargetState> targets;
    std::vector<WGPUTextureFormat> formats = a.targets;
    if (formats.empty() && !a.render_fs.empty()) formats.push_back(WGPUTextureFormat_BGRA8Unorm);
    for (WGPUTextureFormat f : formats) {
      WGPUColorTargetState t = WGPU_COLOR_TARGET_STATE_INIT;
      t.format = f;
      targets.push_back(t);
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = WGPUStringView{a.render_fs.c_str(), a.render_fs.size()};
    fragment.constantCount = constants.size();
    fragment.constants = constants.data();
    fragment.targetCount = targets.size();
    fragment.targets = targets.data();
    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    depth.format = a.depth;
    depth.depthWriteEnabled = WGPUOptionalBool_True;
    depth.depthCompare = WGPUCompareFunction_Less;
    WGPURenderPipelineDescriptor d = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    d.vertex.module = module;
    d.vertex.entryPoint = WGPUStringView{a.render_vs.c_str(), a.render_vs.size()};
    d.vertex.constantCount = constants.size();
    d.vertex.constants = constants.data();
    d.vertex.bufferCount = layouts.size();
    d.vertex.buffers = layouts.data();
    d.primitive.topology = a.topology;
    d.depthStencil = a.depth == WGPUTextureFormat_Undefined ? nullptr : &depth;
    d.fragment = a.render_fs.empty() ? nullptr : &fragment;
    WGPURenderPipeline pipeline = nullptr;
    NtGpuDiag pd{};
    NtGpuStatus ps = ntgpu_create_render_pipeline(s.ctx, &d, &pipeline, &pd);
    j.Begin('{').Key("stage").Str("render-pipeline").Key("vertex").Str(a.render_vs);
    j.Key("fragment").Str(a.render_fs).Key("layout").Str("auto");
    DiagJson(j, pd, ps);
    j.End('}');
    ok = ok && ps == NTGPU_OK;
    if (pipeline) wgpuRenderPipelineRelease(pipeline);
  }
  j.End(']');
  // Entries the module defines but no pipeline exercised: they passed module validation only.
  j.Key("moduleOnly").Begin('[');
  for (const Entry &e : lexical) {
    bool covered = false;
    for (const Entry &c : compute) covered = covered || c.name == e.name;
    covered = covered || e.name == a.render_vs || e.name == a.render_fs;
    if (!covered) {
      j.Begin('{').Key("name").Str(e.name).Key("stage").Str(e.stage);
      j.Key("reason").Str(e.stage == "compute" ? "not selected" : "render pipeline needs --render/--vbuf/--target");
      j.End('}');
    }
  }
  j.End(']');
  wgpuShaderModuleRelease(module);
  j.End('}');
  return ok;
}

}  // namespace
extern "C" const char *ntgpu_probe_format_name(uint32_t format) { return NameOf(kTextureFormats, format); }
namespace {

int CmdShader(const Options &opt, const ShaderArgs &a) {
  Json j;
  j.Begin('{');
  Header(j, "shader");
  if (a.files.empty()) return Fail(j, "no WGSL files given");
  Session s;
  if (!Open(opt, &s)) return Fail(j, s.error);
  NtGpuCapabilities device;
  ntgpu_device_capabilities(s.ctx, &device);
  j.Key("deviceFeatures").Begin('[');
  for (uint32_t i = 0; i < device.feature_count; ++i) {
    if (ntgpu_feature_name(device.features[i])) j.Str(FeatureLabel(device.features[i]));
  }
  j.End(']');
  j.Key("deviceLimits").Str(opt.adapter_limits ? "adapter" : "default");
  bool ok = true;
  j.Key("files").Begin('[');
  for (const std::string &f : a.files) ok = ShaderFile(s, a, f, j) && ok;
  j.End(']');
  std::vector<std::string> uncaptured;
  std::vector<NtGpuEvent> events;
  DrainEvents(s.ctx, &events, &uncaptured);
  j.Key("events").Num(events.size());
  j.Key("ok").Bool(ok);
  j.End('}');
  std::printf("%s\n", j.str().c_str());
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// proof: compute + readback (atomicCompareExchangeWeak) and render + readback

const char *kAtomicsWgsl = R"(
@group(0) @binding(0) var<storage, read_write> counters: array<atomic<u32>, 2>;
@group(0) @binding(1) var<storage, read_write> slots: array<atomic<u32>, 64>;
@group(0) @binding(2) var<storage, read_write> winners: array<u32>;

// Every invocation increments counters[0] through a compare-exchange loop (no lost updates allowed) and tries to
// claim slot id % 64 by exchanging 0 -> id + 1; exactly one invocation per slot may win.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  var old = atomicLoad(&counters[0]);
  loop {
    let r = atomicCompareExchangeWeak(&counters[0], old, old + 1u);
    if (r.exchanged) { break; }
    old = r.old_value;
  }
  let slot = id % 64u;
  var won = 0u;
  loop {
    let r = atomicCompareExchangeWeak(&slots[slot], 0u, id + 1u);
    if (r.exchanged) { won = 1u; break; }
    if (r.old_value != 0u) { break; }
  }
  winners[id] = won;
  atomicAdd(&counters[1], won);
}
)";

const char *kRenderWgsl = R"(
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.25, 0.5, 0.75, 1.0); }
)";

WGPUBuffer MakeBuffer(NtGpuContext *ctx, uint64_t size, WGPUBufferUsage usage, const char *label) {
  WGPUBufferDescriptor d = WGPU_BUFFER_DESCRIPTOR_INIT;
  d.label = WGPUStringView{label, WGPU_STRLEN};
  d.size = size;
  d.usage = usage;
  return wgpuDeviceCreateBuffer(ntgpu_device(ctx), &d);
}

// Maps buf for reading through the facade's event path and copies size bytes out.
bool ReadBack(NtGpuContext *ctx, WGPUBuffer buf, size_t size, std::vector<uint8_t> *out, std::string *error,
              uint64_t token) {
  if (ntgpu_map_async(ctx, buf, WGPUMapMode_Read, 0, size, token) != NTGPU_OK) {
    *error = "mapAsync refused";
    return false;
  }
  while (ntgpu_process(ctx, 1) > 0) {
  }
  NtGpuEvent ev;
  bool mapped = false;
  while (ntgpu_next_event(ctx, &ev)) {
    if (ev.kind == NTGPU_EVENT_MAP && ev.token == token) {
      mapped = ev.status == NTGPU_OK;
      if (!mapped) *error = std::string("map failed: ") + ev.message;
    } else if (ev.kind == NTGPU_EVENT_UNCAPTURED_ERROR) {
      *error = std::string("uncaptured error: ") + ev.message;
      mapped = false;
    }
  }
  if (!mapped) {
    if (error->empty()) *error = "no MAP event";
    return false;
  }
  const void *data = wgpuBufferGetConstMappedRange(buf, 0, size);
  if (!data) {
    *error = "getConstMappedRange returned null";
    return false;
  }
  out->assign(static_cast<const uint8_t *>(data), static_cast<const uint8_t *>(data) + size);
  wgpuBufferUnmap(buf);
  return true;
}

bool ProofAtomics(NtGpuContext *ctx, Json &j) {
  const uint32_t kInvocations = 4096, kSlots = 64;
  j.Begin('{').Key("name").Str("compute-atomicCompareExchangeWeak");
  std::string error;
  bool ok = false;
  WGPUShaderModule module = nullptr;
  WGPUComputePipeline pipeline = nullptr;
  NtGpuDiag diag{};
  WGPUBuffer counters = nullptr, slots = nullptr, winners = nullptr, readback = nullptr;
  WGPUBindGroupLayout bgl = nullptr;
  WGPUBindGroup group = nullptr;
  do {
    if (ntgpu_compile_wgsl(ctx, kAtomicsWgsl, std::strlen(kAtomicsWgsl), "atomics", &module, &diag) != NTGPU_OK) {
      error = std::string("module: ") + diag.message;
      break;
    }
    if (ntgpu_create_compute_pipeline(ctx, module, "main", nullptr, 0, nullptr, &pipeline, &diag) != NTGPU_OK) {
      error = std::string("pipeline: ") + diag.message;
      break;
    }
    const uint64_t counters_size = 8, slots_size = kSlots * 4, winners_size = kInvocations * 4;
    const uint64_t total = counters_size + slots_size + winners_size;
    WGPUBufferUsage storage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst;
    counters = MakeBuffer(ctx, counters_size, storage, "counters");
    slots = MakeBuffer(ctx, slots_size, storage, "slots");
    winners = MakeBuffer(ctx, winners_size, storage, "winners");
    readback = MakeBuffer(ctx, total, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, "readback");
    // Fresh buffers are zero-initialised by WebGPU; write winners with a sentinel to prove the shader wrote them.
    std::vector<uint32_t> sentinel(kInvocations, 0xdeadbeefu);
    wgpuQueueWriteBuffer(ntgpu_queue(ctx), winners, 0, sentinel.data(), winners_size);
    bgl = wgpuComputePipelineGetBindGroupLayout(pipeline, 0);
    WGPUBindGroupEntry entries[3];
    WGPUBuffer bufs[3] = {counters, slots, winners};
    uint64_t sizes[3] = {counters_size, slots_size, winners_size};
    for (uint32_t i = 0; i < 3; ++i) {
      entries[i] = WGPU_BIND_GROUP_ENTRY_INIT;
      entries[i].binding = i;
      entries[i].buffer = bufs[i];
      entries[i].size = sizes[i];
    }
    WGPUBindGroupDescriptor bgd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bgd.layout = bgl;
    bgd.entryCount = 3;
    bgd.entries = entries;
    group = wgpuDeviceCreateBindGroup(ntgpu_device(ctx), &bgd);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(ntgpu_device(ctx), nullptr);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(enc, nullptr);
    wgpuComputePassEncoderSetPipeline(pass, pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, kInvocations / 64, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    wgpuCommandEncoderCopyBufferToBuffer(enc, counters, 0, readback, 0, counters_size);
    wgpuCommandEncoderCopyBufferToBuffer(enc, slots, 0, readback, counters_size, slots_size);
    wgpuCommandEncoderCopyBufferToBuffer(enc, winners, 0, readback, counters_size + slots_size, winners_size);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
    wgpuCommandEncoderRelease(enc);
    wgpuQueueSubmit(ntgpu_queue(ctx), 1, &cmd);
    wgpuCommandBufferRelease(cmd);
    std::vector<uint8_t> bytes;
    if (!ReadBack(ctx, readback, total, &bytes, &error, 100)) break;
    std::vector<uint32_t> v(total / 4);
    std::memcpy(v.data(), bytes.data(), total);
    uint32_t counter = v[0], wins = v[1];
    const uint32_t *slot = &v[2];
    const uint32_t *won = &v[2 + kSlots];
    uint32_t won_sum = 0, sentinels = 0, bad_slots = 0;
    for (uint32_t i = 0; i < kInvocations; ++i) {
      if (won[i] == 0xdeadbeefu) ++sentinels;
      else won_sum += won[i];
    }
    for (uint32_t s = 0; s < kSlots; ++s) {
      uint32_t claimant = slot[s];
      if (claimant == 0 || (claimant - 1) % kSlots != s || claimant > kInvocations || won[claimant - 1] != 1) {
        ++bad_slots;
      }
    }
    j.Key("invocations").Num(kInvocations).Key("casCounter").Num(counter).Key("claimedSlots").Num(wins);
    j.Key("winnerFlags").Num(won_sum).Key("unwrittenWinners").Num(sentinels).Key("badSlots").Num(bad_slots);
    ok = counter == kInvocations && wins == kSlots && won_sum == kSlots && sentinels == 0 && bad_slots == 0;
    if (!ok) error = "readback values do not match the expected atomic results";
  } while (false);
  if (group) wgpuBindGroupRelease(group);
  if (bgl) wgpuBindGroupLayoutRelease(bgl);
  for (WGPUBuffer b : {counters, slots, winners, readback}) {
    if (b) {
      wgpuBufferDestroy(b);
      wgpuBufferRelease(b);
    }
  }
  if (pipeline) wgpuComputePipelineRelease(pipeline);
  if (module) wgpuShaderModuleRelease(module);
  j.Key("ok").Bool(ok);
  if (!ok) j.Key("error").Str(error);
  j.End('}');
  return ok;
}

bool ProofRender(NtGpuContext *ctx, Json &j) {
  const uint32_t kSize = 4, kRow = 256;
  j.Begin('{').Key("name").Str("render-rgba8unorm-readback");
  std::string error;
  bool ok = false;
  WGPUShaderModule module = nullptr;
  WGPURenderPipeline pipeline = nullptr;
  WGPUTexture texture = nullptr;
  WGPUTextureView view = nullptr;
  WGPUBuffer readback = nullptr;
  NtGpuDiag diag{};
  do {
    if (ntgpu_compile_wgsl(ctx, kRenderWgsl, std::strlen(kRenderWgsl), "render", &module, &diag) != NTGPU_OK) {
      error = std::string("module: ") + diag.message;
      break;
    }
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = WGPUTextureFormat_RGBA8Unorm;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = WGPUStringView{"fs", WGPU_STRLEN};
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor d = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    d.vertex.module = module;
    d.vertex.entryPoint = WGPUStringView{"vs", WGPU_STRLEN};
    d.fragment = &fragment;
    if (ntgpu_create_render_pipeline(ctx, &d, &pipeline, &diag) != NTGPU_OK) {
      error = std::string("pipeline: ") + diag.message;
      break;
    }
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.size = {kSize, kSize, 1};
    td.format = WGPUTextureFormat_RGBA8Unorm;
    td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    texture = wgpuDeviceCreateTexture(ntgpu_device(ctx), &td);
    view = wgpuTextureCreateView(texture, nullptr);
    readback = MakeBuffer(ctx, kRow * kSize, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, "pixels");
    WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    color.view = view;
    color.loadOp = WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
    color.clearValue = {1.0, 0.0, 0.0, 1.0};
    WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &color;
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(ntgpu_device(ctx), nullptr);
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    WGPUTexelCopyTextureInfo src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    src.texture = texture;
    WGPUTexelCopyBufferInfo dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    dst.buffer = readback;
    dst.layout.bytesPerRow = kRow;
    dst.layout.rowsPerImage = kSize;
    WGPUExtent3D extent = {kSize, kSize, 1};
    wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &extent);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
    wgpuCommandEncoderRelease(enc);
    wgpuQueueSubmit(ntgpu_queue(ctx), 1, &cmd);
    wgpuCommandBufferRelease(cmd);
    std::vector<uint8_t> bytes;
    if (!ReadBack(ctx, readback, kRow * kSize, &bytes, &error, 101)) break;
    uint32_t mismatches = 0;
    const uint8_t expect[4] = {64, 128, 191, 255};  // 0.25, 0.5, 0.75, 1.0 in unorm8 (0.75*255 = 191.25)
    for (uint32_t y = 0; y < kSize; ++y) {
      for (uint32_t x = 0; x < kSize; ++x) {
        const uint8_t *p = &bytes[y * kRow + x * 4];
        for (int c = 0; c < 4; ++c) {
          if (std::abs(static_cast<int>(p[c]) - expect[c]) > 1) ++mismatches;
        }
      }
    }
    char pixel[32];
    std::snprintf(pixel, sizeof pixel, "%u,%u,%u,%u", bytes[0], bytes[1], bytes[2], bytes[3]);
    j.Key("size").Num(kSize).Key("firstPixel").Str(pixel).Key("mismatchedChannels").Num(mismatches);
    ok = mismatches == 0;
    if (!ok) error = "pixels do not match the cleared/drawn colour";
  } while (false);
  if (readback) { wgpuBufferDestroy(readback); wgpuBufferRelease(readback); }
  if (view) wgpuTextureViewRelease(view);
  if (texture) { wgpuTextureDestroy(texture); wgpuTextureRelease(texture); }
  if (pipeline) wgpuRenderPipelineRelease(pipeline);
  if (module) wgpuShaderModuleRelease(module);
  j.Key("ok").Bool(ok);
  if (!ok) j.Key("error").Str(error);
  j.End('}');
  return ok;
}

bool RunProofs(NtGpuContext *ctx, Json &j) {
  j.Key("proofs").Begin('[');
  bool a = ProofAtomics(ctx, j);
  bool b = ProofRender(ctx, j);
  j.End(']');
  return a && b;
}

int CmdProof(const Options &opt) {
  Json j;
  j.Begin('{');
  Header(j, "proof");
  Session s;
  if (!Open(opt, &s)) return Fail(j, s.error);
  bool ok = RunProofs(s.ctx, j);
  j.Key("timings").Str("not measured (correctness only)");
  j.Key("ok").Bool(ok);
  j.End('}');
  std::printf("%s\n", j.str().c_str());
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// lifecycle: event queue, error scopes, device loss, re-request, teardown with outstanding work

struct Check {
  std::string name;
  bool ok;
  std::string detail;
};

std::atomic<int> g_wakes{0};
std::mutex g_wake_mutex;
std::condition_variable g_wake_cv;
void CountWake(void *) {
  {
    std::lock_guard<std::mutex> lock(g_wake_mutex);
    ++g_wakes;
  }
  g_wake_cv.notify_all();
}

// The intended host pattern: a waiter thread blocks in ntgpu_process(ctx, 1) only while work is pending; the
// completion callback queues an event and the wake hook signals the driving thread, which drains the queue.
bool ThreadedReadback(NtGpuContext *ctx, std::string *detail) {
  const uint32_t kWords = 1024;
  std::vector<uint32_t> data(kWords);
  for (uint32_t i = 0; i < kWords; ++i) data[i] = i * 2654435761u;
  WGPUBuffer src = MakeBuffer(ctx, kWords * 4, WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst, "threaded-src");
  WGPUBuffer dst = MakeBuffer(ctx, kWords * 4, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, "threaded-dst");
  wgpuQueueWriteBuffer(ntgpu_queue(ctx), src, 0, data.data(), kWords * 4);
  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(ntgpu_device(ctx), nullptr);
  wgpuCommandEncoderCopyBufferToBuffer(enc, src, 0, dst, 0, kWords * 4);
  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuCommandEncoderRelease(enc);
  wgpuQueueSubmit(ntgpu_queue(ctx), 1, &cmd);
  wgpuCommandBufferRelease(cmd);
  int wakes_before = g_wakes.load();
  ntgpu_map_async(ctx, dst, WGPUMapMode_Read, 0, kWords * 4, 42);
  std::thread waiter([ctx] {
    while (ntgpu_process(ctx, 1) > 0) {
    }
  });
  bool woke;
  {
    std::unique_lock<std::mutex> lock(g_wake_mutex);
    woke = g_wake_cv.wait_for(lock, std::chrono::seconds(30), [&] { return g_wakes.load() > wakes_before; });
  }
  waiter.join();
  bool ok = false;
  NtGpuEvent ev;
  while (ntgpu_next_event(ctx, &ev)) {
    if (ev.kind == NTGPU_EVENT_MAP && ev.token == 42 && ev.status == NTGPU_OK) {
      const void *p = wgpuBufferGetConstMappedRange(dst, 0, kWords * 4);
      ok = p && std::memcmp(p, data.data(), kWords * 4) == 0;
      wgpuBufferUnmap(dst);
    }
  }
  *detail = woke ? (ok ? "waiter thread completed the map; wake hook signalled the driver" : "data mismatch")
                 : "wake hook never fired";
  wgpuBufferRelease(src);
  wgpuBufferRelease(dst);
  return woke && ok;
}

bool RunLifecycle(const Options &opt, Json &j) {
  std::vector<Check> checks;
  auto check = [&](const std::string &name, bool ok, const std::string &detail = std::string()) {
    checks.push_back({name, ok, detail});
  };
  NtGpuContextOptions co{};
  co.api_version = NTGPU_API_VERSION;
  co.event_capacity = 4;
  co.wake = CountWake;
  g_wakes.store(0);
  {
    Session s;
    if (!Open(opt, &s, &co)) {
      check("open", false, s.error);
    } else {
      NtGpuContext *ctx = s.ctx;
      check("generation-1", ntgpu_device_generation(ctx) == 1);
      check("idle-process-returns", ntgpu_pending(ctx) == 0 && ntgpu_process(ctx, 1) == 0);

      // Error scopes: balanced use, emulated internal filter, refusal instead of abort on underflow.
      NtGpuDiag d{};
      check("pop-empty-refused", ntgpu_scope_pop(ctx, &d) == NTGPU_ERR_ARGUMENT);
      ntgpu_scope_push(ctx, WGPUErrorFilter_Internal);
      check("internal-scope-emulated", ntgpu_scope_pop(ctx, &d) == NTGPU_OK && d.status == NTGPU_OK);
      ntgpu_scope_push(ctx, WGPUErrorFilter_Validation);
      WGPUBuffer bad = MakeBuffer(ctx, 16, WGPUBufferUsage_MapRead | WGPUBufferUsage_Storage, "invalid-usage");
      ntgpu_scope_pop(ctx, &d);
      check("scope-captures-validation", d.status == NTGPU_ERR_VALIDATION, d.message ? d.message : "");
      wgpuBufferRelease(bad);

      // Uncaptured errors are queued, bounded, and the wake hook fires once per empty->non-empty transition.
      int wakes_before = g_wakes.load();
      for (int i = 0; i < 7; ++i) {
        WGPUBuffer b = MakeBuffer(ctx, 16, WGPUBufferUsage_MapRead | WGPUBufferUsage_Storage, "uncaptured");
        wgpuBufferRelease(b);
      }
      std::vector<NtGpuEvent> events;
      DrainEvents(ctx, &events, nullptr);
      uint32_t uncaptured = 0, overflow = 0;
      for (const NtGpuEvent &e : events) {
        if (e.kind == NTGPU_EVENT_UNCAPTURED_ERROR) ++uncaptured;
        if (e.kind == NTGPU_EVENT_OVERFLOW) overflow += static_cast<uint32_t>(e.token);
      }
      check("uncaptured-queued-bounded", uncaptured == 4 && overflow == 3,
            std::to_string(uncaptured) + " queued, " + std::to_string(overflow) + " dropped");
      check("wake-once-per-transition", g_wakes.load() - wakes_before == 1,
            std::to_string(g_wakes.load() - wakes_before));

      // Work-done completes through process() and the queue.
      ntgpu_work_done(ctx, 7);
      check("work-done-pending", ntgpu_pending(ctx) == 1);
      while (ntgpu_process(ctx, 1) > 0) {
      }
      events.clear();
      DrainEvents(ctx, &events, nullptr);
      check("work-done-event", events.size() == 1 && events[0].kind == NTGPU_EVENT_WORK_DONE &&
                                   events[0].token == 7 && events[0].status == NTGPU_OK);

      // Device loss: destroy emits DEVICE_LOST once; later use is refused without touching the lost device.
      check("destroy", ntgpu_device_destroy(ctx) == NTGPU_OK);
      ntgpu_device_destroy(ctx);
      events.clear();
      DrainEvents(ctx, &events, nullptr);
      check("lost-event-once", events.size() == 1 && events[0].kind == NTGPU_EVENT_DEVICE_LOST &&
                                   events[0].detail == WGPUDeviceLostReason_Destroyed && events[0].generation == 1);
      check("alive-false", ntgpu_device_alive(ctx) == 0);
      WGPUShaderModule m = nullptr;
      check("compile-after-loss-refused",
            ntgpu_compile_wgsl(ctx, kRenderWgsl, std::strlen(kRenderWgsl), "x", &m, &d) == NTGPU_ERR_DEVICE_LOST &&
                m == nullptr);
      check("work-done-after-loss-refused", ntgpu_work_done(ctx, 8) == NTGPU_ERR_DEVICE_LOST);

      // Refused requests: a feature the adapter lacks (checked by the facade; wgpu-native would ignore it) and a
      // limit above the adapter's. Both complete with a DEVICE event carrying the error.
      NtGpuCapabilities adapter;
      ntgpu_adapter_capabilities(ctx, &adapter);
      WGPUFeatureName absent = WGPUFeatureName_Force32;
      for (WGPUFeatureName f : {WGPUFeatureName_Subgroups, WGPUFeatureName_ClipDistances,
                                WGPUFeatureName_TextureFormatsTier2, WGPUFeatureName_CoreFeaturesAndLimits}) {
        bool has = false;
        for (uint32_t i = 0; i < adapter.feature_count; ++i) has = has || adapter.features[i] == f;
        if (!has && absent == WGPUFeatureName_Force32) absent = f;
      }
      if (absent != WGPUFeatureName_Force32) {
        bool refused = ntgpu_request_device(ctx, 20, &absent, 1, nullptr) == NTGPU_ERR_UNAVAILABLE;
        events.clear();
        std::vector<std::string> messages;
        DrainEvents(ctx, &events, &messages);
        check("missing-feature-refused", refused && events.size() == 1 && events[0].kind == NTGPU_EVENT_DEVICE &&
                                             events[0].status == NTGPU_ERR_UNAVAILABLE,
              messages.empty() ? "" : messages[0]);
      }
      WGPULimits too_much = adapter.limits;
      too_much.maxBufferSize = adapter.limits.maxBufferSize * 2;
      bool refused = ntgpu_request_device(ctx, 21, nullptr, 0, &too_much) == NTGPU_ERR_UNAVAILABLE;
      events.clear();
      std::vector<std::string> limit_messages;
      DrainEvents(ctx, &events, &limit_messages);
      check("excess-limit-refused", refused && !events.empty() && events.back().kind == NTGPU_EVENT_DEVICE &&
                                        events.back().status == NTGPU_ERR_UNAVAILABLE,
            limit_messages.empty() ? "" : limit_messages.back());

      // Re-request on the same adapter: new generation, working device.
      check("re-request", ntgpu_request_device(ctx, 9, nullptr, 0, nullptr) == NTGPU_OK);
      events.clear();
      DrainEvents(ctx, &events, nullptr);
      check("device-event-generation-2", events.size() == 1 && events[0].kind == NTGPU_EVENT_DEVICE &&
                                             events[0].generation == 2 && events[0].token == 9,
            events.empty() ? "" : "generation " + std::to_string(events[0].generation));
      check("compile-after-re-request",
            ntgpu_compile_wgsl(ctx, kRenderWgsl, std::strlen(kRenderWgsl), "y", &m, &d) == NTGPU_OK && m);
      if (m) wgpuShaderModuleRelease(m);
      std::string detail;
      bool threaded = ThreadedReadback(ctx, &detail);
      check("threaded-waiter-readback", threaded, detail);

      // Teardown with an outstanding readback: callbacks complete during release and are discarded.
      WGPUBuffer rb = MakeBuffer(ctx, 256, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, "outstanding");
      ntgpu_map_async(ctx, rb, WGPUMapMode_Read, 0, 256, 11);
      check("outstanding-map-before-teardown", ntgpu_pending(ctx) == 1);
      wgpuBufferRelease(rb);  // the device keeps the buffer alive until the map resolves
    }
  }  // Session destructor: ntgpu_context_destroy with the map outstanding
  check("teardown-with-outstanding-map", true, "context destroyed without crash");

  bool all = true;
  j.Key("checks").Begin('[');
  for (const Check &c : checks) {
    j.Begin('{').Key("name").Str(c.name).Key("ok").Bool(c.ok);
    if (!c.detail.empty()) j.Key("detail").Str(c.detail);
    j.End('}');
    all = all && c.ok;
  }
  j.End(']');
  return all;
}

int CmdLifecycle(const Options &opt) {
  Json j;
  j.Begin('{');
  Header(j, "lifecycle");
  bool ok = RunLifecycle(opt, j);
  j.Key("ok").Bool(ok);
  j.End('}');
  std::printf("%s\n", j.str().c_str());
  return ok ? 0 : 1;
}

int CmdSurface(const Options &opt) {
  Json j;
  j.Begin('{');
  Header(j, "surface");
  Session s;
  if (!Open(opt, &s)) return Fail(j, s.error);
  std::string report;
  int ok = ntgpu_probe_surface(s.ctx, &report);
  j.Key("surface").Raw(report);
  j.Key("ok").Bool(ok != 0);
  j.End('}');
  std::printf("%s\n", j.str().c_str());
  return ok ? 0 : 1;
}

void Usage() {
  std::fprintf(stderr,
               "usage: ntgpu-probe <command> [options]\n"
               "commands:\n"
               "  caps                         adapter + device capabilities and limits\n"
               "  shader FILE.wgsl...          shader-module diagnostics, then pipeline validation\n"
               "      --entry NAME             compute pipeline for NAME (repeatable; default: every @compute entry)\n"
               "      --render VS[,FS]         render pipeline (layout auto)\n"
               "      --target FORMAT          colour target (repeatable; default bgra8unorm when FS is given)\n"
               "      --depth FORMAT           depth-stencil format\n"
               "      --vbuf STRIDE[/instance]:LOC=FORMAT@OFFSET[,...]   vertex buffer (repeatable, slot order)\n"
               "      --topology NAME          point-list|line-list|line-strip|triangle-list|triangle-strip\n"
               "      --constant NAME=VALUE    pipeline-overridable constant (repeatable)\n"
               "      --module-only            stop after the shader-module stage\n"
               "  proof                        compute (atomicCompareExchangeWeak) + render readback correctness\n"
               "  lifecycle                    event queue, error scopes, device loss/re-request, teardown checks\n"
               "  surface                      CAMetalLayer surface configure/acquire/clear/present\n"
               "common options:\n"
               "  --power low|high             adapter power preference (default high)\n"
               "  --feature NAME               require a device feature (repeatable, WebGPU name)\n"
               "  --all-features               enable every standard feature the adapter has\n"
               "  --adapter-limits             request the adapter's limits instead of WebGPU defaults\n");
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    Usage();
    return 2;
  }
  std::string cmd = argv[1];
  Options opt;
  ShaderArgs sa;
  for (int i = 2; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&](std::string *out) {
      if (i + 1 >= argc) return false;
      *out = argv[++i];
      return true;
    };
    std::string v;
    uint32_t e;
    if (a == "--power" && next(&v)) {
      if (v == "low") opt.power = WGPUPowerPreference_LowPower;
      else if (v == "high") opt.power = WGPUPowerPreference_HighPerformance;
      else { Usage(); return 2; }
    } else if (a == "--feature" && next(&v)) {
      WGPUFeatureName f;
      if (!ntgpu_feature_from_name(v.c_str(), &f)) { std::fprintf(stderr, "unknown feature %s\n", v.c_str()); return 2; }
      opt.features.push_back(f);
    } else if (a == "--all-features") {
      opt.all_features = true;
    } else if (a == "--adapter-limits") {
      opt.adapter_limits = true;
    } else if (a == "--entry" && next(&v)) {
      size_t colon = v.find(':');
      std::string stage = colon == std::string::npos ? "compute" : v.substr(colon + 1);
      if (stage != "compute") { std::fprintf(stderr, "--entry takes compute entries; use --render\n"); return 2; }
      sa.entries.push_back({v.substr(0, colon), "compute", "argument"});
    } else if (a == "--render" && next(&v)) {
      size_t comma = v.find(',');
      sa.render_vs = v.substr(0, comma);
      if (comma != std::string::npos) sa.render_fs = v.substr(comma + 1);
    } else if (a == "--target" && next(&v)) {
      if (!Lookup(kTextureFormats, v, &e)) { std::fprintf(stderr, "unknown format %s\n", v.c_str()); return 2; }
      sa.targets.push_back(static_cast<WGPUTextureFormat>(e));
    } else if (a == "--depth" && next(&v)) {
      if (!Lookup(kTextureFormats, v, &e)) { std::fprintf(stderr, "unknown format %s\n", v.c_str()); return 2; }
      sa.depth = static_cast<WGPUTextureFormat>(e);
    } else if (a == "--topology" && next(&v)) {
      if (!Lookup(kTopologies, v, &e)) { std::fprintf(stderr, "unknown topology %s\n", v.c_str()); return 2; }
      sa.topology = static_cast<WGPUPrimitiveTopology>(e);
    } else if (a == "--vbuf" && next(&v)) {
      VertexBuffer vb;
      std::string error;
      if (!ParseVertexBuffer(v, &vb, &error)) { std::fprintf(stderr, "%s\n", error.c_str()); return 2; }
      sa.vbufs.push_back(vb);
    } else if (a == "--constant" && next(&v)) {
      size_t eq = v.find('=');
      if (eq == std::string::npos) { Usage(); return 2; }
      sa.constants.push_back({v.substr(0, eq), std::strtod(v.c_str() + eq + 1, nullptr)});
    } else if (a == "--module-only") {
      sa.module_only = true;
    } else if (!a.empty() && a[0] != '-' && cmd == "shader") {
      sa.files.push_back(a);
    } else {
      Usage();
      return 2;
    }
  }
  if (cmd == "caps") return CmdCaps(opt);
  if (cmd == "shader") return CmdShader(opt, sa);
  if (cmd == "proof") return CmdProof(opt);
  if (cmd == "lifecycle") return CmdLifecycle(opt);
  if (cmd == "surface") return CmdSurface(opt);
  Usage();
  return 2;
}

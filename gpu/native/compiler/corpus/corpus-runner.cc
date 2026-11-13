// Replays a WGSL corpus plan (plan.mjs) through the real WebGPU C API of the linked wgpu-native, via the ntgpu
// facade: for each device-limit set the guest requested, a device with exactly those limits; every shader module
// (shader-module stage: WGSL parse + Naga validation); then every captured pipeline descriptor with its explicit bind
// group layouts and pipeline layout (layout stage), and the compute or render pipeline itself (pipeline stage: entry
// point and interface/layout validation, override constants, MSL generation and the Metal library + pipeline state).
//   corpus-runner replay PLAN.json > RESULTS.json   exit 0 when every module and pipeline was created, 1 otherwise
// It also runs small regression fixtures on the GPU (one storage buffer at @group(0) @binding(0), one workgroup):
//   corpus-runner exec FILE.wgsl ENTRY WORDS [OVERRIDE=VALUE...]   prints the module/pipeline results and the
//   buffer's first WORDS u32 values after the dispatch (exit 0 when everything succeeded)
// Correctness only: nothing is timed.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "ntgpu.h"

namespace {

// ---- minimal JSON (the plan is produced by plan.mjs) ------------------------------------------------------------
struct Value {
  enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Value> a;
  std::vector<std::pair<std::string, Value>> o;
  const Value *Get(const char *key) const {
    for (const auto &kv : o) if (kv.first == key) return &kv.second;
    return nullptr;
  }
  const Value &operator[](const char *key) const {
    static const Value null;
    const Value *v = Get(key);
    return v ? *v : null;
  }
  bool IsNull() const { return kind == Null; }
};

class Parser {
 public:
  explicit Parser(const std::string &t) : t_(t) {}
  bool Parse(Value *out) { return ParseValue(out) && (Ws(), i_ == t_.size()); }

 private:
  void Ws() { while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\n' || t_[i_] == '\r' || t_[i_] == '\t')) ++i_; }
  bool Lit(const char *w) {
    size_t n = std::strlen(w);
    if (t_.compare(i_, n, w) != 0) return false;
    i_ += n;
    return true;
  }
  bool ParseString(std::string *out) {
    if (t_[i_] != '"') return false;
    ++i_;
    while (i_ < t_.size() && t_[i_] != '"') {
      char c = t_[i_++];
      if (c != '\\') { out->push_back(c); continue; }
      if (i_ >= t_.size()) return false;
      char e = t_[i_++];
      switch (e) {
        case 'n': out->push_back('\n'); break;
        case 't': out->push_back('\t'); break;
        case 'r': out->push_back('\r'); break;
        case 'b': out->push_back('\b'); break;
        case 'f': out->push_back('\f'); break;
        case 'u': {
          if (i_ + 4 > t_.size()) return false;
          unsigned cp = std::strtoul(t_.substr(i_, 4).c_str(), nullptr, 16);
          i_ += 4;
          if (cp >= 0xD800 && cp < 0xDC00 && t_.compare(i_, 2, "\\u") == 0) {
            unsigned lo = std::strtoul(t_.substr(i_ + 2, 4).c_str(), nullptr, 16);
            i_ += 6;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          if (cp < 0x80) out->push_back(char(cp));
          else if (cp < 0x800) { out->push_back(char(0xC0 | (cp >> 6))); out->push_back(char(0x80 | (cp & 63))); }
          else if (cp < 0x10000) {
            out->push_back(char(0xE0 | (cp >> 12))); out->push_back(char(0x80 | ((cp >> 6) & 63)));
            out->push_back(char(0x80 | (cp & 63)));
          } else {
            out->push_back(char(0xF0 | (cp >> 18))); out->push_back(char(0x80 | ((cp >> 12) & 63)));
            out->push_back(char(0x80 | ((cp >> 6) & 63))); out->push_back(char(0x80 | (cp & 63)));
          }
          break;
        }
        default: out->push_back(e);
      }
    }
    if (i_ >= t_.size()) return false;
    ++i_;
    return true;
  }
  bool ParseValue(Value *v) {
    Ws();
    if (i_ >= t_.size()) return false;
    char c = t_[i_];
    if (c == '{') {
      v->kind = Value::Object;
      ++i_;
      Ws();
      if (t_[i_] == '}') { ++i_; return true; }
      for (;;) {
        Ws();
        std::string key;
        if (!ParseString(&key)) return false;
        Ws();
        if (t_[i_++] != ':') return false;
        v->o.emplace_back(std::move(key), Value());
        if (!ParseValue(&v->o.back().second)) return false;
        Ws();
        if (t_[i_] == ',') { ++i_; continue; }
        if (t_[i_] == '}') { ++i_; return true; }
        return false;
      }
    }
    if (c == '[') {
      v->kind = Value::Array;
      ++i_;
      Ws();
      if (t_[i_] == ']') { ++i_; return true; }
      for (;;) {
        v->a.emplace_back();
        if (!ParseValue(&v->a.back())) return false;
        Ws();
        if (t_[i_] == ',') { ++i_; continue; }
        if (t_[i_] == ']') { ++i_; return true; }
        return false;
      }
    }
    if (c == '"') { v->kind = Value::String; return ParseString(&v->s); }
    if (Lit("true")) { v->kind = Value::Bool; v->b = true; return true; }
    if (Lit("false")) { v->kind = Value::Bool; return true; }
    if (Lit("null")) return true;
    char *end = nullptr;
    v->n = std::strtod(t_.c_str() + i_, &end);
    if (end == t_.c_str() + i_) return false;
    v->kind = Value::Number;
    i_ = size_t(end - t_.c_str());
    return true;
  }
  const std::string &t_;
  size_t i_ = 0;
};

// ---- JSON output ---------------------------------------------------------------------------------------------------
std::string Quote(const std::string &s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += char(c);
  }
  return o + "\"";
}

// ---- WebGPU JS names -> webgpu.h enums (the core WebGPU spellings the corpus can contain) ---------------------------
template <typename T>
struct Name { const char *name; T value; };

const Name<WGPUTextureFormat> kFormats[] = {
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
    {"rg11b10ufloat", WGPUTextureFormat_RG11B10Ufloat}, {"rgb9e5ufloat", WGPUTextureFormat_RGB9E5Ufloat},
    {"rg32float", WGPUTextureFormat_RG32Float}, {"rg32uint", WGPUTextureFormat_RG32Uint},
    {"rg32sint", WGPUTextureFormat_RG32Sint}, {"rgba16uint", WGPUTextureFormat_RGBA16Uint},
    {"rgba16sint", WGPUTextureFormat_RGBA16Sint}, {"rgba16float", WGPUTextureFormat_RGBA16Float},
    {"rgba32float", WGPUTextureFormat_RGBA32Float}, {"rgba32uint", WGPUTextureFormat_RGBA32Uint},
    {"rgba32sint", WGPUTextureFormat_RGBA32Sint}, {"stencil8", WGPUTextureFormat_Stencil8},
    {"depth16unorm", WGPUTextureFormat_Depth16Unorm}, {"depth24plus", WGPUTextureFormat_Depth24Plus},
    {"depth24plus-stencil8", WGPUTextureFormat_Depth24PlusStencil8}, {"depth32float", WGPUTextureFormat_Depth32Float},
    {"depth32float-stencil8", WGPUTextureFormat_Depth32FloatStencil8},
};
const Name<WGPUVertexFormat> kVertexFormats[] = {
    {"uint8x2", WGPUVertexFormat_Uint8x2}, {"uint8x4", WGPUVertexFormat_Uint8x4},
    {"sint8x2", WGPUVertexFormat_Sint8x2}, {"sint8x4", WGPUVertexFormat_Sint8x4},
    {"unorm8x2", WGPUVertexFormat_Unorm8x2}, {"unorm8x4", WGPUVertexFormat_Unorm8x4},
    {"snorm8x2", WGPUVertexFormat_Snorm8x2}, {"snorm8x4", WGPUVertexFormat_Snorm8x4},
    {"uint16x2", WGPUVertexFormat_Uint16x2}, {"uint16x4", WGPUVertexFormat_Uint16x4},
    {"sint16x2", WGPUVertexFormat_Sint16x2}, {"sint16x4", WGPUVertexFormat_Sint16x4},
    {"unorm16x2", WGPUVertexFormat_Unorm16x2}, {"unorm16x4", WGPUVertexFormat_Unorm16x4},
    {"snorm16x2", WGPUVertexFormat_Snorm16x2}, {"snorm16x4", WGPUVertexFormat_Snorm16x4},
    {"float16x2", WGPUVertexFormat_Float16x2}, {"float16x4", WGPUVertexFormat_Float16x4},
    {"float32", WGPUVertexFormat_Float32}, {"float32x2", WGPUVertexFormat_Float32x2},
    {"float32x3", WGPUVertexFormat_Float32x3}, {"float32x4", WGPUVertexFormat_Float32x4},
    {"uint32", WGPUVertexFormat_Uint32}, {"uint32x2", WGPUVertexFormat_Uint32x2},
    {"uint32x3", WGPUVertexFormat_Uint32x3}, {"uint32x4", WGPUVertexFormat_Uint32x4},
    {"sint32", WGPUVertexFormat_Sint32}, {"sint32x2", WGPUVertexFormat_Sint32x2},
    {"sint32x3", WGPUVertexFormat_Sint32x3}, {"sint32x4", WGPUVertexFormat_Sint32x4},
};
const Name<WGPUBufferBindingType> kBufferTypes[] = {
    {"uniform", WGPUBufferBindingType_Uniform}, {"storage", WGPUBufferBindingType_Storage},
    {"read-only-storage", WGPUBufferBindingType_ReadOnlyStorage}};
const Name<WGPUSamplerBindingType> kSamplerTypes[] = {
    {"filtering", WGPUSamplerBindingType_Filtering}, {"non-filtering", WGPUSamplerBindingType_NonFiltering},
    {"comparison", WGPUSamplerBindingType_Comparison}};
const Name<WGPUTextureSampleType> kSampleTypes[] = {
    {"float", WGPUTextureSampleType_Float}, {"unfilterable-float", WGPUTextureSampleType_UnfilterableFloat},
    {"depth", WGPUTextureSampleType_Depth}, {"sint", WGPUTextureSampleType_Sint}, {"uint", WGPUTextureSampleType_Uint}};
const Name<WGPUTextureViewDimension> kViewDimensions[] = {
    {"1d", WGPUTextureViewDimension_1D}, {"2d", WGPUTextureViewDimension_2D},
    {"2d-array", WGPUTextureViewDimension_2DArray}, {"cube", WGPUTextureViewDimension_Cube},
    {"cube-array", WGPUTextureViewDimension_CubeArray}, {"3d", WGPUTextureViewDimension_3D}};
const Name<WGPUStorageTextureAccess> kAccess[] = {
    {"write-only", WGPUStorageTextureAccess_WriteOnly}, {"read-only", WGPUStorageTextureAccess_ReadOnly},
    {"read-write", WGPUStorageTextureAccess_ReadWrite}};
const Name<WGPUCompareFunction> kCompare[] = {
    {"never", WGPUCompareFunction_Never}, {"less", WGPUCompareFunction_Less}, {"equal", WGPUCompareFunction_Equal},
    {"less-equal", WGPUCompareFunction_LessEqual}, {"greater", WGPUCompareFunction_Greater},
    {"not-equal", WGPUCompareFunction_NotEqual}, {"greater-equal", WGPUCompareFunction_GreaterEqual},
    {"always", WGPUCompareFunction_Always}};
const Name<WGPUStencilOperation> kStencilOps[] = {
    {"keep", WGPUStencilOperation_Keep}, {"zero", WGPUStencilOperation_Zero},
    {"replace", WGPUStencilOperation_Replace}, {"invert", WGPUStencilOperation_Invert},
    {"increment-clamp", WGPUStencilOperation_IncrementClamp}, {"decrement-clamp", WGPUStencilOperation_DecrementClamp},
    {"increment-wrap", WGPUStencilOperation_IncrementWrap}, {"decrement-wrap", WGPUStencilOperation_DecrementWrap}};
const Name<WGPUBlendFactor> kBlendFactors[] = {
    {"zero", WGPUBlendFactor_Zero}, {"one", WGPUBlendFactor_One}, {"src", WGPUBlendFactor_Src},
    {"one-minus-src", WGPUBlendFactor_OneMinusSrc}, {"src-alpha", WGPUBlendFactor_SrcAlpha},
    {"one-minus-src-alpha", WGPUBlendFactor_OneMinusSrcAlpha}, {"dst", WGPUBlendFactor_Dst},
    {"one-minus-dst", WGPUBlendFactor_OneMinusDst}, {"dst-alpha", WGPUBlendFactor_DstAlpha},
    {"one-minus-dst-alpha", WGPUBlendFactor_OneMinusDstAlpha}, {"src-alpha-saturated", WGPUBlendFactor_SrcAlphaSaturated},
    {"constant", WGPUBlendFactor_Constant}, {"one-minus-constant", WGPUBlendFactor_OneMinusConstant}};
const Name<WGPUBlendOperation> kBlendOps[] = {
    {"add", WGPUBlendOperation_Add}, {"subtract", WGPUBlendOperation_Subtract},
    {"reverse-subtract", WGPUBlendOperation_ReverseSubtract}, {"min", WGPUBlendOperation_Min},
    {"max", WGPUBlendOperation_Max}};
const Name<WGPUPrimitiveTopology> kTopologies[] = {
    {"point-list", WGPUPrimitiveTopology_PointList}, {"line-list", WGPUPrimitiveTopology_LineList},
    {"line-strip", WGPUPrimitiveTopology_LineStrip}, {"triangle-list", WGPUPrimitiveTopology_TriangleList},
    {"triangle-strip", WGPUPrimitiveTopology_TriangleStrip}};
const Name<WGPUIndexFormat> kIndexFormats[] = {{"uint16", WGPUIndexFormat_Uint16}, {"uint32", WGPUIndexFormat_Uint32}};
const Name<WGPUFrontFace> kFrontFaces[] = {{"ccw", WGPUFrontFace_CCW}, {"cw", WGPUFrontFace_CW}};
const Name<WGPUCullMode> kCullModes[] = {
    {"none", WGPUCullMode_None}, {"front", WGPUCullMode_Front}, {"back", WGPUCullMode_Back}};
const Name<WGPUVertexStepMode> kStepModes[] = {
    {"vertex", WGPUVertexStepMode_Vertex}, {"instance", WGPUVertexStepMode_Instance}};

struct Unsupported { std::string what; };

template <typename T, size_t N>
T Enum(const Name<T> (&table)[N], const Value &v, const char *what, T fallback) {
  if (v.IsNull()) return fallback;
  for (const auto &e : table) if (v.s == e.name) return e.value;
  throw Unsupported{std::string(what) + " '" + v.s + "'"};
}

// ---- device limits by WebGPU name -----------------------------------------------------------------------------------
bool SetLimit(WGPULimits *l, const std::string &name, double value) {
#define NT_U32(field) if (name == #field) { l->field = uint32_t(value); return true; }
#define NT_U64(field) if (name == #field) { l->field = uint64_t(value); return true; }
  NT_U32(maxTextureDimension1D) NT_U32(maxTextureDimension2D) NT_U32(maxTextureDimension3D)
  NT_U32(maxTextureArrayLayers) NT_U32(maxBindGroups) NT_U32(maxBindGroupsPlusVertexBuffers)
  NT_U32(maxBindingsPerBindGroup) NT_U32(maxDynamicUniformBuffersPerPipelineLayout)
  NT_U32(maxDynamicStorageBuffersPerPipelineLayout) NT_U32(maxSampledTexturesPerShaderStage)
  NT_U32(maxSamplersPerShaderStage) NT_U32(maxStorageBuffersPerShaderStage) NT_U32(maxStorageTexturesPerShaderStage)
  NT_U32(maxUniformBuffersPerShaderStage) NT_U64(maxUniformBufferBindingSize) NT_U64(maxStorageBufferBindingSize)
  NT_U32(minUniformBufferOffsetAlignment) NT_U32(minStorageBufferOffsetAlignment) NT_U32(maxVertexBuffers)
  NT_U64(maxBufferSize) NT_U32(maxVertexAttributes) NT_U32(maxVertexBufferArrayStride)
  NT_U32(maxInterStageShaderVariables) NT_U32(maxColorAttachments) NT_U32(maxColorAttachmentBytesPerSample)
  NT_U32(maxComputeWorkgroupStorageSize) NT_U32(maxComputeInvocationsPerWorkgroup) NT_U32(maxComputeWorkgroupSizeX)
  NT_U32(maxComputeWorkgroupSizeY) NT_U32(maxComputeWorkgroupSizeZ) NT_U32(maxComputeWorkgroupsPerDimension)
#undef NT_U32
#undef NT_U64
  return false;
}

WGPUStringView View(const std::string &s) { return WGPUStringView{s.data(), s.size()}; }

void Drain(NtGpuContext *ctx, std::vector<std::string> *uncaptured) {
  NtGpuEvent e;
  while (ntgpu_next_event(ctx, &e)) {
    if (e.kind == NTGPU_EVENT_UNCAPTURED_ERROR) uncaptured->push_back(e.message ? e.message : "uncaptured error");
    // Requesting the next limit set's device destroys the previous one; any other loss is a failure.
    if (e.kind == NTGPU_EVENT_DEVICE_LOST && e.detail != WGPUDeviceLostReason_Destroyed) {
      uncaptured->push_back(std::string("device lost: ") + (e.message ? e.message : ""));
    }
  }
}

std::string DiagFields(const NtGpuDiag &d, NtGpuStatus st) {
  std::string o = "\"ok\":" + std::string(st == NTGPU_OK ? "true" : "false") + ",\"status\":" + Quote(ntgpu_status_name(st));
  if (st != NTGPU_OK && d.message) o += ",\"message\":" + Quote(d.message);
  return o;
}

// Owns everything one pipeline replay creates.
struct Scratch {
  std::vector<WGPUBindGroupLayout> bgls;
  WGPUPipelineLayout layout = nullptr;
  ~Scratch() {
    if (layout) wgpuPipelineLayoutRelease(layout);
    for (auto b : bgls) if (b) wgpuBindGroupLayoutRelease(b);
  }
};

// Creates the explicit bind group layouts and the pipeline layout; on failure fills *diag and returns its status.
NtGpuStatus MakeLayout(NtGpuContext *ctx, const Value &layout, Scratch *s, NtGpuDiag *diag, std::string *diag_text) {
  WGPUDevice device = ntgpu_device(ctx);
  ntgpu_scope_push(ctx, WGPUErrorFilter_Validation);
  for (const Value &group : layout.a) {
    std::vector<WGPUBindGroupLayoutEntry> entries;
    for (const Value &e : group.a) {
      WGPUBindGroupLayoutEntry x = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
      x.binding = uint32_t(e["binding"].n);
      x.visibility = WGPUShaderStage(uint64_t(e["visibility"].n));
      if (const Value *b = e.Get("buffer")) {
        x.buffer = WGPU_BUFFER_BINDING_LAYOUT_INIT;
        x.buffer.type = Enum(kBufferTypes, (*b)["type"], "buffer type", WGPUBufferBindingType_Uniform);
        x.buffer.hasDynamicOffset = (*b)["hasDynamicOffset"].b ? WGPU_TRUE : WGPU_FALSE;
        x.buffer.minBindingSize = uint64_t((*b)["minBindingSize"].n);
      } else if (const Value *sm = e.Get("sampler")) {
        x.sampler = WGPU_SAMPLER_BINDING_LAYOUT_INIT;
        x.sampler.type = Enum(kSamplerTypes, (*sm)["type"], "sampler type", WGPUSamplerBindingType_Filtering);
      } else if (const Value *t = e.Get("texture")) {
        x.texture = WGPU_TEXTURE_BINDING_LAYOUT_INIT;
        x.texture.sampleType = Enum(kSampleTypes, (*t)["sampleType"], "sample type", WGPUTextureSampleType_Float);
        x.texture.viewDimension =
            Enum(kViewDimensions, (*t)["viewDimension"], "view dimension", WGPUTextureViewDimension_2D);
        x.texture.multisampled = (*t)["multisampled"].b ? WGPU_TRUE : WGPU_FALSE;
      } else if (const Value *st = e.Get("storageTexture")) {
        x.storageTexture = WGPU_STORAGE_TEXTURE_BINDING_LAYOUT_INIT;
        x.storageTexture.access = Enum(kAccess, (*st)["access"], "storage access", WGPUStorageTextureAccess_WriteOnly);
        x.storageTexture.format = Enum(kFormats, (*st)["format"], "format", WGPUTextureFormat_Undefined);
        x.storageTexture.viewDimension =
            Enum(kViewDimensions, (*st)["viewDimension"], "view dimension", WGPUTextureViewDimension_2D);
      } else {
        throw Unsupported{"bind group layout entry without a known resource type"};
      }
      entries.push_back(x);
    }
    WGPUBindGroupLayoutDescriptor d = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    d.entryCount = entries.size();
    d.entries = entries.data();
    s->bgls.push_back(wgpuDeviceCreateBindGroupLayout(device, &d));
  }
  WGPUPipelineLayoutDescriptor pd = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
  pd.bindGroupLayoutCount = s->bgls.size();
  pd.bindGroupLayouts = s->bgls.data();
  s->layout = wgpuDeviceCreatePipelineLayout(device, &pd);
  ntgpu_scope_pop(ctx, diag);
  if (diag->message) *diag_text = diag->message;
  return NtGpuStatus(diag->status);
}

std::vector<WGPUConstantEntry> Constants(const Value &stage, std::deque<std::string> *keep) {
  std::vector<WGPUConstantEntry> out;
  const Value &list = stage["constants"];
  for (const Value &kv : list.a) {
    keep->push_back(kv.a[0].s);
    WGPUConstantEntry e = WGPU_CONSTANT_ENTRY_INIT;
    e.key = View(keep->back());
    e.value = kv.a[1].n;
    out.push_back(e);
  }
  return out;
}

WGPUBlendComponent Blend(const Value &c) {
  WGPUBlendComponent b = WGPU_BLEND_COMPONENT_INIT;
  b.operation = Enum(kBlendOps, c["operation"], "blend operation", WGPUBlendOperation_Add);
  b.srcFactor = Enum(kBlendFactors, c["srcFactor"], "blend factor", WGPUBlendFactor_One);
  b.dstFactor = Enum(kBlendFactors, c["dstFactor"], "blend factor", WGPUBlendFactor_Zero);
  return b;
}

WGPUStencilFaceState Face(const Value &f) {
  WGPUStencilFaceState s = WGPU_STENCIL_FACE_STATE_INIT;
  s.compare = Enum(kCompare, f["compare"], "compare", WGPUCompareFunction_Always);
  s.failOp = Enum(kStencilOps, f["failOp"], "stencil op", WGPUStencilOperation_Keep);
  s.depthFailOp = Enum(kStencilOps, f["depthFailOp"], "stencil op", WGPUStencilOperation_Keep);
  s.passOp = Enum(kStencilOps, f["passOp"], "stencil op", WGPUStencilOperation_Keep);
  return s;
}

struct Module {
  std::string sha, path, source;
  WGPUShaderModule handle = nullptr;
};

std::string Entries(const Value &p) {
  std::string o;
  for (const char *st : {"compute", "vertex", "fragment"}) {
    const Value *s = p.Get(st);
    if (!s || s->IsNull()) continue;
    if (!o.empty()) o += ",";
    o += std::string(st) + ":" + (*s)["entryPoint"].s;
  }
  return o;
}

bool OpenDevice(NtGpuContext **ctx, NtGpuCapabilities *adapter, std::vector<WGPUFeatureName> *features) {
  NtGpuContextOptions copt{};
  copt.api_version = NTGPU_API_VERSION;
  copt.message_limit = 16384;
  if (ntgpu_context_create(&copt, ctx) != NTGPU_OK ||
      ntgpu_request_adapter(*ctx, 1, WGPUPowerPreference_HighPerformance) != NTGPU_OK) {
    return false;
  }
  ntgpu_adapter_capabilities(*ctx, adapter);
  // The guest asks for timestamp-query when the adapter has it (optional feature); nothing else.
  WGPUFeatureName ts;
  if (ntgpu_feature_from_name("timestamp-query", &ts)) {
    for (uint32_t i = 0; i < adapter->feature_count; ++i) if (adapter->features[i] == ts) features->push_back(ts);
  }
  return true;
}

bool ReadFile(const std::string &path, std::string *out) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream s;
  s << f.rdbuf();
  *out = s.str();
  return bool(f);
}

int Exec(int argc, char **argv) {
  if (argc < 5) {
    std::fprintf(stderr, "usage: corpus-runner exec FILE.wgsl ENTRY WORDS [OVERRIDE=VALUE...]\n");
    return 2;
  }
  std::string source;
  if (!ReadFile(argv[2], &source)) {
    std::fprintf(stderr, "corpus-runner: cannot read %s\n", argv[2]);
    return 2;
  }
  const std::string entry = argv[3];
  const uint64_t words = std::strtoull(argv[4], nullptr, 10);
  std::deque<std::string> keys;
  std::vector<WGPUConstantEntry> constants;
  for (int i = 5; i < argc; ++i) {
    std::string kv = argv[i];
    size_t eq = kv.find('=');
    if (eq == std::string::npos) return 2;
    keys.push_back(kv.substr(0, eq));
    WGPUConstantEntry e = WGPU_CONSTANT_ENTRY_INIT;
    e.key = View(keys.back());
    e.value = std::strtod(kv.c_str() + eq + 1, nullptr);
    constants.push_back(e);
  }
  NtGpuContext *ctx = nullptr;
  NtGpuCapabilities adapter;
  std::vector<WGPUFeatureName> features;
  if (!OpenDevice(&ctx, &adapter, &features) ||
      ntgpu_request_device(ctx, 2, features.data(), features.size(), nullptr) != NTGPU_OK) {
    std::fprintf(stderr, "corpus-runner: no device\n");
    return 2;
  }
  std::vector<std::string> uncaptured;
  Drain(ctx, &uncaptured);
  std::string out = "{";
  WGPUShaderModule module = nullptr;
  NtGpuDiag d{};
  NtGpuStatus st = ntgpu_compile_wgsl(ctx, source.data(), source.size(), argv[2], &module, &d);
  out += "\"module\":{" + DiagFields(d, st) + "}";
  bool ok = st == NTGPU_OK;
  WGPUComputePipeline pipeline = nullptr;
  if (ok) {
    d = NtGpuDiag{};
    st = ntgpu_create_compute_pipeline(ctx, module, entry.c_str(), constants.data(), constants.size(), nullptr,
                                       &pipeline, &d);
    out += ",\"pipeline\":{" + DiagFields(d, st) + "}";
    ok = st == NTGPU_OK;
  }
  if (ok) {
    WGPUDevice device = ntgpu_device(ctx);
    const uint64_t size = words * 4;
    WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
    bd.size = size;
    bd.usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc;
    WGPUBuffer storage = wgpuDeviceCreateBuffer(device, &bd);
    bd.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    WGPUBuffer readback = wgpuDeviceCreateBuffer(device, &bd);
    WGPUBindGroupEntry be = WGPU_BIND_GROUP_ENTRY_INIT;
    be.binding = 0;
    be.buffer = storage;
    be.size = size;
    WGPUBindGroupDescriptor bgd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    WGPUBindGroupLayout bgl = wgpuComputePipelineGetBindGroupLayout(pipeline, 0);
    bgd.layout = bgl;
    bgd.entryCount = 1;
    bgd.entries = &be;
    WGPUBindGroup group = wgpuDeviceCreateBindGroup(device, &bgd);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, nullptr);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(enc, nullptr);
    wgpuComputePassEncoderSetPipeline(pass, pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, 1, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuCommandEncoderCopyBufferToBuffer(enc, storage, 0, readback, 0, size);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
    wgpuQueueSubmit(ntgpu_queue(ctx), 1, &cmd);
    std::string error;
    bool mapped = ntgpu_map_async(ctx, readback, WGPUMapMode_Read, 0, size, 7) == NTGPU_OK;
    while (mapped && ntgpu_process(ctx, 1) > 0) {
    }
    NtGpuEvent ev;
    bool map_event = false;
    while (ntgpu_next_event(ctx, &ev)) {
      if (ev.kind == NTGPU_EVENT_MAP && ev.token == 7) map_event = ev.status == NTGPU_OK;
      if (ev.kind == NTGPU_EVENT_UNCAPTURED_ERROR) uncaptured.push_back(ev.message ? ev.message : "uncaptured error");
    }
    const uint32_t *data =
        map_event ? static_cast<const uint32_t *>(wgpuBufferGetConstMappedRange(readback, 0, size)) : nullptr;
    out += ",\"words\":[";
    for (uint64_t i = 0; data && i < words; ++i) out += (i ? "," : "") + std::to_string(data[i]);
    out += "]";
    ok = data != nullptr;
    if (data) wgpuBufferUnmap(readback);
    wgpuCommandBufferRelease(cmd);
    wgpuComputePassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuBindGroupRelease(group);
    wgpuBindGroupLayoutRelease(bgl);
    wgpuBufferRelease(readback);
    wgpuBufferRelease(storage);
  }
  if (pipeline) wgpuComputePipelineRelease(pipeline);
  if (module) wgpuShaderModuleRelease(module);
  Drain(ctx, &uncaptured);
  out += ",\"uncapturedErrors\":" + std::to_string(uncaptured.size()) + "}\n";
  std::fwrite(out.data(), 1, out.size(), stdout);
  ntgpu_context_destroy(ctx);
  return ok && uncaptured.empty() ? 0 : 1;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc >= 2 && std::string(argv[1]) == "exec") return Exec(argc, argv);
  if (argc != 3 || std::string(argv[1]) != "replay") {
    std::fprintf(stderr, "usage: corpus-runner replay PLAN.json | exec FILE.wgsl ENTRY WORDS [OVERRIDE=VALUE...]\n");
    return 2;
  }
  std::ifstream in(argv[2], std::ios::binary);
  std::stringstream buf;
  buf << in.rdbuf();
  std::string text = buf.str();
  Value plan;
  if (!in || !Parser(text).Parse(&plan)) {
    std::fprintf(stderr, "corpus-runner: cannot parse %s\n", argv[2]);
    return 2;
  }

  NtGpuContext *ctx = nullptr;
  NtGpuCapabilities adapter;
  std::vector<WGPUFeatureName> features;
  if (!OpenDevice(&ctx, &adapter, &features)) {
    std::fprintf(stderr, "corpus-runner: no adapter\n");
    return 2;
  }

  std::vector<Module> modules;
  for (const Value &m : plan["modules"].a) {
    Module mod;
    mod.sha = m["sha256"].s;
    mod.path = m["path"].s;
    if (!ReadFile(mod.path, &mod.source)) {
      std::fprintf(stderr, "corpus-runner: cannot read %s\n", mod.path.c_str());
      return 2;
    }
    modules.push_back(std::move(mod));
  }
  auto find_module = [&](const std::string &sha) -> Module * {
    for (Module &m : modules) if (m.sha == sha) return &m;
    return nullptr;
  };

  std::string out = "{\"implementation\":" + Quote(ntgpu_implementation_name());
  char version[32];
  uint32_t v = ntgpu_implementation_version();
  std::snprintf(version, sizeof version, "%u.%u.%u.%u", v >> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  out += ",\"version\":" + Quote(version) + ",\"backend\":" + Quote(ntgpu_backend_name(adapter.backend));
  out += ",\"adapter\":" + Quote(adapter.device ? adapter.device : "") + ",\"limitSets\":[";
  std::string module_json, pipeline_json;
  size_t modules_ok = 0, modules_total = 0, layouts_failed = 0, pipelines_ok = 0, pipelines_total = 0, unsupported = 0;
  std::vector<std::string> uncaptured;
  bool first_set = true;
  for (const auto &set : plan["limitSets"].o) {
    const std::string &set_name = set.first;
    WGPULimits limits = WGPU_LIMITS_INIT;
    std::string limit_json;
    for (const auto &kv : set.second.o) {
      if (!SetLimit(&limits, kv.first, kv.second.n)) {
        std::fprintf(stderr, "corpus-runner: unknown limit %s\n", kv.first.c_str());
        return 2;
      }
      limit_json += (limit_json.empty() ? "" : ",") + Quote(kv.first) + ":" + std::to_string(uint64_t(kv.second.n));
    }
    if (ntgpu_request_device(ctx, 2, features.data(), features.size(), &limits) != NTGPU_OK) {
      std::fprintf(stderr, "corpus-runner: device request with %s failed\n", set_name.c_str());
      return 2;
    }
    Drain(ctx, &uncaptured);
    out += std::string(first_set ? "" : ",") + "{\"name\":" + Quote(set_name) + ",\"requiredLimits\":{" + limit_json +
           "},\"features\":" + (features.empty() ? "[]" : "[\"timestamp-query\"]") + "}";
    first_set = false;

    // Shader-module stage: every module, on this device.
    for (Module &m : modules) {
      NtGpuDiag d{};
      NtGpuStatus st = ntgpu_compile_wgsl(ctx, m.source.data(), m.source.size(), m.sha.substr(0, 12).c_str(), &m.handle, &d);
      ++modules_total;
      modules_ok += st == NTGPU_OK;
      std::string row = "{\"limits\":" + Quote(set_name) + ",\"sha256\":" + Quote(m.sha) + ",\"path\":" + Quote(m.path) +
                        ",\"stage\":\"shader-module\"," + DiagFields(d, st);
      NtGpuSourceLocation loc{};
      if (st != NTGPU_OK && ntgpu_wgsl_location(d.message, m.source.data(), m.source.size(), &loc)) {
        row += ",\"location\":{\"lineNum\":" + std::to_string(loc.line_num) + ",\"linePos\":" + std::to_string(loc.line_pos) + "}";
      }
      module_json += (module_json.empty() ? "" : ",\n") + row + "}";
      Drain(ctx, &uncaptured);
    }

    // Pipelines created under this limit set: layout stage, then pipeline stage.
    for (const Value &p : plan["pipelines"].a) {
      if (p["limits"].s != set_name) continue;
      ++pipelines_total;
      std::string row = "{\"id\":" + std::to_string(int(p["id"].n)) + ",\"limits\":" + Quote(set_name) + ",\"kind\":" +
                        Quote(p["kind"].s) + ",\"entries\":" + Quote(Entries(p)) + ",\"label\":" + Quote(p["labels"].a[0].s);
      const Value &stage0 = p["kind"].s == "compute" ? p["compute"] : p["vertex"];
      Module *mod = find_module(stage0["module"].s);
      row += ",\"module\":" + Quote(stage0["module"].s);
      if (!mod || !mod->handle) {
        row += ",\"stage\":\"shader-module\",\"ok\":false,\"status\":\"module-failed\"}";
        pipeline_json += (pipeline_json.empty() ? "" : ",\n") + row;
        continue;
      }
      try {
        Scratch s;
        NtGpuDiag d{};
        std::string text;
        NtGpuStatus st = MakeLayout(ctx, p["layout"], &s, &d, &text);
        if (st != NTGPU_OK) {
          ++layouts_failed;
          row += ",\"stage\":\"layout\"," + DiagFields(d, st) + "}";
          pipeline_json += (pipeline_json.empty() ? "" : ",\n") + row;
          continue;
        }
        std::deque<std::string> keys;  // stable addresses for the constant keys
        if (p["kind"].s == "compute") {
          std::vector<WGPUConstantEntry> c = Constants(p["compute"], &keys);
          WGPUComputePipeline cp = nullptr;
          d = NtGpuDiag{};
          st = ntgpu_create_compute_pipeline(ctx, mod->handle, p["compute"]["entryPoint"].s.c_str(), c.data(), c.size(),
                                             s.layout, &cp, &d);
          if (cp) wgpuComputePipelineRelease(cp);
          row += ",\"stage\":\"compute-pipeline\"," + DiagFields(d, st);
        } else {
          const Value &vs = p["vertex"];
          const Value &fs = p["fragment"];
          std::vector<WGPUConstantEntry> vc = Constants(vs, &keys);
          std::vector<std::vector<WGPUVertexAttribute>> attrs;
          std::vector<WGPUVertexBufferLayout> buffers;
          attrs.reserve(vs["buffers"].a.size());
          for (const Value &b : vs["buffers"].a) {
            attrs.emplace_back();
            for (const Value &a : b["attributes"].a) {
              WGPUVertexAttribute x = WGPU_VERTEX_ATTRIBUTE_INIT;
              x.format = Enum(kVertexFormats, a["format"], "vertex format", WGPUVertexFormat_Float32);
              x.offset = uint64_t(a["offset"].n);
              x.shaderLocation = uint32_t(a["shaderLocation"].n);
              attrs.back().push_back(x);
            }
            WGPUVertexBufferLayout l = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
            l.stepMode = Enum(kStepModes, b["stepMode"], "step mode", WGPUVertexStepMode_Vertex);
            l.arrayStride = uint64_t(b["arrayStride"].n);
            l.attributeCount = attrs.back().size();
            l.attributes = attrs.back().data();
            buffers.push_back(l);
          }
          WGPURenderPipelineDescriptor rd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
          rd.layout = s.layout;
          Module *vmod = find_module(vs["module"].s);
          rd.vertex.module = vmod ? vmod->handle : nullptr;
          rd.vertex.entryPoint = View(vs["entryPoint"].s);
          rd.vertex.constantCount = vc.size();
          rd.vertex.constants = vc.data();
          rd.vertex.bufferCount = buffers.size();
          rd.vertex.buffers = buffers.data();
          const Value &prim = p["primitive"];
          rd.primitive.topology = Enum(kTopologies, prim["topology"], "topology", WGPUPrimitiveTopology_TriangleList);
          rd.primitive.stripIndexFormat = Enum(kIndexFormats, prim["stripIndexFormat"], "index format", WGPUIndexFormat_Undefined);
          rd.primitive.frontFace = Enum(kFrontFaces, prim["frontFace"], "front face", WGPUFrontFace_CCW);
          rd.primitive.cullMode = Enum(kCullModes, prim["cullMode"], "cull mode", WGPUCullMode_None);
          rd.primitive.unclippedDepth = prim["unclippedDepth"].b ? WGPU_TRUE : WGPU_FALSE;
          WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
          const Value &dsv = p["depthStencil"];
          if (!dsv.IsNull()) {
            ds.format = Enum(kFormats, dsv["format"], "format", WGPUTextureFormat_Undefined);
            ds.depthWriteEnabled = dsv["depthWriteEnabled"].b ? WGPUOptionalBool_True : WGPUOptionalBool_False;
            ds.depthCompare = Enum(kCompare, dsv["depthCompare"], "compare", WGPUCompareFunction_Undefined);
            ds.stencilFront = Face(dsv["stencilFront"]);
            ds.stencilBack = Face(dsv["stencilBack"]);
            if (const Value *m = dsv.Get("stencilReadMask")) ds.stencilReadMask = uint32_t(m->n);
            if (const Value *m = dsv.Get("stencilWriteMask")) ds.stencilWriteMask = uint32_t(m->n);
            ds.depthBias = int32_t(dsv["depthBias"].n);
            ds.depthBiasSlopeScale = float(dsv["depthBiasSlopeScale"].n);
            ds.depthBiasClamp = float(dsv["depthBiasClamp"].n);
            rd.depthStencil = &ds;
          }
          const Value &ms = p["multisample"];
          if (!ms.IsNull()) {
            if (const Value *c = ms.Get("count")) rd.multisample.count = uint32_t(c->n);
            if (const Value *m = ms.Get("mask")) rd.multisample.mask = uint32_t(m->n);
            rd.multisample.alphaToCoverageEnabled = ms["alphaToCoverageEnabled"].b ? WGPU_TRUE : WGPU_FALSE;
          }
          std::vector<WGPUConstantEntry> fc;
          std::vector<WGPUColorTargetState> targets;
          std::vector<WGPUBlendState> blends;
          WGPUFragmentState frag = WGPU_FRAGMENT_STATE_INIT;
          if (!fs.IsNull()) {
            fc = Constants(fs, &keys);
            blends.reserve(fs["targets"].a.size());
            for (const Value &t : fs["targets"].a) {
              WGPUColorTargetState c = WGPU_COLOR_TARGET_STATE_INIT;
              c.format = Enum(kFormats, t["format"], "format", WGPUTextureFormat_Undefined);
              if (const Value *w = t.Get("writeMask")) c.writeMask = WGPUColorWriteMask(uint64_t(w->n));
              if (const Value *b = t.Get("blend")) {
                WGPUBlendState bs = WGPU_BLEND_STATE_INIT;
                bs.color = Blend((*b)["color"]);
                bs.alpha = Blend((*b)["alpha"]);
                blends.push_back(bs);
                c.blend = &blends.back();
              }
              targets.push_back(c);
            }
            Module *fmod = find_module(fs["module"].s);
            frag.module = fmod ? fmod->handle : nullptr;
            frag.entryPoint = View(fs["entryPoint"].s);
            frag.constantCount = fc.size();
            frag.constants = fc.data();
            frag.targetCount = targets.size();
            frag.targets = targets.data();
            rd.fragment = &frag;
          }
          WGPURenderPipeline rp = nullptr;
          d = NtGpuDiag{};
          st = ntgpu_create_render_pipeline(ctx, &rd, &rp, &d);
          if (rp) wgpuRenderPipelineRelease(rp);
          row += ",\"stage\":\"render-pipeline\"," + DiagFields(d, st);
        }
        pipelines_ok += st == NTGPU_OK;
      } catch (const Unsupported &u) {
        ++unsupported;
        row += ",\"stage\":\"runner\",\"ok\":false,\"status\":\"unsupported\",\"message\":" + Quote(u.what);
      }
      row += "}";
      pipeline_json += (pipeline_json.empty() ? "" : ",\n") + row;
      Drain(ctx, &uncaptured);
    }
    for (Module &m : modules) {
      if (m.handle) wgpuShaderModuleRelease(m.handle);
      m.handle = nullptr;
    }
  }
  Drain(ctx, &uncaptured);
  out += "],\n\"summary\":{\"modules\":" + std::to_string(modules_total) + ",\"modulesOk\":" + std::to_string(modules_ok) +
         ",\"pipelines\":" + std::to_string(pipelines_total) + ",\"pipelinesOk\":" + std::to_string(pipelines_ok) +
         ",\"layoutFailures\":" + std::to_string(layouts_failed) + ",\"unsupported\":" + std::to_string(unsupported) +
         ",\"uncapturedErrors\":" + std::to_string(uncaptured.size()) + "},\n\"modules\":[\n" + module_json +
         "],\n\"pipelines\":[\n" + pipeline_json + "]}\n";
  std::fwrite(out.data(), 1, out.size(), stdout);
  ntgpu_context_destroy(ctx);
  bool ok = modules_ok == modules_total && pipelines_ok == pipelines_total && uncaptured.empty();
  return ok ? 0 : 1;
}

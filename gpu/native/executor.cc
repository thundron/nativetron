// Native protocol-3 executor (C++17 over the ntgpu facade and wgpu-native). See executor.h for the embedding
// contract. The batch is decoded only by the generated gpu/native-decoder.generated.h; this file is the native twin
// of gpu/host.js: the same handle table (20-bit slot, 12-bit generation, retirement without wrap), the same request
// rules (exactly one terminal event per id, at most kMaxPendingRequests, cancellation, LOST before DEVICE_LOST),
// the same rejection texts and the same event JSON. WebGPU calls go to webgpu.h; implementation gaps that abort the
// process in wgpu-native (async pipeline creation, getCompilationInfo, unmap of an unmapped buffer, labels set
// after creation, empty error-scope pops) are never reached.
#include "executor.h"
#include "executor-test.h"

#include "../native-decoder.generated.h"
#include "ntgpu.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

namespace ng = nativetron::gpu;
using ng::Handle;

// ---------------------------------------------------------------------------------------------------------------
// Rejections, numbers and JSON

struct Reject {
  std::string message;
};
[[noreturn]] void fail(std::string message) { throw Reject{std::move(message)}; }

// ECMAScript Number::toString for the values that occur in messages and events.
std::string jsnum(double value) {
  if (std::isnan(value)) return "NaN";
  if (std::isinf(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (value == 0) return "0";
  if (std::floor(value) == value && std::fabs(value) < 1e21) {
    char buffer[32];
    std::snprintf(buffer, sizeof buffer, "%.0f", value);
    return buffer;
  }
  char buffer[40];
  for (int precision = 1; precision <= 17; ++precision) {
    std::snprintf(buffer, sizeof buffer, "%.*g", precision, value);
    if (std::strtod(buffer, nullptr) == value) break;
  }
  return buffer;
}

bool is_integer(double v) { return std::isfinite(v) && std::floor(v) == v; }
uint64_t integer(double v, const char *label) {
  if (!is_integer(v) || v < 0 || v > 9007199254740991.0) fail(std::string("invalid GPU ") + label);
  return static_cast<uint64_t>(v);
}
uint32_t u32_field(double v, const char *label) {
  if (!is_integer(v) || v < 0 || v > 4294967295.0) fail(std::string("invalid GPU ") + label);
  return static_cast<uint32_t>(v);
}
int32_t i32_field(double v, const char *label) {
  if (!is_integer(v) || v < -2147483648.0 || v > 2147483647.0) fail(std::string("invalid GPU ") + label);
  return static_cast<int32_t>(v);
}
double finite(double v, const char *label) {
  if (!std::isfinite(v)) fail(std::string("invalid GPU ") + label);
  return v;
}
bool flag(double v, const char *label) {
  if (v != 0 && v != 1) fail(std::string("invalid GPU ") + label + " flag");
  return v == 1;
}

void append_escaped(std::string &out, const std::string &text) {
  std::string valid;
  ng::wire::decode_utf8(reinterpret_cast<const uint8_t *>(text.data()), text.size(), &valid);
  out += '"';
  for (unsigned char c : valid) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof buffer, "\\u%04x", c);
          out += buffer;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  out += '"';
}

// Builds the members after {type, requestId, handle, status}, in JS insertion order.
class Json {
 public:
  Json &key(const char *name) {
    text_ += ',';
    append_escaped(text_, name);
    text_ += ':';
    return *this;
  }
  Json &num(const char *name, double value) { key(name).text_ += jsnum(value); return *this; }
  Json &str(const char *name, const std::string &value) { key(name); append_escaped(text_, value); return *this; }
  Json &boolean(const char *name, bool value) { key(name).text_ += value ? "true" : "false"; return *this; }
  Json &raw(const char *name, const std::string &value) { key(name).text_ += value; return *this; }
  const std::string &text() const { return text_; }

 private:
  std::string text_;
};

std::string json_string_array(const std::vector<std::string> &values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ',';
    append_escaped(out, values[i]);
  }
  return out + "]";
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol enum indices (generated string tables) → webgpu.h values

template <size_t N>
const char *choice(const char *const (&table)[N], double value) {
  if (!is_integer(value) || value < 0 || value >= static_cast<double>(N) || !table[static_cast<size_t>(value)]) {
    fail("unsupported GPU enum " + jsnum(value));
  }
  return table[static_cast<size_t>(value)];
}
template <size_t N>
const char *optional_choice(const char *const (&table)[N], double value) {
  return value == 0 ? nullptr : choice(table, value);
}

template <class T>
struct Named {
  const char *name;
  T value;
};
template <class T, size_t N>
T named(const Named<T> (&table)[N], const char *name) {
  for (const auto &entry : table) {
    if (std::strcmp(entry.name, name) == 0) return entry.value;
  }
  fail(std::string("unsupported GPU enum ") + name);
}

constexpr Named<WGPUTextureFormat> kTextureFormats[] = {
    {"r8unorm", WGPUTextureFormat_R8Unorm}, {"r8snorm", WGPUTextureFormat_R8Snorm},
    {"r8uint", WGPUTextureFormat_R8Uint}, {"r8sint", WGPUTextureFormat_R8Sint},
    {"r16unorm", WGPUTextureFormat_R16Unorm}, {"r16snorm", WGPUTextureFormat_R16Snorm},
    {"r16uint", WGPUTextureFormat_R16Uint}, {"r16sint", WGPUTextureFormat_R16Sint},
    {"r16float", WGPUTextureFormat_R16Float}, {"rg8unorm", WGPUTextureFormat_RG8Unorm},
    {"rg8snorm", WGPUTextureFormat_RG8Snorm}, {"rg8uint", WGPUTextureFormat_RG8Uint},
    {"rg8sint", WGPUTextureFormat_RG8Sint}, {"r32float", WGPUTextureFormat_R32Float},
    {"r32uint", WGPUTextureFormat_R32Uint}, {"r32sint", WGPUTextureFormat_R32Sint},
    {"rg16unorm", WGPUTextureFormat_RG16Unorm}, {"rg16snorm", WGPUTextureFormat_RG16Snorm},
    {"rg16uint", WGPUTextureFormat_RG16Uint}, {"rg16sint", WGPUTextureFormat_RG16Sint},
    {"rg16float", WGPUTextureFormat_RG16Float}, {"rgba8unorm", WGPUTextureFormat_RGBA8Unorm},
    {"rgba8unorm-srgb", WGPUTextureFormat_RGBA8UnormSrgb}, {"rgba8snorm", WGPUTextureFormat_RGBA8Snorm},
    {"rgba8uint", WGPUTextureFormat_RGBA8Uint}, {"rgba8sint", WGPUTextureFormat_RGBA8Sint},
    {"bgra8unorm", WGPUTextureFormat_BGRA8Unorm}, {"bgra8unorm-srgb", WGPUTextureFormat_BGRA8UnormSrgb},
    {"rgb10a2uint", WGPUTextureFormat_RGB10A2Uint}, {"rgb10a2unorm", WGPUTextureFormat_RGB10A2Unorm},
    {"rg11b10ufloat", WGPUTextureFormat_RG11B10Ufloat}, {"rgb9e5ufloat", WGPUTextureFormat_RGB9E5Ufloat},
    {"rg32float", WGPUTextureFormat_RG32Float}, {"rg32uint", WGPUTextureFormat_RG32Uint},
    {"rg32sint", WGPUTextureFormat_RG32Sint}, {"rgba16unorm", WGPUTextureFormat_RGBA16Unorm},
    {"rgba16snorm", WGPUTextureFormat_RGBA16Snorm}, {"rgba16uint", WGPUTextureFormat_RGBA16Uint},
    {"rgba16sint", WGPUTextureFormat_RGBA16Sint}, {"rgba16float", WGPUTextureFormat_RGBA16Float},
    {"rgba32float", WGPUTextureFormat_RGBA32Float}, {"rgba32uint", WGPUTextureFormat_RGBA32Uint},
    {"rgba32sint", WGPUTextureFormat_RGBA32Sint}, {"stencil8", WGPUTextureFormat_Stencil8},
    {"depth16unorm", WGPUTextureFormat_Depth16Unorm}, {"depth24plus", WGPUTextureFormat_Depth24Plus},
    {"depth24plus-stencil8", WGPUTextureFormat_Depth24PlusStencil8},
    {"depth32float", WGPUTextureFormat_Depth32Float},
    {"depth32float-stencil8", WGPUTextureFormat_Depth32FloatStencil8},
    {"bc1-rgba-unorm", WGPUTextureFormat_BC1RGBAUnorm}, {"bc1-rgba-unorm-srgb", WGPUTextureFormat_BC1RGBAUnormSrgb},
    {"bc2-rgba-unorm", WGPUTextureFormat_BC2RGBAUnorm}, {"bc2-rgba-unorm-srgb", WGPUTextureFormat_BC2RGBAUnormSrgb},
    {"bc3-rgba-unorm", WGPUTextureFormat_BC3RGBAUnorm}, {"bc3-rgba-unorm-srgb", WGPUTextureFormat_BC3RGBAUnormSrgb},
    {"bc4-r-unorm", WGPUTextureFormat_BC4RUnorm}, {"bc4-r-snorm", WGPUTextureFormat_BC4RSnorm},
    {"bc5-rg-unorm", WGPUTextureFormat_BC5RGUnorm}, {"bc5-rg-snorm", WGPUTextureFormat_BC5RGSnorm},
    {"bc6h-rgb-ufloat", WGPUTextureFormat_BC6HRGBUfloat}, {"bc6h-rgb-float", WGPUTextureFormat_BC6HRGBFloat},
    {"bc7-rgba-unorm", WGPUTextureFormat_BC7RGBAUnorm}, {"bc7-rgba-unorm-srgb", WGPUTextureFormat_BC7RGBAUnormSrgb},
    {"etc2-rgb8unorm", WGPUTextureFormat_ETC2RGB8Unorm}, {"etc2-rgb8unorm-srgb", WGPUTextureFormat_ETC2RGB8UnormSrgb},
    {"etc2-rgb8a1unorm", WGPUTextureFormat_ETC2RGB8A1Unorm},
    {"etc2-rgb8a1unorm-srgb", WGPUTextureFormat_ETC2RGB8A1UnormSrgb},
    {"etc2-rgba8unorm", WGPUTextureFormat_ETC2RGBA8Unorm},
    {"etc2-rgba8unorm-srgb", WGPUTextureFormat_ETC2RGBA8UnormSrgb},
    {"eac-r11unorm", WGPUTextureFormat_EACR11Unorm}, {"eac-r11snorm", WGPUTextureFormat_EACR11Snorm},
    {"eac-rg11unorm", WGPUTextureFormat_EACRG11Unorm}, {"eac-rg11snorm", WGPUTextureFormat_EACRG11Snorm},
#define NT_ASTC(w, h)                                                     \
  {"astc-" #w "x" #h "-unorm", WGPUTextureFormat_ASTC##w##x##h##Unorm}, \
      {"astc-" #w "x" #h "-unorm-srgb", WGPUTextureFormat_ASTC##w##x##h##UnormSrgb}
    NT_ASTC(4, 4), NT_ASTC(5, 4), NT_ASTC(5, 5), NT_ASTC(6, 5), NT_ASTC(6, 6), NT_ASTC(8, 5), NT_ASTC(8, 6),
    NT_ASTC(8, 8), NT_ASTC(10, 5), NT_ASTC(10, 6), NT_ASTC(10, 8), NT_ASTC(10, 10), NT_ASTC(12, 10),
    NT_ASTC(12, 12),
#undef NT_ASTC
};

// A WebGPU texture format string as the JS host passes it to WebGPU; an unknown string is a TypeError there.
WGPUTextureFormat texture_format(const std::string &name) {
  for (const auto &entry : kTextureFormats) {
    if (name == entry.name) return entry.value;
  }
  fail("unsupported GPU texture format \"" + name + "\"");
}
const char *texture_format_name(WGPUTextureFormat format) {
  for (const auto &entry : kTextureFormats) {
    if (entry.value == format) return entry.name;
  }
  return "";
}

constexpr Named<WGPUVertexFormat> kVertexFormats[] = {
    {"float32", WGPUVertexFormat_Float32}, {"float32x2", WGPUVertexFormat_Float32x2},
    {"float32x3", WGPUVertexFormat_Float32x3}, {"float32x4", WGPUVertexFormat_Float32x4},
    {"uint32", WGPUVertexFormat_Uint32}, {"uint32x2", WGPUVertexFormat_Uint32x2},
    {"uint32x3", WGPUVertexFormat_Uint32x3}, {"uint32x4", WGPUVertexFormat_Uint32x4},
    {"sint32", WGPUVertexFormat_Sint32}, {"sint32x2", WGPUVertexFormat_Sint32x2},
    {"sint32x3", WGPUVertexFormat_Sint32x3}, {"sint32x4", WGPUVertexFormat_Sint32x4},
    {"unorm8x4", WGPUVertexFormat_Unorm8x4}, {"uint8", WGPUVertexFormat_Uint8},
    {"uint8x2", WGPUVertexFormat_Uint8x2}, {"uint8x4", WGPUVertexFormat_Uint8x4},
    {"sint8", WGPUVertexFormat_Sint8}, {"sint8x2", WGPUVertexFormat_Sint8x2},
    {"sint8x4", WGPUVertexFormat_Sint8x4}, {"unorm8", WGPUVertexFormat_Unorm8},
    {"unorm8x2", WGPUVertexFormat_Unorm8x2}, {"snorm8", WGPUVertexFormat_Snorm8},
    {"snorm8x2", WGPUVertexFormat_Snorm8x2}, {"snorm8x4", WGPUVertexFormat_Snorm8x4},
    {"uint16", WGPUVertexFormat_Uint16}, {"uint16x2", WGPUVertexFormat_Uint16x2},
    {"uint16x4", WGPUVertexFormat_Uint16x4}, {"sint16", WGPUVertexFormat_Sint16},
    {"sint16x2", WGPUVertexFormat_Sint16x2}, {"sint16x4", WGPUVertexFormat_Sint16x4},
    {"unorm16", WGPUVertexFormat_Unorm16}, {"unorm16x2", WGPUVertexFormat_Unorm16x2},
    {"unorm16x4", WGPUVertexFormat_Unorm16x4}, {"snorm16", WGPUVertexFormat_Snorm16},
    {"snorm16x2", WGPUVertexFormat_Snorm16x2}, {"snorm16x4", WGPUVertexFormat_Snorm16x4},
    {"float16", WGPUVertexFormat_Float16}, {"float16x2", WGPUVertexFormat_Float16x2},
    {"float16x4", WGPUVertexFormat_Float16x4}, {"unorm10-10-10-2", WGPUVertexFormat_Unorm10_10_10_2},
    {"unorm8x4-bgra", WGPUVertexFormat_Unorm8x4BGRA},
};
constexpr Named<WGPUTextureDimension> kDimensions[] = {
    {"1d", WGPUTextureDimension_1D}, {"2d", WGPUTextureDimension_2D}, {"3d", WGPUTextureDimension_3D}};
constexpr Named<WGPUTextureViewDimension> kViewDimensions[] = {
    {"1d", WGPUTextureViewDimension_1D}, {"2d", WGPUTextureViewDimension_2D},
    {"2d-array", WGPUTextureViewDimension_2DArray}, {"cube", WGPUTextureViewDimension_Cube},
    {"cube-array", WGPUTextureViewDimension_CubeArray}, {"3d", WGPUTextureViewDimension_3D}};
constexpr Named<WGPUAddressMode> kAddressModes[] = {{"clamp-to-edge", WGPUAddressMode_ClampToEdge},
                                                    {"repeat", WGPUAddressMode_Repeat},
                                                    {"mirror-repeat", WGPUAddressMode_MirrorRepeat}};
constexpr Named<WGPUFilterMode> kFilters[] = {{"nearest", WGPUFilterMode_Nearest}, {"linear", WGPUFilterMode_Linear}};
constexpr Named<WGPUMipmapFilterMode> kMipmapFilters[] = {{"nearest", WGPUMipmapFilterMode_Nearest},
                                                          {"linear", WGPUMipmapFilterMode_Linear}};
constexpr Named<WGPUCompareFunction> kCompares[] = {
    {"never", WGPUCompareFunction_Never}, {"less", WGPUCompareFunction_Less},
    {"equal", WGPUCompareFunction_Equal}, {"less-equal", WGPUCompareFunction_LessEqual},
    {"greater", WGPUCompareFunction_Greater}, {"not-equal", WGPUCompareFunction_NotEqual},
    {"greater-equal", WGPUCompareFunction_GreaterEqual}, {"always", WGPUCompareFunction_Always}};
constexpr Named<WGPUPrimitiveTopology> kTopologies[] = {
    {"point-list", WGPUPrimitiveTopology_PointList}, {"line-list", WGPUPrimitiveTopology_LineList},
    {"line-strip", WGPUPrimitiveTopology_LineStrip}, {"triangle-list", WGPUPrimitiveTopology_TriangleList},
    {"triangle-strip", WGPUPrimitiveTopology_TriangleStrip}};
constexpr Named<WGPUFrontFace> kFronts[] = {{"ccw", WGPUFrontFace_CCW}, {"cw", WGPUFrontFace_CW}};
constexpr Named<WGPUCullMode> kCulls[] = {
    {"none", WGPUCullMode_None}, {"front", WGPUCullMode_Front}, {"back", WGPUCullMode_Back}};
constexpr Named<WGPULoadOp> kLoads[] = {{"load", WGPULoadOp_Load}, {"clear", WGPULoadOp_Clear}};
constexpr Named<WGPUStoreOp> kStores[] = {{"store", WGPUStoreOp_Store}, {"discard", WGPUStoreOp_Discard}};
constexpr Named<WGPUTextureAspect> kAspects[] = {{"all", WGPUTextureAspect_All},
                                                 {"stencil-only", WGPUTextureAspect_StencilOnly},
                                                 {"depth-only", WGPUTextureAspect_DepthOnly}};
constexpr Named<WGPUBufferBindingType> kBufferBindings[] = {
    {"uniform", WGPUBufferBindingType_Uniform}, {"storage", WGPUBufferBindingType_Storage},
    {"read-only-storage", WGPUBufferBindingType_ReadOnlyStorage}};
constexpr Named<WGPUSamplerBindingType> kSamplerBindings[] = {
    {"filtering", WGPUSamplerBindingType_Filtering}, {"non-filtering", WGPUSamplerBindingType_NonFiltering},
    {"comparison", WGPUSamplerBindingType_Comparison}};
constexpr Named<WGPUTextureSampleType> kSampleTypes[] = {
    {"float", WGPUTextureSampleType_Float}, {"unfilterable-float", WGPUTextureSampleType_UnfilterableFloat},
    {"depth", WGPUTextureSampleType_Depth}, {"sint", WGPUTextureSampleType_Sint},
    {"uint", WGPUTextureSampleType_Uint}};
constexpr Named<WGPUStorageTextureAccess> kAccesses[] = {{"write-only", WGPUStorageTextureAccess_WriteOnly},
                                                         {"read-only", WGPUStorageTextureAccess_ReadOnly},
                                                         {"read-write", WGPUStorageTextureAccess_ReadWrite}};
constexpr Named<WGPUIndexFormat> kIndexFormats[] = {{"uint16", WGPUIndexFormat_Uint16},
                                                    {"uint32", WGPUIndexFormat_Uint32}};
constexpr Named<WGPUVertexStepMode> kSteps[] = {{"vertex", WGPUVertexStepMode_Vertex},
                                                {"instance", WGPUVertexStepMode_Instance}};
constexpr Named<WGPUBlendFactor> kBlendFactors[] = {
    {"zero", WGPUBlendFactor_Zero}, {"one", WGPUBlendFactor_One}, {"src", WGPUBlendFactor_Src},
    {"one-minus-src", WGPUBlendFactor_OneMinusSrc}, {"src-alpha", WGPUBlendFactor_SrcAlpha},
    {"one-minus-src-alpha", WGPUBlendFactor_OneMinusSrcAlpha}, {"dst", WGPUBlendFactor_Dst},
    {"one-minus-dst", WGPUBlendFactor_OneMinusDst}, {"dst-alpha", WGPUBlendFactor_DstAlpha},
    {"one-minus-dst-alpha", WGPUBlendFactor_OneMinusDstAlpha},
    {"src-alpha-saturated", WGPUBlendFactor_SrcAlphaSaturated}, {"constant", WGPUBlendFactor_Constant},
    {"one-minus-constant", WGPUBlendFactor_OneMinusConstant}, {"src1", WGPUBlendFactor_Src1},
    {"one-minus-src1", WGPUBlendFactor_OneMinusSrc1}, {"src1-alpha", WGPUBlendFactor_Src1Alpha},
    {"one-minus-src1-alpha", WGPUBlendFactor_OneMinusSrc1Alpha}};
constexpr Named<WGPUBlendOperation> kBlendOperations[] = {
    {"add", WGPUBlendOperation_Add}, {"subtract", WGPUBlendOperation_Subtract},
    {"reverse-subtract", WGPUBlendOperation_ReverseSubtract}, {"min", WGPUBlendOperation_Min},
    {"max", WGPUBlendOperation_Max}};
constexpr Named<WGPUStencilOperation> kStencilOperations[] = {
    {"keep", WGPUStencilOperation_Keep}, {"zero", WGPUStencilOperation_Zero},
    {"replace", WGPUStencilOperation_Replace}, {"invert", WGPUStencilOperation_Invert},
    {"increment-clamp", WGPUStencilOperation_IncrementClamp},
    {"decrement-clamp", WGPUStencilOperation_DecrementClamp},
    {"increment-wrap", WGPUStencilOperation_IncrementWrap}, {"decrement-wrap", WGPUStencilOperation_DecrementWrap}};
constexpr Named<WGPUPowerPreference> kPowers[] = {{"low-power", WGPUPowerPreference_LowPower},
                                                  {"high-performance", WGPUPowerPreference_HighPerformance}};

template <class T, size_t TN, size_t N>
T pick(const Named<T> (&table)[TN], const char *const (&protocol)[N], double value) {
  return named(table, choice(protocol, value));
}
// optionalChoice → undefined, mapped to the WebGPU dictionary default the JS binding applies.
template <class T, size_t TN, size_t N>
T pick_or(const Named<T> (&table)[TN], const char *const (&protocol)[N], double value, T fallback) {
  const char *name = optional_choice(protocol, value);
  return name ? named(table, name) : fallback;
}

WGPUStringView view(const std::string &text) { return WGPUStringView{text.data(), text.size()}; }

// ---------------------------------------------------------------------------------------------------------------
// Limits

struct LimitSlot {
  const char *name;
  size_t offset;
  bool wide;
  uint64_t fallback;  // WebGPU default
};
#define NT_LIMIT(field, wide, fallback) {#field, offsetof(WGPULimits, field), wide, fallback}
constexpr LimitSlot kLimitSlots[] = {
    NT_LIMIT(maxTextureDimension1D, false, 8192),
    NT_LIMIT(maxTextureDimension2D, false, 8192),
    NT_LIMIT(maxTextureDimension3D, false, 2048),
    NT_LIMIT(maxTextureArrayLayers, false, 256),
    NT_LIMIT(maxBindGroups, false, 4),
    NT_LIMIT(maxBindGroupsPlusVertexBuffers, false, 24),
    NT_LIMIT(maxBindingsPerBindGroup, false, 1000),
    NT_LIMIT(maxDynamicUniformBuffersPerPipelineLayout, false, 8),
    NT_LIMIT(maxDynamicStorageBuffersPerPipelineLayout, false, 4),
    NT_LIMIT(maxSampledTexturesPerShaderStage, false, 16),
    NT_LIMIT(maxSamplersPerShaderStage, false, 16),
    NT_LIMIT(maxStorageBuffersPerShaderStage, false, 8),
    NT_LIMIT(maxStorageTexturesPerShaderStage, false, 4),
    NT_LIMIT(maxUniformBuffersPerShaderStage, false, 12),
    NT_LIMIT(maxUniformBufferBindingSize, true, 65536),
    NT_LIMIT(maxStorageBufferBindingSize, true, 134217728),
    NT_LIMIT(minUniformBufferOffsetAlignment, false, 256),
    NT_LIMIT(minStorageBufferOffsetAlignment, false, 256),
    NT_LIMIT(maxVertexBuffers, false, 8),
    NT_LIMIT(maxBufferSize, true, 268435456),
    NT_LIMIT(maxVertexAttributes, false, 16),
    NT_LIMIT(maxVertexBufferArrayStride, false, 2048),
    NT_LIMIT(maxInterStageShaderVariables, false, 16),
    NT_LIMIT(maxColorAttachments, false, 8),
    NT_LIMIT(maxColorAttachmentBytesPerSample, false, 32),
    NT_LIMIT(maxComputeWorkgroupStorageSize, false, 16384),
    NT_LIMIT(maxComputeInvocationsPerWorkgroup, false, 256),
    NT_LIMIT(maxComputeWorkgroupSizeX, false, 256),
    NT_LIMIT(maxComputeWorkgroupSizeY, false, 256),
    NT_LIMIT(maxComputeWorkgroupSizeZ, false, 64),
    NT_LIMIT(maxComputeWorkgroupsPerDimension, false, 65535),
};
#undef NT_LIMIT

const LimitSlot *limit_slot(const char *name) {
  for (const auto &slot : kLimitSlots) {
    if (std::strcmp(slot.name, name) == 0) return &slot;
  }
  return nullptr;
}
// Returns false when the implementation left the field undefined.
bool limit_get(const WGPULimits &limits, const LimitSlot &slot, uint64_t *value) {
  const auto *base = reinterpret_cast<const unsigned char *>(&limits) + slot.offset;
  if (slot.wide) {
    std::memcpy(value, base, sizeof(uint64_t));
    return *value != WGPU_LIMIT_U64_UNDEFINED;
  }
  uint32_t narrow;
  std::memcpy(&narrow, base, sizeof narrow);
  *value = narrow;
  return narrow != WGPU_LIMIT_U32_UNDEFINED;
}
void limit_set(WGPULimits &limits, const LimitSlot &slot, uint64_t value) {
  auto *base = reinterpret_cast<unsigned char *>(&limits) + slot.offset;
  if (slot.wide) {
    std::memcpy(base, &value, sizeof value);
  } else {
    uint32_t narrow = static_cast<uint32_t>(std::min<uint64_t>(value, 0xffffffffu));
    std::memcpy(base, &narrow, sizeof narrow);
  }
}
// The JS numericLimits object: every defined limit, plus WebGPU's default for the ones wgpu-native leaves undefined
// (maxBindGroupsPlusVertexBuffers), so the same names are always present.
std::string limits_json(const WGPULimits &limits) {
  std::string out = "{";
  bool first = true;
  for (const auto &slot : kLimitSlots) {
    uint64_t value;
    if (!limit_get(limits, slot, &value)) value = slot.fallback;
    if (!first) out += ',';
    first = false;
    append_escaped(out, slot.name);
    out += ':';
    out += std::to_string(value);
  }
  return out + "}";
}
uint64_t limit_value(const WGPULimits &limits, const char *name) {
  const LimitSlot *slot = limit_slot(name);
  uint64_t value = 0;
  if (slot && !limit_get(limits, *slot, &value)) value = slot->fallback;
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Handle table (gpu/host.js GpuHandles)

enum class Kind : uint8_t {
  None, Buffer, Texture, TextureView, Sampler, ShaderModule, BindGroupLayout, BindGroup, PipelineLayout,
  ComputePipeline, RenderPipeline, QuerySet, CommandEncoder, ComputePass, RenderPass, CommandBuffer,
};
const char *kind_name(Kind kind) {
  switch (kind) {
    case Kind::None: return "null";
    case Kind::Buffer: return "buffer";
    case Kind::Texture: return "texture";
    case Kind::TextureView: return "textureView";
    case Kind::Sampler: return "sampler";
    case Kind::ShaderModule: return "shaderModule";
    case Kind::BindGroupLayout: return "bindGroupLayout";
    case Kind::BindGroup: return "bindGroup";
    case Kind::PipelineLayout: return "pipelineLayout";
    case Kind::ComputePipeline: return "computePipeline";
    case Kind::RenderPipeline: return "renderPipeline";
    case Kind::QuerySet: return "querySet";
    case Kind::CommandEncoder: return "commandEncoder";
    case Kind::ComputePass: return "computePass";
    case Kind::RenderPass: return "renderPass";
    case Kind::CommandBuffer: return "commandBuffer";
  }
  return "null";
}

// Releases one reference; destroy additionally frees GPU memory for objects that have destroy() in WebGPU.
// Buffer map state is serialized with the waiter's native poll (see NtGpuExecutor::poll_mutex): wgpu-core's
// map/unmap and its poll-side mapping race when they run on two threads at once.
void release_object(Kind kind, void *value, bool destroy, std::mutex *serial = nullptr) {
  if (!value) return;
  switch (kind) {
    case Kind::Buffer: {
      std::unique_lock<std::mutex> lock;
      if (serial) lock = std::unique_lock<std::mutex>(*serial);
      if (destroy) wgpuBufferDestroy(static_cast<WGPUBuffer>(value));
      wgpuBufferRelease(static_cast<WGPUBuffer>(value));
      break;
    }
    case Kind::Texture:
      if (destroy) wgpuTextureDestroy(static_cast<WGPUTexture>(value));
      wgpuTextureRelease(static_cast<WGPUTexture>(value));
      break;
    case Kind::QuerySet:
      // wgpu-native's wgpuQuerySetDestroy drops the resource id, so a later release panics ("Cannot remove a vacant
      // resource") across extern "C" and aborts. Releasing the last reference frees it; destroy is not called.
      wgpuQuerySetRelease(static_cast<WGPUQuerySet>(value));
      break;
    case Kind::TextureView: wgpuTextureViewRelease(static_cast<WGPUTextureView>(value)); break;
    case Kind::Sampler: wgpuSamplerRelease(static_cast<WGPUSampler>(value)); break;
    case Kind::ShaderModule: wgpuShaderModuleRelease(static_cast<WGPUShaderModule>(value)); break;
    case Kind::BindGroupLayout: wgpuBindGroupLayoutRelease(static_cast<WGPUBindGroupLayout>(value)); break;
    case Kind::BindGroup: wgpuBindGroupRelease(static_cast<WGPUBindGroup>(value)); break;
    case Kind::PipelineLayout: wgpuPipelineLayoutRelease(static_cast<WGPUPipelineLayout>(value)); break;
    case Kind::ComputePipeline: wgpuComputePipelineRelease(static_cast<WGPUComputePipeline>(value)); break;
    case Kind::RenderPipeline: wgpuRenderPipelineRelease(static_cast<WGPURenderPipeline>(value)); break;
    case Kind::CommandEncoder: wgpuCommandEncoderRelease(static_cast<WGPUCommandEncoder>(value)); break;
    case Kind::ComputePass: wgpuComputePassEncoderRelease(static_cast<WGPUComputePassEncoder>(value)); break;
    case Kind::RenderPass: wgpuRenderPassEncoderRelease(static_cast<WGPURenderPassEncoder>(value)); break;
    case Kind::CommandBuffer: wgpuCommandBufferRelease(static_cast<WGPUCommandBuffer>(value)); break;
    case Kind::None: break;
  }
}

enum MapState : uint8_t { UNMAPPED = 0, MAPPING = 1, MAPPED = 2 };
enum Phase : uint8_t { OPEN = 0, LOCKED = 1, FINISHED = 2 };

// Submission guard state. wgpu-native's wgpuQueueSubmit treats every queue_submit error as fatal (panic across
// extern "C" → abort), where WebGPU reports a validation error and skips the submission. Guest-reachable causes are
// an invalid command buffer, a destroyed buffer/texture/query set, and a buffer that is mapped or pending a map.
// Each such resource has a Tracked record shared by every encoder, bind group, view and command buffer using it.
struct Tracked {
  const char *kind = "resource";
  bool destroyed = false;
  uint8_t map = 0;  // MapState for buffers
};
using TrackedPtr = std::shared_ptr<Tracked>;
struct Uses {
  std::vector<TrackedPtr> list;
  std::unordered_set<const Tracked *> seen;
  void add(const TrackedPtr &track) {
    if (track && seen.insert(track.get()).second) list.push_back(track);
  }
};

struct PassState {
  uint32_t encoder_slot = 0;
  uint64_t encoder_serial = 0;  // identity of the owning encoder entry
  bool ended = false, pipeline = false, index = false;
  bool occlusion = false, occlusion_active = false;
  uint32_t occlusion_count = 0;
  std::vector<bool> occlusion_used;
};

struct Entry {
  uint64_t serial = 0;  // identity of this entry object (JS object identity)
  uint32_t generation = 0, next = 0;
  Kind kind = Kind::None;
  void *value = nullptr;
  bool live = false, failed = false, lost = false, has_state = false, canvas = false;
  uint32_t request = 0;
  // state, per kind
  uint8_t map = UNMAPPED;
  uint64_t size = 0;
  uint8_t phase = OPEN;
  bool submitted = false;
  uint32_t query_type = 0, query_count = 0;
  std::unique_ptr<PassState> pass;
  TrackedPtr track;                  // buffer, texture, query set; a texture view shares its texture's
  std::vector<TrackedPtr> bound;     // bind group resources
  std::shared_ptr<Uses> uses;        // encoder, its passes and its command buffer
  std::string invalid;               // command buffer: the error its finish() reported
  void set_map(uint8_t state) {
    map = state;
    if (track) track->map = state;
  }
  void clear_state() {
    has_state = false;
    map = UNMAPPED;
    phase = OPEN;
    submitted = false;
    pass.reset();
  }
};

constexpr uint32_t kSlotMask = ng::kHandleSlotMask;
constexpr uint32_t kGenerationMask = ng::kHandleGenerationMask;

struct Split {
  uint32_t slot, generation;
};
Split split(double handle) {
  integer(handle, "handle");
  const uint32_t value = handle > 4294967295.0 ? 0 : static_cast<uint32_t>(handle);
  if (handle > 4294967295.0 || !(value & kSlotMask)) fail("invalid GPU handle");
  const uint32_t generation = value >> ng::kHandleSlotBits;
  if (!generation) fail("invalid GPU handle generation");
  return Split{value & kSlotMask, generation};
}
double hv(Handle handle) { return static_cast<double>(ng::handle_value(handle)); }

class Handles {
 public:
  Handles(uint64_t *serials, std::mutex *serial) : serials_(serials), serial_(serial) {}
  ~Handles() { clear(); }

  Entry &reserve(double handle, Kind kind) {
    const Split s = split(handle);
    auto it = slots_.find(s.slot);
    Entry *old = it == slots_.end() ? nullptr : it->second.get();
    if (old && (old->live || s.generation != old->next)) fail("stale or duplicate GPU handle");
    if (!old && s.generation != 1) fail("unissued GPU handle generation");
    auto entry = std::make_unique<Entry>();
    entry->serial = ++*serials_;
    entry->generation = entry->next = s.generation;
    entry->kind = kind;
    entry->live = true;
    if (old) release(old->kind, old->value, false);
    Entry &ref = *entry;
    slots_[s.slot] = std::move(entry);
    return ref;
  }
  Entry *peek(double handle) {
    const Split s = split(handle);
    auto it = slots_.find(s.slot);
    if (it == slots_.end()) return nullptr;
    Entry *entry = it->second.get();
    return entry->live && entry->generation == s.generation ? entry : nullptr;
  }
  Entry *by_serial(uint32_t slot, uint64_t serial) {
    auto it = slots_.find(slot);
    return it != slots_.end() && it->second->serial == serial ? it->second.get() : nullptr;
  }
  Entry &lookup(double handle, Kind kind) {
    Entry *entry = peek(handle);
    if (!entry) fail("stale GPU handle");
    if (kind != Kind::None && entry->kind != kind) {
      fail(std::string("GPU handle is ") + kind_name(entry->kind) + ", expected " + kind_name(kind));
    }
    if (!entry->value) {
      fail(entry->lost ? "GPU resource was lost with its device"
                       : entry->failed ? "GPU resource creation failed" : "GPU resource is not ready");
    }
    return *entry;
  }
  template <class T>
  T get(double handle, Kind kind) {
    return static_cast<T>(lookup(handle, kind).value);
  }
  // Retires a live handle, or a handle whose creating operation was rejected before reservation (keeping guest and
  // executor generations in step). Generation 4095 retires the slot for good: the next generation would be 0.
  void retire(double handle, bool destroy) {
    const Split s = split(handle);
    auto it = slots_.find(s.slot);
    Entry *entry = it == slots_.end() ? nullptr : it->second.get();
    if (!entry ? s.generation == 1 : (!entry->live && entry->next == s.generation)) {
      auto retired = std::make_unique<Entry>();
      retired->serial = ++*serials_;
      retired->generation = s.generation;
      retired->next = s.generation == kGenerationMask ? 0 : s.generation + 1;
      retired->failed = true;
      if (entry) release(entry->kind, entry->value, false);
      slots_[s.slot] = std::move(retired);
      return;
    }
    if (!entry || !entry->live || entry->generation != s.generation) fail("stale GPU handle");
    void *value = entry->value;
    const bool canvas = entry->canvas;
    if (destroy && entry->track && !canvas &&
        (entry->kind == Kind::Buffer || entry->kind == Kind::Texture || entry->kind == Kind::QuerySet)) {
      entry->track->destroyed = true;
    }
    entry->live = false;
    entry->value = nullptr;
    entry->clear_state();
    entry->next = entry->generation == kGenerationMask ? 0 : entry->generation + 1;
    release(entry->kind, value, destroy && !canvas);
  }
  bool complete(uint32_t slot, uint64_t serial, Kind kind, void *value) {
    Entry *entry = by_serial(slot, serial);
    if (!entry || !entry->live) {
      release(kind, value, true);
      return false;
    }
    entry->value = value;
    entry->request = 0;
    return true;
  }
  // Device loss: live handles stay allocated until the guest retires them, but no longer resolve.
  void lose() {
    for (auto &pair : slots_) {
      Entry &entry = *pair.second;
      if (!entry.live) continue;
      release(entry.kind, entry.value, false);
      entry.lost = true;
      entry.value = nullptr;
      entry.clear_state();
      entry.request = 0;
    }
  }
  void clear() {
    for (auto &pair : slots_) {
      Entry &entry = *pair.second;
      if (!entry.live) continue;
      entry.live = false;
      release(entry.kind, entry.value, !entry.canvas);
      entry.value = nullptr;
      entry.clear_state();
    }
  }
  size_t live_count() const {
    size_t count = 0;
    for (const auto &pair : slots_) count += pair.second->live ? 1 : 0;
    return count;
  }

 private:
  void release(Kind kind, void *value, bool destroy) { release_object(kind, value, destroy, serial_); }
  std::unordered_map<uint32_t, std::unique_ptr<Entry>> slots_;
  uint64_t *serials_;
  std::mutex *serial_;
};

// ---------------------------------------------------------------------------------------------------------------
// Requests

constexpr uint32_t E_CAPABILITIES = static_cast<uint32_t>(ng::Event::Capabilities);
constexpr uint32_t E_PIPELINE_READY = static_cast<uint32_t>(ng::Event::PipelineReady);
constexpr uint32_t E_MAP_READY = static_cast<uint32_t>(ng::Event::MapReady);
constexpr uint32_t E_WORK_DONE = static_cast<uint32_t>(ng::Event::WorkDone);
constexpr uint32_t E_DEVICE_LOST = static_cast<uint32_t>(ng::Event::DeviceLost);
constexpr uint32_t E_UNCAUGHT_ERROR = static_cast<uint32_t>(ng::Event::UncaughtError);
constexpr uint32_t E_SHADER_INFO = static_cast<uint32_t>(ng::Event::ShaderInfo);
constexpr uint32_t E_RESIZE = static_cast<uint32_t>(ng::Event::Resize);
constexpr uint32_t E_ERROR = static_cast<uint32_t>(ng::Event::Error);
constexpr uint32_t S_OK = static_cast<uint32_t>(ng::Status::Ok);
constexpr uint32_t S_ERROR = static_cast<uint32_t>(ng::Status::Error);
constexpr uint32_t S_CANCELLED = static_cast<uint32_t>(ng::Status::Cancelled);
constexpr uint32_t S_LOST = static_cast<uint32_t>(ng::Status::Lost);

enum class Cleanup : uint8_t { None, Negotiate, Pipeline, Map };
enum class Deferred : uint8_t { None, Negotiate, ShaderInfo, Pipeline };

struct LimitWish {
  const LimitSlot *slot;
  uint64_t value;
  bool required;
  bool alignment;
};

struct Request {
  uint64_t serial = 0;
  uint32_t type = 0;
  uint32_t handle = 0;
  bool device = true;
  bool native = false;  // completes through a native callback (map, work done)
  bool readback = false;
  uint64_t readback_begin = 0, readback_end = 0;
  Cleanup cleanup = Cleanup::None;
  Deferred deferred = Deferred::None;
  uint32_t slot = 0;
  uint64_t entry_serial = 0;
  // pipeline
  Kind pipeline_kind = Kind::None;
  void *pipeline = nullptr;
  bool pipeline_failed = false;
  std::string message;
  // shader info
  std::string messages = "[]";
  bool shader_error = false;
  // negotiation
  WGPUPowerPreference power = WGPUPowerPreference_Undefined;
  uint32_t required_bits = 0, optional_bits = 0;
  std::vector<LimitWish> limits;
  // map
  WGPUBuffer buffer = nullptr;  // borrowed; the native op holds a reference
  uint64_t map_start = 0, map_length = 0;
  uint32_t destination = 0;
};

struct NativeOp {
  uint32_t id = 0;  // request id, 0 for captures
  uint64_t serial = 0;
  WGPUBuffer buffer = nullptr;  // owned reference (maps)
  bool capture = false;
};

constexpr uint32_t kKnownFeatureBits = (1u << (sizeof(ng::kFeatures) / sizeof(ng::kFeatures[0]))) - 1u;
constexpr size_t kLimitCount = sizeof(ng::kLimits) / sizeof(ng::kLimits[0]) - 1;

uint32_t feature_bit(const char *name) {
  for (size_t i = 0; i < sizeof(ng::kFeatures) / sizeof(ng::kFeatures[0]); ++i) {
    if (std::strcmp(ng::kFeatures[i], name) == 0) return 1u << i;
  }
  return 0;
}

struct FeatureSet {
  std::vector<std::string> names;
  uint32_t bits = 0;
  bool has(const char *name) const {
    return std::find(names.begin(), names.end(), std::string(name)) != names.end();
  }
};
FeatureSet features_of(const NtGpuCapabilities &caps) {
  FeatureSet set;
  for (uint32_t i = 0; i < caps.feature_count; ++i) {
    const char *name = ntgpu_feature_name(caps.features[i]);
    if (!name) continue;
    set.names.emplace_back(name);
    set.bits |= feature_bit(name);
  }
  return set;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------------

struct NtGpuExecutor {
  // Held by the waiter during its blocking native poll, and around every call that changes buffer map state or the
  // device (map, unmap, mapped ranges, buffer release, device request/release). wgpu-core's poll-side mapping races
  // with a concurrent unmap/map of the same buffer ("Buffer is already mapped"), so these never overlap a poll.
  // The cost: such a call waits while the waiter blocks for already-submitted GPU work.
  std::mutex poll_mutex;
  NtGpuExecutorOptions options{};
  NtGpuContext *ctx = nullptr;
  uint64_t serials = 0;
  Handles handles{&serials, &poll_mutex};
  bool stopped = false;

  // device
  bool device = false;  // the JS host's `device !== null`
  uint32_t device_generation = 0;
  uint32_t epoch = 0;
  uint64_t requesting = 0;  // serial of the negotiating request
  WGPULimits device_limits = WGPU_LIMITS_INIT;
  bool timestamp_queries = false;

  // requests
  std::unordered_map<uint32_t, Request> pending;
  std::vector<std::pair<uint32_t, uint64_t>> deferred;
  std::unordered_map<uint64_t, NativeOp> natives;
  uint64_t next_token = 0;

  // batch
  const uint8_t *uploads = nullptr;
  size_t upload_size = 0;
  size_t readback_capacity = 0;
  std::string last_error;
  bool frame_wanted = false;
  bool submitted_after_acquire = false;

  // canvas
  uint32_t width = 64, height = 64;
  double dpr = 1;
  std::string last_size;
  bool configured = false;
  WGPUTextureFormat canvas_format = WGPUTextureFormat_Undefined;
  WGPUTextureUsage canvas_usage = WGPUTextureUsage_None;
  WGPUCompositeAlphaMode canvas_alpha = WGPUCompositeAlphaMode_Opaque;
  WGPUTexture canvas_texture = nullptr;  // headless: owned current texture
  uint32_t canvas_width = 0, canvas_height = 0;
  WGPUSurface surface = nullptr;  // CAMetalLayer path
  uint32_t surface_width = 0, surface_height = 0;
  bool surface_configured = false;
  WGPUTexture acquired = nullptr;  // surface texture until presented
  TrackedPtr canvas_track;          // the current canvas texture; a presented surface texture is destroyed

  // capture
  bool capture_done = false, capture_ok = false;
  uint8_t *capture_out = nullptr;
  uint32_t capture_w = 0, capture_h = 0, capture_row = 0;
  bool capture_bgra = false;

  // waiter: blocks in the native poll only while native completions are awaited
  std::mutex wait_mutex;
  std::condition_variable wait_cv;
  bool wait_stop = false;
  size_t awaiting = 0;  // guarded by wait_mutex
  uint64_t version = 0;  // guarded by wait_mutex; bumped when the awaited set or the event queue drained
  std::thread waiter;
  std::atomic<bool> in_call{false};
  std::atomic<uint64_t> polls{0};

  // -------------------------------------------------------------------------------------------------------------
  // events

  void emit(uint32_t type, uint32_t request_id, uint32_t handle, uint32_t status, const Json &data = Json(),
            const uint8_t *bytes = nullptr, size_t size = 0) {
    if (stopped || !options.event) return;
    std::string json = "{\"type\":" + std::to_string(type) + ",\"requestId\":" + std::to_string(request_id) +
                       ",\"handle\":" + std::to_string(handle) + ",\"status\":" + std::to_string(status) +
                       data.text() + "}";
    options.event(options.user, json.c_str(), bytes, size);
  }
  void fail_event(const std::string &message, uint32_t request_id = 0, uint32_t handle = 0) {
    emit(E_ERROR, request_id, handle, S_ERROR, Json().str("message", message));
  }
  // An error WebGPU would raise as uncaptured, found by the executor itself: queued in order with wgpu-native's own,
  // so it is delivered by process() like them.
  void uncaught(const std::string &message) {
    if (device) ntgpu_report_error(ctx, WGPUErrorType_Validation, message.c_str());
  }
  // Why wgpuQueueSubmit must not run for these command buffers (empty: submit; "lost": the device is gone and the
  // loss is reported by process()). Mirrors the WebGPU submit validation that wgpu-native turns into an abort.
  template <class Entries>
  std::string submit_refusal(const Entries &entries) {
    if (!ntgpu_device_alive(ctx)) return "lost";
    for (const auto *entry : entries) {
      if (!entry->invalid.empty()) return "GPU command buffer is invalid: " + entry->invalid;
    }
    for (const auto *entry : entries) {
      if (!entry->uses) continue;
      for (const auto &track : entry->uses->list) {
        if (track->destroyed) return std::string("Destroyed ") + track->kind + " used in a GPU submission";
        if (track->map != UNMAPPED) return "GPU buffer used in a submission while mapped or pending a map";
      }
    }
    return std::string();
  }

  void bump() {
    {
      std::lock_guard<std::mutex> lock(wait_mutex);
      ++version;
    }
    wait_cv.notify_all();
  }
  void await_native(int delta) {
    {
      std::lock_guard<std::mutex> lock(wait_mutex);
      awaiting = static_cast<size_t>(static_cast<long>(awaiting) + delta);
      ++version;
    }
    wait_cv.notify_all();
    if (delta > 0 && !waiter.joinable()) waiter = std::thread([this] { wait_loop(); });
  }

  void wait_loop() {
    std::unique_lock<std::mutex> lock(wait_mutex);
    std::chrono::milliseconds backoff(0);
    while (!wait_stop) {
      if (awaiting == 0) {
        backoff = std::chrono::milliseconds(0);
        wait_cv.wait(lock);
        continue;
      }
      const uint64_t seen = version;
      lock.unlock();
      uint32_t queued = 0;
      {
        std::lock_guard<std::mutex> poll(poll_mutex);
        if (ntgpu_device(ctx)) {
          polls.fetch_add(1);
          ntgpu_process(ctx, 1);
        }
        queued = ntgpu_queued_events(ctx);
      }
      lock.lock();
      if (queued > 0) {
        // The owner drains through process(); wait for it instead of polling again.
        backoff = std::chrono::milliseconds(0);
        wait_cv.wait(lock, [&] { return wait_stop || version != seen; });
      } else {
        backoff = std::min(std::chrono::milliseconds(64), backoff.count() ? backoff * 2 : std::chrono::milliseconds(1));
        wait_cv.wait_for(lock, backoff, [&] { return wait_stop || version != seen; });
      }
    }
  }
  static void wake_trampoline(void *user) {
    auto *self = static_cast<NtGpuExecutor *>(user);
    if (!self->in_call.load() && self->options.wake) self->options.wake(self->options.user);
  }
  struct CallScope {
    NtGpuExecutor *self;
    explicit CallScope(NtGpuExecutor *s) : self(s) { self->in_call.store(true); }
    ~CallScope() {
      self->in_call.store(false);
      if (!self->stopped && self->ctx && ntgpu_queued_events(self->ctx) > 0 && self->options.wake) {
        self->options.wake(self->options.user);
      }
    }
  };

  // -------------------------------------------------------------------------------------------------------------
  // requests

  Request *current(uint32_t id, uint64_t serial) {
    if (stopped) return nullptr;
    auto it = pending.find(id);
    return it != pending.end() && it->second.serial == serial ? &it->second : nullptr;
  }
  Request &request(uint32_t id, uint32_t type, uint32_t handle) {
    if (id == 0) fail("invalid GPU request id");
    if (pending.count(id)) fail("duplicate pending GPU request id " + std::to_string(id));
    if (pending.size() >= ng::kMaxPendingRequests) fail("too many pending GPU requests");
    Request &record = pending[id];
    record.serial = ++serials;
    record.type = type;
    record.handle = handle;
    return record;
  }
  void run_cleanup(uint32_t id, Request &record, uint32_t status) {
    switch (record.cleanup) {
      case Cleanup::None: break;
      case Cleanup::Negotiate:
        if (requesting == record.serial) requesting = 0;
        break;
      case Cleanup::Pipeline: {
        Entry *entry = handles.by_serial(record.slot, record.entry_serial);
        if (entry && entry->request == id) {
          entry->request = 0;
          if (status != S_OK && !entry->value) entry->failed = true;
        }
        break;
      }
      case Cleanup::Map: {
        Entry *entry = handles.by_serial(record.slot, record.entry_serial);
        if (!entry || entry->request != id) break;
        entry->request = 0;
        if (entry->map == MAPPING) {
          entry->set_map(UNMAPPED);
          if (status == S_CANCELLED && record.buffer) {
            std::lock_guard<std::mutex> serial(poll_mutex);
            wgpuBufferUnmap(record.buffer);
          }
        }
        break;
      }
    }
    if (record.pipeline) {
      release_object(record.pipeline_kind, record.pipeline, true);
      record.pipeline = nullptr;
    }
  }
  // Removes the request before its event is delivered; false when it is no longer current.
  bool settle(uint32_t id, uint64_t serial, uint32_t type, uint32_t status, const Json &data = Json(),
              const uint8_t *bytes = nullptr, size_t size = 0) {
    auto it = pending.find(id);
    if (it == pending.end() || it->second.serial != serial) return false;
    Request record = std::move(it->second);
    pending.erase(it);
    if (record.native) await_native(-1);
    run_cleanup(id, record, status);
    emit(type, id, record.handle, status, data, bytes, size);
    return true;
  }
  void cancel(uint32_t id, const char *message = "GPU request cancelled") {
    auto it = pending.find(id);
    if (it == pending.end()) return;
    settle(id, it->second.serial, it->second.type, S_CANCELLED, Json().str("message", message));
  }
  void retire_owned(double handle) {
    Entry *entry = handles.peek(handle);
    if (entry && entry->request) cancel(entry->request, "GPU request cancelled by releasing its resource");
  }
  std::vector<std::pair<uint32_t, uint64_t>> pending_in_order() const {
    std::vector<std::pair<uint64_t, uint32_t>> order;
    for (const auto &pair : pending) order.emplace_back(pair.second.serial, pair.first);
    std::sort(order.begin(), order.end());
    std::vector<std::pair<uint32_t, uint64_t>> out;
    for (const auto &item : order) out.emplace_back(item.second, item.first);
    return out;
  }

  void release_surface_state() {
    if (acquired) {
      wgpuTextureRelease(acquired);
      acquired = nullptr;
    }
    if (canvas_texture) {
      wgpuTextureDestroy(canvas_texture);
      wgpuTextureRelease(canvas_texture);
      canvas_texture = nullptr;
    }
    if (surface) {
      if (surface_configured) wgpuSurfaceUnconfigure(surface);
      wgpuSurfaceRelease(surface);
      surface = nullptr;
    }
    surface_configured = false;
  }

  void release_native_device() {
    std::lock_guard<std::mutex> poll(poll_mutex);
    if (ntgpu_device(ctx)) ntgpu_device_release(ctx);
  }

  void lose_device(const char *reason, const std::string &message) {
    if (stopped || !device) return;
    device = false;
    ++epoch;
    configured = false;
    frame_wanted = false;
    for (const auto &item : pending_in_order()) {
      Request *record = current(item.first, item.second);
      if (record && record->device) {
        settle(item.first, item.second, record->type, S_LOST, Json().str("message", "GPU device lost"));
      }
    }
    handles.lose();
    release_surface_state();
    emit(E_DEVICE_LOST, 0, 0, S_ERROR, Json().str("reason", reason).str("message", message));
  }

  // -------------------------------------------------------------------------------------------------------------
  // native completions

  void drain() {
    NtGpuEvent event;
    while (ctx && ntgpu_next_event(ctx, &event)) {
      const std::string message = event.message ? event.message : "";
      switch (event.kind) {
        case NTGPU_EVENT_DEVICE_LOST:
          if (device && event.generation == device_generation) {
            lose_device(event.detail == WGPUDeviceLostReason_Destroyed ? "destroyed" : "unknown", message);
            release_native_device();
          }
          break;
        case NTGPU_EVENT_UNCAPTURED_ERROR:
          if (device && event.generation == device_generation) {
            emit(E_UNCAUGHT_ERROR, 0, 0, S_ERROR, Json().str("message", message));
          }
          break;
        case NTGPU_EVENT_OVERFLOW:
          if (device) {
            emit(E_UNCAUGHT_ERROR, 0, 0, S_ERROR,
                 Json().str("message", std::to_string(event.token) + " further uncaptured GPU errors were dropped"));
          }
          break;
        case NTGPU_EVENT_MAP:
        case NTGPU_EVENT_WORK_DONE:
          complete_native(event, message);
          break;
        default: break;  // ADAPTER / DEVICE are consumed synchronously by negotiation
      }
    }
    bump();
  }

  void complete_native(const NtGpuEvent &event, const std::string &message) {
    auto it = natives.find(event.token);
    if (it == natives.end()) return;
    NativeOp op = it->second;
    natives.erase(it);
    struct Release {
      NtGpuExecutor *self;
      WGPUBuffer buffer;
      ~Release() {
        if (!buffer) return;
        std::lock_guard<std::mutex> serial(self->poll_mutex);
        wgpuBufferRelease(buffer);
      }
    } release{this, op.buffer};
    if (op.capture) {
      capture_done = true;
      capture_ok = event.status == NTGPU_OK && finish_capture(op.buffer);
      return;
    }
    Request *record = current(op.id, op.serial);
    if (!record) return;
    if (event.status != NTGPU_OK) {
      // A failure caused by a concurrent device loss settles as LOST through the loss handler.
      if (record->device && device && event.generation == device_generation && !ntgpu_device_alive(ctx)) {
        lose_device("unknown", "GPU device lost");
      }
      if (current(op.id, op.serial)) {
        settle(op.id, op.serial, E_ERROR, S_ERROR,
               Json().str("message", message.empty() ? std::string("GPU operation failed") : message));
      }
      return;
    }
    if (event.kind == NTGPU_EVENT_WORK_DONE) {
      settle(op.id, op.serial, E_WORK_DONE, S_OK);
      return;
    }
    const uint64_t start = record->map_start, length = record->map_length;
    const uint32_t destination = record->destination;
    Entry *entry = handles.by_serial(record->slot, record->entry_serial);
    const void *mapped;
    {
      std::lock_guard<std::mutex> serial(poll_mutex);
      mapped = wgpuBufferGetConstMappedRange(op.buffer, static_cast<size_t>(start), static_cast<size_t>(length));
      if (!mapped) wgpuBufferUnmap(op.buffer);
    }
    if (!mapped) {
      if (entry && entry->request == op.id) entry->set_map(UNMAPPED);
      settle(op.id, op.serial, E_ERROR, S_ERROR, Json().str("message", "GPU mapped range has an unexpected length"));
      return;
    }
    if (entry && entry->request == op.id) entry->set_map(UNMAPPED);
    // The bytes are borrowed by the embedding until event() returns; unmap afterwards.
    settle(op.id, op.serial, E_MAP_READY, S_OK, Json().num("offset", destination).num("length", static_cast<double>(length)),
           static_cast<const uint8_t *>(mapped), static_cast<size_t>(length));
    std::lock_guard<std::mutex> serial(poll_mutex);
    wgpuBufferUnmap(op.buffer);
  }

  uint64_t start_native(NativeOp op) {
    const uint64_t token = ++next_token;
    natives[token] = op;
    return token;
  }

  // -------------------------------------------------------------------------------------------------------------
  // canvas

  void pixels() {
    const std::string key = std::to_string(width) + "/" + std::to_string(height) + "/" + jsnum(dpr);
    if (key == last_size) return;
    last_size = key;
    emit(E_RESIZE, 0, 0, S_OK, Json().num("width", width).num("height", height).num("dpr", dpr));
  }

  WGPUTexture headless_texture() {
    if (canvas_texture && canvas_width == width && canvas_height == height) return canvas_texture;
    if (canvas_texture) {
      wgpuTextureRelease(canvas_texture);
      canvas_texture = nullptr;
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    const std::string label = "nativetron canvas";
    descriptor.label = view(label);
    descriptor.usage = canvas_usage | WGPUTextureUsage_CopySrc | WGPUTextureUsage_RenderAttachment;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.size = WGPUExtent3D{width, height, 1};
    descriptor.format = canvas_format;
    descriptor.mipLevelCount = 1;
    descriptor.sampleCount = 1;
    canvas_texture = wgpuDeviceCreateTexture(ntgpu_device(ctx), &descriptor);
    canvas_track = std::make_shared<Tracked>();
    canvas_track->kind = "texture";
    canvas_width = width;
    canvas_height = height;
    if (!canvas_texture) fail("GPU canvas texture unavailable");
    return canvas_texture;
  }

  void configure_surface() {
    WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
    if (wgpuSurfaceGetCapabilities(surface, ntgpu_adapter(ctx), &caps) != WGPUStatus_Success) {
      wgpuSurfaceCapabilitiesFreeMembers(caps);
      fail("GPU canvas surface capabilities unavailable");
    }
    bool format_ok = false;
    for (size_t i = 0; i < caps.formatCount && !format_ok; ++i) format_ok = caps.formats[i] == canvas_format;
    WGPUTextureUsage usage = canvas_usage | WGPUTextureUsage_RenderAttachment;
    if (caps.usages & WGPUTextureUsage_CopySrc) usage |= WGPUTextureUsage_CopySrc;
    usage &= caps.usages;
    WGPUCompositeAlphaMode alpha = canvas_alpha;
    bool alpha_ok = false;
    for (size_t i = 0; i < caps.alphaModeCount && !alpha_ok; ++i) alpha_ok = caps.alphaModes[i] == alpha;
    if (!alpha_ok) alpha = WGPUCompositeAlphaMode_Auto;
    wgpuSurfaceCapabilitiesFreeMembers(caps);
    if (!format_ok) fail(std::string("GPU canvas format ") + texture_format_name(canvas_format) + " unsupported");
    WGPUSurfaceConfiguration config = WGPU_SURFACE_CONFIGURATION_INIT;
    config.device = ntgpu_device(ctx);
    config.format = canvas_format;
    config.usage = usage;
    config.width = width;
    config.height = height;
    config.alphaMode = alpha;
    config.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &config);
    surface_configured = true;
    surface_width = width;
    surface_height = height;
  }

  void present() {
    if (!acquired) return;
    if (submitted_after_acquire && surface) wgpuSurfacePresent(surface);
    if (!submitted_after_acquire) return;
    if (canvas_track) canvas_track->destroyed = true;  // like a presented WebGPU canvas texture
    wgpuTextureRelease(acquired);
    acquired = nullptr;
    submitted_after_acquire = false;
  }

  bool finish_capture(WGPUBuffer buffer) {
    const size_t size = static_cast<size_t>(capture_row) * capture_h;
    std::lock_guard<std::mutex> serial(poll_mutex);
    const auto *mapped = static_cast<const uint8_t *>(wgpuBufferGetConstMappedRange(buffer, 0, size));
    if (!mapped) return false;
    for (uint32_t y = 0; y < capture_h; ++y) {
      const uint8_t *row = mapped + static_cast<size_t>(y) * capture_row;
      uint8_t *out = capture_out + static_cast<size_t>(y) * capture_w * 4;
      for (uint32_t x = 0; x < capture_w; ++x) {
        const uint8_t *p = row + x * 4;
        out[x * 4 + 0] = capture_bgra ? p[2] : p[0];
        out[x * 4 + 1] = p[1];
        out[x * 4 + 2] = capture_bgra ? p[0] : p[2];
        out[x * 4 + 3] = p[3];
      }
    }
    wgpuBufferUnmap(buffer);
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------
  // operation helpers (gpu/host.js)

  WGPUDevice active() {
    if (!device) fail("WebGPU device unavailable");
    return ntgpu_device(ctx);
  }
  uint64_t limit(const char *name, uint64_t fallback) const {
    return device ? limit_value(device_limits, name) : fallback;
  }
  // Resources referenced while recording an encoder or pass are noted on it (see Tracked).
  Uses *recording = nullptr;
  void note(const Entry &entry) {
    if (!recording) return;
    recording->add(entry.track);
    for (const auto &track : entry.bound) recording->add(track);
  }
  template <class T>
  T ref(double handle, Kind kind) {
    Entry &entry = handles.lookup(handle, kind);
    note(entry);
    return static_cast<T>(entry.value);
  }
  template <class T>
  T tracked(double handle, Kind kind, std::vector<TrackedPtr> &out) {
    Entry &entry = handles.lookup(handle, kind);
    if (entry.track) out.push_back(entry.track);
    return static_cast<T>(entry.value);
  }
  template <class T>
  T optional(double handle, Kind kind) {
    return handle != 0 ? ref<T>(handle, kind) : nullptr;
  }
  template <class Make>
  Entry &create(double handle, Kind kind, Make make) {
    Entry &entry = handles.reserve(handle, kind);
    try {
      entry.value = make();
    } catch (...) {
      entry.failed = true;
      throw;
    }
    if (!entry.value) entry.failed = true;
    entry.has_state = true;
    return entry;
  }
  size_t records(const char *kind, uint32_t width, const ng::F64Array &values, size_t min, size_t max,
                 bool optional_record = false) {
    if (values.size() % width) fail(std::string("invalid GPU ") + kind + " record");
    const size_t count = values.size() / width;
    if (optional_record && count > 1) fail(std::string("GPU ") + kind + " accepts at most one record");
    if (count < min || count > max) {
      fail(std::string("GPU ") + kind + " record count " + std::to_string(count) + " outside " +
           std::to_string(min) + ".." + (max == SIZE_MAX ? std::string("Infinity") : std::to_string(max)));
    }
    return count;
  }

  struct Timestamp {
    WGPUPassTimestampWrites writes = WGPU_PASS_TIMESTAMP_WRITES_INIT;
    bool used = false;
  };
  Timestamp timestamp_writes(double query_set, uint32_t begin, uint32_t end) {
    Timestamp result;
    if (!query_set) return result;
    Entry &entry = handles.lookup(query_set, Kind::QuerySet);
    note(entry);
    if (entry.has_state && entry.query_type != ng::constants::QUERY_TYPE_TIMESTAMP) {
      fail("GPU timestamp writes need a timestamp query set");
    }
    result.writes.querySet = static_cast<WGPUQuerySet>(entry.value);
    result.writes.beginningOfPassWriteIndex = begin;
    result.writes.endOfPassWriteIndex = end;
    result.used = true;
    return result;
  }

  struct Constants {
    std::vector<std::string> keys;
    std::vector<WGPUConstantEntry> entries;
  };
  Constants constants_of(const ng::F64Array &values, uint32_t stage) {
    const size_t count = records("constant", ng::record::Constant::kWidth, values, 0, SIZE_MAX);
    Constants result;
    result.keys.reserve(count);
    for (size_t i = 0; i < count; ++i) {
      const double stages = values[static_cast<uint32_t>(i * 3)], id = values[static_cast<uint32_t>(i * 3 + 1)],
                   value = values[static_cast<uint32_t>(i * 3 + 2)];
      if (!is_integer(stages) || stages < 1 || stages > 7) fail("invalid GPU pipeline constant stages");
      if (!is_integer(id) || id < 0 || id > 65535) fail("invalid GPU pipeline constant " + jsnum(id));
      finite(value, "pipeline constant");
      if (!(static_cast<uint32_t>(stages) & stage)) continue;
      const std::string key = jsnum(id);
      if (std::find(result.keys.begin(), result.keys.end(), key) != result.keys.end()) {
        fail("duplicate GPU pipeline constant " + key);
      }
      result.keys.push_back(key);
      WGPUConstantEntry entry = WGPU_CONSTANT_ENTRY_INIT;
      entry.value = value;
      result.entries.push_back(entry);
    }
    for (size_t i = 0; i < result.entries.size(); ++i) result.entries[i].key = view(result.keys[i]);
    return result;
  }

  struct VertexLayouts {
    std::vector<WGPUVertexBufferLayout> buffers;
    std::vector<std::vector<WGPUVertexAttribute>> attributes;
  };
  VertexLayouts vertex_layouts(const ng::F64Array &values) {
    uint32_t index = 0;
    auto read = [&]() -> double {
      if (index >= values.size()) fail("truncated GPU vertex layout");
      return values[index++];
    };
    VertexLayouts result;
    std::vector<uint64_t> locations;
    const uint64_t max_buffers = limit("maxVertexBuffers", 8), max_attributes = limit("maxVertexAttributes", 16),
                   max_stride = limit("maxVertexBufferArrayStride", 2048);
    while (index < values.size()) {
      const uint64_t stride = integer(read(), "vertex stride");
      const double step = read();
      const uint64_t count = integer(read(), "attribute count");
      if (stride % 4 || stride > max_stride) {
        fail("GPU vertex stride must be a multiple of 4 within maxVertexBufferArrayStride");
      }
      if (locations.size() + count > max_attributes) fail("GPU vertex attribute limit exceeded");
      std::vector<WGPUVertexAttribute> attributes;
      for (uint64_t i = 0; i < count; ++i) {
        const uint64_t location = integer(read(), "shader location");
        const uint64_t offset = integer(read(), "attribute offset");
        const WGPUVertexFormat format = pick(kVertexFormats, ng::enums::kVertexFormat, read());
        if (location >= max_attributes || std::find(locations.begin(), locations.end(), location) != locations.end()) {
          fail("invalid or duplicate GPU shader location " + std::to_string(location));
        }
        locations.push_back(location);
        WGPUVertexAttribute attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
        attribute.shaderLocation = static_cast<uint32_t>(location);
        attribute.offset = offset;
        attribute.format = format;
        attributes.push_back(attribute);
      }
      WGPUVertexBufferLayout layout = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
      layout.arrayStride = stride;
      layout.stepMode = pick(kSteps, ng::enums::kStep, step);
      result.attributes.push_back(std::move(attributes));
      result.buffers.push_back(layout);
      if (result.buffers.size() > max_buffers) fail("GPU vertex buffer limit exceeded");
    }
    for (size_t i = 0; i < result.buffers.size(); ++i) {
      result.buffers[i].attributeCount = result.attributes[i].size();
      result.buffers[i].attributes = result.attributes[i].data();
    }
    return result;
  }

  // Owns every array a render pipeline descriptor points into.
  struct RenderDescriptor {
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    std::string label, vertex_entry, fragment_entry;
    VertexLayouts layouts;
    Constants vertex_constants, fragment_constants;
    std::vector<WGPUColorTargetState> targets;
    std::vector<WGPUBlendState> blends;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    bool has_fragment = false, has_depth = false;
    void finish() {
      descriptor.label = view(label);
      descriptor.vertex.entryPoint = view(vertex_entry);
      descriptor.vertex.bufferCount = layouts.buffers.size();
      descriptor.vertex.buffers = layouts.buffers.data();
      descriptor.vertex.constantCount = vertex_constants.entries.size();
      descriptor.vertex.constants = vertex_constants.entries.data();
      if (has_fragment) {
        fragment.entryPoint = view(fragment_entry);
        fragment.constantCount = fragment_constants.entries.size();
        fragment.constants = fragment_constants.entries.data();
        size_t blend = 0;
        for (auto &target : targets) {
          if (target.blend) target.blend = &blends[blend++];
        }
        fragment.targetCount = targets.size();
        fragment.targets = targets.data();
        descriptor.fragment = &fragment;
      }
      if (has_depth) descriptor.depthStencil = &depth;
    }
  };

  template <class Op>
  std::unique_ptr<RenderDescriptor> render_descriptor(const Op &op) {
    auto r = std::make_unique<RenderDescriptor>();
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    const std::string color_format = op.colorFormat.text();
    target.format = color_format.empty() ? WGPUTextureFormat_BGRA8Unorm : texture_format(color_format);
    target.writeMask = WGPUColorWriteMask_All;
    if (op.blend == 1) {
      WGPUBlendState blend;
      blend.color = WGPUBlendComponent{WGPUBlendOperation_Add, WGPUBlendFactor_SrcAlpha, WGPUBlendFactor_OneMinusSrcAlpha};
      blend.alpha = WGPUBlendComponent{WGPUBlendOperation_Add, WGPUBlendFactor_One, WGPUBlendFactor_OneMinusSrcAlpha};
      r->blends.push_back(blend);
      target.blend = &r->blends.back();
    } else if (op.blend != 0) {
      fail("unsupported GPU blend mode");
    }
    r->label = op.label.text();
    r->descriptor.layout = op.layout != Handle{} ? ref<WGPUPipelineLayout>(hv(op.layout), Kind::PipelineLayout) : nullptr;
    r->descriptor.vertex.module = ref<WGPUShaderModule>(hv(op.vertexShader), Kind::ShaderModule);
    r->vertex_entry = op.vertexEntry.text();
    r->layouts = vertex_layouts(op.vertexLayouts);
    r->descriptor.primitive.topology = pick(kTopologies, ng::enums::kTopology, op.topology);
    r->descriptor.primitive.frontFace = pick(kFronts, ng::enums::kFront, op.frontFace);
    r->descriptor.primitive.cullMode = pick(kCulls, ng::enums::kCull, op.cullMode);
    r->descriptor.multisample.count = op.sampleCount;
    if (op.fragmentShader != Handle{}) {
      r->fragment.module = ref<WGPUShaderModule>(hv(op.fragmentShader), Kind::ShaderModule);
      r->fragment_entry = op.fragmentEntry.text();
      r->targets.push_back(target);
      r->has_fragment = true;
    }
    const std::string depth_format = op.depthFormat.text();
    if (!depth_format.empty()) {
      r->depth.format = texture_format(depth_format);
      r->depth.depthWriteEnabled = op.depthWrite ? WGPUOptionalBool_True : WGPUOptionalBool_False;
      r->depth.depthCompare = pick(kCompares, ng::enums::kCompare, op.depthCompare);
      r->has_depth = true;
    }
    r->finish();
    return r;
  }

  WGPUBlendComponent blend_component(double operation, double src, double dst) {
    WGPUBlendComponent component;
    component.operation = pick_or(kBlendOperations, ng::enums::kBlendOperation, operation, WGPUBlendOperation_Add);
    component.srcFactor = pick_or(kBlendFactors, ng::enums::kBlendFactor, src, WGPUBlendFactor_One);
    component.dstFactor = pick_or(kBlendFactors, ng::enums::kBlendFactor, dst, WGPUBlendFactor_Zero);
    return component;
  }
  WGPUStencilFaceState stencil_face(double compare, double fail_op, double depth_fail, double pass) {
    WGPUStencilFaceState face;
    face.compare = pick_or(kCompares, ng::enums::kCompare, compare, WGPUCompareFunction_Always);
    face.failOp = pick_or(kStencilOperations, ng::enums::kStencilOperation, fail_op, WGPUStencilOperation_Keep);
    face.depthFailOp = pick_or(kStencilOperations, ng::enums::kStencilOperation, depth_fail, WGPUStencilOperation_Keep);
    face.passOp = pick_or(kStencilOperations, ng::enums::kStencilOperation, pass, WGPUStencilOperation_Keep);
    return face;
  }

  template <class Op>
  std::unique_ptr<RenderDescriptor> render_descriptor_with(const Op &op) {
    namespace rec = ng::record;
    auto r = std::make_unique<RenderDescriptor>();
    const size_t target_count = records("colorTarget", rec::ColorTarget::kWidth, op.targets, 0,
                                        static_cast<size_t>(limit("maxColorAttachments", 8)));
    const ng::F64Array &t = op.targets;
    for (size_t i = 0; i < target_count; ++i) {
      const uint32_t base = static_cast<uint32_t>(i * rec::ColorTarget::kWidth);
      auto field = [&](uint32_t f) { return t[base + f]; };
      WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
      if (field(rec::ColorTarget::kFormat) == 0) {
        target.format = WGPUTextureFormat_Undefined;
        target.writeMask = WGPUColorWriteMask_None;
        r->targets.push_back(target);
        continue;
      }
      target.format = pick(kTextureFormats, ng::enums::kFormat, field(rec::ColorTarget::kFormat));
      const uint64_t mask = integer(field(rec::ColorTarget::kWriteMask), "color write mask");
      if (mask > 15) fail("invalid GPU color write mask");
      target.writeMask = static_cast<WGPUColorWriteMask>(mask);
      if (flag(field(rec::ColorTarget::kBlend), "blend")) {
        WGPUBlendState blend;
        blend.color = blend_component(field(rec::ColorTarget::kColorOperation), field(rec::ColorTarget::kColorSrcFactor),
                                      field(rec::ColorTarget::kColorDstFactor));
        blend.alpha = blend_component(field(rec::ColorTarget::kAlphaOperation), field(rec::ColorTarget::kAlphaSrcFactor),
                                      field(rec::ColorTarget::kAlphaDstFactor));
        r->blends.push_back(blend);
        target.blend = reinterpret_cast<const WGPUBlendState *>(1);  // patched in finish()
      }
      r->targets.push_back(target);
    }
    r->label = op.label.text();
    r->descriptor.layout = op.layout != Handle{} ? ref<WGPUPipelineLayout>(hv(op.layout), Kind::PipelineLayout) : nullptr;
    r->descriptor.vertex.module = ref<WGPUShaderModule>(hv(op.vertexShader), Kind::ShaderModule);
    r->vertex_entry = op.vertexEntry.text();
    r->layouts = vertex_layouts(op.vertexLayouts);
    r->vertex_constants = constants_of(op.constants, ng::constants::SHADER_STAGE_VERTEX);
    if (op.fragmentShader != Handle{}) {
      r->fragment.module = ref<WGPUShaderModule>(hv(op.fragmentShader), Kind::ShaderModule);
      r->fragment_entry = op.fragmentEntry.text();
      r->fragment_constants = constants_of(op.constants, ng::constants::SHADER_STAGE_FRAGMENT);
      r->has_fragment = true;
    } else if (!r->targets.empty()) {
      fail("GPU colour targets need a fragment stage");
    }
    if (records("primitive", rec::Primitive::kWidth, op.primitive, 0, SIZE_MAX, true)) {
      const ng::F64Array &p = op.primitive;
      WGPUPrimitiveState &primitive = r->descriptor.primitive;
      primitive.topology = pick_or(kTopologies, ng::enums::kTopology, p[rec::Primitive::kTopology],
                                   WGPUPrimitiveTopology_TriangleList);
      primitive.stripIndexFormat = pick_or(kIndexFormats, ng::enums::kIndex, p[rec::Primitive::kStripIndexFormat],
                                           WGPUIndexFormat_Undefined);
      primitive.frontFace = pick_or(kFronts, ng::enums::kFront, p[rec::Primitive::kFrontFace], WGPUFrontFace_CCW);
      primitive.cullMode = pick(kCulls, ng::enums::kCull, p[rec::Primitive::kCullMode]);
      primitive.unclippedDepth = flag(p[rec::Primitive::kUnclippedDepth], "unclipped depth");
    }
    if (records("depthStencil", rec::DepthStencil::kWidth, op.depthStencil, 0, SIZE_MAX, true)) {
      const ng::F64Array &d = op.depthStencil;
      if (d[rec::DepthStencil::kFormat] == 0) fail("GPU depth-stencil state needs a format");
      WGPUDepthStencilState &depth = r->depth;
      depth.format = pick(kTextureFormats, ng::enums::kFormat, d[rec::DepthStencil::kFormat]);
      depth.depthWriteEnabled = flag(d[rec::DepthStencil::kDepthWrite], "depth write") ? WGPUOptionalBool_True
                                                                                       : WGPUOptionalBool_False;
      depth.depthCompare = pick_or(kCompares, ng::enums::kCompare, d[rec::DepthStencil::kDepthCompare],
                                   WGPUCompareFunction_Undefined);
      depth.stencilFront = stencil_face(d[rec::DepthStencil::kFrontCompare], d[rec::DepthStencil::kFrontFail],
                                        d[rec::DepthStencil::kFrontDepthFail], d[rec::DepthStencil::kFrontPass]);
      depth.stencilBack = stencil_face(d[rec::DepthStencil::kBackCompare], d[rec::DepthStencil::kBackFail],
                                       d[rec::DepthStencil::kBackDepthFail], d[rec::DepthStencil::kBackPass]);
      depth.stencilReadMask = u32_field(d[rec::DepthStencil::kStencilReadMask], "stencil read mask");
      depth.stencilWriteMask = u32_field(d[rec::DepthStencil::kStencilWriteMask], "stencil write mask");
      depth.depthBias = i32_field(d[rec::DepthStencil::kDepthBias], "depth bias");
      depth.depthBiasSlopeScale = static_cast<float>(finite(d[rec::DepthStencil::kDepthBiasSlopeScale], "depth bias slope scale"));
      depth.depthBiasClamp = static_cast<float>(finite(d[rec::DepthStencil::kDepthBiasClamp], "depth bias clamp"));
      r->has_depth = true;
    }
    if (records("multisample", rec::Multisample::kWidth, op.multisample, 0, SIZE_MAX, true)) {
      const ng::F64Array &m = op.multisample;
      r->descriptor.multisample.count = static_cast<uint32_t>(std::min<uint64_t>(integer(m[rec::Multisample::kCount], "sample count"), 0xffffffffu));
      r->descriptor.multisample.mask = u32_field(m[rec::Multisample::kMask], "sample mask");
      r->descriptor.multisample.alphaToCoverageEnabled = flag(m[rec::Multisample::kAlphaToCoverage], "alpha to coverage");
    }
    r->finish();
    return r;
  }

  struct ComputeDescriptor {
    WGPUComputePipelineDescriptor descriptor = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    std::string label, entry;
    Constants constants;
  };
  std::unique_ptr<ComputeDescriptor> compute_descriptor(Handle layout, Handle shader, const ng::Str &entry,
                                                        const ng::Str &label, const ng::F64Array *constants) {
    auto c = std::make_unique<ComputeDescriptor>();
    c->label = label.text();
    c->entry = entry.text();
    c->descriptor.layout = layout != Handle{} ? ref<WGPUPipelineLayout>(hv(layout), Kind::PipelineLayout) : nullptr;
    c->descriptor.compute.module = ref<WGPUShaderModule>(hv(shader), Kind::ShaderModule);
    if (constants) c->constants = constants_of(*constants, ng::constants::SHADER_STAGE_COMPUTE);
    c->descriptor.label = view(c->label);
    c->descriptor.compute.entryPoint = view(c->entry);
    c->descriptor.compute.constantCount = c->constants.entries.size();
    c->descriptor.compute.constants = c->constants.entries.data();
    return c;
  }

  // Captures validation and out-of-memory errors of one creation call (the async pipeline path).
  template <class Fn>
  std::string scoped(Fn fn) {
    ntgpu_scope_push(ctx, WGPUErrorFilter_Validation);
    ntgpu_scope_push(ctx, WGPUErrorFilter_OutOfMemory);
    try {
      fn();
    } catch (...) {
      NtGpuDiag ignored{};
      ntgpu_scope_pop(ctx, &ignored);
      ntgpu_scope_pop(ctx, &ignored);
      throw;
    }
    NtGpuDiag oom{}, validation{};
    ntgpu_scope_pop(ctx, &oom);
    std::string oom_message = oom.status != NTGPU_OK && oom.message ? oom.message : "";
    if (oom.status != NTGPU_OK && oom_message.empty()) oom_message = "GPU out of memory";
    ntgpu_scope_pop(ctx, &validation);
    if (validation.status != NTGPU_OK) {
      std::string message = validation.message ? validation.message : "";
      return message.empty() ? std::string("GPU validation error") : message;
    }
    return oom_message;
  }

  void async_pipeline(double handle, uint32_t request_id, Kind kind, const std::function<void *()> &make) {
    Entry &entry = handles.reserve(handle, kind);
    Request *record = nullptr;
    try {
      record = &request(request_id, E_PIPELINE_READY, static_cast<uint32_t>(handle));
    } catch (...) {
      entry.failed = true;
      throw;
    }
    record->cleanup = Cleanup::Pipeline;
    record->slot = static_cast<uint32_t>(handle) & kSlotMask;
    record->entry_serial = entry.serial;
    record->pipeline_kind = kind;
    entry.request = request_id;
    // wgpu-native has no async creation: create now (ordered with the batch), complete after the batch.
    void *value = nullptr;
    const std::string error = scoped([&] { value = make(); });
    if (!error.empty()) {
      release_object(kind, value, true);
      record->pipeline_failed = true;
      record->message = error;
    } else {
      record->pipeline = value;
    }
    record->deferred = Deferred::Pipeline;
    deferred.emplace_back(request_id, record->serial);
  }

  struct UploadView {
    const uint8_t *data;
    size_t length;
  };
  UploadView upload_range(const ng::UploadRange &slice) {
    if (static_cast<uint64_t>(slice.offset) + slice.length > upload_size) fail("GPU upload outside staging arena");
    return UploadView{uploads + slice.offset, slice.length};
  }
  Entry &encoder(double handle) {
    Entry &entry = handles.lookup(handle, Kind::CommandEncoder);
    if (entry.phase == LOCKED) fail("GPU command encoder has an open pass");
    if (entry.phase == FINISHED) fail("GPU command encoder has finished");
    recording = entry.uses.get();
    return entry;
  }
  Entry &pass(double handle, Kind kind) {
    Entry &entry = handles.lookup(handle, kind);
    recording = entry.uses.get();
    if (!entry.pass) entry.pass = std::make_unique<PassState>();
    if (entry.pass->ended) fail(std::string("GPU ") + (kind == Kind::RenderPass ? "render" : "compute") + " pass has ended");
    return entry;
  }
  template <class Make>
  void begin_pass(double handle, Kind kind, Entry &owner, Handle owner_handle, Make make,
                  const std::function<void(PassState &)> &setup = {}) {
    auto state = std::make_unique<PassState>();
    state->encoder_slot = ng::handle_slot(owner_handle);
    state->encoder_serial = owner.serial;
    if (setup) setup(*state);
    void *owner_value = owner.value;
    // Entries are heap objects; reserving another (necessarily different) slot never moves or frees the owner.
    Entry &entry = create(handle, kind, [&] { return make(owner_value); });
    entry.pass = std::move(state);
    entry.uses = owner.uses;
    owner.phase = LOCKED;
  }
  void end_pass(double handle, Kind kind) {
    Entry &entry = pass(handle, kind);
    if (entry.pass->occlusion_active) fail("GPU occlusion query is still active");
    if (kind == Kind::RenderPass) wgpuRenderPassEncoderEnd(static_cast<WGPURenderPassEncoder>(entry.value));
    else wgpuComputePassEncoderEnd(static_cast<WGPUComputePassEncoder>(entry.value));
    entry.pass->ended = true;
    // The encoder entry the pass began on; a retired or reused slot is a different entry and stays untouched.
    Entry *owner = handles.by_serial(entry.pass->encoder_slot, entry.pass->encoder_serial);
    if (owner && owner->live && owner->has_state && owner->phase == LOCKED) owner->phase = OPEN;
  }
  WGPURenderPassEncoder drawable(double handle, bool indexed) {
    Entry &entry = pass(handle, Kind::RenderPass);
    if (!entry.pass->pipeline) fail("GPU draw without a render pipeline");
    if (indexed && !entry.pass->index) fail("GPU indexed draw without an index buffer");
    return static_cast<WGPURenderPassEncoder>(entry.value);
  }
  WGPUComputePassEncoder dispatchable(double handle) {
    Entry &entry = pass(handle, Kind::ComputePass);
    if (!entry.pass->pipeline) fail("GPU dispatch without a compute pipeline");
    return static_cast<WGPUComputePassEncoder>(entry.value);
  }
  WGPUBuffer unmapped_buffer(double handle) {
    Entry &entry = handles.lookup(handle, Kind::Buffer);
    if (entry.map != UNMAPPED) fail("GPU buffer is mapped or has a pending map");
    return static_cast<WGPUBuffer>(entry.value);
  }

  // -------------------------------------------------------------------------------------------------------------
  // device negotiation (runs after the batch, like the JS host's awaited adapter/device requests)

  void negotiate(uint32_t request_id, double power_value, uint32_t required_bits, uint32_t optional_bits,
                 const std::vector<double> &limit_values) {
    if (requesting || device) fail("GPU device already requested");
    if ((required_bits | optional_bits) & ~kKnownFeatureBits) fail("unsupported GPU feature bits");
    const WGPUPowerPreference power = pick(kPowers, ng::enums::kPower, power_value);
    const size_t width = ng::record::LimitRequest::kWidth;
    if (limit_values.size() % width) fail("invalid GPU limitRequest record");
    const size_t count = limit_values.size() / width;
    if (count > kLimitCount) {
      fail("GPU limitRequest record count " + std::to_string(count) + " outside 0.." + std::to_string(kLimitCount));
    }
    std::vector<LimitWish> wishes;
    std::vector<double> wanted;
    for (size_t i = 0; i < count; ++i) {
      const double id = limit_values[i * width], value = limit_values[i * width + 1], mode = limit_values[i * width + 2];
      if (!is_integer(id) || id < 0 || id > static_cast<double>(kLimitCount) || !ng::kLimits[static_cast<size_t>(id)].name) {
        fail("unsupported GPU limit " + jsnum(id));
      }
      const ng::LimitInfo &spec = ng::kLimits[static_cast<size_t>(id)];
      if (std::find(wanted.begin(), wanted.end(), id) != wanted.end()) fail(std::string("duplicate GPU limit ") + spec.name);
      wanted.push_back(id);
      const uint64_t amount = integer(value, (std::string(spec.name) + " value").c_str());
      if (mode != ng::constants::LIMIT_MODE_REQUIRED && mode != ng::constants::LIMIT_MODE_PREFERRED) {
        fail("invalid GPU limit mode " + jsnum(mode));
      }
      const bool alignment = spec.limit_class == ng::LimitClass::Alignment;
      if (alignment && (amount == 0 || (amount & (amount - 1)) != 0)) fail(std::string("GPU ") + spec.name + " must be a power of two");
      const LimitSlot *slot = limit_slot(spec.name);
      wishes.push_back(LimitWish{slot, amount, mode == ng::constants::LIMIT_MODE_REQUIRED, alignment});
    }
    Request &record = request(request_id, E_CAPABILITIES, 0);
    record.device = false;
    record.cleanup = Cleanup::Negotiate;
    record.deferred = Deferred::Negotiate;
    record.power = power;
    record.required_bits = required_bits;
    record.optional_bits = optional_bits;
    record.limits = std::move(wishes);
    requesting = record.serial;
    deferred.emplace_back(request_id, record.serial);
  }

  void run_negotiation(uint32_t id, uint64_t serial) {
    Request *record = current(id, serial);
    if (!record) return;
    struct Done {
      NtGpuExecutor *self;
      uint64_t serial;
      ~Done() {
        if (self->requesting == serial) self->requesting = 0;
      }
    } done{this, serial};
    const uint32_t required_bits = record->required_bits, optional_bits = record->optional_bits;
    const std::vector<LimitWish> wishes = record->limits;
    if (ntgpu_device(ctx)) release_native_device();
    if (ntgpu_request_adapter(ctx, 0, record->power) != NTGPU_OK) {
      settle(id, serial, E_CAPABILITIES, S_ERROR, Json().boolean("available", false).str("reason", "no WebGPU adapter"));
      return;
    }
    NtGpuCapabilities adapter_caps;
    if (ntgpu_adapter_capabilities(ctx, &adapter_caps) != NTGPU_OK) {
      settle(id, serial, E_ERROR, S_ERROR, Json().str("message", "GPU adapter capabilities unavailable"));
      return;
    }
    const FeatureSet adapter_features = features_of(adapter_caps);
    const std::string adapter_limits = limits_json(adapter_caps.limits);
    std::vector<std::string> missing_features;
    std::vector<WGPUFeatureName> required_features;
    uint32_t missing_bits = 0;
    for (size_t bit = 0; bit < sizeof(ng::kFeatures) / sizeof(ng::kFeatures[0]); ++bit) {
      const uint32_t mask = 1u << bit;
      const bool has = adapter_features.has(ng::kFeatures[bit]);
      if ((required_bits & mask) && !has) {
        missing_features.emplace_back(ng::kFeatures[bit]);
        missing_bits |= mask;
      }
      if (((required_bits | optional_bits) & mask) && has) {
        WGPUFeatureName feature;
        if (ntgpu_feature_from_name(ng::kFeatures[bit], &feature)) required_features.push_back(feature);
      }
    }
    WGPULimits required_limits = WGPU_LIMITS_INIT;
    std::vector<std::string> missing_limits;
    for (const LimitWish &wish : wishes) {
      uint64_t supported;
      if (!limit_get(adapter_caps.limits, *wish.slot, &supported)) supported = wish.slot->fallback;
      const bool satisfied = wish.alignment ? wish.value >= supported : wish.value <= supported;
      if (wish.required && !satisfied) {
        missing_limits.emplace_back(wish.slot->name);
        continue;
      }
      uint64_t granted = satisfied ? wish.value : supported;
      // WebGPU upgrades a request that is worse than the default to the default.
      granted = wish.alignment ? std::min(granted, wish.slot->fallback) : std::max(granted, wish.slot->fallback);
      uint64_t defined;
      if (!limit_get(adapter_caps.limits, *wish.slot, &defined)) continue;  // left to the implementation
      limit_set(required_limits, *wish.slot, granted);
    }
    if (!missing_features.empty() || !missing_limits.empty()) {
      settle(id, serial, E_CAPABILITIES, S_ERROR,
             Json()
                 .boolean("available", false)
                 .str("reason", "required GPU features or limits unavailable")
                 .raw("missingFeatures", json_string_array(missing_features))
                 .num("missingFeatureBits", missing_bits)
                 .raw("missingLimits", json_string_array(missing_limits))
                 .raw("adapterFeatures", json_string_array(adapter_features.names))
                 .num("adapterFeatureBits", adapter_features.bits)
                 .raw("adapterLimits", adapter_limits));
      return;
    }
    NtGpuStatus status;
    {
      std::lock_guard<std::mutex> poll(poll_mutex);
      status = ntgpu_request_device(ctx, 0, required_features.data(), required_features.size(), &required_limits);
    }
    if (status != NTGPU_OK) {
      NtGpuEvent event;
      std::string message = "GPU device request failed";
      while (ntgpu_next_event(ctx, &event)) {
        if (event.kind == NTGPU_EVENT_DEVICE && event.message && *event.message) message = event.message;
      }
      settle(id, serial, E_ERROR, S_ERROR, Json().str("message", message));
      return;
    }
    NtGpuCapabilities device_caps;
    if (ntgpu_device_capabilities(ctx, &device_caps) != NTGPU_OK) {
      settle(id, serial, E_ERROR, S_ERROR, Json().str("message", "GPU device capabilities unavailable"));
      release_native_device();
      return;
    }
    if (!current(id, serial)) {
      release_native_device();
      return;
    }
    const FeatureSet device_features = features_of(device_caps);
    device = true;
    ++epoch;
    device_generation = ntgpu_device_generation(ctx);
    device_limits = device_caps.limits;
    timestamp_queries = device_features.has("timestamp-query");
    settle(id, serial, E_CAPABILITIES, S_OK,
           Json()
               .boolean("available", true)
               .raw("features", json_string_array(device_features.names))
               .num("featureBits", device_features.bits)
               .raw("adapterFeatures", json_string_array(adapter_features.names))
               .num("adapterFeatureBits", adapter_features.bits)
               .raw("limits", limits_json(device_caps.limits))
               .raw("adapterLimits", adapter_limits)
               .str("format", "bgra8unorm")
               .num("formatCode", ng::constants::FORMAT_BGRA8UNORM)
               .raw("protocol", "{\"version\":" + std::to_string(ng::kProtocolVersion) +
                                    ",\"identity\":" + std::to_string(ng::kProtocolIdentity) + "}"));
    pixels();
  }

  void run_deferred() {
    // Completions of this batch's shader modules, async pipelines and device requests, in request order, after
    // every operation of the batch ran (so a later cancelRequest/destroy in the same batch wins, as in the JS host).
    while (!deferred.empty()) {
      auto list = std::move(deferred);
      deferred.clear();
      for (const auto &item : list) {
        Request *record = current(item.first, item.second);
        if (!record) continue;
        switch (record->deferred) {
          case Deferred::Negotiate: run_negotiation(item.first, item.second); break;
          case Deferred::ShaderInfo:
            settle(item.first, item.second, E_SHADER_INFO, record->shader_error ? S_ERROR : S_OK,
                   Json().raw("messages", record->messages));
            break;
          case Deferred::Pipeline:
            if (record->pipeline_failed) {
              const std::string message = record->message;
              settle(item.first, item.second, E_ERROR, S_ERROR, Json().str("message", message));
            } else {
              void *value = record->pipeline;
              record->pipeline = nullptr;
              if (handles.complete(record->slot, record->entry_serial, record->pipeline_kind, value)) {
                settle(item.first, item.second, E_PIPELINE_READY, S_OK);
              }
            }
            break;
          case Deferred::None: break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // visitor

  template <class Fn>
  bool guard(Fn fn) {
    recording = nullptr;
    try {
      fn();
      return true;
    } catch (const Reject &reject) {
      last_error = reject.message;
    } catch (const std::bad_alloc &) {
      last_error = "GPU executor out of memory";
    }
    return false;
  }

  struct Visitor {
    NtGpuExecutor &x;

    bool on(const ng::RequestDeviceOp &op) {
      return x.guard([&] {
        if (op.featureBits & ~1u) fail("unsupported GPU feature bits");
        std::vector<double> limits;
        if (op.maxBufferSize != 0 && !std::isnan(op.maxBufferSize)) {
          limits = {static_cast<double>(limit_index("maxBufferSize")), op.maxBufferSize,
                    static_cast<double>(ng::constants::LIMIT_MODE_REQUIRED)};
        }
        x.negotiate(op.requestId, op.powerPreference, 0, op.featureBits, limits);
      });
    }
    static size_t limit_index(const char *name) {
      for (size_t i = 1; i <= kLimitCount; ++i) {
        if (std::strcmp(ng::kLimits[i].name, name) == 0) return i;
      }
      return 0;
    }
    bool on(const ng::RequestDeviceWithOp &op) {
      return x.guard([&] {
        std::vector<double> limits(op.limits.size());
        for (uint32_t i = 0; i < op.limits.size(); ++i) limits[i] = op.limits[i];
        x.negotiate(op.requestId, op.powerPreference, op.requiredFeatures, op.optionalFeatures, limits);
      });
    }
    bool on(const ng::CancelRequestOp &op) {
      return x.guard([&] { x.cancel(op.request); });
    }
    bool on(const ng::DestroyDeviceOp &) {
      return x.guard([&] {
        x.active();
        x.lose_device("destroyed", "GPU device destroyed by the guest");
        x.release_native_device();
      });
    }
    bool on(const ng::CreateBufferOp &op) {
      return x.guard([&] {
        const uint64_t bytes = integer(op.size, "buffer size");
        if (op.mappedAtCreation && bytes % 4) fail("GPU mapped-at-creation buffer size must be a multiple of 4");
        const std::string label = op.label.text();
        Entry &entry = x.create(hv(op.handle), Kind::Buffer, [&] {
          WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.size = bytes;
          descriptor.usage = op.usage;
          descriptor.mappedAtCreation = op.mappedAtCreation;
          return static_cast<void *>(wgpuDeviceCreateBuffer(x.active(), &descriptor));
        });
        entry.size = bytes;
        entry.track = std::make_shared<Tracked>();
        entry.track->kind = "buffer";
        entry.set_map(op.mappedAtCreation ? MAPPED : UNMAPPED);
      });
    }
    bool on(const ng::CreateTextureOp &op) {
      return x.guard([&] {
        const std::string label = op.label.text(), format = op.format.text();
        x.create(hv(op.handle), Kind::Texture, [&] {
          WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.size = WGPUExtent3D{op.width, op.height, op.depth};
          descriptor.mipLevelCount = op.mipLevels;
          descriptor.sampleCount = op.samples;
          descriptor.dimension = pick(kDimensions, ng::enums::kDimension, op.dimension);
          descriptor.format = texture_format(format);
          descriptor.usage = op.usage;
          return static_cast<void *>(wgpuDeviceCreateTexture(x.active(), &descriptor));
        });
        Entry *entry = x.handles.peek(hv(op.handle));
        entry->track = std::make_shared<Tracked>();
        entry->track->kind = "texture";
      });
    }
    bool on(const ng::CreateTextureViewOp &op) {
      return x.guard([&] {
        const std::string label = op.label.text(), format = op.format.text();
        WGPUTextureViewDescriptor descriptor = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        descriptor.label = view(label);
        descriptor.baseMipLevel = op.baseMip;
        descriptor.baseArrayLayer = op.baseLayer;
        descriptor.aspect = pick(kAspects, ng::enums::kAspect, op.aspect);
        if (!format.empty()) descriptor.format = texture_format(format);
        if (op.dimension) descriptor.dimension = pick(kViewDimensions, ng::enums::kView, op.dimension);
        if (op.mipCount) descriptor.mipLevelCount = op.mipCount;
        if (op.layerCount) descriptor.arrayLayerCount = op.layerCount;
        Entry &texture = x.handles.lookup(hv(op.texture), Kind::Texture);
        WGPUTexture source = static_cast<WGPUTexture>(texture.value);
        TrackedPtr track = texture.track;
        Entry &view = x.create(hv(op.handle), Kind::TextureView,
                               [&] { return static_cast<void *>(wgpuTextureCreateView(source, &descriptor)); });
        view.track = track;
      });
    }
    bool on(const ng::CreateSamplerOp &op) {
      return x.guard([&] {
        const std::string label = op.label.text();
        x.create(hv(op.handle), Kind::Sampler, [&] {
          WGPUDevice device = x.active();
          WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.addressModeU = pick(kAddressModes, ng::enums::kAddress, op.addressU);
          descriptor.addressModeV = pick(kAddressModes, ng::enums::kAddress, op.addressV);
          descriptor.addressModeW = pick(kAddressModes, ng::enums::kAddress, op.addressW);
          descriptor.magFilter = pick(kFilters, ng::enums::kFilter, op.magFilter);
          descriptor.minFilter = pick(kFilters, ng::enums::kFilter, op.minFilter);
          descriptor.mipmapFilter = pick(kMipmapFilters, ng::enums::kFilter, op.mipmapFilter);
          descriptor.lodMinClamp = op.lodMin;
          descriptor.lodMaxClamp = op.lodMax;
          descriptor.compare = op.compare ? pick(kCompares, ng::enums::kCompare, op.compare) : WGPUCompareFunction_Undefined;
          if (op.maxAnisotropy > 65535) fail("invalid GPU max anisotropy");
          descriptor.maxAnisotropy = static_cast<uint16_t>(op.maxAnisotropy);
          return static_cast<void *>(wgpuDeviceCreateSampler(device, &descriptor));
        });
      });
    }
    bool on(const ng::CreateShaderModuleOp &op) {
      return x.guard([&] {
        const std::string code = op.code.text(), label = op.label.text();
        std::string error;
        x.create(hv(op.handle), Kind::ShaderModule, [&] {
          WGPUDevice device = x.active();
          WGPUShaderModule module = nullptr;
          error = x.scoped([&] {
            WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
            wgsl.code = view(code);
            WGPUShaderModuleDescriptor descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
            descriptor.nextInChain = &wgsl.chain;
            descriptor.label = view(label);
            module = wgpuDeviceCreateShaderModule(device, &descriptor);
          });
          return static_cast<void *>(module);
        });
        Request &record = x.request(op.requestId, E_SHADER_INFO, ng::handle_value(op.handle));
        record.deferred = Deferred::ShaderInfo;
        if (!error.empty()) {
          // wgpu-native has no getCompilationInfo: one error message recovered from the Naga report.
          NtGpuSourceLocation where;
          ntgpu_wgsl_location(error.c_str(), code.data(), code.size(), &where);
          const std::string summary = where.summary ? std::string(where.summary, where.summary_length) : error;
          std::string message = "[{";
          message += "\"message\":";
          append_escaped(message, summary);
          message += ",\"type\":\"error\",\"lineNum\":" + std::to_string(where.line_num) +
                     ",\"linePos\":" + std::to_string(where.line_pos) + ",\"offset\":" + std::to_string(where.offset) +
                     ",\"length\":" + std::to_string(where.length) + "}]";
          record.messages = message;
          record.shader_error = true;
        }
        x.deferred.emplace_back(op.requestId, record.serial);
      });
    }
    bool on(const ng::CreateBindGroupLayoutOp &op) {
      return x.guard([&] {
        namespace rec = ng::record;
        const size_t count = x.records("bindGroupLayout", rec::BindGroupLayout::kWidth, op.entries, 0, SIZE_MAX);
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (size_t i = 0; i < count; ++i) {
          const uint32_t base = static_cast<uint32_t>(i * rec::BindGroupLayout::kWidth);
          auto f = [&](uint32_t field) { return op.entries[base + field]; };
          WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
          entry.binding = static_cast<uint32_t>(std::min<uint64_t>(integer(f(rec::BindGroupLayout::kBinding), "binding"), 0xffffffffu));
          entry.visibility = u32_field(f(rec::BindGroupLayout::kVisibility), "visibility");
          const double kind = f(rec::BindGroupLayout::kKind);
          if (kind == 1) {
            entry.buffer.type = pick(kBufferBindings, ng::enums::kBuffer, f(rec::BindGroupLayout::kType));
            entry.buffer.hasDynamicOffset = f(rec::BindGroupLayout::kDynamic) != 0;
            entry.buffer.minBindingSize = integer(f(rec::BindGroupLayout::kMinSize), "min binding size");
          } else if (kind == 2) {
            entry.sampler.type = pick(kSamplerBindings, ng::enums::kSampler, f(rec::BindGroupLayout::kType));
          } else if (kind == 3) {
            entry.texture.sampleType = pick(kSampleTypes, ng::enums::kSample, f(rec::BindGroupLayout::kType));
            entry.texture.viewDimension = pick(kViewDimensions, ng::enums::kView, f(rec::BindGroupLayout::kDimension));
            entry.texture.multisampled = f(rec::BindGroupLayout::kMultisampled) != 0;
          } else if (kind == 4) {
            entry.storageTexture.access = pick(kAccesses, ng::enums::kAccess, f(rec::BindGroupLayout::kAccess));
            entry.storageTexture.format = pick(kTextureFormats, ng::enums::kFormat, f(rec::BindGroupLayout::kFormat));
            entry.storageTexture.viewDimension = pick(kViewDimensions, ng::enums::kView, f(rec::BindGroupLayout::kDimension));
          } else {
            fail("unsupported GPU binding kind");
          }
          entries.push_back(entry);
        }
        const std::string label = op.label.text();
        x.create(hv(op.handle), Kind::BindGroupLayout, [&] {
          WGPUBindGroupLayoutDescriptor descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.entryCount = entries.size();
          descriptor.entries = entries.data();
          return static_cast<void *>(wgpuDeviceCreateBindGroupLayout(x.active(), &descriptor));
        });
      });
    }
    bool on(const ng::CreateBindGroupOp &op) {
      return x.guard([&] {
        namespace rec = ng::record;
        const size_t count = x.records("bindGroup", rec::BindGroup::kWidth, op.entries, 0, SIZE_MAX);
        std::vector<WGPUBindGroupEntry> entries;
        std::vector<TrackedPtr> bound;
        for (size_t i = 0; i < count; ++i) {
          const uint32_t base = static_cast<uint32_t>(i * rec::BindGroup::kWidth);
          auto f = [&](uint32_t field) { return op.entries[base + field]; };
          WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
          const double kind = f(rec::BindGroup::kKind);
          if (kind == 1) {
            entry.buffer = x.tracked<WGPUBuffer>(f(rec::BindGroup::kResource), Kind::Buffer, bound);
            entry.offset = integer(f(rec::BindGroup::kOffset), "binding offset");
            if (f(rec::BindGroup::kSize) != 0) entry.size = integer(f(rec::BindGroup::kSize), "binding size");
          } else if (kind == 2) {
            entry.sampler = x.ref<WGPUSampler>(f(rec::BindGroup::kResource), Kind::Sampler);
          } else if (kind == 3 || kind == 4) {
            entry.textureView = x.tracked<WGPUTextureView>(f(rec::BindGroup::kResource), Kind::TextureView, bound);
          } else {
            fail("unsupported GPU binding resource");
          }
          entry.binding = static_cast<uint32_t>(std::min<uint64_t>(integer(f(rec::BindGroup::kBinding), "binding"), 0xffffffffu));
          entries.push_back(entry);
        }
        WGPUBindGroupLayout layout = x.ref<WGPUBindGroupLayout>(hv(op.layout), Kind::BindGroupLayout);
        const std::string label = op.label.text();
        x.create(hv(op.handle), Kind::BindGroup, [&] {
          WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.layout = layout;
          descriptor.entryCount = entries.size();
          descriptor.entries = entries.data();
          return static_cast<void *>(wgpuDeviceCreateBindGroup(x.active(), &descriptor));
        });
        x.handles.peek(hv(op.handle))->bound = std::move(bound);
      });
    }
    bool on(const ng::CreatePipelineLayoutOp &op) {
      return x.guard([&] {
        std::vector<WGPUBindGroupLayout> layouts;
        for (uint32_t i = 0; i < op.layouts.size(); ++i) {
          layouts.push_back(x.ref<WGPUBindGroupLayout>(hv(op.layouts[i]), Kind::BindGroupLayout));
        }
        const std::string label = op.label.text();
        x.create(hv(op.handle), Kind::PipelineLayout, [&] {
          WGPUPipelineLayoutDescriptor descriptor = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.bindGroupLayoutCount = layouts.size();
          descriptor.bindGroupLayouts = layouts.data();
          return static_cast<void *>(wgpuDeviceCreatePipelineLayout(x.active(), &descriptor));
        });
      });
    }
    void sync_compute(Handle handle, const ComputeDescriptor &c) {
      x.create(hv(handle), Kind::ComputePipeline,
               [&] { return static_cast<void *>(wgpuDeviceCreateComputePipeline(x.active(), &c.descriptor)); });
    }
    void async_compute(Handle handle, uint32_t request_id, std::unique_ptr<ComputeDescriptor> c) {
      WGPUDevice device = x.active();
      ComputeDescriptor *raw = c.get();
      x.async_pipeline(hv(handle), request_id, Kind::ComputePipeline,
                       [&] { return static_cast<void *>(wgpuDeviceCreateComputePipeline(device, &raw->descriptor)); });
    }
    bool on(const ng::CreateComputePipelineOp &op) {
      return x.guard([&] { sync_compute(op.handle, *x.compute_descriptor(op.layout, op.shader, op.entry, op.label, nullptr)); });
    }
    bool on(const ng::CreateComputePipelineAsyncOp &op) {
      return x.guard([&] {
        async_compute(op.handle, op.requestId, x.compute_descriptor(op.layout, op.shader, op.entry, op.label, nullptr));
      });
    }
    bool on(const ng::CreateComputePipelineWithOp &op) {
      return x.guard([&] {
        sync_compute(op.handle, *x.compute_descriptor(op.layout, op.shader, op.entry, op.label, &op.constants));
      });
    }
    bool on(const ng::CreateComputePipelineAsyncWithOp &op) {
      return x.guard([&] {
        async_compute(op.handle, op.requestId, x.compute_descriptor(op.layout, op.shader, op.entry, op.label, &op.constants));
      });
    }
    void sync_render(Handle handle, const RenderDescriptor &r) {
      x.create(hv(handle), Kind::RenderPipeline,
               [&] { return static_cast<void *>(wgpuDeviceCreateRenderPipeline(x.active(), &r.descriptor)); });
    }
    void async_render(Handle handle, uint32_t request_id, std::unique_ptr<RenderDescriptor> r) {
      WGPUDevice device = x.active();
      RenderDescriptor *raw = r.get();
      x.async_pipeline(hv(handle), request_id, Kind::RenderPipeline,
                       [&] { return static_cast<void *>(wgpuDeviceCreateRenderPipeline(device, &raw->descriptor)); });
    }
    bool on(const ng::CreateRenderPipelineOp &op) {
      return x.guard([&] { sync_render(op.handle, *x.render_descriptor(op)); });
    }
    bool on(const ng::CreateRenderPipelineAsyncOp &op) {
      return x.guard([&] { async_render(op.handle, op.requestId, x.render_descriptor(op)); });
    }
    bool on(const ng::CreateRenderPipelineWithOp &op) {
      return x.guard([&] { sync_render(op.handle, *x.render_descriptor_with(op)); });
    }
    bool on(const ng::CreateRenderPipelineAsyncWithOp &op) {
      return x.guard([&] { async_render(op.handle, op.requestId, x.render_descriptor_with(op)); });
    }
    bool on(const ng::CreateQuerySetOp &op) {
      return x.guard([&] {
        if (op.count < 1 || op.count > 4096) fail("invalid GPU query count");
        if (op.type == ng::constants::QUERY_TYPE_TIMESTAMP && (x.active(), !x.timestamp_queries)) {
          fail("GPU timestamp queries unavailable");
        }
        if (op.type != ng::constants::QUERY_TYPE_TIMESTAMP && op.type != ng::constants::QUERY_TYPE_OCCLUSION) {
          fail("unsupported GPU query type");
        }
        const std::string label = op.label.text();
        Entry &entry = x.create(hv(op.handle), Kind::QuerySet, [&] {
          WGPUQuerySetDescriptor descriptor = WGPU_QUERY_SET_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.type = op.type == ng::constants::QUERY_TYPE_TIMESTAMP ? WGPUQueryType_Timestamp : WGPUQueryType_Occlusion;
          descriptor.count = op.count;
          return static_cast<void *>(wgpuDeviceCreateQuerySet(x.active(), &descriptor));
        });
        entry.query_type = op.type;
        entry.query_count = op.count;
        entry.track = std::make_shared<Tracked>();
        entry.track->kind = "query set";
      });
    }
    bool on(const ng::CreateCommandEncoderOp &op) {
      return x.guard([&] {
        const std::string label = op.label.text();
        Entry &entry = x.create(hv(op.handle), Kind::CommandEncoder, [&] {
          WGPUCommandEncoderDescriptor descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          return static_cast<void *>(wgpuDeviceCreateCommandEncoder(x.active(), &descriptor));
        });
        entry.phase = OPEN;
        entry.uses = std::make_shared<Uses>();
      });
    }
    bool on(const ng::BeginComputePassOp &op) {
      return x.guard([&] {
        Entry &owner = x.encoder(hv(op.encoder));
        const std::string label = op.label.text();
        Timestamp timestamps = x.timestamp_writes(hv(op.querySet), op.beginIndex, op.endIndex);
        x.begin_pass(hv(op.handle), Kind::ComputePass, owner, op.encoder, [&](void *encoder) {
          WGPUComputePassDescriptor descriptor = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.timestampWrites = timestamps.used ? &timestamps.writes : nullptr;
          return static_cast<void *>(wgpuCommandEncoderBeginComputePass(static_cast<WGPUCommandEncoder>(encoder), &descriptor));
        });
      });
    }
    bool on(const ng::ComputeSetPipelineOp &op) {
      return x.guard([&] {
        Entry &entry = x.pass(hv(op.pass), Kind::ComputePass);
        wgpuComputePassEncoderSetPipeline(static_cast<WGPUComputePassEncoder>(entry.value),
                                          x.ref<WGPUComputePipeline>(hv(op.pipeline), Kind::ComputePipeline));
        entry.pass->pipeline = true;
      });
    }
    bool on(const ng::ComputeSetBindGroupOp &op) {
      return x.guard([&] {
        Entry &entry = x.pass(hv(op.pass), Kind::ComputePass);
        WGPUBindGroup group = x.ref<WGPUBindGroup>(hv(op.bindGroup), Kind::BindGroup);
        std::vector<uint32_t> offsets(op.dynamicOffsets.size());
        for (uint32_t i = 0; i < op.dynamicOffsets.size(); ++i) offsets[i] = op.dynamicOffsets[i];
        wgpuComputePassEncoderSetBindGroup(static_cast<WGPUComputePassEncoder>(entry.value), op.index, group,
                                           offsets.size(), offsets.data());
      });
    }
    bool on(const ng::ComputeDispatchOp &op) {
      return x.guard([&] { wgpuComputePassEncoderDispatchWorkgroups(x.dispatchable(hv(op.pass)), op.x, op.y, op.z); });
    }
    bool on(const ng::ComputeDispatchIndirectOp &op) {
      return x.guard([&] {
        WGPUComputePassEncoder pass = x.dispatchable(hv(op.pass));
        WGPUBuffer buffer = x.ref<WGPUBuffer>(hv(op.buffer), Kind::Buffer);
        wgpuComputePassEncoderDispatchWorkgroupsIndirect(pass, buffer, integer(op.offset, "indirect offset"));
      });
    }
    bool on(const ng::EndComputePassOp &op) {
      return x.guard([&] { x.end_pass(hv(op.pass), Kind::ComputePass); });
    }
    bool on(const ng::BeginRenderPassOp &op) {
      return x.guard([&] {
        Entry &owner = x.encoder(hv(op.encoder));
        const std::string label = op.label.text();
        std::vector<WGPURenderPassColorAttachment> colors;
        if (op.colorView != Handle{}) {
          WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
          color.view = x.ref<WGPUTextureView>(hv(op.colorView), Kind::TextureView);
          color.resolveTarget = x.optional<WGPUTextureView>(hv(op.resolveView), Kind::TextureView);
          color.loadOp = pick(kLoads, ng::enums::kLoad, op.colorLoad);
          color.storeOp = pick(kStores, ng::enums::kStore, op.colorStore);
          color.clearValue = WGPUColor{op.clearR, op.clearG, op.clearB, op.clearA};
          colors.push_back(color);
        }
        Timestamp timestamps = x.timestamp_writes(hv(op.querySet), op.beginIndex, op.endIndex);
        WGPURenderPassDepthStencilAttachment depth = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
        const bool has_depth = op.depthView != Handle{};
        if (has_depth) {
          depth.view = x.ref<WGPUTextureView>(hv(op.depthView), Kind::TextureView);
          depth.depthLoadOp = pick(kLoads, ng::enums::kLoad, op.depthLoad);
          depth.depthStoreOp = pick(kStores, ng::enums::kStore, op.depthStore);
          depth.depthClearValue = op.clearDepth;
        }
        x.begin_pass(hv(op.handle), Kind::RenderPass, owner, op.encoder, [&](void *encoder) {
          WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          descriptor.colorAttachmentCount = colors.size();
          descriptor.colorAttachments = colors.data();
          descriptor.depthStencilAttachment = has_depth ? &depth : nullptr;
          descriptor.timestampWrites = timestamps.used ? &timestamps.writes : nullptr;
          return static_cast<void *>(wgpuCommandEncoderBeginRenderPass(static_cast<WGPUCommandEncoder>(encoder), &descriptor));
        });
      });
    }
    bool on(const ng::BeginRenderPassWithOp &op) {
      return x.guard([&] {
        namespace rec = ng::record;
        Entry &owner = x.encoder(hv(op.encoder));
        const size_t count = x.records("colorAttachment", rec::ColorAttachment::kWidth, op.colors, 0,
                                       static_cast<size_t>(x.limit("maxColorAttachments", 8)));
        std::vector<WGPURenderPassColorAttachment> colors;
        for (size_t i = 0; i < count; ++i) {
          const uint32_t base = static_cast<uint32_t>(i * rec::ColorAttachment::kWidth);
          auto f = [&](uint32_t field) { return op.colors[base + field]; };
          WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
          if (f(rec::ColorAttachment::kView) == 0) {
            colors.push_back(color);
            continue;
          }
          color.view = x.ref<WGPUTextureView>(f(rec::ColorAttachment::kView), Kind::TextureView);
          color.resolveTarget = x.optional<WGPUTextureView>(f(rec::ColorAttachment::kResolveView), Kind::TextureView);
          color.loadOp = pick(kLoads, ng::enums::kLoad, f(rec::ColorAttachment::kLoad));
          color.storeOp = pick(kStores, ng::enums::kStore, f(rec::ColorAttachment::kStore));
          color.clearValue = WGPUColor{finite(f(rec::ColorAttachment::kClearR), "clear value"),
                                       finite(f(rec::ColorAttachment::kClearG), "clear value"),
                                       finite(f(rec::ColorAttachment::kClearB), "clear value"),
                                       finite(f(rec::ColorAttachment::kClearA), "clear value")};
          if (f(rec::ColorAttachment::kDepthSlicePlusOne) != 0) {
            color.depthSlice = static_cast<uint32_t>(integer(f(rec::ColorAttachment::kDepthSlicePlusOne), "depth slice") - 1);
          }
          colors.push_back(color);
        }
        const std::string label = op.label.text();
        Timestamp timestamps = x.timestamp_writes(hv(op.timestampQuerySet), op.beginIndex, op.endIndex);
        WGPURenderPassDepthStencilAttachment depth = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
        const bool has_depth = x.records("depthStencilAttachment", rec::DepthStencilAttachment::kWidth, op.depthStencil, 0,
                                         SIZE_MAX, true) == 1;
        if (has_depth) {
          const ng::F64Array &d = op.depthStencil;
          depth.view = x.ref<WGPUTextureView>(d[rec::DepthStencilAttachment::kView], Kind::TextureView);
          depth.depthLoadOp = pick_or(kLoads, ng::enums::kLoad, d[rec::DepthStencilAttachment::kDepthLoad], WGPULoadOp_Undefined);
          depth.depthStoreOp = pick_or(kStores, ng::enums::kStore, d[rec::DepthStencilAttachment::kDepthStore], WGPUStoreOp_Undefined);
          depth.depthClearValue = static_cast<float>(finite(d[rec::DepthStencilAttachment::kDepthClear], "depth clear value"));
          depth.depthReadOnly = flag(d[rec::DepthStencilAttachment::kDepthReadOnly], "depth read-only");
          depth.stencilLoadOp = pick_or(kLoads, ng::enums::kLoad, d[rec::DepthStencilAttachment::kStencilLoad], WGPULoadOp_Undefined);
          depth.stencilStoreOp = pick_or(kStores, ng::enums::kStore, d[rec::DepthStencilAttachment::kStencilStore], WGPUStoreOp_Undefined);
          depth.stencilClearValue = u32_field(d[rec::DepthStencilAttachment::kStencilClear], "stencil clear value");
          depth.stencilReadOnly = flag(d[rec::DepthStencilAttachment::kStencilReadOnly], "stencil read-only");
        }
        WGPUQuerySet occlusion = nullptr;
        uint32_t occlusion_count = 0;
        if (op.occlusionQuerySet != Handle{}) {
          Entry &set = x.handles.lookup(hv(op.occlusionQuerySet), Kind::QuerySet);
          x.note(set);
          if (!set.has_state || set.query_type != ng::constants::QUERY_TYPE_OCCLUSION) {
            fail("GPU occlusion queries need an occlusion query set");
          }
          occlusion = static_cast<WGPUQuerySet>(set.value);
          occlusion_count = set.query_count;
        }
        x.begin_pass(
            hv(op.handle), Kind::RenderPass, owner, op.encoder,
            [&](void *encoder) {
              WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
              descriptor.label = view(label);
              descriptor.colorAttachmentCount = colors.size();
              descriptor.colorAttachments = colors.data();
              descriptor.depthStencilAttachment = has_depth ? &depth : nullptr;
              descriptor.occlusionQuerySet = occlusion;
              descriptor.timestampWrites = timestamps.used ? &timestamps.writes : nullptr;
              return static_cast<void *>(
                  wgpuCommandEncoderBeginRenderPass(static_cast<WGPUCommandEncoder>(encoder), &descriptor));
            },
            [&](PassState &state) {
              if (!occlusion) return;
              state.occlusion = true;
              state.occlusion_count = occlusion_count;
              state.occlusion_used.assign(occlusion_count, false);
            });
      });
    }
    WGPURenderPassEncoder render(Handle pass) {
      return static_cast<WGPURenderPassEncoder>(x.pass(hv(pass), Kind::RenderPass).value);
    }
    bool on(const ng::RenderSetViewportOp &op) {
      return x.guard([&] {
        wgpuRenderPassEncoderSetViewport(render(op.pass), op.x, op.y, op.width, op.height, op.minDepth, op.maxDepth);
      });
    }
    bool on(const ng::RenderSetScissorOp &op) {
      return x.guard([&] { wgpuRenderPassEncoderSetScissorRect(render(op.pass), op.x, op.y, op.width, op.height); });
    }
    bool on(const ng::RenderSetPipelineOp &op) {
      return x.guard([&] {
        Entry &entry = x.pass(hv(op.pass), Kind::RenderPass);
        wgpuRenderPassEncoderSetPipeline(static_cast<WGPURenderPassEncoder>(entry.value),
                                         x.ref<WGPURenderPipeline>(hv(op.pipeline), Kind::RenderPipeline));
        entry.pass->pipeline = true;
      });
    }
    bool on(const ng::RenderSetBindGroupOp &op) {
      return x.guard([&] {
        WGPURenderPassEncoder pass = render(op.pass);
        WGPUBindGroup group = x.ref<WGPUBindGroup>(hv(op.bindGroup), Kind::BindGroup);
        std::vector<uint32_t> offsets(op.dynamicOffsets.size());
        for (uint32_t i = 0; i < op.dynamicOffsets.size(); ++i) offsets[i] = op.dynamicOffsets[i];
        wgpuRenderPassEncoderSetBindGroup(pass, op.index, group, offsets.size(), offsets.data());
      });
    }
    bool on(const ng::RenderSetVertexBufferOp &op) {
      return x.guard([&] {
        WGPURenderPassEncoder pass = render(op.pass);
        WGPUBuffer buffer = x.ref<WGPUBuffer>(hv(op.buffer), Kind::Buffer);
        const uint64_t offset = integer(op.offset, "vertex offset");
        const uint64_t size = op.size != 0 ? integer(op.size, "vertex size") : WGPU_WHOLE_SIZE;
        wgpuRenderPassEncoderSetVertexBuffer(pass, op.slot, buffer, offset, size);
      });
    }
    bool on(const ng::RenderSetIndexBufferOp &op) {
      return x.guard([&] {
        Entry &entry = x.pass(hv(op.pass), Kind::RenderPass);
        WGPUBuffer buffer = x.ref<WGPUBuffer>(hv(op.buffer), Kind::Buffer);
        const WGPUIndexFormat format = pick(kIndexFormats, ng::enums::kIndex, op.format);
        const uint64_t offset = integer(op.offset, "index offset");
        const uint64_t size = op.size != 0 ? integer(op.size, "index size") : WGPU_WHOLE_SIZE;
        wgpuRenderPassEncoderSetIndexBuffer(static_cast<WGPURenderPassEncoder>(entry.value), buffer, format, offset, size);
        entry.pass->index = true;
      });
    }
    bool on(const ng::RenderSetStencilReferenceOp &op) {
      return x.guard([&] { wgpuRenderPassEncoderSetStencilReference(render(op.pass), op.reference); });
    }
    bool on(const ng::RenderSetBlendConstantOp &op) {
      return x.guard([&] {
        WGPURenderPassEncoder pass = render(op.pass);
        const WGPUColor color{finite(op.r, "blend constant"), finite(op.g, "blend constant"), finite(op.b, "blend constant"),
                              finite(op.a, "blend constant")};
        wgpuRenderPassEncoderSetBlendConstant(pass, &color);
      });
    }
    bool on(const ng::RenderBeginOcclusionQueryOp &op) {
      return x.guard([&] {
        Entry &entry = x.pass(hv(op.pass), Kind::RenderPass);
        PassState &state = *entry.pass;
        if (!state.occlusion) fail("GPU render pass has no occlusion query set");
        if (state.occlusion_active) fail("GPU occlusion query is already active");
        if (op.index >= state.occlusion_count || state.occlusion_used[op.index]) {
          fail("invalid or reused GPU occlusion query index");
        }
        wgpuRenderPassEncoderBeginOcclusionQuery(static_cast<WGPURenderPassEncoder>(entry.value), op.index);
        state.occlusion_used[op.index] = true;
        state.occlusion_active = true;
      });
    }
    bool on(const ng::RenderEndOcclusionQueryOp &op) {
      return x.guard([&] {
        Entry &entry = x.pass(hv(op.pass), Kind::RenderPass);
        if (!entry.pass->occlusion_active) fail("GPU occlusion query is not active");
        wgpuRenderPassEncoderEndOcclusionQuery(static_cast<WGPURenderPassEncoder>(entry.value));
        entry.pass->occlusion_active = false;
      });
    }
    bool on(const ng::RenderDrawOp &op) {
      return x.guard([&] {
        wgpuRenderPassEncoderDraw(x.drawable(hv(op.pass), false), op.vertexCount, op.instanceCount, op.firstVertex,
                                  op.firstInstance);
      });
    }
    bool on(const ng::RenderDrawIndexedOp &op) {
      return x.guard([&] {
        wgpuRenderPassEncoderDrawIndexed(x.drawable(hv(op.pass), true), op.indexCount, op.instanceCount, op.firstIndex,
                                         op.baseVertex, op.firstInstance);
      });
    }
    bool on(const ng::RenderDrawIndirectOp &op) {
      return x.guard([&] {
        WGPURenderPassEncoder pass = x.drawable(hv(op.pass), false);
        WGPUBuffer buffer = x.ref<WGPUBuffer>(hv(op.buffer), Kind::Buffer);
        wgpuRenderPassEncoderDrawIndirect(pass, buffer, integer(op.offset, "indirect offset"));
      });
    }
    bool on(const ng::RenderDrawIndexedIndirectOp &op) {
      return x.guard([&] {
        WGPURenderPassEncoder pass = x.drawable(hv(op.pass), true);
        WGPUBuffer buffer = x.ref<WGPUBuffer>(hv(op.buffer), Kind::Buffer);
        wgpuRenderPassEncoderDrawIndexedIndirect(pass, buffer, integer(op.offset, "indirect offset"));
      });
    }
    bool on(const ng::EndRenderPassOp &op) {
      return x.guard([&] { x.end_pass(hv(op.pass), Kind::RenderPass); });
    }
    WGPUCommandEncoder encoder_value(Handle handle) { return static_cast<WGPUCommandEncoder>(x.encoder(hv(handle)).value); }
    bool on(const ng::CopyBufferToBufferOp &op) {
      return x.guard([&] {
        WGPUCommandEncoder encoder = encoder_value(op.encoder);
        WGPUBuffer source = x.ref<WGPUBuffer>(hv(op.source), Kind::Buffer);
        const uint64_t source_offset = integer(op.sourceOffset, "copy offset");
        WGPUBuffer destination = x.ref<WGPUBuffer>(hv(op.destination), Kind::Buffer);
        const uint64_t destination_offset = integer(op.destinationOffset, "copy offset");
        const uint64_t size = integer(op.size, "copy size");
        wgpuCommandEncoderCopyBufferToBuffer(encoder, source, source_offset, destination, destination_offset, size);
      });
    }
    bool on(const ng::CopyBufferToTextureOp &op) {
      return x.guard([&] {
        WGPUCommandEncoder encoder = encoder_value(op.encoder);
        WGPUTexelCopyBufferInfo source = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        source.buffer = x.ref<WGPUBuffer>(hv(op.source), Kind::Buffer);
        source.layout.offset = integer(op.sourceOffset, "copy offset");
        source.layout.bytesPerRow = op.bytesPerRow;
        source.layout.rowsPerImage = op.rowsPerImage;
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = x.ref<WGPUTexture>(hv(op.destination), Kind::Texture);
        destination.mipLevel = op.mipLevel;
        destination.origin = WGPUOrigin3D{op.originX, op.originY, op.originZ};
        destination.aspect = pick(kAspects, ng::enums::kAspect, op.aspect);
        const WGPUExtent3D size{op.width, op.height, op.depth};
        wgpuCommandEncoderCopyBufferToTexture(encoder, &source, &destination, &size);
      });
    }
    bool on(const ng::CopyTextureToBufferOp &op) {
      return x.guard([&] {
        if (op.bytesPerRow % 256) fail("GPU texture-to-buffer bytesPerRow must be a multiple of 256");
        WGPUCommandEncoder encoder = encoder_value(op.encoder);
        WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        source.texture = x.ref<WGPUTexture>(hv(op.source), Kind::Texture);
        source.mipLevel = op.mipLevel;
        source.origin = WGPUOrigin3D{op.originX, op.originY, op.originZ};
        source.aspect = pick(kAspects, ng::enums::kAspect, op.aspect);
        WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        destination.buffer = x.ref<WGPUBuffer>(hv(op.destination), Kind::Buffer);
        destination.layout.offset = integer(op.offset, "copy offset");
        destination.layout.bytesPerRow = op.bytesPerRow;
        destination.layout.rowsPerImage = op.rowsPerImage ? op.rowsPerImage : WGPU_COPY_STRIDE_UNDEFINED;
        const WGPUExtent3D size{op.width, op.height, op.depth};
        wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &size);
      });
    }
    bool on(const ng::CopyTextureToTextureOp &op) {
      return x.guard([&] {
        WGPUCommandEncoder encoder = encoder_value(op.encoder);
        WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        source.texture = x.ref<WGPUTexture>(hv(op.source), Kind::Texture);
        source.mipLevel = op.sourceMip;
        source.origin = WGPUOrigin3D{op.sourceX, op.sourceY, op.sourceZ};
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = x.ref<WGPUTexture>(hv(op.destination), Kind::Texture);
        destination.mipLevel = op.destinationMip;
        destination.origin = WGPUOrigin3D{op.destinationX, op.destinationY, op.destinationZ};
        const WGPUExtent3D size{op.width, op.height, op.depth};
        wgpuCommandEncoderCopyTextureToTexture(encoder, &source, &destination, &size);
      });
    }
    bool on(const ng::ClearBufferOp &op) {
      return x.guard([&] {
        const uint64_t start = integer(op.offset, "clear offset"), length = integer(op.size, "clear size");
        if (start % 4 || length % 4) fail("GPU clearBuffer offset and size must be multiples of 4");
        WGPUCommandEncoder encoder = encoder_value(op.encoder);
        WGPUBuffer buffer = x.ref<WGPUBuffer>(hv(op.buffer), Kind::Buffer);
        wgpuCommandEncoderClearBuffer(encoder, buffer, start, length ? length : WGPU_WHOLE_SIZE);
      });
    }
    bool on(const ng::ResolveQuerySetOp &op) {
      return x.guard([&] {
        WGPUCommandEncoder encoder = encoder_value(op.encoder);
        WGPUQuerySet set = x.ref<WGPUQuerySet>(hv(op.querySet), Kind::QuerySet);
        WGPUBuffer destination = x.ref<WGPUBuffer>(hv(op.destination), Kind::Buffer);
        wgpuCommandEncoderResolveQuerySet(encoder, set, op.first, op.count, destination, integer(op.offset, "query offset"));
      });
    }
    bool on(const ng::FinishCommandEncoderOp &op) {
      return x.guard([&] {
        Entry &owner = x.encoder(hv(op.encoder));
        const std::string label = op.label.text();
        void *encoder = owner.value;
        const uint64_t owner_serial = owner.serial;
        const uint32_t owner_slot = ng::handle_slot(op.encoder);
        std::shared_ptr<Uses> uses = owner.uses;
        std::string error;
        Entry &entry = x.create(hv(op.handle), Kind::CommandBuffer, [&] {
          WGPUCommandBufferDescriptor descriptor = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
          descriptor.label = view(label);
          WGPUCommandBuffer buffer = nullptr;
          // Recording errors surface here; an invalid command buffer must never reach wgpuQueueSubmit.
          error = x.scoped([&] { buffer = wgpuCommandEncoderFinish(static_cast<WGPUCommandEncoder>(encoder), &descriptor); });
          return static_cast<void *>(buffer);
        });
        entry.submitted = false;
        entry.uses = uses;
        entry.invalid = error;
        if (Entry *again = x.handles.by_serial(owner_slot, owner_serial)) again->phase = FINISHED;
        // WebGPU reports the encoder's validation error as an uncaptured error at finish().
        if (!error.empty()) x.uncaught(error);
      });
    }
    bool on(const ng::QueueSubmitOp &op) {
      return x.guard([&] {
        x.active();
        std::vector<Entry *> entries;
        for (uint32_t i = 0; i < op.commandBuffers.size(); ++i) {
          entries.push_back(&x.handles.lookup(hv(op.commandBuffers[i]), Kind::CommandBuffer));
        }
        for (size_t i = 0; i < entries.size(); ++i) {
          for (size_t k = i + 1; k < entries.size(); ++k) {
            if (entries[i] == entries[k]) fail("GPU command buffer listed twice in one submission");
          }
        }
        for (Entry *entry : entries) {
          if (entry->submitted) fail("GPU command buffer was already submitted");
        }
        std::vector<WGPUCommandBuffer> buffers;
        for (Entry *entry : entries) buffers.push_back(static_cast<WGPUCommandBuffer>(entry->value));
        const std::string refused = x.submit_refusal(entries);
        if (refused.empty()) {
          wgpuQueueSubmit(ntgpu_queue(x.ctx), buffers.size(), buffers.data());
        } else if (refused != "lost") {
          x.uncaught(refused);  // WebGPU: a validation error, and nothing of the submission executes
        }
        for (Entry *entry : entries) entry->submitted = true;
        if (x.acquired) x.submitted_after_acquire = true;
      });
    }
    bool on(const ng::WriteBufferOp &op) {
      return x.guard([&] {
        WGPUBuffer target = x.unmapped_buffer(hv(op.buffer));
        Entry &entry = *x.handles.peek(hv(op.buffer));
        const uint64_t offset = integer(op.bufferOffset, "write offset");
        if (offset % 4 || op.data.length % 4) fail("GPU writeBuffer offset and size must be multiples of 4");
        if (offset + op.data.length > entry.size) fail("GPU writeBuffer outside buffer");
        const UploadView source = x.upload_range(op.data);
        wgpuQueueWriteBuffer(ntgpu_queue(x.ctx), target, offset, source.data, source.length);
      });
    }
    bool on(const ng::WriteTextureOp &op) {
      return x.guard([&] {
        WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = x.ref<WGPUTexture>(hv(op.texture), Kind::Texture);
        const UploadView source = x.upload_range(op.data);
        x.active();
        destination.mipLevel = op.mipLevel;
        destination.origin = WGPUOrigin3D{op.originX, op.originY, op.originZ};
        destination.aspect = pick(kAspects, ng::enums::kAspect, op.aspect);
        WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
        layout.offset = 0;
        layout.bytesPerRow = op.bytesPerRow;
        layout.rowsPerImage = op.rowsPerImage;
        const WGPUExtent3D size{op.width, op.height, op.depth};
        wgpuQueueWriteTexture(ntgpu_queue(x.ctx), &destination, source.data, source.length, &layout, &size);
      });
    }
    bool on(const ng::UnmapOp &op) {
      return x.guard([&] {
        Entry &entry = x.handles.lookup(hv(op.buffer), Kind::Buffer);
        if (entry.map == MAPPING) {
          x.cancel(entry.request, "GPU map cancelled by unmap");
          return;
        }
        // WebGPU unmap of an unmapped buffer is a no-op; wgpu-native would raise a validation error.
        if (entry.map == MAPPED) {
          std::lock_guard<std::mutex> serial(x.poll_mutex);
          wgpuBufferUnmap(static_cast<WGPUBuffer>(entry.value));
        }
        entry.set_map(UNMAPPED);
      });
    }
    bool on(const ng::WriteMappedBufferOp &op) {
      return x.guard([&] {
        Entry &entry = x.handles.lookup(hv(op.buffer), Kind::Buffer);
        if (entry.map != MAPPED) fail("GPU buffer is not mapped");
        const uint64_t offset = integer(op.bufferOffset, "mapped offset");
        if (offset % 8 || op.data.length % 4) fail("GPU mapped writes need an 8-byte offset and a size multiple of 4");
        const UploadView source = x.upload_range(op.data);
        if (offset + source.length > entry.size) fail("GPU mapped range out of bounds");
        void *mapped = nullptr;
        std::lock_guard<std::mutex> serial(x.poll_mutex);
        x.scoped([&] {
          mapped = wgpuBufferGetMappedRange(static_cast<WGPUBuffer>(entry.value), static_cast<size_t>(offset), source.length);
        });
        if (!mapped && source.length) fail("GPU mapped range unavailable");
        if (source.length) std::memcpy(mapped, source.data, source.length);
      });
    }
    bool on(const ng::ConfigureCanvasOp &op) {
      return x.guard([&] {
        x.active();
        const std::string format = op.format.text();
        static const char *const kAlpha[] = {"opaque", "premultiplied"};
        static const char *const kColorSpace[] = {"srgb", "display-p3"};
        const char *alpha = choice(kAlpha, op.alphaMode);
        choice(kColorSpace, op.colorSpace);
        const WGPUTextureFormat chosen = format.empty() ? WGPUTextureFormat_BGRA8Unorm : texture_format(format);
        x.canvas_format = chosen;
        x.canvas_usage = static_cast<WGPUTextureUsage>(op.usage);
        x.canvas_alpha = std::strcmp(alpha, "opaque") == 0 ? WGPUCompositeAlphaMode_Opaque : WGPUCompositeAlphaMode_Premultiplied;
        if (x.acquired) {
          wgpuTextureRelease(x.acquired);
          x.acquired = nullptr;
        }
        if (x.canvas_texture) {
          wgpuTextureRelease(x.canvas_texture);
          x.canvas_texture = nullptr;
        }
        if (x.options.metal_layer) {
          if (!x.surface && ntgpu_surface_from_metal_layer(x.ctx, x.options.metal_layer, &x.surface) != NTGPU_OK) {
            fail("GPU canvas surface unavailable");
          }
          std::string error;
          try {
            error = x.scoped([&] { x.configure_surface(); });
          } catch (...) {
            x.surface_configured = false;
            throw;
          }
          if (!error.empty()) fail("GPU canvas configuration failed: " + error);
        }
        x.configured = true;
      });
    }
    bool on(const ng::GetCurrentTextureOp &op) {
      return x.guard([&] {
        if (!x.configured) fail("GPU canvas not configured");
        Entry &entry = x.create(hv(op.handle), Kind::Texture, [&]() -> void * {
          WGPUTexture texture = nullptr;
          if (x.surface) {
            if (!x.acquired) {
              if (x.surface_width != x.width || x.surface_height != x.height) x.configure_surface();
              WGPUSurfaceTexture current = WGPU_SURFACE_TEXTURE_INIT;
              wgpuSurfaceGetCurrentTexture(x.surface, &current);
              if (current.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
                  current.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
                if (current.texture) wgpuTextureRelease(current.texture);
                if (current.status == WGPUSurfaceGetCurrentTextureStatus_Outdated) x.surface_width = 0;
                fail("GPU canvas texture unavailable (surface status " + std::to_string(current.status) + ")");
              }
              x.acquired = current.texture;
              x.submitted_after_acquire = false;
              x.canvas_track = std::make_shared<Tracked>();
              x.canvas_track->kind = "texture";
            }
            texture = x.acquired;
          } else {
            texture = x.headless_texture();
          }
          wgpuTextureAddRef(texture);
          return texture;
        });
        entry.canvas = true;
        entry.track = x.canvas_track;
      });
    }
    bool on(const ng::DestroyOp &op) {
      return x.guard([&] {
        x.retire_owned(hv(op.resource));
        x.handles.retire(hv(op.resource), true);
      });
    }
    bool on(const ng::ReleaseOp &op) {
      return x.guard([&] {
        x.retire_owned(hv(op.resource));
        x.handles.retire(hv(op.resource), false);
      });
    }
    bool on(const ng::MapAsyncOp &op) {
      return x.guard([&] {
        if (op.mode != ng::constants::MAP_MODE_READ) fail("GPU readback supports MAP_READ only");
        Entry &entry = x.handles.lookup(hv(op.buffer), Kind::Buffer);
        const uint64_t start = integer(op.offset, "map offset"), length = integer(op.size, "map size");
        if (start % 8 || length % 4 || length == 0) {
          fail("GPU map offset must be a multiple of 8 and its size a nonzero multiple of 4");
        }
        if (start + length > entry.size) fail("GPU map range outside buffer");
        if (entry.map != UNMAPPED) fail("GPU buffer is mapped or has a pending map");
        const uint64_t target = op.destination.offset;
        if (target + op.destination.length > x.readback_capacity || length > op.destination.length) {
          fail("GPU readback outside staging arena");
        }
        for (const auto &pair : x.pending) {
          const Request &other = pair.second;
          if (other.readback && other.readback_begin < target + length && target < other.readback_end) {
            fail("GPU readback range is in use by a pending request");
          }
        }
        Request &record = x.request(op.requestId, E_MAP_READY, ng::handle_value(op.buffer));
        record.readback = true;
        record.readback_begin = target;
        record.readback_end = target + length;
        record.cleanup = Cleanup::Map;
        record.slot = ng::handle_slot(op.buffer);
        record.entry_serial = entry.serial;
        record.buffer = static_cast<WGPUBuffer>(entry.value);
        record.map_start = start;
        record.map_length = length;
        record.destination = op.destination.offset;
        record.native = true;
        entry.set_map(MAPPING);
        entry.request = op.requestId;
        const uint32_t id = op.requestId;
        const uint64_t serial = record.serial;
        x.await_native(1);
        wgpuBufferAddRef(record.buffer);
        NativeOp native;
        native.id = id;
        native.serial = serial;
        native.buffer = record.buffer;
        const uint64_t token = x.start_native(native);
        NtGpuStatus status;
        {
          std::lock_guard<std::mutex> serial(x.poll_mutex);
          status = ntgpu_map_async(x.ctx, record.buffer, WGPUMapMode_Read, static_cast<size_t>(start),
                                   static_cast<size_t>(length), token);
        }
        if (status != NTGPU_OK) x.native_refused(token, status);
      });
    }
    bool on(const ng::OnSubmittedWorkDoneOp &op) {
      return x.guard([&] {
        x.active();
        Request &record = x.request(op.requestId, E_WORK_DONE, 0);
        record.native = true;
        NativeOp native;
        native.id = op.requestId;
        native.serial = record.serial;
        x.await_native(1);
        const uint64_t token = x.start_native(native);
        const NtGpuStatus status = ntgpu_work_done(x.ctx, token);
        if (status != NTGPU_OK) x.native_refused(token, status);
      });
    }
    bool on(const ng::RequestFrameOp &) {
      return x.guard([&] {
        if (!x.stopped && x.device) x.frame_wanted = true;
      });
    }

    void on_skipped_request(const ng::SkippedRequest &skipped) {
      if (!skipped.request_id) return;
      const uint32_t handle = ng::handle_value(skipped.handle);
      if (x.pending.count(skipped.request_id)) {
        x.emit(E_ERROR, 0, handle, S_ERROR,
               Json().str("message", "GPU request id is already pending").num("duplicateRequestId", skipped.request_id));
        return;
      }
      Json data;
      data.str("message", "GPU batch aborted before this request");
      if (skipped.completion == ng::Event::Capabilities) data.boolean("available", false);
      x.emit(static_cast<uint32_t>(skipped.completion), skipped.request_id, handle, S_CANCELLED, data);
    }
    void on_error(const ng::ErrorReport &report) {
      Json data;
      data.str("message", report.fatal ? std::string(report.message ? report.message : "GPU protocol error") : x.last_error);
      if (report.fatal) data.boolean("fatal", true);
      uint32_t request_id = report.request_id;
      if (request_id && x.pending.count(request_id)) {
        data.num("duplicateRequestId", request_id);
        request_id = 0;
      }
      x.emit(E_ERROR, request_id, ng::handle_value(report.handle), S_ERROR, data);
    }
  };

  // A native call that the facade refused synchronously: a lost device settles as LOST, anything else as ERROR.
  void native_refused(uint64_t token, NtGpuStatus status) {
    auto it = natives.find(token);
    if (it == natives.end()) return;
    NativeOp op = it->second;
    natives.erase(it);
    if (op.buffer) {
      std::lock_guard<std::mutex> serial(poll_mutex);
      wgpuBufferRelease(op.buffer);
    }
    if (status == NTGPU_ERR_DEVICE_LOST) drain();
    if (current(op.id, op.serial)) {
      settle(op.id, op.serial, E_ERROR, S_ERROR,
             Json().str("message", std::string("GPU operation refused: ") + ntgpu_status_name(status)));
    }
  }
};

namespace {
void dispose(NtGpuExecutor *x) {
  {
    std::lock_guard<std::mutex> lock(x->wait_mutex);
    x->wait_stop = true;
  }
  x->wait_cv.notify_all();
  if (x->waiter.joinable()) x->waiter.join();
  x->stopped = true;
  x->pending.clear();
  x->deferred.clear();
  x->handles.clear();
  x->release_surface_state();
  if (x->ctx) ntgpu_context_destroy(x->ctx);
  x->ctx = nullptr;
  for (auto &pair : x->natives) {
    if (pair.second.buffer) wgpuBufferRelease(pair.second.buffer);
  }
  x->natives.clear();
}
}  // namespace

extern "C" {

int ntgpu_executor_create(const NtGpuExecutorOptions *options, NtGpuExecutor **out) {
  if (!out) return 0;
  *out = nullptr;
  auto *x = new (std::nothrow) NtGpuExecutor();
  if (!x) return 0;
  if (options) x->options = *options;
  x->width = x->options.width ? x->options.width : 64;
  x->height = x->options.height ? x->options.height : 64;
  x->dpr = x->options.pixel_ratio > 0 ? x->options.pixel_ratio : 1;
  NtGpuContextOptions context = {};
  context.api_version = NTGPU_API_VERSION;
  context.event_capacity = 1024;
  context.message_limit = 16384;
  context.wake = &NtGpuExecutor::wake_trampoline;
  context.wake_user = x;
  if (ntgpu_context_create(&context, &x->ctx) != NTGPU_OK) {
    delete x;
    return 0;
  }
  *out = x;
  return 1;
}

void ntgpu_executor_destroy(NtGpuExecutor *executor) {
  if (!executor) return;
  dispose(executor);
  delete executor;
}

int ntgpu_executor_submit(NtGpuExecutor *executor, const uint8_t *commands, size_t command_size,
                          const uint8_t *uploads, size_t upload_size, size_t readback_capacity) {
  if (!executor || executor->stopped) return 0;
  NtGpuExecutor &x = *executor;
  NtGpuExecutor::CallScope scope(&x);
  if (upload_size > ng::kMaxUploadBytes || (upload_size && !uploads) || readback_capacity > ng::kMaxReadbackBytes) {
    x.emit(E_ERROR, 0, 0, S_ERROR,
           Json()
               .str("message", upload_size > ng::kMaxUploadBytes || (upload_size && !uploads)
                                   ? "GPU upload arena exceeds the protocol limit"
                                   : "GPU readback arena exceeds the protocol limit")
               .boolean("fatal", true));
    return 0;
  }
  x.uploads = uploads;
  x.upload_size = upload_size;
  x.readback_capacity = readback_capacity;
  x.frame_wanted = false;
  NtGpuExecutor::Visitor visitor{x};
  const ng::BatchResult result = ng::decode_batch(commands, command_size, visitor);
  // Borrowed submission memory is not retained past this call.
  x.uploads = nullptr;
  x.upload_size = 0;
  x.run_deferred();
  // Native completions (maps, work done, uncaptured errors, loss) are not drained here: like the JS host's promise
  // callbacks they arrive later, through process() after wake (CallScope wakes if the queue is non-empty).
  x.present();
  if (x.frame_wanted && x.device && !x.stopped && x.options.frame_requested) x.options.frame_requested(x.options.user);
  x.frame_wanted = false;
  return result.ok() ? 1 : 0;
}

void ntgpu_executor_process(NtGpuExecutor *executor) {
  if (!executor || executor->stopped) return;
  NtGpuExecutor &x = *executor;
  NtGpuExecutor::CallScope scope(&x);
  if (x.awaiting || ntgpu_pending(x.ctx)) {
    std::unique_lock<std::mutex> poll(x.poll_mutex, std::try_to_lock);
    if (poll.owns_lock() && ntgpu_device(x.ctx)) {
      x.polls.fetch_add(1);
      ntgpu_process(x.ctx, 0);
    }
  }
  x.drain();
}

size_t ntgpu_executor_pending(const NtGpuExecutor *executor) {
  if (!executor || executor->stopped) return 0;
  return executor->pending.size() + (executor->ctx ? ntgpu_queued_events(executor->ctx) : 0);
}

void ntgpu_executor_resize(NtGpuExecutor *executor, uint32_t width, uint32_t height, double pixel_ratio) {
  if (!executor || executor->stopped) return;
  NtGpuExecutor &x = *executor;
  NtGpuExecutor::CallScope scope(&x);
  x.width = std::max<uint32_t>(1, width);
  x.height = std::max<uint32_t>(1, height);
  x.dpr = pixel_ratio > 0 ? pixel_ratio : 1;
  x.pixels();
}

int ntgpu_executor_capture_rgba(NtGpuExecutor *executor, uint8_t *rgba, size_t capacity, uint32_t *width,
                                uint32_t *height) {
  if (!executor || executor->stopped) return 0;
  NtGpuExecutor &x = *executor;
  NtGpuExecutor::CallScope scope(&x);
  auto unavailable = [&](const std::string &why) {
    x.emit(E_ERROR, 0, 0, S_ERROR, Json().str("message", "GPU capture unavailable: " + why).boolean("capture", true));
    return 0;
  };
  if (!x.device) return unavailable("no device");
  if (x.surface) return unavailable("the canvas presents to a CAMetalLayer");
  if (!x.configured || !x.canvas_texture) return unavailable("no canvas texture was rendered");
  const uint32_t w = x.canvas_width, h = x.canvas_height;
  if (width) *width = w;
  if (height) *height = h;
  const bool bgra = x.canvas_format == WGPUTextureFormat_BGRA8Unorm || x.canvas_format == WGPUTextureFormat_BGRA8UnormSrgb;
  const bool rgba8 = x.canvas_format == WGPUTextureFormat_RGBA8Unorm || x.canvas_format == WGPUTextureFormat_RGBA8UnormSrgb;
  if (!bgra && !rgba8) return unavailable(std::string("canvas format ") + texture_format_name(x.canvas_format));
  if (!rgba || capacity < static_cast<size_t>(w) * h * 4) return unavailable("output buffer too small");
  const uint32_t row = (w * 4 + 255) / 256 * 256;
  WGPUDevice device = ntgpu_device(x.ctx);
  WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
  const std::string label = "nativetron capture";
  descriptor.label = view(label);
  descriptor.size = static_cast<uint64_t>(row) * h;
  descriptor.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
  WGPUBuffer buffer = wgpuDeviceCreateBuffer(device, &descriptor);
  WGPUCommandEncoderDescriptor encoder_descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
  WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encoder_descriptor);
  WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
  source.texture = x.canvas_texture;
  WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
  destination.buffer = buffer;
  destination.layout.bytesPerRow = row;
  destination.layout.rowsPerImage = h;
  const WGPUExtent3D size{w, h, 1};
  wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &size);
  WGPUCommandBufferDescriptor finish = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
  WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &finish);
  wgpuQueueSubmit(ntgpu_queue(x.ctx), 1, &commands);
  wgpuCommandBufferRelease(commands);
  wgpuCommandEncoderRelease(encoder);
  x.capture_done = x.capture_ok = false;
  x.capture_out = rgba;
  x.capture_w = w;
  x.capture_h = h;
  x.capture_row = row;
  x.capture_bgra = bgra;
  NativeOp op;
  op.capture = true;
  op.buffer = buffer;  // the native op owns the buffer reference
  const uint64_t token = x.start_native(op);
  NtGpuStatus mapped;
  {
    std::lock_guard<std::mutex> serial(x.poll_mutex);
    mapped = ntgpu_map_async(x.ctx, buffer, WGPUMapMode_Read, 0, static_cast<size_t>(row) * h, token);
  }
  if (mapped != NTGPU_OK) {
    x.natives.erase(token);
    wgpuBufferRelease(buffer);
    return unavailable("map refused");
  }
  // Synchronous by contract: wait for this map only (called outside any guest export).
  for (int round = 0; round < 10000 && !x.capture_done && x.device; ++round) {
    {
      std::lock_guard<std::mutex> poll(x.poll_mutex);
      if (ntgpu_device(x.ctx)) {
        x.polls.fetch_add(1);
        ntgpu_process(x.ctx, 1);
      }
    }
    x.drain();
  }
  x.capture_out = nullptr;
  if (!x.capture_done) {
    auto it = x.natives.find(token);
    if (it != x.natives.end()) it->second.capture = true;  // released when the callback arrives
    return unavailable("readback did not complete");
  }
  if (!x.capture_ok) return unavailable("readback failed");
  return 1;
}

// Test hooks (executor-test.h): an external device loss as `host.device.destroy()` in the browser lanes, and counters.
int ntgpu_executor_test_lose_device(NtGpuExecutor *executor) {
  if (!executor || !executor->device || executor->stopped) return 0;
  NtGpuExecutor::CallScope scope(executor);
  {
    std::lock_guard<std::mutex> poll(executor->poll_mutex);
    if (ntgpu_device_destroy(executor->ctx) != NTGPU_OK) return 0;
  }
  // Like GPUDevice.destroy() under the JS host: pending work settles LOST before completions already queued.
  executor->lose_device("destroyed", "GPU device destroyed outside the protocol");
  executor->release_native_device();
  executor->drain();
  return 1;
}
uint64_t ntgpu_executor_test_polls(const NtGpuExecutor *executor) { return executor ? executor->polls.load() : 0; }
size_t ntgpu_executor_test_live_handles(const NtGpuExecutor *executor) {
  return executor ? executor->handles.live_count() : 0;
}

}  // extern "C"

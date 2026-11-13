// generated from gpu/ops.json by gpu/generate.mjs — do not edit
//
// Portable C++17 decoder for the nativetron GPU command stream, protocol 3, identity 0xbc024fc5.
// It has no WebGPU, platform or allocation dependency on the decode path; it is the native twin of the
// generated JS decodeGpuBatch in gpu-host.generated.js and follows the same wire and batch contract.
//
// Wire format: a batch starts with the 9-byte header (u8 opcode 51, u32 version, u32 identity),
// followed by operations: u8 opcode, then the operands of gpu/ops.json in order. Scalars are little-endian and
// unaligned (u32, i32, f32, f64 and handles are 4 or 8 bytes; bool is one byte that must be 0 or 1). str is a
// u32 byte length followed by that many bytes. handle[], u32[] and f64[] are a u32 element count (at most
// kMaxArrayLength) followed by the elements. upload and readback ranges are u32 offset, u32 length into the
// embedding's staging arenas. Operations that create a resource carry the guest-allocated result handle first.
//
// Usage:
//   struct Executor {
//     bool on(const nativetron::gpu::CreateBufferOp& op);      // one overload per operation (or a template)
//     ...
//     void on_skipped_request(const nativetron::gpu::SkippedRequest& skipped);
//     void on_error(const nativetron::gpu::ErrorReport& report);
//   };
//   nativetron::gpu::BatchResult result = nativetron::gpu::decode_batch(bytes, size, executor);
// Every operation struct must have an overload, so a schema change is a compile error in the executor. The
// abstract nativetron::gpu::Visitor declares the same members virtually; VisitorAdapter<T> erases a template
// visitor behind it. on() returns true when the executor accepted the operation and false when it rejected it.
// The decoder is exception-neutral and never catches: report a rejection by returning false.
//
// Batch contract (identical to the JS host):
// - Preflight: a batch larger than kMaxBatchBytes, shorter than the header, with another first opcode, or with a
//   different version or identity is refused before any operation (fatal ErrorReport, outcome Fatal).
// - Decoding and execution are interleaved and ordered, not transactional. An operation is delivered only
//   after all of its operands decoded; operations before a failure are never rolled back.
// - A malformed operation (truncation, unknown opcode, bool other than 0/1, array count above kMaxArrayLength)
//   stops the batch: on_error(fatal = true) with request id 0 and handle 0, outcome Fatal. Later bytes are not
//   inspected, so requests after that point are never seen and never cancelled; the reactor is out of protocol.
// - The first on() returning false is a host rejection: on_error(fatal = false) with that operation's request
//   id and request handle (both 0 unless the operation is a request; the handle is its first handle operand,
//   including the result handle), outcome Rejected. Decoding continues without executing: control operations
//   (destroy, requestFrame, release, cancelRequest) are still delivered to on() and their result is ignored,
//   request operations are reported once each through on_skipped_request (complete them with their completion
//   event and status CANCELLED), every other operation is dropped. A later malformed operation is still fatal,
//   giving a second, fatal on_error.
//
// Guarantees: every operand delivered to on() is in bounds of the batch and of the declared type; bools are 0/1;
// arrays hold at most kMaxArrayLength elements; Str, arrays and ranges are views into the caller's batch bytes
// and are valid only until the batch memory is reused. Loads are byte-wise, so any alignment and host byte
// order are safe. The executor remains responsible for every semantic check the JS host performs: handle
// liveness, generation and kind (see handle_slot/handle_generation), result-handle reservation, request id
// validity (nonzero, not pending, at most kMaxPendingRequests; on_skipped_request and rejections can carry 0 or a
// pending id, which the JS host reports as duplicateRequestId instead of completing), enum indices (nullptr
// entries are invalid), record widths and counts, finite/integral f64 operands, upload/readback range bounds
// against the arenas (compute in 64 bits) and the readback lease, feature and limit negotiation, and WebGPU
// recording state. Str bytes are not validated as UTF-8: Str::text() decodes them exactly as the JS
// TextDecoder does (WHATWG UTF-8, replacement characters, leading BOM removed).
#ifndef NATIVETRON_GPU_NATIVE_DECODER_GENERATED_H
#define NATIVETRON_GPU_NATIVE_DECODER_GENERATED_H

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>

namespace nativetron::gpu {

static_assert(std::numeric_limits<float>::is_iec559 && sizeof(float) == 4, "IEEE-754 binary32 float required");
static_assert(std::numeric_limits<double>::is_iec559 && sizeof(double) == 8, "IEEE-754 binary64 double required");

inline constexpr uint32_t kProtocolVersion = 3u;
inline constexpr uint32_t kProtocolIdentity = 0xbc024fc5u;
inline constexpr uint8_t kProtocolOpcode = 51u;
inline constexpr uint32_t kProtocolHeaderBytes = 9u;
inline constexpr uint32_t kMaxBatchBytes = 16777216u;
inline constexpr uint32_t kMaxUploadBytes = 536870912u;
inline constexpr uint32_t kMaxReadbackBytes = 16777216u;
inline constexpr uint32_t kMaxArrayLength = 65536u;
inline constexpr uint32_t kMaxPendingRequests = 1024u;
inline constexpr uint32_t kHandleSlotBits = 20u;
inline constexpr uint32_t kHandleGenerationBits = 12u;
inline constexpr uint32_t kHandleSlotMask = 1048575u;
inline constexpr uint32_t kHandleGenerationMask = 4095u;
inline constexpr uint32_t kOperationCount = 64u;

namespace constants {
inline constexpr uint32_t BUFFER_USAGE_MAP_READ = 1u;
inline constexpr uint32_t BUFFER_USAGE_MAP_WRITE = 2u;
inline constexpr uint32_t BUFFER_USAGE_COPY_SRC = 4u;
inline constexpr uint32_t BUFFER_USAGE_COPY_DST = 8u;
inline constexpr uint32_t BUFFER_USAGE_INDEX = 16u;
inline constexpr uint32_t BUFFER_USAGE_VERTEX = 32u;
inline constexpr uint32_t BUFFER_USAGE_UNIFORM = 64u;
inline constexpr uint32_t BUFFER_USAGE_STORAGE = 128u;
inline constexpr uint32_t BUFFER_USAGE_INDIRECT = 256u;
inline constexpr uint32_t BUFFER_USAGE_QUERY_RESOLVE = 512u;
inline constexpr uint32_t TEXTURE_USAGE_COPY_SRC = 1u;
inline constexpr uint32_t TEXTURE_USAGE_COPY_DST = 2u;
inline constexpr uint32_t TEXTURE_USAGE_TEXTURE_BINDING = 4u;
inline constexpr uint32_t TEXTURE_USAGE_STORAGE_BINDING = 8u;
inline constexpr uint32_t TEXTURE_USAGE_RENDER_ATTACHMENT = 16u;
inline constexpr uint32_t SHADER_STAGE_VERTEX = 1u;
inline constexpr uint32_t SHADER_STAGE_FRAGMENT = 2u;
inline constexpr uint32_t SHADER_STAGE_COMPUTE = 4u;
inline constexpr uint32_t MAP_MODE_READ = 1u;
inline constexpr uint32_t MAP_MODE_WRITE = 2u;
inline constexpr uint32_t BINDING_BUFFER = 1u;
inline constexpr uint32_t BINDING_SAMPLER = 2u;
inline constexpr uint32_t BINDING_TEXTURE = 3u;
inline constexpr uint32_t BINDING_STORAGE_TEXTURE = 4u;
inline constexpr uint32_t COLOR_WRITE_RED = 1u;
inline constexpr uint32_t COLOR_WRITE_GREEN = 2u;
inline constexpr uint32_t COLOR_WRITE_BLUE = 4u;
inline constexpr uint32_t COLOR_WRITE_ALPHA = 8u;
inline constexpr uint32_t COLOR_WRITE_ALL = 15u;
inline constexpr uint32_t FORMAT_RGBA8UNORM = 1u;
inline constexpr uint32_t FORMAT_BGRA8UNORM = 2u;
inline constexpr uint32_t FORMAT_RGBA16FLOAT = 3u;
inline constexpr uint32_t FORMAT_R32FLOAT = 4u;
inline constexpr uint32_t FORMAT_R32UINT = 5u;
inline constexpr uint32_t FORMAT_RG32FLOAT = 6u;
inline constexpr uint32_t FORMAT_RGBA32FLOAT = 7u;
inline constexpr uint32_t FORMAT_DEPTH24PLUS = 8u;
inline constexpr uint32_t FORMAT_DEPTH32FLOAT = 9u;
inline constexpr uint32_t FORMAT_R8UNORM = 10u;
inline constexpr uint32_t FORMAT_R8SNORM = 11u;
inline constexpr uint32_t FORMAT_R8UINT = 12u;
inline constexpr uint32_t FORMAT_R8SINT = 13u;
inline constexpr uint32_t FORMAT_R16UINT = 14u;
inline constexpr uint32_t FORMAT_R16SINT = 15u;
inline constexpr uint32_t FORMAT_R16FLOAT = 16u;
inline constexpr uint32_t FORMAT_RG8UNORM = 17u;
inline constexpr uint32_t FORMAT_RG8SNORM = 18u;
inline constexpr uint32_t FORMAT_RG8UINT = 19u;
inline constexpr uint32_t FORMAT_RG8SINT = 20u;
inline constexpr uint32_t FORMAT_R32SINT = 21u;
inline constexpr uint32_t FORMAT_RG16UINT = 22u;
inline constexpr uint32_t FORMAT_RG16SINT = 23u;
inline constexpr uint32_t FORMAT_RG16FLOAT = 24u;
inline constexpr uint32_t FORMAT_RGBA8UNORM_SRGB = 25u;
inline constexpr uint32_t FORMAT_RGBA8SNORM = 26u;
inline constexpr uint32_t FORMAT_RGBA8UINT = 27u;
inline constexpr uint32_t FORMAT_RGBA8SINT = 28u;
inline constexpr uint32_t FORMAT_BGRA8UNORM_SRGB = 29u;
inline constexpr uint32_t FORMAT_RGB10A2UINT = 30u;
inline constexpr uint32_t FORMAT_RGB10A2UNORM = 31u;
inline constexpr uint32_t FORMAT_RG11B10UFLOAT = 32u;
inline constexpr uint32_t FORMAT_RGB9E5UFLOAT = 33u;
inline constexpr uint32_t FORMAT_RG32UINT = 34u;
inline constexpr uint32_t FORMAT_RG32SINT = 35u;
inline constexpr uint32_t FORMAT_RGBA16UINT = 36u;
inline constexpr uint32_t FORMAT_RGBA16SINT = 37u;
inline constexpr uint32_t FORMAT_RGBA32UINT = 38u;
inline constexpr uint32_t FORMAT_RGBA32SINT = 39u;
inline constexpr uint32_t FORMAT_STENCIL8 = 40u;
inline constexpr uint32_t FORMAT_DEPTH16UNORM = 41u;
inline constexpr uint32_t FORMAT_DEPTH24PLUS_STENCIL8 = 42u;
inline constexpr uint32_t FORMAT_DEPTH32FLOAT_STENCIL8 = 43u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT32 = 1u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT32X2 = 2u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT32X3 = 3u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT32X4 = 4u;
inline constexpr uint32_t VERTEX_FORMAT_UINT32 = 5u;
inline constexpr uint32_t VERTEX_FORMAT_UINT32X2 = 6u;
inline constexpr uint32_t VERTEX_FORMAT_UINT32X3 = 7u;
inline constexpr uint32_t VERTEX_FORMAT_UINT32X4 = 8u;
inline constexpr uint32_t VERTEX_FORMAT_SINT32 = 9u;
inline constexpr uint32_t VERTEX_FORMAT_SINT32X2 = 10u;
inline constexpr uint32_t VERTEX_FORMAT_SINT32X3 = 11u;
inline constexpr uint32_t VERTEX_FORMAT_SINT32X4 = 12u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM8X4 = 13u;
inline constexpr uint32_t VERTEX_FORMAT_UINT8 = 14u;
inline constexpr uint32_t VERTEX_FORMAT_UINT8X2 = 15u;
inline constexpr uint32_t VERTEX_FORMAT_UINT8X4 = 16u;
inline constexpr uint32_t VERTEX_FORMAT_SINT8 = 17u;
inline constexpr uint32_t VERTEX_FORMAT_SINT8X2 = 18u;
inline constexpr uint32_t VERTEX_FORMAT_SINT8X4 = 19u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM8 = 20u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM8X2 = 21u;
inline constexpr uint32_t VERTEX_FORMAT_SNORM8 = 22u;
inline constexpr uint32_t VERTEX_FORMAT_SNORM8X2 = 23u;
inline constexpr uint32_t VERTEX_FORMAT_SNORM8X4 = 24u;
inline constexpr uint32_t VERTEX_FORMAT_UINT16 = 25u;
inline constexpr uint32_t VERTEX_FORMAT_UINT16X2 = 26u;
inline constexpr uint32_t VERTEX_FORMAT_UINT16X4 = 27u;
inline constexpr uint32_t VERTEX_FORMAT_SINT16 = 28u;
inline constexpr uint32_t VERTEX_FORMAT_SINT16X2 = 29u;
inline constexpr uint32_t VERTEX_FORMAT_SINT16X4 = 30u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM16 = 31u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM16X2 = 32u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM16X4 = 33u;
inline constexpr uint32_t VERTEX_FORMAT_SNORM16 = 34u;
inline constexpr uint32_t VERTEX_FORMAT_SNORM16X2 = 35u;
inline constexpr uint32_t VERTEX_FORMAT_SNORM16X4 = 36u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT16 = 37u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT16X2 = 38u;
inline constexpr uint32_t VERTEX_FORMAT_FLOAT16X4 = 39u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM10_10_10_2 = 40u;
inline constexpr uint32_t VERTEX_FORMAT_UNORM8X4_BGRA = 41u;
inline constexpr uint32_t DIMENSION_1D = 1u;
inline constexpr uint32_t DIMENSION_2D = 2u;
inline constexpr uint32_t DIMENSION_3D = 3u;
inline constexpr uint32_t VIEW_1D = 1u;
inline constexpr uint32_t VIEW_2D = 2u;
inline constexpr uint32_t VIEW_2D_ARRAY = 3u;
inline constexpr uint32_t VIEW_CUBE = 4u;
inline constexpr uint32_t VIEW_CUBE_ARRAY = 5u;
inline constexpr uint32_t VIEW_3D = 6u;
inline constexpr uint32_t ADDRESS_CLAMP_TO_EDGE = 0u;
inline constexpr uint32_t ADDRESS_REPEAT = 1u;
inline constexpr uint32_t ADDRESS_MIRROR_REPEAT = 2u;
inline constexpr uint32_t FILTER_NEAREST = 0u;
inline constexpr uint32_t FILTER_LINEAR = 1u;
inline constexpr uint32_t COMPARE_NEVER = 1u;
inline constexpr uint32_t COMPARE_LESS = 2u;
inline constexpr uint32_t COMPARE_EQUAL = 3u;
inline constexpr uint32_t COMPARE_LESS_EQUAL = 4u;
inline constexpr uint32_t COMPARE_GREATER = 5u;
inline constexpr uint32_t COMPARE_NOT_EQUAL = 6u;
inline constexpr uint32_t COMPARE_GREATER_EQUAL = 7u;
inline constexpr uint32_t COMPARE_ALWAYS = 8u;
inline constexpr uint32_t TOPOLOGY_POINT_LIST = 1u;
inline constexpr uint32_t TOPOLOGY_LINE_LIST = 2u;
inline constexpr uint32_t TOPOLOGY_LINE_STRIP = 3u;
inline constexpr uint32_t TOPOLOGY_TRIANGLE_LIST = 4u;
inline constexpr uint32_t TOPOLOGY_TRIANGLE_STRIP = 5u;
inline constexpr uint32_t FRONT_FACE_CCW = 1u;
inline constexpr uint32_t FRONT_FACE_CW = 2u;
inline constexpr uint32_t CULL_NONE = 0u;
inline constexpr uint32_t CULL_FRONT = 1u;
inline constexpr uint32_t CULL_BACK = 2u;
inline constexpr uint32_t LOAD_LOAD = 1u;
inline constexpr uint32_t LOAD_CLEAR = 2u;
inline constexpr uint32_t STORE_STORE = 1u;
inline constexpr uint32_t STORE_DISCARD = 2u;
inline constexpr uint32_t ASPECT_ALL = 0u;
inline constexpr uint32_t ASPECT_STENCIL_ONLY = 1u;
inline constexpr uint32_t ASPECT_DEPTH_ONLY = 2u;
inline constexpr uint32_t BUFFER_BINDING_UNIFORM = 1u;
inline constexpr uint32_t BUFFER_BINDING_STORAGE = 2u;
inline constexpr uint32_t BUFFER_BINDING_READ_ONLY_STORAGE = 3u;
inline constexpr uint32_t SAMPLER_FILTERING = 1u;
inline constexpr uint32_t SAMPLER_NON_FILTERING = 2u;
inline constexpr uint32_t SAMPLER_COMPARISON = 3u;
inline constexpr uint32_t TEXTURE_SAMPLE_FLOAT = 1u;
inline constexpr uint32_t TEXTURE_SAMPLE_UNFILTERABLE_FLOAT = 2u;
inline constexpr uint32_t TEXTURE_SAMPLE_DEPTH = 3u;
inline constexpr uint32_t TEXTURE_SAMPLE_SINT = 4u;
inline constexpr uint32_t TEXTURE_SAMPLE_UINT = 5u;
inline constexpr uint32_t STORAGE_WRITE_ONLY = 1u;
inline constexpr uint32_t STORAGE_READ_ONLY = 2u;
inline constexpr uint32_t STORAGE_READ_WRITE = 3u;
inline constexpr uint32_t INDEX_UINT16 = 1u;
inline constexpr uint32_t INDEX_UINT32 = 2u;
inline constexpr uint32_t STEP_VERTEX = 0u;
inline constexpr uint32_t STEP_INSTANCE = 1u;
inline constexpr uint32_t BLEND_FACTOR_ZERO = 1u;
inline constexpr uint32_t BLEND_FACTOR_ONE = 2u;
inline constexpr uint32_t BLEND_FACTOR_SRC = 3u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_SRC = 4u;
inline constexpr uint32_t BLEND_FACTOR_SRC_ALPHA = 5u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_SRC_ALPHA = 6u;
inline constexpr uint32_t BLEND_FACTOR_DST = 7u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_DST = 8u;
inline constexpr uint32_t BLEND_FACTOR_DST_ALPHA = 9u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_DST_ALPHA = 10u;
inline constexpr uint32_t BLEND_FACTOR_SRC_ALPHA_SATURATED = 11u;
inline constexpr uint32_t BLEND_FACTOR_CONSTANT = 12u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_CONSTANT = 13u;
inline constexpr uint32_t BLEND_FACTOR_SRC1 = 14u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_SRC1 = 15u;
inline constexpr uint32_t BLEND_FACTOR_SRC1_ALPHA = 16u;
inline constexpr uint32_t BLEND_FACTOR_ONE_MINUS_SRC1_ALPHA = 17u;
inline constexpr uint32_t BLEND_OP_ADD = 1u;
inline constexpr uint32_t BLEND_OP_SUBTRACT = 2u;
inline constexpr uint32_t BLEND_OP_REVERSE_SUBTRACT = 3u;
inline constexpr uint32_t BLEND_OP_MIN = 4u;
inline constexpr uint32_t BLEND_OP_MAX = 5u;
inline constexpr uint32_t STENCIL_OP_KEEP = 1u;
inline constexpr uint32_t STENCIL_OP_ZERO = 2u;
inline constexpr uint32_t STENCIL_OP_REPLACE = 3u;
inline constexpr uint32_t STENCIL_OP_INVERT = 4u;
inline constexpr uint32_t STENCIL_OP_INCREMENT_CLAMP = 5u;
inline constexpr uint32_t STENCIL_OP_DECREMENT_CLAMP = 6u;
inline constexpr uint32_t STENCIL_OP_INCREMENT_WRAP = 7u;
inline constexpr uint32_t STENCIL_OP_DECREMENT_WRAP = 8u;
inline constexpr uint32_t QUERY_TYPE_TIMESTAMP = 1u;
inline constexpr uint32_t QUERY_TYPE_OCCLUSION = 2u;
inline constexpr uint32_t LIMIT_MODE_REQUIRED = 1u;
inline constexpr uint32_t LIMIT_MODE_PREFERRED = 2u;
inline constexpr uint32_t POWER_LOW_POWER = 0u;
inline constexpr uint32_t POWER_HIGH_PERFORMANCE = 1u;
inline constexpr uint32_t FEATURE_TIMESTAMP_QUERY = 1u;
inline constexpr uint32_t FEATURE_DEPTH_CLIP_CONTROL = 2u;
inline constexpr uint32_t FEATURE_DEPTH32FLOAT_STENCIL8 = 4u;
inline constexpr uint32_t FEATURE_TEXTURE_COMPRESSION_BC = 8u;
inline constexpr uint32_t FEATURE_TEXTURE_COMPRESSION_BC_SLICED_3D = 16u;
inline constexpr uint32_t FEATURE_TEXTURE_COMPRESSION_ETC2 = 32u;
inline constexpr uint32_t FEATURE_TEXTURE_COMPRESSION_ASTC = 64u;
inline constexpr uint32_t FEATURE_TEXTURE_COMPRESSION_ASTC_SLICED_3D = 128u;
inline constexpr uint32_t FEATURE_INDIRECT_FIRST_INSTANCE = 256u;
inline constexpr uint32_t FEATURE_SHADER_F16 = 512u;
inline constexpr uint32_t FEATURE_RG11B10UFLOAT_RENDERABLE = 1024u;
inline constexpr uint32_t FEATURE_BGRA8UNORM_STORAGE = 2048u;
inline constexpr uint32_t FEATURE_FLOAT32_FILTERABLE = 4096u;
inline constexpr uint32_t FEATURE_FLOAT32_BLENDABLE = 8192u;
inline constexpr uint32_t FEATURE_CLIP_DISTANCES = 16384u;
inline constexpr uint32_t FEATURE_DUAL_SOURCE_BLENDING = 32768u;
inline constexpr uint32_t FEATURE_SUBGROUPS = 65536u;
inline constexpr uint32_t FEATURE_CORE_FEATURES_AND_LIMITS = 131072u;
inline constexpr uint32_t FEATURE_PRIMITIVE_INDEX = 262144u;
inline constexpr uint32_t FEATURE_TEXTURE_FORMATS_TIER1 = 524288u;
inline constexpr uint32_t FEATURE_TEXTURE_FORMATS_TIER2 = 1048576u;
inline constexpr uint32_t LIMIT_MAX_TEXTURE_DIMENSION_1_D = 1u;
inline constexpr uint32_t LIMIT_MAX_TEXTURE_DIMENSION_2_D = 2u;
inline constexpr uint32_t LIMIT_MAX_TEXTURE_DIMENSION_3_D = 3u;
inline constexpr uint32_t LIMIT_MAX_TEXTURE_ARRAY_LAYERS = 4u;
inline constexpr uint32_t LIMIT_MAX_BIND_GROUPS = 5u;
inline constexpr uint32_t LIMIT_MAX_BIND_GROUPS_PLUS_VERTEX_BUFFERS = 6u;
inline constexpr uint32_t LIMIT_MAX_BINDINGS_PER_BIND_GROUP = 7u;
inline constexpr uint32_t LIMIT_MAX_DYNAMIC_UNIFORM_BUFFERS_PER_PIPELINE_LAYOUT = 8u;
inline constexpr uint32_t LIMIT_MAX_DYNAMIC_STORAGE_BUFFERS_PER_PIPELINE_LAYOUT = 9u;
inline constexpr uint32_t LIMIT_MAX_SAMPLED_TEXTURES_PER_SHADER_STAGE = 10u;
inline constexpr uint32_t LIMIT_MAX_SAMPLERS_PER_SHADER_STAGE = 11u;
inline constexpr uint32_t LIMIT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE = 12u;
inline constexpr uint32_t LIMIT_MAX_STORAGE_TEXTURES_PER_SHADER_STAGE = 13u;
inline constexpr uint32_t LIMIT_MAX_UNIFORM_BUFFERS_PER_SHADER_STAGE = 14u;
inline constexpr uint32_t LIMIT_MAX_UNIFORM_BUFFER_BINDING_SIZE = 15u;
inline constexpr uint32_t LIMIT_MAX_STORAGE_BUFFER_BINDING_SIZE = 16u;
inline constexpr uint32_t LIMIT_MIN_UNIFORM_BUFFER_OFFSET_ALIGNMENT = 17u;
inline constexpr uint32_t LIMIT_MIN_STORAGE_BUFFER_OFFSET_ALIGNMENT = 18u;
inline constexpr uint32_t LIMIT_MAX_VERTEX_BUFFERS = 19u;
inline constexpr uint32_t LIMIT_MAX_BUFFER_SIZE = 20u;
inline constexpr uint32_t LIMIT_MAX_VERTEX_ATTRIBUTES = 21u;
inline constexpr uint32_t LIMIT_MAX_VERTEX_BUFFER_ARRAY_STRIDE = 22u;
inline constexpr uint32_t LIMIT_MAX_INTER_STAGE_SHADER_VARIABLES = 23u;
inline constexpr uint32_t LIMIT_MAX_COLOR_ATTACHMENTS = 24u;
inline constexpr uint32_t LIMIT_MAX_COLOR_ATTACHMENT_BYTES_PER_SAMPLE = 25u;
inline constexpr uint32_t LIMIT_MAX_COMPUTE_WORKGROUP_STORAGE_SIZE = 26u;
inline constexpr uint32_t LIMIT_MAX_COMPUTE_INVOCATIONS_PER_WORKGROUP = 27u;
inline constexpr uint32_t LIMIT_MAX_COMPUTE_WORKGROUP_SIZE_X = 28u;
inline constexpr uint32_t LIMIT_MAX_COMPUTE_WORKGROUP_SIZE_Y = 29u;
inline constexpr uint32_t LIMIT_MAX_COMPUTE_WORKGROUP_SIZE_Z = 30u;
inline constexpr uint32_t LIMIT_MAX_COMPUTE_WORKGROUPS_PER_DIMENSION = 31u;
inline constexpr uint32_t RECORD_BIND_GROUP_LAYOUT_WIDTH = 10u;
inline constexpr uint32_t RECORD_BIND_GROUP_WIDTH = 5u;
inline constexpr uint32_t RECORD_VERTEX_BUFFER_WIDTH = 3u;
inline constexpr uint32_t RECORD_VERTEX_ATTRIBUTE_WIDTH = 3u;
inline constexpr uint32_t RECORD_COLOR_TARGET_WIDTH = 9u;
inline constexpr uint32_t RECORD_PRIMITIVE_WIDTH = 5u;
inline constexpr uint32_t RECORD_DEPTH_STENCIL_WIDTH = 16u;
inline constexpr uint32_t RECORD_MULTISAMPLE_WIDTH = 3u;
inline constexpr uint32_t RECORD_COLOR_ATTACHMENT_WIDTH = 9u;
inline constexpr uint32_t RECORD_DEPTH_STENCIL_ATTACHMENT_WIDTH = 9u;
inline constexpr uint32_t RECORD_LIMIT_REQUEST_WIDTH = 3u;
inline constexpr uint32_t RECORD_CONSTANT_WIDTH = 3u;
}  // namespace constants

enum class Opcode : uint8_t {
  RequestDevice = 1,
  CreateBuffer = 2,
  CreateTexture = 3,
  CreateTextureView = 4,
  CreateSampler = 5,
  CreateShaderModule = 6,
  CreateBindGroupLayout = 7,
  CreateBindGroup = 8,
  CreatePipelineLayout = 9,
  CreateComputePipeline = 10,
  CreateComputePipelineAsync = 11,
  CreateRenderPipeline = 12,
  CreateRenderPipelineAsync = 13,
  CreateQuerySet = 14,
  CreateCommandEncoder = 15,
  BeginComputePass = 16,
  ComputeSetPipeline = 17,
  ComputeSetBindGroup = 18,
  ComputeDispatch = 19,
  ComputeDispatchIndirect = 20,
  EndComputePass = 21,
  BeginRenderPass = 22,
  RenderSetViewport = 23,
  RenderSetScissor = 24,
  RenderSetPipeline = 25,
  RenderSetBindGroup = 26,
  RenderSetVertexBuffer = 27,
  RenderSetIndexBuffer = 28,
  RenderDraw = 29,
  RenderDrawIndexed = 30,
  RenderDrawIndirect = 31,
  RenderDrawIndexedIndirect = 32,
  EndRenderPass = 33,
  CopyBufferToBuffer = 34,
  CopyBufferToTexture = 35,
  CopyTextureToTexture = 36,
  ResolveQuerySet = 37,
  FinishCommandEncoder = 38,
  QueueSubmit = 39,
  WriteBuffer = 40,
  WriteTexture = 41,
  ConfigureCanvas = 42,
  GetCurrentTexture = 43,
  Destroy = 44,
  MapAsync = 45,
  OnSubmittedWorkDone = 46,
  RequestFrame = 47,
  Release = 48,
  Unmap = 49,
  WriteMappedBuffer = 50,
  RequestDeviceWith = 52,
  CancelRequest = 53,
  DestroyDevice = 54,
  CreateRenderPipelineWith = 55,
  CreateRenderPipelineAsyncWith = 56,
  CreateComputePipelineWith = 57,
  CreateComputePipelineAsyncWith = 58,
  BeginRenderPassWith = 59,
  RenderSetStencilReference = 60,
  RenderSetBlendConstant = 61,
  RenderBeginOcclusionQuery = 62,
  RenderEndOcclusionQuery = 63,
  CopyTextureToBuffer = 64,
  ClearBuffer = 65,
  Protocol = 51,  // batch header only; unknown inside a batch
};

enum class Event : uint32_t {
  Capabilities = 1,  // terminal
  PipelineReady = 2,  // terminal
  MapReady = 3,  // terminal
  WorkDone = 4,  // terminal
  DeviceLost = 5,
  UncaughtError = 6,
  ShaderInfo = 7,  // terminal
  Resize = 8,
  Error = 9,  // terminal
};

enum class Status : uint32_t {
  Ok = 0,
  Error = 1,
  Cancelled = 2,
  Lost = 3,
};

inline const char* event_name(Event event) noexcept {
  switch (event) {
    case Event::Capabilities: return "CAPABILITIES";
    case Event::PipelineReady: return "PIPELINE_READY";
    case Event::MapReady: return "MAP_READY";
    case Event::WorkDone: return "WORK_DONE";
    case Event::DeviceLost: return "DEVICE_LOST";
    case Event::UncaughtError: return "UNCAUGHT_ERROR";
    case Event::ShaderInfo: return "SHADER_INFO";
    case Event::Resize: return "RESIZE";
    case Event::Error: return "ERROR";
  }
  return nullptr;
}

inline bool event_is_terminal(Event event) noexcept {
  switch (event) {
    case Event::Capabilities: return true;
    case Event::PipelineReady: return true;
    case Event::MapReady: return true;
    case Event::WorkDone: return true;
    case Event::DeviceLost: return false;
    case Event::UncaughtError: return false;
    case Event::ShaderInfo: return true;
    case Event::Resize: return false;
    case Event::Error: return true;
  }
  return false;
}

// Handles: 20-bit slot, 12-bit generation (generation << 20 | slot); 0 is "no handle".
enum class Handle : uint32_t {};
inline constexpr uint32_t handle_value(Handle handle) noexcept { return static_cast<uint32_t>(handle); }
inline constexpr uint32_t handle_slot(Handle handle) noexcept { return handle_value(handle) & kHandleSlotMask; }
inline constexpr uint32_t handle_generation(Handle handle) noexcept { return (handle_value(handle) >> kHandleSlotBits) & kHandleGenerationMask; }
inline constexpr Handle make_handle(uint32_t slot, uint32_t generation) noexcept {
  return static_cast<Handle>(((generation & kHandleGenerationMask) << kHandleSlotBits) | (slot & kHandleSlotMask));
}

namespace wire {
inline uint32_t load_u32(const uint8_t* p) noexcept {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
inline uint64_t load_u64(const uint8_t* p) noexcept {
  return static_cast<uint64_t>(load_u32(p)) | (static_cast<uint64_t>(load_u32(p + 4)) << 32);
}
inline int32_t load_i32(const uint8_t* p) noexcept { const uint32_t bits = load_u32(p); int32_t value; std::memcpy(&value, &bits, sizeof value); return value; }
inline float load_f32(const uint8_t* p) noexcept { const uint32_t bits = load_u32(p); float value; std::memcpy(&value, &bits, sizeof value); return value; }
inline double load_f64(const uint8_t* p) noexcept { const uint64_t bits = load_u64(p); double value; std::memcpy(&value, &bits, sizeof value); return value; }
inline void store_u32(uint8_t* p, uint32_t value) noexcept {
  p[0] = static_cast<uint8_t>(value); p[1] = static_cast<uint8_t>(value >> 8); p[2] = static_cast<uint8_t>(value >> 16); p[3] = static_cast<uint8_t>(value >> 24);
}

template <class T> struct Element;
template <> struct Element<uint32_t> { static constexpr size_t kBytes = 4; static uint32_t load(const uint8_t* p) noexcept { return load_u32(p); } };
template <> struct Element<Handle> { static constexpr size_t kBytes = 4; static Handle load(const uint8_t* p) noexcept { return static_cast<Handle>(load_u32(p)); } };
template <> struct Element<double> { static constexpr size_t kBytes = 8; static double load(const uint8_t* p) noexcept { return load_f64(p); } };

// WHATWG UTF-8 decode (TextDecoder("utf-8") with fatal false, ignoreBOM false). Returns true when the result
// equals the input bytes; out may be null to only check that.
inline bool decode_utf8(const uint8_t* bytes, size_t size, std::string* out) {
  bool same = true;
  size_t i = 0;
  if (size >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) { i = 3; same = false; }
  if (out) out->reserve(size);
  uint32_t needed = 0, seen = 0;
  uint8_t lower = 0x80, upper = 0xbf;
  size_t lead = i;
  const auto replace = [&] { same = false; if (out) out->append("\xef\xbf\xbd", 3); };
  while (i < size) {
    const uint8_t byte = bytes[i];
    if (needed == 0) {
      lead = i++;
      if (byte <= 0x7f) { if (out) out->push_back(static_cast<char>(byte)); }
      else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; }
      else if (byte >= 0xe0 && byte <= 0xef) { if (byte == 0xe0) lower = 0xa0; if (byte == 0xed) upper = 0x9f; needed = 2; }
      else if (byte >= 0xf0 && byte <= 0xf4) { if (byte == 0xf0) lower = 0x90; if (byte == 0xf4) upper = 0x8f; needed = 3; }
      else replace();
      continue;
    }
    if (byte < lower || byte > upper) {
      needed = seen = 0; lower = 0x80; upper = 0xbf;
      replace();
      continue;  // the byte is processed again as a lead byte
    }
    ++i; lower = 0x80; upper = 0xbf;
    if (++seen == needed) {
      if (out) out->append(reinterpret_cast<const char*>(bytes + lead), i - lead);
      needed = seen = 0;
    }
  }
  if (needed) replace();
  return same;
}
}  // namespace wire

// A str operand: borrowed bytes of the batch. bytes() is the raw wire value; text() is the exact string the JS
// host sees. is_exact_text() is true when bytes() already equals text(), so it can be used without a copy.
struct Str {
  const uint8_t* data = nullptr;
  uint32_t size = 0;
  std::string_view bytes() const noexcept { return size ? std::string_view(reinterpret_cast<const char*>(data), size) : std::string_view(); }
  bool is_exact_text() const { return wire::decode_utf8(data, size, nullptr); }
  std::string text() const { std::string out; wire::decode_utf8(data, size, &out); return out; }
};

// A handle[], u32[] or f64[] operand: borrowed little-endian elements of the batch; operator[] is unchecked.
template <class T> class WireArray {
 public:
  using value_type = T;
  static constexpr size_t kElementBytes = wire::Element<T>::kBytes;
  constexpr WireArray() noexcept = default;
  constexpr WireArray(const uint8_t* data, uint32_t count) noexcept : data_(data), count_(count) {}
  uint32_t size() const noexcept { return count_; }
  bool empty() const noexcept { return count_ == 0; }
  const uint8_t* data() const noexcept { return data_; }
  T operator[](uint32_t index) const noexcept { return wire::Element<T>::load(data_ + static_cast<size_t>(index) * kElementBytes); }

 private:
  const uint8_t* data_ = nullptr;
  uint32_t count_ = 0;
};
using HandleArray = WireArray<Handle>;
using U32Array = WireArray<uint32_t>;
using F64Array = WireArray<double>;

// upload and readback operands: offsets into the arenas passed with the batch, not validated by the decoder.
struct UploadRange { uint32_t offset = 0; uint32_t length = 0; };
struct ReadbackRange { uint32_t offset = 0; uint32_t length = 0; };
inline constexpr bool range_within(uint32_t offset, uint32_t length, uint64_t arena_bytes) noexcept {
  return static_cast<uint64_t>(offset) + length <= arena_bytes;
}

// Descriptor records: fixed-width groups of f64[] elements. The executor maps operands to record kinds and
// checks widths and counts exactly as the JS host does.
namespace record {
struct BindGroupLayout {
  static constexpr const char* kName = "bindGroupLayout";
  static constexpr uint32_t kWidth = 10u;
  enum Field : uint32_t { kBinding = 0, kVisibility = 1, kKind = 2, kType = 3, kDynamic = 4, kMinSize = 5, kDimension = 6, kMultisampled = 7, kFormat = 8, kAccess = 9 };
};
struct BindGroup {
  static constexpr const char* kName = "bindGroup";
  static constexpr uint32_t kWidth = 5u;
  enum Field : uint32_t { kBinding = 0, kKind = 1, kResource = 2, kOffset = 3, kSize = 4 };
};
struct VertexBuffer {
  static constexpr const char* kName = "vertexBuffer";
  static constexpr uint32_t kWidth = 3u;
  enum Field : uint32_t { kArrayStride = 0, kStep = 1, kAttributeCount = 2 };
};
struct VertexAttribute {
  static constexpr const char* kName = "vertexAttribute";
  static constexpr uint32_t kWidth = 3u;
  enum Field : uint32_t { kShaderLocation = 0, kOffset = 1, kFormat = 2 };
};
struct ColorTarget {
  static constexpr const char* kName = "colorTarget";
  static constexpr uint32_t kWidth = 9u;
  enum Field : uint32_t { kFormat = 0, kWriteMask = 1, kBlend = 2, kColorOperation = 3, kColorSrcFactor = 4, kColorDstFactor = 5, kAlphaOperation = 6, kAlphaSrcFactor = 7, kAlphaDstFactor = 8 };
};
struct Primitive {
  static constexpr const char* kName = "primitive";
  static constexpr uint32_t kWidth = 5u;
  enum Field : uint32_t { kTopology = 0, kStripIndexFormat = 1, kFrontFace = 2, kCullMode = 3, kUnclippedDepth = 4 };
};
struct DepthStencil {
  static constexpr const char* kName = "depthStencil";
  static constexpr uint32_t kWidth = 16u;
  enum Field : uint32_t { kFormat = 0, kDepthWrite = 1, kDepthCompare = 2, kFrontCompare = 3, kFrontFail = 4, kFrontDepthFail = 5, kFrontPass = 6, kBackCompare = 7, kBackFail = 8, kBackDepthFail = 9, kBackPass = 10, kStencilReadMask = 11, kStencilWriteMask = 12, kDepthBias = 13, kDepthBiasSlopeScale = 14, kDepthBiasClamp = 15 };
};
struct Multisample {
  static constexpr const char* kName = "multisample";
  static constexpr uint32_t kWidth = 3u;
  enum Field : uint32_t { kCount = 0, kMask = 1, kAlphaToCoverage = 2 };
};
struct ColorAttachment {
  static constexpr const char* kName = "colorAttachment";
  static constexpr uint32_t kWidth = 9u;
  enum Field : uint32_t { kView = 0, kResolveView = 1, kLoad = 2, kStore = 3, kClearR = 4, kClearG = 5, kClearB = 6, kClearA = 7, kDepthSlicePlusOne = 8 };
};
struct DepthStencilAttachment {
  static constexpr const char* kName = "depthStencilAttachment";
  static constexpr uint32_t kWidth = 9u;
  enum Field : uint32_t { kView = 0, kDepthLoad = 1, kDepthStore = 2, kDepthClear = 3, kDepthReadOnly = 4, kStencilLoad = 5, kStencilStore = 6, kStencilClear = 7, kStencilReadOnly = 8 };
};
struct LimitRequest {
  static constexpr const char* kName = "limitRequest";
  static constexpr uint32_t kWidth = 3u;
  enum Field : uint32_t { kLimit = 0, kValue = 1, kMode = 2 };
};
struct Constant {
  static constexpr const char* kName = "constant";
  static constexpr uint32_t kWidth = 3u;
  enum Field : uint32_t { kStages = 0, kId = 1, kValue = 2 };
};
inline constexpr const char* const kBindGroupLayoutFields[] = { "binding", "visibility", "kind", "type", "dynamic", "minSize", "dimension", "multisampled", "format", "access" };
inline constexpr const char* const kBindGroupFields[] = { "binding", "kind", "resource", "offset", "size" };
inline constexpr const char* const kVertexBufferFields[] = { "arrayStride", "step", "attributeCount" };
inline constexpr const char* const kVertexAttributeFields[] = { "shaderLocation", "offset", "format" };
inline constexpr const char* const kColorTargetFields[] = { "format", "writeMask", "blend", "colorOperation", "colorSrcFactor", "colorDstFactor", "alphaOperation", "alphaSrcFactor", "alphaDstFactor" };
inline constexpr const char* const kPrimitiveFields[] = { "topology", "stripIndexFormat", "frontFace", "cullMode", "unclippedDepth" };
inline constexpr const char* const kDepthStencilFields[] = { "format", "depthWrite", "depthCompare", "frontCompare", "frontFail", "frontDepthFail", "frontPass", "backCompare", "backFail", "backDepthFail", "backPass", "stencilReadMask", "stencilWriteMask", "depthBias", "depthBiasSlopeScale", "depthBiasClamp" };
inline constexpr const char* const kMultisampleFields[] = { "count", "mask", "alphaToCoverage" };
inline constexpr const char* const kColorAttachmentFields[] = { "view", "resolveView", "load", "store", "clearR", "clearG", "clearB", "clearA", "depthSlicePlusOne" };
inline constexpr const char* const kDepthStencilAttachmentFields[] = { "view", "depthLoad", "depthStore", "depthClear", "depthReadOnly", "stencilLoad", "stencilStore", "stencilClear", "stencilReadOnly" };
inline constexpr const char* const kLimitRequestFields[] = { "limit", "value", "mode" };
inline constexpr const char* const kConstantFields[] = { "stages", "id", "value" };
}  // namespace record

struct RecordInfo { const char* name; uint32_t width; const char* const* fields; };
inline constexpr RecordInfo kRecords[] = {
  { "bindGroupLayout", 10u, record::kBindGroupLayoutFields },
  { "bindGroup", 5u, record::kBindGroupFields },
  { "vertexBuffer", 3u, record::kVertexBufferFields },
  { "vertexAttribute", 3u, record::kVertexAttributeFields },
  { "colorTarget", 9u, record::kColorTargetFields },
  { "primitive", 5u, record::kPrimitiveFields },
  { "depthStencil", 16u, record::kDepthStencilFields },
  { "multisample", 3u, record::kMultisampleFields },
  { "colorAttachment", 9u, record::kColorAttachmentFields },
  { "depthStencilAttachment", 9u, record::kDepthStencilAttachmentFields },
  { "limitRequest", 3u, record::kLimitRequestFields },
  { "constant", 3u, record::kConstantFields },
};

template <class T> class RecordView {
 public:
  RecordView(WireArray<T> values, uint32_t width) noexcept : values_(values), width_(width) {}
  bool valid() const noexcept { return width_ != 0 && values_.size() % width_ == 0; }
  uint32_t count() const noexcept { return width_ ? values_.size() / width_ : 0; }
  T operator()(uint32_t index, uint32_t field) const noexcept { return values_[index * width_ + field]; }

 private:
  WireArray<T> values_;
  uint32_t width_;
};

// Enum tables: wire value = index; nullptr entries are not valid values.
namespace enums {
inline constexpr const char* const kDimension[] = { nullptr, "1d", "2d", "3d" };
inline constexpr const char* const kView[] = { nullptr, "1d", "2d", "2d-array", "cube", "cube-array", "3d" };
inline constexpr const char* const kAddress[] = { "clamp-to-edge", "repeat", "mirror-repeat" };
inline constexpr const char* const kFilter[] = { "nearest", "linear" };
inline constexpr const char* const kCompare[] = { nullptr, "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always" };
inline constexpr const char* const kTopology[] = { nullptr, "point-list", "line-list", "line-strip", "triangle-list", "triangle-strip" };
inline constexpr const char* const kFront[] = { nullptr, "ccw", "cw" };
inline constexpr const char* const kCull[] = { "none", "front", "back" };
inline constexpr const char* const kLoad[] = { nullptr, "load", "clear" };
inline constexpr const char* const kStore[] = { nullptr, "store", "discard" };
inline constexpr const char* const kAspect[] = { "all", "stencil-only", "depth-only" };
inline constexpr const char* const kBuffer[] = { nullptr, "uniform", "storage", "read-only-storage" };
inline constexpr const char* const kSampler[] = { nullptr, "filtering", "non-filtering", "comparison" };
inline constexpr const char* const kSample[] = { nullptr, "float", "unfilterable-float", "depth", "sint", "uint" };
inline constexpr const char* const kAccess[] = { nullptr, "write-only", "read-only", "read-write" };
inline constexpr const char* const kFormat[] = { nullptr, "rgba8unorm", "bgra8unorm", "rgba16float", "r32float", "r32uint", "rg32float", "rgba32float", "depth24plus", "depth32float", "r8unorm", "r8snorm", "r8uint", "r8sint", "r16uint", "r16sint", "r16float", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint", "r32sint", "rg16uint", "rg16sint", "rg16float", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm-srgb", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rgb9e5ufloat", "rg32uint", "rg32sint", "rgba16uint", "rgba16sint", "rgba32uint", "rgba32sint", "stencil8", "depth16unorm", "depth24plus-stencil8", "depth32float-stencil8" };
inline constexpr const char* const kVertexFormat[] = { nullptr, "float32", "float32x2", "float32x3", "float32x4", "uint32", "uint32x2", "uint32x3", "uint32x4", "sint32", "sint32x2", "sint32x3", "sint32x4", "unorm8x4", "uint8", "uint8x2", "uint8x4", "sint8", "sint8x2", "sint8x4", "unorm8", "unorm8x2", "snorm8", "snorm8x2", "snorm8x4", "uint16", "uint16x2", "uint16x4", "sint16", "sint16x2", "sint16x4", "unorm16", "unorm16x2", "unorm16x4", "snorm16", "snorm16x2", "snorm16x4", "float16", "float16x2", "float16x4", "unorm10-10-10-2", "unorm8x4-bgra" };
inline constexpr const char* const kIndex[] = { nullptr, "uint16", "uint32" };
inline constexpr const char* const kStep[] = { "vertex", "instance" };
inline constexpr const char* const kBlendFactor[] = { nullptr, "zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturated", "constant", "one-minus-constant", "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha" };
inline constexpr const char* const kBlendOperation[] = { nullptr, "add", "subtract", "reverse-subtract", "min", "max" };
inline constexpr const char* const kStencilOperation[] = { nullptr, "keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap" };
inline constexpr const char* const kQueryType[] = { nullptr, "timestamp", "occlusion" };
inline constexpr const char* const kLimitMode[] = { nullptr, "required", "preferred" };
inline constexpr const char* const kPower[] = { "low-power", "high-performance" };
}  // namespace enums

struct EnumInfo {
  const char* name; const char* const* values; uint32_t size;
  const char* at(uint32_t index) const noexcept { return index < size ? values[index] : nullptr; }
};
inline constexpr EnumInfo kEnums[] = {
  { "dimension", enums::kDimension, 4u },
  { "view", enums::kView, 7u },
  { "address", enums::kAddress, 3u },
  { "filter", enums::kFilter, 2u },
  { "compare", enums::kCompare, 9u },
  { "topology", enums::kTopology, 6u },
  { "front", enums::kFront, 3u },
  { "cull", enums::kCull, 3u },
  { "load", enums::kLoad, 3u },
  { "store", enums::kStore, 3u },
  { "aspect", enums::kAspect, 3u },
  { "buffer", enums::kBuffer, 4u },
  { "sampler", enums::kSampler, 4u },
  { "sample", enums::kSample, 6u },
  { "access", enums::kAccess, 4u },
  { "format", enums::kFormat, 44u },
  { "vertexFormat", enums::kVertexFormat, 42u },
  { "index", enums::kIndex, 3u },
  { "step", enums::kStep, 2u },
  { "blendFactor", enums::kBlendFactor, 18u },
  { "blendOperation", enums::kBlendOperation, 6u },
  { "stencilOperation", enums::kStencilOperation, 9u },
  { "queryType", enums::kQueryType, 3u },
  { "limitMode", enums::kLimitMode, 3u },
  { "power", enums::kPower, 2u },
};

// Feature bit i is (1 << i); limit ids are one-based (kLimits[0] is unused).
inline constexpr const char* const kFeatures[] = { "timestamp-query", "depth-clip-control", "depth32float-stencil8", "texture-compression-bc", "texture-compression-bc-sliced-3d", "texture-compression-etc2", "texture-compression-astc", "texture-compression-astc-sliced-3d", "indirect-first-instance", "shader-f16", "rg11b10ufloat-renderable", "bgra8unorm-storage", "float32-filterable", "float32-blendable", "clip-distances", "dual-source-blending", "subgroups", "core-features-and-limits", "primitive-index", "texture-formats-tier1", "texture-formats-tier2" };
enum class LimitClass : uint8_t { None, Maximum, Alignment };
struct LimitInfo { const char* name; LimitClass limit_class; };
inline constexpr LimitInfo kLimits[] = {
  { nullptr, LimitClass::None },
  { "maxTextureDimension1D", LimitClass::Maximum },
  { "maxTextureDimension2D", LimitClass::Maximum },
  { "maxTextureDimension3D", LimitClass::Maximum },
  { "maxTextureArrayLayers", LimitClass::Maximum },
  { "maxBindGroups", LimitClass::Maximum },
  { "maxBindGroupsPlusVertexBuffers", LimitClass::Maximum },
  { "maxBindingsPerBindGroup", LimitClass::Maximum },
  { "maxDynamicUniformBuffersPerPipelineLayout", LimitClass::Maximum },
  { "maxDynamicStorageBuffersPerPipelineLayout", LimitClass::Maximum },
  { "maxSampledTexturesPerShaderStage", LimitClass::Maximum },
  { "maxSamplersPerShaderStage", LimitClass::Maximum },
  { "maxStorageBuffersPerShaderStage", LimitClass::Maximum },
  { "maxStorageTexturesPerShaderStage", LimitClass::Maximum },
  { "maxUniformBuffersPerShaderStage", LimitClass::Maximum },
  { "maxUniformBufferBindingSize", LimitClass::Maximum },
  { "maxStorageBufferBindingSize", LimitClass::Maximum },
  { "minUniformBufferOffsetAlignment", LimitClass::Alignment },
  { "minStorageBufferOffsetAlignment", LimitClass::Alignment },
  { "maxVertexBuffers", LimitClass::Maximum },
  { "maxBufferSize", LimitClass::Maximum },
  { "maxVertexAttributes", LimitClass::Maximum },
  { "maxVertexBufferArrayStride", LimitClass::Maximum },
  { "maxInterStageShaderVariables", LimitClass::Maximum },
  { "maxColorAttachments", LimitClass::Maximum },
  { "maxColorAttachmentBytesPerSample", LimitClass::Maximum },
  { "maxComputeWorkgroupStorageSize", LimitClass::Maximum },
  { "maxComputeInvocationsPerWorkgroup", LimitClass::Maximum },
  { "maxComputeWorkgroupSizeX", LimitClass::Maximum },
  { "maxComputeWorkgroupSizeY", LimitClass::Maximum },
  { "maxComputeWorkgroupSizeZ", LimitClass::Maximum },
  { "maxComputeWorkgroupsPerDimension", LimitClass::Maximum },
};

// opcode 1, request completing with CAPABILITIES
struct RequestDeviceOp {
  static constexpr Opcode kOpcode = Opcode::RequestDevice;
  static constexpr const char* kName = "requestDevice";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::Capabilities;
  static constexpr const char* kResult = nullptr;
  uint32_t requestId{};
  uint32_t powerPreference{};
  uint32_t featureBits{};
  double maxBufferSize{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("requestId", requestId); f("powerPreference", powerPreference); f("featureBits", featureBits); f("maxBufferSize", maxBufferSize); }
};

// opcode 2, result buffer
struct CreateBufferOp {
  static constexpr Opcode kOpcode = Opcode::CreateBuffer;
  static constexpr const char* kName = "createBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "buffer";
  Handle handle{};
  double size{};
  uint32_t usage{};
  bool mappedAtCreation{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("size", size); f("usage", usage); f("mappedAtCreation", mappedAtCreation); f("label", label); }
};

// opcode 3, result texture
struct CreateTextureOp {
  static constexpr Opcode kOpcode = Opcode::CreateTexture;
  static constexpr const char* kName = "createTexture";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "texture";
  Handle handle{};
  uint32_t width{};
  uint32_t height{};
  uint32_t depth{};
  uint32_t mipLevels{};
  uint32_t samples{};
  uint32_t dimension{};
  Str format{};
  uint32_t usage{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("width", width); f("height", height); f("depth", depth); f("mipLevels", mipLevels); f("samples", samples); f("dimension", dimension); f("format", format); f("usage", usage); f("label", label); }
};

// opcode 4, result textureView
struct CreateTextureViewOp {
  static constexpr Opcode kOpcode = Opcode::CreateTextureView;
  static constexpr const char* kName = "createTextureView";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "textureView";
  Handle handle{};
  Handle texture{};
  Str format{};
  uint32_t dimension{};
  uint32_t baseMip{};
  uint32_t mipCount{};
  uint32_t baseLayer{};
  uint32_t layerCount{};
  uint32_t aspect{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("texture", texture); f("format", format); f("dimension", dimension); f("baseMip", baseMip); f("mipCount", mipCount); f("baseLayer", baseLayer); f("layerCount", layerCount); f("aspect", aspect); f("label", label); }
};

// opcode 5, result sampler
struct CreateSamplerOp {
  static constexpr Opcode kOpcode = Opcode::CreateSampler;
  static constexpr const char* kName = "createSampler";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "sampler";
  Handle handle{};
  uint32_t addressU{};
  uint32_t addressV{};
  uint32_t addressW{};
  uint32_t magFilter{};
  uint32_t minFilter{};
  uint32_t mipmapFilter{};
  float lodMin{};
  float lodMax{};
  uint32_t compare{};
  uint32_t maxAnisotropy{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("addressU", addressU); f("addressV", addressV); f("addressW", addressW); f("magFilter", magFilter); f("minFilter", minFilter); f("mipmapFilter", mipmapFilter); f("lodMin", lodMin); f("lodMax", lodMax); f("compare", compare); f("maxAnisotropy", maxAnisotropy); f("label", label); }
};

// opcode 6, result shaderModule, request completing with SHADER_INFO
struct CreateShaderModuleOp {
  static constexpr Opcode kOpcode = Opcode::CreateShaderModule;
  static constexpr const char* kName = "createShaderModule";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::ShaderInfo;
  static constexpr const char* kResult = "shaderModule";
  Handle handle{};
  uint32_t requestId{};
  Str code{};
  Str label{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return handle; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("requestId", requestId); f("code", code); f("label", label); }
};

// opcode 7, result bindGroupLayout
struct CreateBindGroupLayoutOp {
  static constexpr Opcode kOpcode = Opcode::CreateBindGroupLayout;
  static constexpr const char* kName = "createBindGroupLayout";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "bindGroupLayout";
  Handle handle{};
  F64Array entries{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("entries", entries); f("label", label); }
};

// opcode 8, result bindGroup
struct CreateBindGroupOp {
  static constexpr Opcode kOpcode = Opcode::CreateBindGroup;
  static constexpr const char* kName = "createBindGroup";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "bindGroup";
  Handle handle{};
  Handle layout{};
  F64Array entries{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("layout", layout); f("entries", entries); f("label", label); }
};

// opcode 9, result pipelineLayout
struct CreatePipelineLayoutOp {
  static constexpr Opcode kOpcode = Opcode::CreatePipelineLayout;
  static constexpr const char* kName = "createPipelineLayout";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "pipelineLayout";
  Handle handle{};
  HandleArray layouts{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("layouts", layouts); f("label", label); }
};

// opcode 10, result computePipeline
struct CreateComputePipelineOp {
  static constexpr Opcode kOpcode = Opcode::CreateComputePipeline;
  static constexpr const char* kName = "createComputePipeline";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "computePipeline";
  Handle handle{};
  Handle layout{};
  Handle shader{};
  Str entry{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("layout", layout); f("shader", shader); f("entry", entry); f("label", label); }
};

// opcode 11, result computePipeline, request completing with PIPELINE_READY
struct CreateComputePipelineAsyncOp {
  static constexpr Opcode kOpcode = Opcode::CreateComputePipelineAsync;
  static constexpr const char* kName = "createComputePipelineAsync";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::PipelineReady;
  static constexpr const char* kResult = "computePipeline";
  Handle handle{};
  uint32_t requestId{};
  Handle layout{};
  Handle shader{};
  Str entry{};
  Str label{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return handle; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("requestId", requestId); f("layout", layout); f("shader", shader); f("entry", entry); f("label", label); }
};

// opcode 12, result renderPipeline
struct CreateRenderPipelineOp {
  static constexpr Opcode kOpcode = Opcode::CreateRenderPipeline;
  static constexpr const char* kName = "createRenderPipeline";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "renderPipeline";
  Handle handle{};
  Handle layout{};
  Handle vertexShader{};
  Str vertexEntry{};
  Handle fragmentShader{};
  Str fragmentEntry{};
  Str colorFormat{};
  Str depthFormat{};
  uint32_t topology{};
  uint32_t frontFace{};
  uint32_t cullMode{};
  uint32_t sampleCount{};
  bool depthWrite{};
  uint32_t depthCompare{};
  uint32_t blend{};
  F64Array vertexLayouts{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("layout", layout); f("vertexShader", vertexShader); f("vertexEntry", vertexEntry); f("fragmentShader", fragmentShader); f("fragmentEntry", fragmentEntry); f("colorFormat", colorFormat); f("depthFormat", depthFormat); f("topology", topology); f("frontFace", frontFace); f("cullMode", cullMode); f("sampleCount", sampleCount); f("depthWrite", depthWrite); f("depthCompare", depthCompare); f("blend", blend); f("vertexLayouts", vertexLayouts); f("label", label); }
};

// opcode 13, result renderPipeline, request completing with PIPELINE_READY
struct CreateRenderPipelineAsyncOp {
  static constexpr Opcode kOpcode = Opcode::CreateRenderPipelineAsync;
  static constexpr const char* kName = "createRenderPipelineAsync";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::PipelineReady;
  static constexpr const char* kResult = "renderPipeline";
  Handle handle{};
  uint32_t requestId{};
  Handle layout{};
  Handle vertexShader{};
  Str vertexEntry{};
  Handle fragmentShader{};
  Str fragmentEntry{};
  Str colorFormat{};
  Str depthFormat{};
  uint32_t topology{};
  uint32_t frontFace{};
  uint32_t cullMode{};
  uint32_t sampleCount{};
  bool depthWrite{};
  uint32_t depthCompare{};
  uint32_t blend{};
  F64Array vertexLayouts{};
  Str label{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return handle; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("requestId", requestId); f("layout", layout); f("vertexShader", vertexShader); f("vertexEntry", vertexEntry); f("fragmentShader", fragmentShader); f("fragmentEntry", fragmentEntry); f("colorFormat", colorFormat); f("depthFormat", depthFormat); f("topology", topology); f("frontFace", frontFace); f("cullMode", cullMode); f("sampleCount", sampleCount); f("depthWrite", depthWrite); f("depthCompare", depthCompare); f("blend", blend); f("vertexLayouts", vertexLayouts); f("label", label); }
};

// opcode 14, result querySet
struct CreateQuerySetOp {
  static constexpr Opcode kOpcode = Opcode::CreateQuerySet;
  static constexpr const char* kName = "createQuerySet";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "querySet";
  Handle handle{};
  uint32_t type{};
  uint32_t count{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("type", type); f("count", count); f("label", label); }
};

// opcode 15, result commandEncoder
struct CreateCommandEncoderOp {
  static constexpr Opcode kOpcode = Opcode::CreateCommandEncoder;
  static constexpr const char* kName = "createCommandEncoder";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "commandEncoder";
  Handle handle{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("label", label); }
};

// opcode 16, result computePass
struct BeginComputePassOp {
  static constexpr Opcode kOpcode = Opcode::BeginComputePass;
  static constexpr const char* kName = "beginComputePass";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "computePass";
  Handle handle{};
  Handle encoder{};
  Handle querySet{};
  uint32_t beginIndex{};
  uint32_t endIndex{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("encoder", encoder); f("querySet", querySet); f("beginIndex", beginIndex); f("endIndex", endIndex); f("label", label); }
};

// opcode 17
struct ComputeSetPipelineOp {
  static constexpr Opcode kOpcode = Opcode::ComputeSetPipeline;
  static constexpr const char* kName = "computeSetPipeline";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  Handle pipeline{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("pipeline", pipeline); }
};

// opcode 18
struct ComputeSetBindGroupOp {
  static constexpr Opcode kOpcode = Opcode::ComputeSetBindGroup;
  static constexpr const char* kName = "computeSetBindGroup";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t index{};
  Handle bindGroup{};
  U32Array dynamicOffsets{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("index", index); f("bindGroup", bindGroup); f("dynamicOffsets", dynamicOffsets); }
};

// opcode 19
struct ComputeDispatchOp {
  static constexpr Opcode kOpcode = Opcode::ComputeDispatch;
  static constexpr const char* kName = "computeDispatch";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t x{};
  uint32_t y{};
  uint32_t z{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("x", x); f("y", y); f("z", z); }
};

// opcode 20
struct ComputeDispatchIndirectOp {
  static constexpr Opcode kOpcode = Opcode::ComputeDispatchIndirect;
  static constexpr const char* kName = "computeDispatchIndirect";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  Handle buffer{};
  double offset{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("buffer", buffer); f("offset", offset); }
};

// opcode 21
struct EndComputePassOp {
  static constexpr Opcode kOpcode = Opcode::EndComputePass;
  static constexpr const char* kName = "endComputePass";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); }
};

// opcode 22, result renderPass
struct BeginRenderPassOp {
  static constexpr Opcode kOpcode = Opcode::BeginRenderPass;
  static constexpr const char* kName = "beginRenderPass";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "renderPass";
  Handle handle{};
  Handle encoder{};
  Handle colorView{};
  Handle resolveView{};
  uint32_t colorLoad{};
  uint32_t colorStore{};
  float clearR{};
  float clearG{};
  float clearB{};
  float clearA{};
  Handle depthView{};
  uint32_t depthLoad{};
  uint32_t depthStore{};
  float clearDepth{};
  Handle querySet{};
  uint32_t beginIndex{};
  uint32_t endIndex{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("encoder", encoder); f("colorView", colorView); f("resolveView", resolveView); f("colorLoad", colorLoad); f("colorStore", colorStore); f("clearR", clearR); f("clearG", clearG); f("clearB", clearB); f("clearA", clearA); f("depthView", depthView); f("depthLoad", depthLoad); f("depthStore", depthStore); f("clearDepth", clearDepth); f("querySet", querySet); f("beginIndex", beginIndex); f("endIndex", endIndex); f("label", label); }
};

// opcode 23
struct RenderSetViewportOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetViewport;
  static constexpr const char* kName = "renderSetViewport";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  float x{};
  float y{};
  float width{};
  float height{};
  float minDepth{};
  float maxDepth{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("x", x); f("y", y); f("width", width); f("height", height); f("minDepth", minDepth); f("maxDepth", maxDepth); }
};

// opcode 24
struct RenderSetScissorOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetScissor;
  static constexpr const char* kName = "renderSetScissor";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t x{};
  uint32_t y{};
  uint32_t width{};
  uint32_t height{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("x", x); f("y", y); f("width", width); f("height", height); }
};

// opcode 25
struct RenderSetPipelineOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetPipeline;
  static constexpr const char* kName = "renderSetPipeline";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  Handle pipeline{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("pipeline", pipeline); }
};

// opcode 26
struct RenderSetBindGroupOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetBindGroup;
  static constexpr const char* kName = "renderSetBindGroup";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t index{};
  Handle bindGroup{};
  U32Array dynamicOffsets{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("index", index); f("bindGroup", bindGroup); f("dynamicOffsets", dynamicOffsets); }
};

// opcode 27
struct RenderSetVertexBufferOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetVertexBuffer;
  static constexpr const char* kName = "renderSetVertexBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t slot{};
  Handle buffer{};
  double offset{};
  double size{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("slot", slot); f("buffer", buffer); f("offset", offset); f("size", size); }
};

// opcode 28
struct RenderSetIndexBufferOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetIndexBuffer;
  static constexpr const char* kName = "renderSetIndexBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  Handle buffer{};
  uint32_t format{};
  double offset{};
  double size{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("buffer", buffer); f("format", format); f("offset", offset); f("size", size); }
};

// opcode 29
struct RenderDrawOp {
  static constexpr Opcode kOpcode = Opcode::RenderDraw;
  static constexpr const char* kName = "renderDraw";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t vertexCount{};
  uint32_t instanceCount{};
  uint32_t firstVertex{};
  uint32_t firstInstance{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("vertexCount", vertexCount); f("instanceCount", instanceCount); f("firstVertex", firstVertex); f("firstInstance", firstInstance); }
};

// opcode 30
struct RenderDrawIndexedOp {
  static constexpr Opcode kOpcode = Opcode::RenderDrawIndexed;
  static constexpr const char* kName = "renderDrawIndexed";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t indexCount{};
  uint32_t instanceCount{};
  uint32_t firstIndex{};
  int32_t baseVertex{};
  uint32_t firstInstance{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("indexCount", indexCount); f("instanceCount", instanceCount); f("firstIndex", firstIndex); f("baseVertex", baseVertex); f("firstInstance", firstInstance); }
};

// opcode 31
struct RenderDrawIndirectOp {
  static constexpr Opcode kOpcode = Opcode::RenderDrawIndirect;
  static constexpr const char* kName = "renderDrawIndirect";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  Handle buffer{};
  double offset{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("buffer", buffer); f("offset", offset); }
};

// opcode 32
struct RenderDrawIndexedIndirectOp {
  static constexpr Opcode kOpcode = Opcode::RenderDrawIndexedIndirect;
  static constexpr const char* kName = "renderDrawIndexedIndirect";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  Handle buffer{};
  double offset{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("buffer", buffer); f("offset", offset); }
};

// opcode 33
struct EndRenderPassOp {
  static constexpr Opcode kOpcode = Opcode::EndRenderPass;
  static constexpr const char* kName = "endRenderPass";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); }
};

// opcode 34
struct CopyBufferToBufferOp {
  static constexpr Opcode kOpcode = Opcode::CopyBufferToBuffer;
  static constexpr const char* kName = "copyBufferToBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle encoder{};
  Handle source{};
  double sourceOffset{};
  Handle destination{};
  double destinationOffset{};
  double size{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("encoder", encoder); f("source", source); f("sourceOffset", sourceOffset); f("destination", destination); f("destinationOffset", destinationOffset); f("size", size); }
};

// opcode 35
struct CopyBufferToTextureOp {
  static constexpr Opcode kOpcode = Opcode::CopyBufferToTexture;
  static constexpr const char* kName = "copyBufferToTexture";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle encoder{};
  Handle source{};
  double sourceOffset{};
  uint32_t bytesPerRow{};
  uint32_t rowsPerImage{};
  Handle destination{};
  uint32_t mipLevel{};
  uint32_t originX{};
  uint32_t originY{};
  uint32_t originZ{};
  uint32_t aspect{};
  uint32_t width{};
  uint32_t height{};
  uint32_t depth{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("encoder", encoder); f("source", source); f("sourceOffset", sourceOffset); f("bytesPerRow", bytesPerRow); f("rowsPerImage", rowsPerImage); f("destination", destination); f("mipLevel", mipLevel); f("originX", originX); f("originY", originY); f("originZ", originZ); f("aspect", aspect); f("width", width); f("height", height); f("depth", depth); }
};

// opcode 36
struct CopyTextureToTextureOp {
  static constexpr Opcode kOpcode = Opcode::CopyTextureToTexture;
  static constexpr const char* kName = "copyTextureToTexture";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle encoder{};
  Handle source{};
  uint32_t sourceMip{};
  uint32_t sourceX{};
  uint32_t sourceY{};
  uint32_t sourceZ{};
  Handle destination{};
  uint32_t destinationMip{};
  uint32_t destinationX{};
  uint32_t destinationY{};
  uint32_t destinationZ{};
  uint32_t width{};
  uint32_t height{};
  uint32_t depth{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("encoder", encoder); f("source", source); f("sourceMip", sourceMip); f("sourceX", sourceX); f("sourceY", sourceY); f("sourceZ", sourceZ); f("destination", destination); f("destinationMip", destinationMip); f("destinationX", destinationX); f("destinationY", destinationY); f("destinationZ", destinationZ); f("width", width); f("height", height); f("depth", depth); }
};

// opcode 37
struct ResolveQuerySetOp {
  static constexpr Opcode kOpcode = Opcode::ResolveQuerySet;
  static constexpr const char* kName = "resolveQuerySet";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle encoder{};
  Handle querySet{};
  uint32_t first{};
  uint32_t count{};
  Handle destination{};
  double offset{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("encoder", encoder); f("querySet", querySet); f("first", first); f("count", count); f("destination", destination); f("offset", offset); }
};

// opcode 38, result commandBuffer
struct FinishCommandEncoderOp {
  static constexpr Opcode kOpcode = Opcode::FinishCommandEncoder;
  static constexpr const char* kName = "finishCommandEncoder";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "commandBuffer";
  Handle handle{};
  Handle encoder{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("encoder", encoder); f("label", label); }
};

// opcode 39
struct QueueSubmitOp {
  static constexpr Opcode kOpcode = Opcode::QueueSubmit;
  static constexpr const char* kName = "queueSubmit";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  HandleArray commandBuffers{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("commandBuffers", commandBuffers); }
};

// opcode 40
struct WriteBufferOp {
  static constexpr Opcode kOpcode = Opcode::WriteBuffer;
  static constexpr const char* kName = "writeBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle buffer{};
  double bufferOffset{};
  UploadRange data{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("buffer", buffer); f("bufferOffset", bufferOffset); f("data", data); }
};

// opcode 41
struct WriteTextureOp {
  static constexpr Opcode kOpcode = Opcode::WriteTexture;
  static constexpr const char* kName = "writeTexture";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle texture{};
  uint32_t mipLevel{};
  uint32_t originX{};
  uint32_t originY{};
  uint32_t originZ{};
  uint32_t aspect{};
  UploadRange data{};
  uint32_t bytesPerRow{};
  uint32_t rowsPerImage{};
  uint32_t width{};
  uint32_t height{};
  uint32_t depth{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("texture", texture); f("mipLevel", mipLevel); f("originX", originX); f("originY", originY); f("originZ", originZ); f("aspect", aspect); f("data", data); f("bytesPerRow", bytesPerRow); f("rowsPerImage", rowsPerImage); f("width", width); f("height", height); f("depth", depth); }
};

// opcode 42
struct ConfigureCanvasOp {
  static constexpr Opcode kOpcode = Opcode::ConfigureCanvas;
  static constexpr const char* kName = "configureCanvas";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Str format{};
  uint32_t usage{};
  uint32_t alphaMode{};
  uint32_t colorSpace{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("format", format); f("usage", usage); f("alphaMode", alphaMode); f("colorSpace", colorSpace); }
};

// opcode 43, result texture
struct GetCurrentTextureOp {
  static constexpr Opcode kOpcode = Opcode::GetCurrentTexture;
  static constexpr const char* kName = "getCurrentTexture";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "texture";
  Handle handle{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); }
};

// opcode 44, control (runs after a rejection; its result is ignored then)
struct DestroyOp {
  static constexpr Opcode kOpcode = Opcode::Destroy;
  static constexpr const char* kName = "destroy";
  static constexpr bool kControl = true;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle resource{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("resource", resource); }
};

// opcode 45, request completing with MAP_READY
struct MapAsyncOp {
  static constexpr Opcode kOpcode = Opcode::MapAsync;
  static constexpr const char* kName = "mapAsync";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::MapReady;
  static constexpr const char* kResult = nullptr;
  uint32_t requestId{};
  Handle buffer{};
  uint32_t mode{};
  double offset{};
  double size{};
  ReadbackRange destination{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return buffer; }
  template <class F> void visit_fields(F&& f) const { f("requestId", requestId); f("buffer", buffer); f("mode", mode); f("offset", offset); f("size", size); f("destination", destination); }
};

// opcode 46, request completing with WORK_DONE
struct OnSubmittedWorkDoneOp {
  static constexpr Opcode kOpcode = Opcode::OnSubmittedWorkDone;
  static constexpr const char* kName = "onSubmittedWorkDone";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::WorkDone;
  static constexpr const char* kResult = nullptr;
  uint32_t requestId{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("requestId", requestId); }
};

// opcode 47, control (runs after a rejection; its result is ignored then)
struct RequestFrameOp {
  static constexpr Opcode kOpcode = Opcode::RequestFrame;
  static constexpr const char* kName = "requestFrame";
  static constexpr bool kControl = true;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { (void)f; }
};

// opcode 48, control (runs after a rejection; its result is ignored then)
struct ReleaseOp {
  static constexpr Opcode kOpcode = Opcode::Release;
  static constexpr const char* kName = "release";
  static constexpr bool kControl = true;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle resource{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("resource", resource); }
};

// opcode 49
struct UnmapOp {
  static constexpr Opcode kOpcode = Opcode::Unmap;
  static constexpr const char* kName = "unmap";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle buffer{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("buffer", buffer); }
};

// opcode 50
struct WriteMappedBufferOp {
  static constexpr Opcode kOpcode = Opcode::WriteMappedBuffer;
  static constexpr const char* kName = "writeMappedBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle buffer{};
  double bufferOffset{};
  UploadRange data{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("buffer", buffer); f("bufferOffset", bufferOffset); f("data", data); }
};

// opcode 52, request completing with CAPABILITIES
struct RequestDeviceWithOp {
  static constexpr Opcode kOpcode = Opcode::RequestDeviceWith;
  static constexpr const char* kName = "requestDeviceWith";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::Capabilities;
  static constexpr const char* kResult = nullptr;
  uint32_t requestId{};
  uint32_t powerPreference{};
  uint32_t requiredFeatures{};
  uint32_t optionalFeatures{};
  F64Array limits{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("requestId", requestId); f("powerPreference", powerPreference); f("requiredFeatures", requiredFeatures); f("optionalFeatures", optionalFeatures); f("limits", limits); }
};

// opcode 53, control (runs after a rejection; its result is ignored then)
struct CancelRequestOp {
  static constexpr Opcode kOpcode = Opcode::CancelRequest;
  static constexpr const char* kName = "cancelRequest";
  static constexpr bool kControl = true;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  uint32_t request{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("request", request); }
};

// opcode 54
struct DestroyDeviceOp {
  static constexpr Opcode kOpcode = Opcode::DestroyDevice;
  static constexpr const char* kName = "destroyDevice";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { (void)f; }
};

// opcode 55, result renderPipeline
struct CreateRenderPipelineWithOp {
  static constexpr Opcode kOpcode = Opcode::CreateRenderPipelineWith;
  static constexpr const char* kName = "createRenderPipelineWith";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "renderPipeline";
  Handle handle{};
  Handle layout{};
  Handle vertexShader{};
  Str vertexEntry{};
  Handle fragmentShader{};
  Str fragmentEntry{};
  F64Array targets{};
  F64Array primitive{};
  F64Array depthStencil{};
  F64Array multisample{};
  F64Array vertexLayouts{};
  F64Array constants{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("layout", layout); f("vertexShader", vertexShader); f("vertexEntry", vertexEntry); f("fragmentShader", fragmentShader); f("fragmentEntry", fragmentEntry); f("targets", targets); f("primitive", primitive); f("depthStencil", depthStencil); f("multisample", multisample); f("vertexLayouts", vertexLayouts); f("constants", constants); f("label", label); }
};

// opcode 56, result renderPipeline, request completing with PIPELINE_READY
struct CreateRenderPipelineAsyncWithOp {
  static constexpr Opcode kOpcode = Opcode::CreateRenderPipelineAsyncWith;
  static constexpr const char* kName = "createRenderPipelineAsyncWith";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::PipelineReady;
  static constexpr const char* kResult = "renderPipeline";
  Handle handle{};
  uint32_t requestId{};
  Handle layout{};
  Handle vertexShader{};
  Str vertexEntry{};
  Handle fragmentShader{};
  Str fragmentEntry{};
  F64Array targets{};
  F64Array primitive{};
  F64Array depthStencil{};
  F64Array multisample{};
  F64Array vertexLayouts{};
  F64Array constants{};
  Str label{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return handle; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("requestId", requestId); f("layout", layout); f("vertexShader", vertexShader); f("vertexEntry", vertexEntry); f("fragmentShader", fragmentShader); f("fragmentEntry", fragmentEntry); f("targets", targets); f("primitive", primitive); f("depthStencil", depthStencil); f("multisample", multisample); f("vertexLayouts", vertexLayouts); f("constants", constants); f("label", label); }
};

// opcode 57, result computePipeline
struct CreateComputePipelineWithOp {
  static constexpr Opcode kOpcode = Opcode::CreateComputePipelineWith;
  static constexpr const char* kName = "createComputePipelineWith";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "computePipeline";
  Handle handle{};
  Handle layout{};
  Handle shader{};
  Str entry{};
  F64Array constants{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("layout", layout); f("shader", shader); f("entry", entry); f("constants", constants); f("label", label); }
};

// opcode 58, result computePipeline, request completing with PIPELINE_READY
struct CreateComputePipelineAsyncWithOp {
  static constexpr Opcode kOpcode = Opcode::CreateComputePipelineAsyncWith;
  static constexpr const char* kName = "createComputePipelineAsyncWith";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = true;
  static constexpr Event kCompletes = Event::PipelineReady;
  static constexpr const char* kResult = "computePipeline";
  Handle handle{};
  uint32_t requestId{};
  Handle layout{};
  Handle shader{};
  Str entry{};
  F64Array constants{};
  Str label{};
  uint32_t request_id() const noexcept { return requestId; }
  Handle request_handle() const noexcept { return handle; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("requestId", requestId); f("layout", layout); f("shader", shader); f("entry", entry); f("constants", constants); f("label", label); }
};

// opcode 59, result renderPass
struct BeginRenderPassWithOp {
  static constexpr Opcode kOpcode = Opcode::BeginRenderPassWith;
  static constexpr const char* kName = "beginRenderPassWith";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = "renderPass";
  Handle handle{};
  Handle encoder{};
  F64Array colors{};
  F64Array depthStencil{};
  Handle occlusionQuerySet{};
  Handle timestampQuerySet{};
  uint32_t beginIndex{};
  uint32_t endIndex{};
  Str label{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("handle", handle); f("encoder", encoder); f("colors", colors); f("depthStencil", depthStencil); f("occlusionQuerySet", occlusionQuerySet); f("timestampQuerySet", timestampQuerySet); f("beginIndex", beginIndex); f("endIndex", endIndex); f("label", label); }
};

// opcode 60
struct RenderSetStencilReferenceOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetStencilReference;
  static constexpr const char* kName = "renderSetStencilReference";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t reference{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("reference", reference); }
};

// opcode 61
struct RenderSetBlendConstantOp {
  static constexpr Opcode kOpcode = Opcode::RenderSetBlendConstant;
  static constexpr const char* kName = "renderSetBlendConstant";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  double r{};
  double g{};
  double b{};
  double a{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("r", r); f("g", g); f("b", b); f("a", a); }
};

// opcode 62
struct RenderBeginOcclusionQueryOp {
  static constexpr Opcode kOpcode = Opcode::RenderBeginOcclusionQuery;
  static constexpr const char* kName = "renderBeginOcclusionQuery";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t index{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); f("index", index); }
};

// opcode 63
struct RenderEndOcclusionQueryOp {
  static constexpr Opcode kOpcode = Opcode::RenderEndOcclusionQuery;
  static constexpr const char* kName = "renderEndOcclusionQuery";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle pass{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("pass", pass); }
};

// opcode 64
struct CopyTextureToBufferOp {
  static constexpr Opcode kOpcode = Opcode::CopyTextureToBuffer;
  static constexpr const char* kName = "copyTextureToBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle encoder{};
  Handle source{};
  uint32_t mipLevel{};
  uint32_t originX{};
  uint32_t originY{};
  uint32_t originZ{};
  uint32_t aspect{};
  Handle destination{};
  double offset{};
  uint32_t bytesPerRow{};
  uint32_t rowsPerImage{};
  uint32_t width{};
  uint32_t height{};
  uint32_t depth{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("encoder", encoder); f("source", source); f("mipLevel", mipLevel); f("originX", originX); f("originY", originY); f("originZ", originZ); f("aspect", aspect); f("destination", destination); f("offset", offset); f("bytesPerRow", bytesPerRow); f("rowsPerImage", rowsPerImage); f("width", width); f("height", height); f("depth", depth); }
};

// opcode 65
struct ClearBufferOp {
  static constexpr Opcode kOpcode = Opcode::ClearBuffer;
  static constexpr const char* kName = "clearBuffer";
  static constexpr bool kControl = false;
  static constexpr bool kRequest = false;
  static constexpr Event kCompletes = Event{};
  static constexpr const char* kResult = nullptr;
  Handle encoder{};
  Handle buffer{};
  double offset{};
  double size{};
  uint32_t request_id() const noexcept { return 0u; }
  Handle request_handle() const noexcept { return Handle{}; }
  template <class F> void visit_fields(F&& f) const { f("encoder", encoder); f("buffer", buffer); f("offset", offset); f("size", size); }
};

struct OperationInfo { Opcode opcode; const char* name; bool control; bool request; Event completes; const char* result; };
inline const OperationInfo* operation_info(uint8_t opcode) noexcept {
  switch (opcode) {
    case 1: { static constexpr OperationInfo info{ RequestDeviceOp::kOpcode, RequestDeviceOp::kName, RequestDeviceOp::kControl, RequestDeviceOp::kRequest, RequestDeviceOp::kCompletes, RequestDeviceOp::kResult }; return &info; }
    case 2: { static constexpr OperationInfo info{ CreateBufferOp::kOpcode, CreateBufferOp::kName, CreateBufferOp::kControl, CreateBufferOp::kRequest, CreateBufferOp::kCompletes, CreateBufferOp::kResult }; return &info; }
    case 3: { static constexpr OperationInfo info{ CreateTextureOp::kOpcode, CreateTextureOp::kName, CreateTextureOp::kControl, CreateTextureOp::kRequest, CreateTextureOp::kCompletes, CreateTextureOp::kResult }; return &info; }
    case 4: { static constexpr OperationInfo info{ CreateTextureViewOp::kOpcode, CreateTextureViewOp::kName, CreateTextureViewOp::kControl, CreateTextureViewOp::kRequest, CreateTextureViewOp::kCompletes, CreateTextureViewOp::kResult }; return &info; }
    case 5: { static constexpr OperationInfo info{ CreateSamplerOp::kOpcode, CreateSamplerOp::kName, CreateSamplerOp::kControl, CreateSamplerOp::kRequest, CreateSamplerOp::kCompletes, CreateSamplerOp::kResult }; return &info; }
    case 6: { static constexpr OperationInfo info{ CreateShaderModuleOp::kOpcode, CreateShaderModuleOp::kName, CreateShaderModuleOp::kControl, CreateShaderModuleOp::kRequest, CreateShaderModuleOp::kCompletes, CreateShaderModuleOp::kResult }; return &info; }
    case 7: { static constexpr OperationInfo info{ CreateBindGroupLayoutOp::kOpcode, CreateBindGroupLayoutOp::kName, CreateBindGroupLayoutOp::kControl, CreateBindGroupLayoutOp::kRequest, CreateBindGroupLayoutOp::kCompletes, CreateBindGroupLayoutOp::kResult }; return &info; }
    case 8: { static constexpr OperationInfo info{ CreateBindGroupOp::kOpcode, CreateBindGroupOp::kName, CreateBindGroupOp::kControl, CreateBindGroupOp::kRequest, CreateBindGroupOp::kCompletes, CreateBindGroupOp::kResult }; return &info; }
    case 9: { static constexpr OperationInfo info{ CreatePipelineLayoutOp::kOpcode, CreatePipelineLayoutOp::kName, CreatePipelineLayoutOp::kControl, CreatePipelineLayoutOp::kRequest, CreatePipelineLayoutOp::kCompletes, CreatePipelineLayoutOp::kResult }; return &info; }
    case 10: { static constexpr OperationInfo info{ CreateComputePipelineOp::kOpcode, CreateComputePipelineOp::kName, CreateComputePipelineOp::kControl, CreateComputePipelineOp::kRequest, CreateComputePipelineOp::kCompletes, CreateComputePipelineOp::kResult }; return &info; }
    case 11: { static constexpr OperationInfo info{ CreateComputePipelineAsyncOp::kOpcode, CreateComputePipelineAsyncOp::kName, CreateComputePipelineAsyncOp::kControl, CreateComputePipelineAsyncOp::kRequest, CreateComputePipelineAsyncOp::kCompletes, CreateComputePipelineAsyncOp::kResult }; return &info; }
    case 12: { static constexpr OperationInfo info{ CreateRenderPipelineOp::kOpcode, CreateRenderPipelineOp::kName, CreateRenderPipelineOp::kControl, CreateRenderPipelineOp::kRequest, CreateRenderPipelineOp::kCompletes, CreateRenderPipelineOp::kResult }; return &info; }
    case 13: { static constexpr OperationInfo info{ CreateRenderPipelineAsyncOp::kOpcode, CreateRenderPipelineAsyncOp::kName, CreateRenderPipelineAsyncOp::kControl, CreateRenderPipelineAsyncOp::kRequest, CreateRenderPipelineAsyncOp::kCompletes, CreateRenderPipelineAsyncOp::kResult }; return &info; }
    case 14: { static constexpr OperationInfo info{ CreateQuerySetOp::kOpcode, CreateQuerySetOp::kName, CreateQuerySetOp::kControl, CreateQuerySetOp::kRequest, CreateQuerySetOp::kCompletes, CreateQuerySetOp::kResult }; return &info; }
    case 15: { static constexpr OperationInfo info{ CreateCommandEncoderOp::kOpcode, CreateCommandEncoderOp::kName, CreateCommandEncoderOp::kControl, CreateCommandEncoderOp::kRequest, CreateCommandEncoderOp::kCompletes, CreateCommandEncoderOp::kResult }; return &info; }
    case 16: { static constexpr OperationInfo info{ BeginComputePassOp::kOpcode, BeginComputePassOp::kName, BeginComputePassOp::kControl, BeginComputePassOp::kRequest, BeginComputePassOp::kCompletes, BeginComputePassOp::kResult }; return &info; }
    case 17: { static constexpr OperationInfo info{ ComputeSetPipelineOp::kOpcode, ComputeSetPipelineOp::kName, ComputeSetPipelineOp::kControl, ComputeSetPipelineOp::kRequest, ComputeSetPipelineOp::kCompletes, ComputeSetPipelineOp::kResult }; return &info; }
    case 18: { static constexpr OperationInfo info{ ComputeSetBindGroupOp::kOpcode, ComputeSetBindGroupOp::kName, ComputeSetBindGroupOp::kControl, ComputeSetBindGroupOp::kRequest, ComputeSetBindGroupOp::kCompletes, ComputeSetBindGroupOp::kResult }; return &info; }
    case 19: { static constexpr OperationInfo info{ ComputeDispatchOp::kOpcode, ComputeDispatchOp::kName, ComputeDispatchOp::kControl, ComputeDispatchOp::kRequest, ComputeDispatchOp::kCompletes, ComputeDispatchOp::kResult }; return &info; }
    case 20: { static constexpr OperationInfo info{ ComputeDispatchIndirectOp::kOpcode, ComputeDispatchIndirectOp::kName, ComputeDispatchIndirectOp::kControl, ComputeDispatchIndirectOp::kRequest, ComputeDispatchIndirectOp::kCompletes, ComputeDispatchIndirectOp::kResult }; return &info; }
    case 21: { static constexpr OperationInfo info{ EndComputePassOp::kOpcode, EndComputePassOp::kName, EndComputePassOp::kControl, EndComputePassOp::kRequest, EndComputePassOp::kCompletes, EndComputePassOp::kResult }; return &info; }
    case 22: { static constexpr OperationInfo info{ BeginRenderPassOp::kOpcode, BeginRenderPassOp::kName, BeginRenderPassOp::kControl, BeginRenderPassOp::kRequest, BeginRenderPassOp::kCompletes, BeginRenderPassOp::kResult }; return &info; }
    case 23: { static constexpr OperationInfo info{ RenderSetViewportOp::kOpcode, RenderSetViewportOp::kName, RenderSetViewportOp::kControl, RenderSetViewportOp::kRequest, RenderSetViewportOp::kCompletes, RenderSetViewportOp::kResult }; return &info; }
    case 24: { static constexpr OperationInfo info{ RenderSetScissorOp::kOpcode, RenderSetScissorOp::kName, RenderSetScissorOp::kControl, RenderSetScissorOp::kRequest, RenderSetScissorOp::kCompletes, RenderSetScissorOp::kResult }; return &info; }
    case 25: { static constexpr OperationInfo info{ RenderSetPipelineOp::kOpcode, RenderSetPipelineOp::kName, RenderSetPipelineOp::kControl, RenderSetPipelineOp::kRequest, RenderSetPipelineOp::kCompletes, RenderSetPipelineOp::kResult }; return &info; }
    case 26: { static constexpr OperationInfo info{ RenderSetBindGroupOp::kOpcode, RenderSetBindGroupOp::kName, RenderSetBindGroupOp::kControl, RenderSetBindGroupOp::kRequest, RenderSetBindGroupOp::kCompletes, RenderSetBindGroupOp::kResult }; return &info; }
    case 27: { static constexpr OperationInfo info{ RenderSetVertexBufferOp::kOpcode, RenderSetVertexBufferOp::kName, RenderSetVertexBufferOp::kControl, RenderSetVertexBufferOp::kRequest, RenderSetVertexBufferOp::kCompletes, RenderSetVertexBufferOp::kResult }; return &info; }
    case 28: { static constexpr OperationInfo info{ RenderSetIndexBufferOp::kOpcode, RenderSetIndexBufferOp::kName, RenderSetIndexBufferOp::kControl, RenderSetIndexBufferOp::kRequest, RenderSetIndexBufferOp::kCompletes, RenderSetIndexBufferOp::kResult }; return &info; }
    case 29: { static constexpr OperationInfo info{ RenderDrawOp::kOpcode, RenderDrawOp::kName, RenderDrawOp::kControl, RenderDrawOp::kRequest, RenderDrawOp::kCompletes, RenderDrawOp::kResult }; return &info; }
    case 30: { static constexpr OperationInfo info{ RenderDrawIndexedOp::kOpcode, RenderDrawIndexedOp::kName, RenderDrawIndexedOp::kControl, RenderDrawIndexedOp::kRequest, RenderDrawIndexedOp::kCompletes, RenderDrawIndexedOp::kResult }; return &info; }
    case 31: { static constexpr OperationInfo info{ RenderDrawIndirectOp::kOpcode, RenderDrawIndirectOp::kName, RenderDrawIndirectOp::kControl, RenderDrawIndirectOp::kRequest, RenderDrawIndirectOp::kCompletes, RenderDrawIndirectOp::kResult }; return &info; }
    case 32: { static constexpr OperationInfo info{ RenderDrawIndexedIndirectOp::kOpcode, RenderDrawIndexedIndirectOp::kName, RenderDrawIndexedIndirectOp::kControl, RenderDrawIndexedIndirectOp::kRequest, RenderDrawIndexedIndirectOp::kCompletes, RenderDrawIndexedIndirectOp::kResult }; return &info; }
    case 33: { static constexpr OperationInfo info{ EndRenderPassOp::kOpcode, EndRenderPassOp::kName, EndRenderPassOp::kControl, EndRenderPassOp::kRequest, EndRenderPassOp::kCompletes, EndRenderPassOp::kResult }; return &info; }
    case 34: { static constexpr OperationInfo info{ CopyBufferToBufferOp::kOpcode, CopyBufferToBufferOp::kName, CopyBufferToBufferOp::kControl, CopyBufferToBufferOp::kRequest, CopyBufferToBufferOp::kCompletes, CopyBufferToBufferOp::kResult }; return &info; }
    case 35: { static constexpr OperationInfo info{ CopyBufferToTextureOp::kOpcode, CopyBufferToTextureOp::kName, CopyBufferToTextureOp::kControl, CopyBufferToTextureOp::kRequest, CopyBufferToTextureOp::kCompletes, CopyBufferToTextureOp::kResult }; return &info; }
    case 36: { static constexpr OperationInfo info{ CopyTextureToTextureOp::kOpcode, CopyTextureToTextureOp::kName, CopyTextureToTextureOp::kControl, CopyTextureToTextureOp::kRequest, CopyTextureToTextureOp::kCompletes, CopyTextureToTextureOp::kResult }; return &info; }
    case 37: { static constexpr OperationInfo info{ ResolveQuerySetOp::kOpcode, ResolveQuerySetOp::kName, ResolveQuerySetOp::kControl, ResolveQuerySetOp::kRequest, ResolveQuerySetOp::kCompletes, ResolveQuerySetOp::kResult }; return &info; }
    case 38: { static constexpr OperationInfo info{ FinishCommandEncoderOp::kOpcode, FinishCommandEncoderOp::kName, FinishCommandEncoderOp::kControl, FinishCommandEncoderOp::kRequest, FinishCommandEncoderOp::kCompletes, FinishCommandEncoderOp::kResult }; return &info; }
    case 39: { static constexpr OperationInfo info{ QueueSubmitOp::kOpcode, QueueSubmitOp::kName, QueueSubmitOp::kControl, QueueSubmitOp::kRequest, QueueSubmitOp::kCompletes, QueueSubmitOp::kResult }; return &info; }
    case 40: { static constexpr OperationInfo info{ WriteBufferOp::kOpcode, WriteBufferOp::kName, WriteBufferOp::kControl, WriteBufferOp::kRequest, WriteBufferOp::kCompletes, WriteBufferOp::kResult }; return &info; }
    case 41: { static constexpr OperationInfo info{ WriteTextureOp::kOpcode, WriteTextureOp::kName, WriteTextureOp::kControl, WriteTextureOp::kRequest, WriteTextureOp::kCompletes, WriteTextureOp::kResult }; return &info; }
    case 42: { static constexpr OperationInfo info{ ConfigureCanvasOp::kOpcode, ConfigureCanvasOp::kName, ConfigureCanvasOp::kControl, ConfigureCanvasOp::kRequest, ConfigureCanvasOp::kCompletes, ConfigureCanvasOp::kResult }; return &info; }
    case 43: { static constexpr OperationInfo info{ GetCurrentTextureOp::kOpcode, GetCurrentTextureOp::kName, GetCurrentTextureOp::kControl, GetCurrentTextureOp::kRequest, GetCurrentTextureOp::kCompletes, GetCurrentTextureOp::kResult }; return &info; }
    case 44: { static constexpr OperationInfo info{ DestroyOp::kOpcode, DestroyOp::kName, DestroyOp::kControl, DestroyOp::kRequest, DestroyOp::kCompletes, DestroyOp::kResult }; return &info; }
    case 45: { static constexpr OperationInfo info{ MapAsyncOp::kOpcode, MapAsyncOp::kName, MapAsyncOp::kControl, MapAsyncOp::kRequest, MapAsyncOp::kCompletes, MapAsyncOp::kResult }; return &info; }
    case 46: { static constexpr OperationInfo info{ OnSubmittedWorkDoneOp::kOpcode, OnSubmittedWorkDoneOp::kName, OnSubmittedWorkDoneOp::kControl, OnSubmittedWorkDoneOp::kRequest, OnSubmittedWorkDoneOp::kCompletes, OnSubmittedWorkDoneOp::kResult }; return &info; }
    case 47: { static constexpr OperationInfo info{ RequestFrameOp::kOpcode, RequestFrameOp::kName, RequestFrameOp::kControl, RequestFrameOp::kRequest, RequestFrameOp::kCompletes, RequestFrameOp::kResult }; return &info; }
    case 48: { static constexpr OperationInfo info{ ReleaseOp::kOpcode, ReleaseOp::kName, ReleaseOp::kControl, ReleaseOp::kRequest, ReleaseOp::kCompletes, ReleaseOp::kResult }; return &info; }
    case 49: { static constexpr OperationInfo info{ UnmapOp::kOpcode, UnmapOp::kName, UnmapOp::kControl, UnmapOp::kRequest, UnmapOp::kCompletes, UnmapOp::kResult }; return &info; }
    case 50: { static constexpr OperationInfo info{ WriteMappedBufferOp::kOpcode, WriteMappedBufferOp::kName, WriteMappedBufferOp::kControl, WriteMappedBufferOp::kRequest, WriteMappedBufferOp::kCompletes, WriteMappedBufferOp::kResult }; return &info; }
    case 52: { static constexpr OperationInfo info{ RequestDeviceWithOp::kOpcode, RequestDeviceWithOp::kName, RequestDeviceWithOp::kControl, RequestDeviceWithOp::kRequest, RequestDeviceWithOp::kCompletes, RequestDeviceWithOp::kResult }; return &info; }
    case 53: { static constexpr OperationInfo info{ CancelRequestOp::kOpcode, CancelRequestOp::kName, CancelRequestOp::kControl, CancelRequestOp::kRequest, CancelRequestOp::kCompletes, CancelRequestOp::kResult }; return &info; }
    case 54: { static constexpr OperationInfo info{ DestroyDeviceOp::kOpcode, DestroyDeviceOp::kName, DestroyDeviceOp::kControl, DestroyDeviceOp::kRequest, DestroyDeviceOp::kCompletes, DestroyDeviceOp::kResult }; return &info; }
    case 55: { static constexpr OperationInfo info{ CreateRenderPipelineWithOp::kOpcode, CreateRenderPipelineWithOp::kName, CreateRenderPipelineWithOp::kControl, CreateRenderPipelineWithOp::kRequest, CreateRenderPipelineWithOp::kCompletes, CreateRenderPipelineWithOp::kResult }; return &info; }
    case 56: { static constexpr OperationInfo info{ CreateRenderPipelineAsyncWithOp::kOpcode, CreateRenderPipelineAsyncWithOp::kName, CreateRenderPipelineAsyncWithOp::kControl, CreateRenderPipelineAsyncWithOp::kRequest, CreateRenderPipelineAsyncWithOp::kCompletes, CreateRenderPipelineAsyncWithOp::kResult }; return &info; }
    case 57: { static constexpr OperationInfo info{ CreateComputePipelineWithOp::kOpcode, CreateComputePipelineWithOp::kName, CreateComputePipelineWithOp::kControl, CreateComputePipelineWithOp::kRequest, CreateComputePipelineWithOp::kCompletes, CreateComputePipelineWithOp::kResult }; return &info; }
    case 58: { static constexpr OperationInfo info{ CreateComputePipelineAsyncWithOp::kOpcode, CreateComputePipelineAsyncWithOp::kName, CreateComputePipelineAsyncWithOp::kControl, CreateComputePipelineAsyncWithOp::kRequest, CreateComputePipelineAsyncWithOp::kCompletes, CreateComputePipelineAsyncWithOp::kResult }; return &info; }
    case 59: { static constexpr OperationInfo info{ BeginRenderPassWithOp::kOpcode, BeginRenderPassWithOp::kName, BeginRenderPassWithOp::kControl, BeginRenderPassWithOp::kRequest, BeginRenderPassWithOp::kCompletes, BeginRenderPassWithOp::kResult }; return &info; }
    case 60: { static constexpr OperationInfo info{ RenderSetStencilReferenceOp::kOpcode, RenderSetStencilReferenceOp::kName, RenderSetStencilReferenceOp::kControl, RenderSetStencilReferenceOp::kRequest, RenderSetStencilReferenceOp::kCompletes, RenderSetStencilReferenceOp::kResult }; return &info; }
    case 61: { static constexpr OperationInfo info{ RenderSetBlendConstantOp::kOpcode, RenderSetBlendConstantOp::kName, RenderSetBlendConstantOp::kControl, RenderSetBlendConstantOp::kRequest, RenderSetBlendConstantOp::kCompletes, RenderSetBlendConstantOp::kResult }; return &info; }
    case 62: { static constexpr OperationInfo info{ RenderBeginOcclusionQueryOp::kOpcode, RenderBeginOcclusionQueryOp::kName, RenderBeginOcclusionQueryOp::kControl, RenderBeginOcclusionQueryOp::kRequest, RenderBeginOcclusionQueryOp::kCompletes, RenderBeginOcclusionQueryOp::kResult }; return &info; }
    case 63: { static constexpr OperationInfo info{ RenderEndOcclusionQueryOp::kOpcode, RenderEndOcclusionQueryOp::kName, RenderEndOcclusionQueryOp::kControl, RenderEndOcclusionQueryOp::kRequest, RenderEndOcclusionQueryOp::kCompletes, RenderEndOcclusionQueryOp::kResult }; return &info; }
    case 64: { static constexpr OperationInfo info{ CopyTextureToBufferOp::kOpcode, CopyTextureToBufferOp::kName, CopyTextureToBufferOp::kControl, CopyTextureToBufferOp::kRequest, CopyTextureToBufferOp::kCompletes, CopyTextureToBufferOp::kResult }; return &info; }
    case 65: { static constexpr OperationInfo info{ ClearBufferOp::kOpcode, ClearBufferOp::kName, ClearBufferOp::kControl, ClearBufferOp::kRequest, ClearBufferOp::kCompletes, ClearBufferOp::kResult }; return &info; }
    default: return nullptr;
  }
}

enum class DecodeError : uint8_t {
  None = 0,
  NotBytes,
  BatchLimit,
  NoHeader,
  ProtocolMismatch,
  Truncated,
  InvalidBoolean,
  ArrayLimit,
  UnknownOpcode,
};

// The same text as the JS host's fatal ERROR events.
inline const char* decode_error_message(DecodeError error) noexcept {
  switch (error) {
    case DecodeError::None: return nullptr;
    case DecodeError::NotBytes: return "GPU batch is not bytes";
    case DecodeError::BatchLimit: return "GPU batch limit exceeded";
    case DecodeError::NoHeader: return "GPU batch has no protocol header";
    case DecodeError::ProtocolMismatch: return "GPU protocol version or identity mismatch";
    case DecodeError::Truncated: return "truncated GPU batch";
    case DecodeError::InvalidBoolean: return "invalid GPU boolean";
    case DecodeError::ArrayLimit: return "GPU array limit exceeded";
    case DecodeError::UnknownOpcode: return "unknown GPU opcode";
  }
  return nullptr;
}

// fatal: the batch stopped (error and message set, request_id 0, handle 0). Otherwise the executor rejected
// the operation at offset (error None, message nullptr; the executor supplies its own message).
struct ErrorReport {
  bool fatal = false;
  DecodeError error = DecodeError::None;
  const char* message = nullptr;
  uint8_t opcode = 0;  // operation being decoded or rejected; 0 for preflight failures
  uint32_t request_id = 0;
  Handle handle{};
  uint32_t offset = 0;  // byte offset of the operation's opcode, or of the failing operand
};

// A request operation that follows a rejection in the same batch: complete it with completion and CANCELLED.
struct SkippedRequest {
  Opcode opcode;
  uint32_t request_id;
  Event completion;
  Handle handle;
};

enum class BatchOutcome : uint8_t { Completed, Rejected, Fatal };
struct BatchResult {
  BatchOutcome outcome = BatchOutcome::Completed;
  DecodeError error = DecodeError::None;  // set when outcome is Fatal
  uint32_t error_offset = 0;
  uint32_t rejected_offset = 0;           // opcode offset of the rejected operation, when one was rejected
  bool rejected = false;
  uint32_t operations = 0;                // operations fully decoded (delivered, skipped or dropped)
  bool ok() const noexcept { return outcome == BatchOutcome::Completed; }  // the JS decoder's return value
};

inline size_t write_protocol_header(uint8_t* out) noexcept {
  out[0] = kProtocolOpcode;
  wire::store_u32(out + 1, kProtocolVersion);
  wire::store_u32(out + 5, kProtocolIdentity);
  return kProtocolHeaderBytes;
}

// Checks everything the JS host checks before the first operation.
inline DecodeError preflight_batch(const void* data, size_t size) noexcept {
  const auto* bytes = static_cast<const uint8_t*>(data);
  if (!bytes && size) return DecodeError::NotBytes;
  if (size > kMaxBatchBytes) return DecodeError::BatchLimit;
  if (size < kProtocolHeaderBytes || bytes[0] != kProtocolOpcode) return DecodeError::NoHeader;
  if (wire::load_u32(bytes + 1) != kProtocolVersion || wire::load_u32(bytes + 5) != kProtocolIdentity) return DecodeError::ProtocolMismatch;
  return DecodeError::None;
}

class Visitor {
 public:
  virtual ~Visitor() = default;
  virtual bool on(const RequestDeviceOp& op) = 0;
  virtual bool on(const CreateBufferOp& op) = 0;
  virtual bool on(const CreateTextureOp& op) = 0;
  virtual bool on(const CreateTextureViewOp& op) = 0;
  virtual bool on(const CreateSamplerOp& op) = 0;
  virtual bool on(const CreateShaderModuleOp& op) = 0;
  virtual bool on(const CreateBindGroupLayoutOp& op) = 0;
  virtual bool on(const CreateBindGroupOp& op) = 0;
  virtual bool on(const CreatePipelineLayoutOp& op) = 0;
  virtual bool on(const CreateComputePipelineOp& op) = 0;
  virtual bool on(const CreateComputePipelineAsyncOp& op) = 0;
  virtual bool on(const CreateRenderPipelineOp& op) = 0;
  virtual bool on(const CreateRenderPipelineAsyncOp& op) = 0;
  virtual bool on(const CreateQuerySetOp& op) = 0;
  virtual bool on(const CreateCommandEncoderOp& op) = 0;
  virtual bool on(const BeginComputePassOp& op) = 0;
  virtual bool on(const ComputeSetPipelineOp& op) = 0;
  virtual bool on(const ComputeSetBindGroupOp& op) = 0;
  virtual bool on(const ComputeDispatchOp& op) = 0;
  virtual bool on(const ComputeDispatchIndirectOp& op) = 0;
  virtual bool on(const EndComputePassOp& op) = 0;
  virtual bool on(const BeginRenderPassOp& op) = 0;
  virtual bool on(const RenderSetViewportOp& op) = 0;
  virtual bool on(const RenderSetScissorOp& op) = 0;
  virtual bool on(const RenderSetPipelineOp& op) = 0;
  virtual bool on(const RenderSetBindGroupOp& op) = 0;
  virtual bool on(const RenderSetVertexBufferOp& op) = 0;
  virtual bool on(const RenderSetIndexBufferOp& op) = 0;
  virtual bool on(const RenderDrawOp& op) = 0;
  virtual bool on(const RenderDrawIndexedOp& op) = 0;
  virtual bool on(const RenderDrawIndirectOp& op) = 0;
  virtual bool on(const RenderDrawIndexedIndirectOp& op) = 0;
  virtual bool on(const EndRenderPassOp& op) = 0;
  virtual bool on(const CopyBufferToBufferOp& op) = 0;
  virtual bool on(const CopyBufferToTextureOp& op) = 0;
  virtual bool on(const CopyTextureToTextureOp& op) = 0;
  virtual bool on(const ResolveQuerySetOp& op) = 0;
  virtual bool on(const FinishCommandEncoderOp& op) = 0;
  virtual bool on(const QueueSubmitOp& op) = 0;
  virtual bool on(const WriteBufferOp& op) = 0;
  virtual bool on(const WriteTextureOp& op) = 0;
  virtual bool on(const ConfigureCanvasOp& op) = 0;
  virtual bool on(const GetCurrentTextureOp& op) = 0;
  virtual bool on(const DestroyOp& op) = 0;
  virtual bool on(const MapAsyncOp& op) = 0;
  virtual bool on(const OnSubmittedWorkDoneOp& op) = 0;
  virtual bool on(const RequestFrameOp& op) = 0;
  virtual bool on(const ReleaseOp& op) = 0;
  virtual bool on(const UnmapOp& op) = 0;
  virtual bool on(const WriteMappedBufferOp& op) = 0;
  virtual bool on(const RequestDeviceWithOp& op) = 0;
  virtual bool on(const CancelRequestOp& op) = 0;
  virtual bool on(const DestroyDeviceOp& op) = 0;
  virtual bool on(const CreateRenderPipelineWithOp& op) = 0;
  virtual bool on(const CreateRenderPipelineAsyncWithOp& op) = 0;
  virtual bool on(const CreateComputePipelineWithOp& op) = 0;
  virtual bool on(const CreateComputePipelineAsyncWithOp& op) = 0;
  virtual bool on(const BeginRenderPassWithOp& op) = 0;
  virtual bool on(const RenderSetStencilReferenceOp& op) = 0;
  virtual bool on(const RenderSetBlendConstantOp& op) = 0;
  virtual bool on(const RenderBeginOcclusionQueryOp& op) = 0;
  virtual bool on(const RenderEndOcclusionQueryOp& op) = 0;
  virtual bool on(const CopyTextureToBufferOp& op) = 0;
  virtual bool on(const ClearBufferOp& op) = 0;
  virtual void on_skipped_request(const SkippedRequest& skipped) = 0;
  virtual void on_error(const ErrorReport& report) = 0;

 protected:
  Visitor() = default;
  Visitor(const Visitor&) = default;
  Visitor& operator=(const Visitor&) = default;
};

template <class Impl> class VisitorAdapter final : public Visitor {
 public:
  explicit VisitorAdapter(Impl& impl) noexcept : impl_(impl) {}
  bool on(const RequestDeviceOp& op) override { return impl_.on(op); }
  bool on(const CreateBufferOp& op) override { return impl_.on(op); }
  bool on(const CreateTextureOp& op) override { return impl_.on(op); }
  bool on(const CreateTextureViewOp& op) override { return impl_.on(op); }
  bool on(const CreateSamplerOp& op) override { return impl_.on(op); }
  bool on(const CreateShaderModuleOp& op) override { return impl_.on(op); }
  bool on(const CreateBindGroupLayoutOp& op) override { return impl_.on(op); }
  bool on(const CreateBindGroupOp& op) override { return impl_.on(op); }
  bool on(const CreatePipelineLayoutOp& op) override { return impl_.on(op); }
  bool on(const CreateComputePipelineOp& op) override { return impl_.on(op); }
  bool on(const CreateComputePipelineAsyncOp& op) override { return impl_.on(op); }
  bool on(const CreateRenderPipelineOp& op) override { return impl_.on(op); }
  bool on(const CreateRenderPipelineAsyncOp& op) override { return impl_.on(op); }
  bool on(const CreateQuerySetOp& op) override { return impl_.on(op); }
  bool on(const CreateCommandEncoderOp& op) override { return impl_.on(op); }
  bool on(const BeginComputePassOp& op) override { return impl_.on(op); }
  bool on(const ComputeSetPipelineOp& op) override { return impl_.on(op); }
  bool on(const ComputeSetBindGroupOp& op) override { return impl_.on(op); }
  bool on(const ComputeDispatchOp& op) override { return impl_.on(op); }
  bool on(const ComputeDispatchIndirectOp& op) override { return impl_.on(op); }
  bool on(const EndComputePassOp& op) override { return impl_.on(op); }
  bool on(const BeginRenderPassOp& op) override { return impl_.on(op); }
  bool on(const RenderSetViewportOp& op) override { return impl_.on(op); }
  bool on(const RenderSetScissorOp& op) override { return impl_.on(op); }
  bool on(const RenderSetPipelineOp& op) override { return impl_.on(op); }
  bool on(const RenderSetBindGroupOp& op) override { return impl_.on(op); }
  bool on(const RenderSetVertexBufferOp& op) override { return impl_.on(op); }
  bool on(const RenderSetIndexBufferOp& op) override { return impl_.on(op); }
  bool on(const RenderDrawOp& op) override { return impl_.on(op); }
  bool on(const RenderDrawIndexedOp& op) override { return impl_.on(op); }
  bool on(const RenderDrawIndirectOp& op) override { return impl_.on(op); }
  bool on(const RenderDrawIndexedIndirectOp& op) override { return impl_.on(op); }
  bool on(const EndRenderPassOp& op) override { return impl_.on(op); }
  bool on(const CopyBufferToBufferOp& op) override { return impl_.on(op); }
  bool on(const CopyBufferToTextureOp& op) override { return impl_.on(op); }
  bool on(const CopyTextureToTextureOp& op) override { return impl_.on(op); }
  bool on(const ResolveQuerySetOp& op) override { return impl_.on(op); }
  bool on(const FinishCommandEncoderOp& op) override { return impl_.on(op); }
  bool on(const QueueSubmitOp& op) override { return impl_.on(op); }
  bool on(const WriteBufferOp& op) override { return impl_.on(op); }
  bool on(const WriteTextureOp& op) override { return impl_.on(op); }
  bool on(const ConfigureCanvasOp& op) override { return impl_.on(op); }
  bool on(const GetCurrentTextureOp& op) override { return impl_.on(op); }
  bool on(const DestroyOp& op) override { return impl_.on(op); }
  bool on(const MapAsyncOp& op) override { return impl_.on(op); }
  bool on(const OnSubmittedWorkDoneOp& op) override { return impl_.on(op); }
  bool on(const RequestFrameOp& op) override { return impl_.on(op); }
  bool on(const ReleaseOp& op) override { return impl_.on(op); }
  bool on(const UnmapOp& op) override { return impl_.on(op); }
  bool on(const WriteMappedBufferOp& op) override { return impl_.on(op); }
  bool on(const RequestDeviceWithOp& op) override { return impl_.on(op); }
  bool on(const CancelRequestOp& op) override { return impl_.on(op); }
  bool on(const DestroyDeviceOp& op) override { return impl_.on(op); }
  bool on(const CreateRenderPipelineWithOp& op) override { return impl_.on(op); }
  bool on(const CreateRenderPipelineAsyncWithOp& op) override { return impl_.on(op); }
  bool on(const CreateComputePipelineWithOp& op) override { return impl_.on(op); }
  bool on(const CreateComputePipelineAsyncWithOp& op) override { return impl_.on(op); }
  bool on(const BeginRenderPassWithOp& op) override { return impl_.on(op); }
  bool on(const RenderSetStencilReferenceOp& op) override { return impl_.on(op); }
  bool on(const RenderSetBlendConstantOp& op) override { return impl_.on(op); }
  bool on(const RenderBeginOcclusionQueryOp& op) override { return impl_.on(op); }
  bool on(const RenderEndOcclusionQueryOp& op) override { return impl_.on(op); }
  bool on(const CopyTextureToBufferOp& op) override { return impl_.on(op); }
  bool on(const ClearBufferOp& op) override { return impl_.on(op); }
  void on_skipped_request(const SkippedRequest& skipped) override { impl_.on_skipped_request(skipped); }
  void on_error(const ErrorReport& report) override { impl_.on_error(report); }

 private:
  Impl& impl_;
};

namespace detail {
class Reader {
 public:
  Reader(const uint8_t* bytes, size_t size, size_t offset) noexcept : bytes_(bytes), size_(size), offset_(offset) {}
  bool failed() const noexcept { return error_ != DecodeError::None; }
  bool at_end() const noexcept { return offset_ >= size_; }
  size_t offset() const noexcept { return offset_; }
  DecodeError error() const noexcept { return error_; }
  size_t error_offset() const noexcept { return error_offset_; }
  void fail(DecodeError error, size_t at) noexcept { if (!failed()) { error_ = error; error_offset_ = at; } }

  uint8_t u8() noexcept { if (!need(1)) return 0; return bytes_[offset_++]; }
  uint32_t u32() noexcept { if (!need(4)) return 0; const uint32_t value = wire::load_u32(bytes_ + offset_); offset_ += 4; return value; }
  int32_t i32() noexcept { if (!need(4)) return 0; const int32_t value = wire::load_i32(bytes_ + offset_); offset_ += 4; return value; }
  float f32() noexcept { if (!need(4)) return 0.0f; const float value = wire::load_f32(bytes_ + offset_); offset_ += 4; return value; }
  double f64() noexcept { if (!need(8)) return 0.0; const double value = wire::load_f64(bytes_ + offset_); offset_ += 8; return value; }
  Handle handle() noexcept { return static_cast<Handle>(u32()); }
  bool boolean() noexcept {
    const size_t at = offset_;
    const uint8_t value = u8();
    if (value > 1) fail(DecodeError::InvalidBoolean, at);
    return value == 1;
  }
  Str str() noexcept {
    const uint32_t length = u32();
    if (!need(length)) return {};
    Str value{bytes_ + offset_, length};
    offset_ += length;
    return value;
  }
  UploadRange upload() noexcept { UploadRange value; value.offset = u32(); value.length = u32(); return value; }
  ReadbackRange readback() noexcept { ReadbackRange value; value.offset = u32(); value.length = u32(); return value; }
  HandleArray handles() noexcept { return array<Handle>(); }
  U32Array u32s() noexcept { return array<uint32_t>(); }
  F64Array f64s() noexcept { return array<double>(); }

 private:
  bool need(size_t length) noexcept {
    if (failed()) return false;
    if (length > size_ - offset_) { fail(DecodeError::Truncated, offset_); return false; }
    return true;
  }
  template <class T> WireArray<T> array() noexcept {
    const size_t at = offset_;
    const uint32_t count = u32();
    if (failed()) return {};
    if (count > kMaxArrayLength) { fail(DecodeError::ArrayLimit, at); return {}; }
    if (!need(static_cast<size_t>(count) * WireArray<T>::kElementBytes)) return {};
    WireArray<T> value(bytes_ + offset_, count);
    offset_ += static_cast<size_t>(count) * WireArray<T>::kElementBytes;
    return value;
  }

  const uint8_t* bytes_;
  size_t size_;
  size_t offset_;
  DecodeError error_ = DecodeError::None;
  size_t error_offset_ = 0;
};

template <class V> struct Session {
  V& visitor;
  BatchResult& result;
  template <class Op> void step(const Op& op, size_t start) {
    ++result.operations;
    if (!result.rejected) {
      if (!visitor.on(op)) {
        result.rejected = true;
        result.rejected_offset = static_cast<uint32_t>(start);
        ErrorReport report;
        report.opcode = static_cast<uint8_t>(Op::kOpcode);
        report.request_id = op.request_id();
        report.handle = op.request_handle();
        report.offset = static_cast<uint32_t>(start);
        visitor.on_error(report);
      }
    } else if constexpr (Op::kControl) {
      (void)visitor.on(op);
    } else if constexpr (Op::kRequest) {
      visitor.on_skipped_request(SkippedRequest{Op::kOpcode, op.request_id(), Op::kCompletes, op.request_handle()});
    }
  }
};

template <class V> void report_fatal(V& visitor, BatchResult& result, DecodeError error, size_t offset, uint8_t opcode) {
  result.outcome = BatchOutcome::Fatal;
  result.error = error;
  result.error_offset = static_cast<uint32_t>(offset);
  ErrorReport report;
  report.fatal = true;
  report.error = error;
  report.message = decode_error_message(error);
  report.opcode = opcode;
  report.offset = static_cast<uint32_t>(offset);
  visitor.on_error(report);
}
}  // namespace detail

// Decodes one batch and drives the visitor; see the contract at the top of this file.
template <class V> BatchResult decode_batch(const void* data, size_t size, V& visitor) {
  BatchResult result;
  const DecodeError preflight = preflight_batch(data, size);
  if (preflight != DecodeError::None) { detail::report_fatal(visitor, result, preflight, 0, 0); return result; }
  detail::Reader r(static_cast<const uint8_t*>(data), size, kProtocolHeaderBytes);
  detail::Session<V> session{visitor, result};
  while (!r.at_end()) {
    const size_t start = r.offset();
    const uint8_t opcode = r.u8();
    switch (opcode) {
      case 1: { RequestDeviceOp op; op.requestId = r.u32(); op.powerPreference = r.u32(); op.featureBits = r.u32(); op.maxBufferSize = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 2: { CreateBufferOp op; op.handle = r.handle(); op.size = r.f64(); op.usage = r.u32(); op.mappedAtCreation = r.boolean(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 3: { CreateTextureOp op; op.handle = r.handle(); op.width = r.u32(); op.height = r.u32(); op.depth = r.u32(); op.mipLevels = r.u32(); op.samples = r.u32(); op.dimension = r.u32(); op.format = r.str(); op.usage = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 4: { CreateTextureViewOp op; op.handle = r.handle(); op.texture = r.handle(); op.format = r.str(); op.dimension = r.u32(); op.baseMip = r.u32(); op.mipCount = r.u32(); op.baseLayer = r.u32(); op.layerCount = r.u32(); op.aspect = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 5: { CreateSamplerOp op; op.handle = r.handle(); op.addressU = r.u32(); op.addressV = r.u32(); op.addressW = r.u32(); op.magFilter = r.u32(); op.minFilter = r.u32(); op.mipmapFilter = r.u32(); op.lodMin = r.f32(); op.lodMax = r.f32(); op.compare = r.u32(); op.maxAnisotropy = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 6: { CreateShaderModuleOp op; op.handle = r.handle(); op.requestId = r.u32(); op.code = r.str(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 7: { CreateBindGroupLayoutOp op; op.handle = r.handle(); op.entries = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 8: { CreateBindGroupOp op; op.handle = r.handle(); op.layout = r.handle(); op.entries = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 9: { CreatePipelineLayoutOp op; op.handle = r.handle(); op.layouts = r.handles(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 10: { CreateComputePipelineOp op; op.handle = r.handle(); op.layout = r.handle(); op.shader = r.handle(); op.entry = r.str(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 11: { CreateComputePipelineAsyncOp op; op.handle = r.handle(); op.requestId = r.u32(); op.layout = r.handle(); op.shader = r.handle(); op.entry = r.str(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 12: { CreateRenderPipelineOp op; op.handle = r.handle(); op.layout = r.handle(); op.vertexShader = r.handle(); op.vertexEntry = r.str(); op.fragmentShader = r.handle(); op.fragmentEntry = r.str(); op.colorFormat = r.str(); op.depthFormat = r.str(); op.topology = r.u32(); op.frontFace = r.u32(); op.cullMode = r.u32(); op.sampleCount = r.u32(); op.depthWrite = r.boolean(); op.depthCompare = r.u32(); op.blend = r.u32(); op.vertexLayouts = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 13: { CreateRenderPipelineAsyncOp op; op.handle = r.handle(); op.requestId = r.u32(); op.layout = r.handle(); op.vertexShader = r.handle(); op.vertexEntry = r.str(); op.fragmentShader = r.handle(); op.fragmentEntry = r.str(); op.colorFormat = r.str(); op.depthFormat = r.str(); op.topology = r.u32(); op.frontFace = r.u32(); op.cullMode = r.u32(); op.sampleCount = r.u32(); op.depthWrite = r.boolean(); op.depthCompare = r.u32(); op.blend = r.u32(); op.vertexLayouts = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 14: { CreateQuerySetOp op; op.handle = r.handle(); op.type = r.u32(); op.count = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 15: { CreateCommandEncoderOp op; op.handle = r.handle(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 16: { BeginComputePassOp op; op.handle = r.handle(); op.encoder = r.handle(); op.querySet = r.handle(); op.beginIndex = r.u32(); op.endIndex = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 17: { ComputeSetPipelineOp op; op.pass = r.handle(); op.pipeline = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 18: { ComputeSetBindGroupOp op; op.pass = r.handle(); op.index = r.u32(); op.bindGroup = r.handle(); op.dynamicOffsets = r.u32s(); if (!r.failed()) session.step(op, start); break; }
      case 19: { ComputeDispatchOp op; op.pass = r.handle(); op.x = r.u32(); op.y = r.u32(); op.z = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 20: { ComputeDispatchIndirectOp op; op.pass = r.handle(); op.buffer = r.handle(); op.offset = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 21: { EndComputePassOp op; op.pass = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 22: { BeginRenderPassOp op; op.handle = r.handle(); op.encoder = r.handle(); op.colorView = r.handle(); op.resolveView = r.handle(); op.colorLoad = r.u32(); op.colorStore = r.u32(); op.clearR = r.f32(); op.clearG = r.f32(); op.clearB = r.f32(); op.clearA = r.f32(); op.depthView = r.handle(); op.depthLoad = r.u32(); op.depthStore = r.u32(); op.clearDepth = r.f32(); op.querySet = r.handle(); op.beginIndex = r.u32(); op.endIndex = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 23: { RenderSetViewportOp op; op.pass = r.handle(); op.x = r.f32(); op.y = r.f32(); op.width = r.f32(); op.height = r.f32(); op.minDepth = r.f32(); op.maxDepth = r.f32(); if (!r.failed()) session.step(op, start); break; }
      case 24: { RenderSetScissorOp op; op.pass = r.handle(); op.x = r.u32(); op.y = r.u32(); op.width = r.u32(); op.height = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 25: { RenderSetPipelineOp op; op.pass = r.handle(); op.pipeline = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 26: { RenderSetBindGroupOp op; op.pass = r.handle(); op.index = r.u32(); op.bindGroup = r.handle(); op.dynamicOffsets = r.u32s(); if (!r.failed()) session.step(op, start); break; }
      case 27: { RenderSetVertexBufferOp op; op.pass = r.handle(); op.slot = r.u32(); op.buffer = r.handle(); op.offset = r.f64(); op.size = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 28: { RenderSetIndexBufferOp op; op.pass = r.handle(); op.buffer = r.handle(); op.format = r.u32(); op.offset = r.f64(); op.size = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 29: { RenderDrawOp op; op.pass = r.handle(); op.vertexCount = r.u32(); op.instanceCount = r.u32(); op.firstVertex = r.u32(); op.firstInstance = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 30: { RenderDrawIndexedOp op; op.pass = r.handle(); op.indexCount = r.u32(); op.instanceCount = r.u32(); op.firstIndex = r.u32(); op.baseVertex = r.i32(); op.firstInstance = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 31: { RenderDrawIndirectOp op; op.pass = r.handle(); op.buffer = r.handle(); op.offset = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 32: { RenderDrawIndexedIndirectOp op; op.pass = r.handle(); op.buffer = r.handle(); op.offset = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 33: { EndRenderPassOp op; op.pass = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 34: { CopyBufferToBufferOp op; op.encoder = r.handle(); op.source = r.handle(); op.sourceOffset = r.f64(); op.destination = r.handle(); op.destinationOffset = r.f64(); op.size = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 35: { CopyBufferToTextureOp op; op.encoder = r.handle(); op.source = r.handle(); op.sourceOffset = r.f64(); op.bytesPerRow = r.u32(); op.rowsPerImage = r.u32(); op.destination = r.handle(); op.mipLevel = r.u32(); op.originX = r.u32(); op.originY = r.u32(); op.originZ = r.u32(); op.aspect = r.u32(); op.width = r.u32(); op.height = r.u32(); op.depth = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 36: { CopyTextureToTextureOp op; op.encoder = r.handle(); op.source = r.handle(); op.sourceMip = r.u32(); op.sourceX = r.u32(); op.sourceY = r.u32(); op.sourceZ = r.u32(); op.destination = r.handle(); op.destinationMip = r.u32(); op.destinationX = r.u32(); op.destinationY = r.u32(); op.destinationZ = r.u32(); op.width = r.u32(); op.height = r.u32(); op.depth = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 37: { ResolveQuerySetOp op; op.encoder = r.handle(); op.querySet = r.handle(); op.first = r.u32(); op.count = r.u32(); op.destination = r.handle(); op.offset = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 38: { FinishCommandEncoderOp op; op.handle = r.handle(); op.encoder = r.handle(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 39: { QueueSubmitOp op; op.commandBuffers = r.handles(); if (!r.failed()) session.step(op, start); break; }
      case 40: { WriteBufferOp op; op.buffer = r.handle(); op.bufferOffset = r.f64(); op.data = r.upload(); if (!r.failed()) session.step(op, start); break; }
      case 41: { WriteTextureOp op; op.texture = r.handle(); op.mipLevel = r.u32(); op.originX = r.u32(); op.originY = r.u32(); op.originZ = r.u32(); op.aspect = r.u32(); op.data = r.upload(); op.bytesPerRow = r.u32(); op.rowsPerImage = r.u32(); op.width = r.u32(); op.height = r.u32(); op.depth = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 42: { ConfigureCanvasOp op; op.format = r.str(); op.usage = r.u32(); op.alphaMode = r.u32(); op.colorSpace = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 43: { GetCurrentTextureOp op; op.handle = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 44: { DestroyOp op; op.resource = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 45: { MapAsyncOp op; op.requestId = r.u32(); op.buffer = r.handle(); op.mode = r.u32(); op.offset = r.f64(); op.size = r.f64(); op.destination = r.readback(); if (!r.failed()) session.step(op, start); break; }
      case 46: { OnSubmittedWorkDoneOp op; op.requestId = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 47: { RequestFrameOp op; if (!r.failed()) session.step(op, start); break; }
      case 48: { ReleaseOp op; op.resource = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 49: { UnmapOp op; op.buffer = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 50: { WriteMappedBufferOp op; op.buffer = r.handle(); op.bufferOffset = r.f64(); op.data = r.upload(); if (!r.failed()) session.step(op, start); break; }
      case 52: { RequestDeviceWithOp op; op.requestId = r.u32(); op.powerPreference = r.u32(); op.requiredFeatures = r.u32(); op.optionalFeatures = r.u32(); op.limits = r.f64s(); if (!r.failed()) session.step(op, start); break; }
      case 53: { CancelRequestOp op; op.request = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 54: { DestroyDeviceOp op; if (!r.failed()) session.step(op, start); break; }
      case 55: { CreateRenderPipelineWithOp op; op.handle = r.handle(); op.layout = r.handle(); op.vertexShader = r.handle(); op.vertexEntry = r.str(); op.fragmentShader = r.handle(); op.fragmentEntry = r.str(); op.targets = r.f64s(); op.primitive = r.f64s(); op.depthStencil = r.f64s(); op.multisample = r.f64s(); op.vertexLayouts = r.f64s(); op.constants = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 56: { CreateRenderPipelineAsyncWithOp op; op.handle = r.handle(); op.requestId = r.u32(); op.layout = r.handle(); op.vertexShader = r.handle(); op.vertexEntry = r.str(); op.fragmentShader = r.handle(); op.fragmentEntry = r.str(); op.targets = r.f64s(); op.primitive = r.f64s(); op.depthStencil = r.f64s(); op.multisample = r.f64s(); op.vertexLayouts = r.f64s(); op.constants = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 57: { CreateComputePipelineWithOp op; op.handle = r.handle(); op.layout = r.handle(); op.shader = r.handle(); op.entry = r.str(); op.constants = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 58: { CreateComputePipelineAsyncWithOp op; op.handle = r.handle(); op.requestId = r.u32(); op.layout = r.handle(); op.shader = r.handle(); op.entry = r.str(); op.constants = r.f64s(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 59: { BeginRenderPassWithOp op; op.handle = r.handle(); op.encoder = r.handle(); op.colors = r.f64s(); op.depthStencil = r.f64s(); op.occlusionQuerySet = r.handle(); op.timestampQuerySet = r.handle(); op.beginIndex = r.u32(); op.endIndex = r.u32(); op.label = r.str(); if (!r.failed()) session.step(op, start); break; }
      case 60: { RenderSetStencilReferenceOp op; op.pass = r.handle(); op.reference = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 61: { RenderSetBlendConstantOp op; op.pass = r.handle(); op.r = r.f64(); op.g = r.f64(); op.b = r.f64(); op.a = r.f64(); if (!r.failed()) session.step(op, start); break; }
      case 62: { RenderBeginOcclusionQueryOp op; op.pass = r.handle(); op.index = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 63: { RenderEndOcclusionQueryOp op; op.pass = r.handle(); if (!r.failed()) session.step(op, start); break; }
      case 64: { CopyTextureToBufferOp op; op.encoder = r.handle(); op.source = r.handle(); op.mipLevel = r.u32(); op.originX = r.u32(); op.originY = r.u32(); op.originZ = r.u32(); op.aspect = r.u32(); op.destination = r.handle(); op.offset = r.f64(); op.bytesPerRow = r.u32(); op.rowsPerImage = r.u32(); op.width = r.u32(); op.height = r.u32(); op.depth = r.u32(); if (!r.failed()) session.step(op, start); break; }
      case 65: { ClearBufferOp op; op.encoder = r.handle(); op.buffer = r.handle(); op.offset = r.f64(); op.size = r.f64(); if (!r.failed()) session.step(op, start); break; }
      default: r.fail(DecodeError::UnknownOpcode, start); break;
    }
    if (r.failed()) { detail::report_fatal(visitor, result, r.error(), r.error_offset(), opcode); return result; }
  }
  result.outcome = result.rejected ? BatchOutcome::Rejected : BatchOutcome::Completed;
  return result;
}

}  // namespace nativetron::gpu

#endif  // NATIVETRON_GPU_NATIVE_DECODER_GENERATED_H

// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
#pragma once
#include <cstdint>
#include <string>
#include <vector>
namespace nt_engine {
constexpr size_t header_bytes = 16;
constexpr size_t max_payload = 65536;
constexpr size_t max_rate = 60;
inline uint32_t read_u32(const std::vector<uint8_t> &b, size_t offset) {
  return uint32_t(b[offset]) | (uint32_t(b[offset + 1]) << 8) | (uint32_t(b[offset + 2]) << 16) | (uint32_t(b[offset + 3]) << 24);
}
inline bool valid(const std::vector<uint8_t> &b) {
  return b.size() >= header_bytes && b.size() <= header_bytes + max_payload && b[0] == 1 &&
    b[1] >= 1 && b[1] <= 5 &&
    b[2] <= 2 && b[3] <= 2 && b[2] != b[3] && read_u32(b, 12) == b.size() - header_bytes;
}
inline std::vector<uint8_t> command(uint32_t topic) {
  std::vector<uint8_t> bytes(header_bytes);
  bytes[0] = 1; bytes[1] = 1; bytes[2] = 0; bytes[3] = 2;
  for (size_t shift = 0; shift < 4; shift++) bytes[8 + shift] = static_cast<uint8_t>(topic >> (shift * 8));
  return bytes;
}
inline std::string base64(const std::vector<uint8_t> &bytes) {
  const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    uint32_t value = uint32_t(bytes[i]) << 16;
    if (i + 1 < bytes.size()) value |= uint32_t(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size()) value |= bytes[i + 2];
    out += alphabet[value >> 18]; out += alphabet[(value >> 12) & 63];
    out += i + 1 < bytes.size() ? alphabet[(value >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? alphabet[value & 63] : '=';
  }
  return out;
}
inline std::vector<uint8_t> from_base64(const std::string &text) {
  if (text.size() > 87404 || text.size() % 4) return {};
  const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<uint8_t> bytes;
  uint32_t value = 0; int bits = 0;
  for (char c : text) {
    if (c == '=') break;
    size_t digit = alphabet.find(c); if (digit == std::string::npos) return {};
    value = (value << 6) | static_cast<uint32_t>(digit); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push_back(static_cast<uint8_t>(value >> bits)); }
  }
  return valid(bytes) && base64(bytes) == text ? bytes : std::vector<uint8_t>{};
}
inline bool from_engine_to_native(const std::vector<uint8_t> &bytes) { return valid(bytes) && bytes[2] == 2 && bytes[3] == 0; }
inline std::string envelope(const std::string &encoded) { return "{\"ntEngine\":1,\"frame\":\"" + encoded + "\"}"; }
}

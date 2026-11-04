import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(resolve(root, "engine/assets.json"), "utf8"));
const paths = new Set();
if (spec.version !== 1 || !spec.files.length || spec.files.length > 1024) throw new Error("invalid asset manifest");
for (const file of spec.files) {
  if (!/^[A-Za-z0-9_./-]+$/.test(file.path) || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(file.path)) throw new Error(`invalid/duplicate asset path ${file.path}`);
  if (!["text/html", "text/javascript", "application/wasm", "application/json", "text/css", "image/png", "image/svg+xml", "application/octet-stream"].includes(file.mime)) throw new Error(`invalid MIME ${file.mime}`);
  paths.add(file.path);
}
if (!paths.has(spec.entry)) throw new Error("missing asset entry");
const note = "// generated from engine/assets.json by engine/generate-assets.mjs — do not edit\n";
const cpp = note + `#pragma once
#include <stddef.h>
#include <string.h>
typedef struct { const char *path; const char *mime; } NtBundledAsset;
static const char *const NT_ASSET_ENTRY = ${JSON.stringify(spec.entry)};
static const NtBundledAsset NT_ASSETS[] = {
${spec.files.map(file => `  {${JSON.stringify(file.path)}, ${JSON.stringify(file.mime)}}`).join(",\n")}
};
static inline const char *nt_asset_mime(const char *path) {
  for (size_t index = 0; index < sizeof(NT_ASSETS) / sizeof(NT_ASSETS[0]); index++) if (strcmp(path, NT_ASSETS[index].path) == 0) return NT_ASSETS[index].mime;
  return NULL;
}
`;
const swift = note + `enum BundledAssets {
  static let entry = ${JSON.stringify(spec.entry)}
  static let isolationHeaders: [String: String] = [${Object.entries(spec.isolationHeaders).map(([key,value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}]
  static let files: [String: String] = [
${spec.files.map(file => `    ${JSON.stringify(file.path)}: ${JSON.stringify(file.mime)}`).join(",\n")}
  ]
}
`;
const java = note + `package dev.nativetron.app;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
final class BundledAssets {
  static final String ENTRY = ${JSON.stringify(spec.entry)};
  static final Map<String, String> FILES;
  static {
    Map<String, String> files = new HashMap<>();
${spec.files.map(file => `    files.put(${JSON.stringify(file.path)}, ${JSON.stringify(file.mime)});`).join("\n")}
    FILES = Collections.unmodifiableMap(files);
  }
}
`;
let stale = 0;
for (const [path, next] of [["native/assets.generated.h", cpp], ["hosts/ios/Sources/BundledAssets.generated.swift", swift], ["hosts/android/src/dev/nativetron/app/BundledAssets.java", java]]) {
  const target = resolve(root, path);
  let previous = ""; try { previous = readFileSync(target, "utf8"); } catch {}
  if (previous === next) continue;
  stale++;
  if (process.argv.includes("--check")) console.error(`stale: ${path}`);
  else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, next); }
}
if (process.argv.includes("--check") && stale) process.exit(1);
console.log(`assets: ${process.argv.includes("--check") ? "generated files up to date" : `wrote ${stale} files`}`);

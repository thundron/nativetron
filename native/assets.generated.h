// generated from engine/assets.json by engine/generate-assets.mjs — do not edit
#pragma once
#include <stddef.h>
#include <string.h>
typedef struct { const char *path; const char *mime; } NtBundledAsset;
static const char *const NT_ASSET_ENTRY = "engine/page.html";
static const NtBundledAsset NT_ASSETS[] = {
  {"engine/page.html", "text/html"},
  {"engine/host.js", "text/javascript"},
  {"engine/worker.js", "text/javascript"},
  {"engine/reactor.js", "text/javascript"},
  {"engine/.scriptc/ui.mjs", "text/javascript"},
  {"engine/.scriptc/ui.wasm", "application/wasm"},
  {"gpu/.scriptc/demo.mjs", "text/javascript"},
  {"gpu/.scriptc/demo.wasm", "application/wasm"},
  {"gpu/host.js", "text/javascript"},
  {"gpu/gpu-host.generated.js", "text/javascript"},
  {"host/dom-host.js", "text/javascript"},
  {"host/event.generated.mjs", "text/javascript"},
  {"ipc/engine.generated.mjs", "text/javascript"},
  {"ipc/engine-bridge.generated.mjs", "text/javascript"}
};
static inline const char *nt_asset_mime(const char *path) {
  for (size_t index = 0; index < sizeof(NT_ASSETS) / sizeof(NT_ASSETS[0]); index++) if (strcmp(path, NT_ASSETS[index].path) == 0) return NT_ASSETS[index].mime;
  return NULL;
}

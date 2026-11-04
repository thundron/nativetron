import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "control-profile.json"), "utf8"));
const type = (value) => ({ f64: "double", void: "void" })[value] ?? (() => { throw new Error(`unsupported control ABI type ${value}`); })();
const params = (values) => values.flatMap((value, index) => value === "bytes" ? [`const uint8_t *arg${index}`, `size_t arg${index}_length`] : [`${type(value)} arg${index}`]);
const output = `// generated from ipc/control-profile.json by ipc/generate-control.mjs — do not edit
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// scriptc host callbacks receive userdata first. The runtime is single-thread-owned.
typedef void (*nt_control_bytes_callback)(void *userdata, const uint8_t *bytes, size_t length);
typedef void (*nt_control_panic_callback)(void *userdata, const uint8_t *bytes, size_t length, uint64_t address);
void ${spec.abi.init_symbol}(void);
void ${spec.abi.collect_symbol}(void);
void ${spec.abi.sink_register_symbol}(nt_control_panic_callback callback, void *userdata);
int32_t ${spec.abi.callback_register_symbol}(const char *name, void (*callback)(void), void *userdata);
${spec.exports.map(entry => `${type(entry.returns)} ${entry.symbol}(${params(entry.params).join(", ") || "void"});`).join("\n")}
#ifdef __cplusplus
}
#endif
`;
const path = join(here, "control.generated.h");
let previous = ""; try { previous = readFileSync(path, "utf8"); } catch {}
if (previous !== output) {
  if (process.argv.includes("--check")) { console.error(`stale: ${path}`); process.exit(1); }
  writeFileSync(path, output);
}
console.log("control ABI: generated header up to date");

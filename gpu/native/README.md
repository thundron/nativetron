# Experimental native GPU backend

An opt-in protocol-3 executor using pinned wgpu-native/Metal. JS WebGPU remains the default. The native path is not production-ready or established as faster; no Dawn runtime is linked.

## Build and test

Requires macOS arm64, Xcode command-line tools and Node 24+. The patched variant also needs the Rust toolchain; see [compiler instructions](compiler/README.md).

```sh
gpu/native/fetch-deps.sh --variant patched
NTGPU_WGPU_VARIANT=patched gpu/native/build-executor.sh
NTGPU_WGPU_VARIANT=patched node --test gpu/native/probe.test.mjs gpu/native/executor.test.mjs
node --test gpu/native/executor-conformance.test.mjs
```

Set `SCRIPTC` for the compiled conformance reactor. `NTGPU_CACHE_DIR` and `NTGPU_EXECUTOR_BUILD_DIR` select external dependency/build directories. Builds print their output paths. Use matching headers and libraries; do not mix official and patched artifacts.

## Interfaces

- `../ops.json` owns the wire schema; `../generate.mjs` emits `../native-decoder.generated.h`.
- `ntgpu.h` provides device, shader and surface operations. `executor.h` accepts complete protocol batches and emits events/readbacks.
- Submission consumes borrowed command/upload views before returning. Callback JSON/data is borrowed only until the callback returns. Enqueue events; never re-enter a guest export.
- Limits: 16 MiB commands, 512 MiB uploads, 16 MiB readbacks, bounded requests and GPU-completion fences. CPU-consumption acknowledgements do not release GPU frame credits.
- Handle types, generations, cancellation and device epochs follow the existing JS executor. Resource IDs are never native pointers.

## Integration

See the [macOS host](../../hosts/macos/README.md), [native/Wasm reactor harness](reactor/README.md) and [benchmark harness](benchmark/README.md). Other native platforms are not validated.

The pinned C API has incomplete or aborting entry points. The facade avoids known unsafe calls, but unexpected backend failures can still terminate the process. Isolate native execution for reliable restart. macOS DOM-underlay composition currently needs private WebKit behavior; overlay mode does not reproduce arbitrary transparent DOM content. Keep this path explicit and experimental.

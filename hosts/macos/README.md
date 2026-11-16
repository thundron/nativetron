# macOS host

An unsigned WKWebView shell for the allowlisted engine assets and page-facing [host services](../README.md#page-facing-services). Browser WebGPU is the default.

```sh
hosts/macos/build.sh
build/macos/Nativetron.app/Contents/MacOS/Nativetron --host-selftest
```

`NT_MACOS_SKIP_ENGINE=1` reuses an existing staged bundle. `NT_MACOS_WASM_ROOT` stages source JS with existing Wasm artifacts from another root. `NT_MACOS_BUILD_DIR` selects the app output directory.

## Experimental native GPU

Build the [native executor](../../gpu/native/README.md), then pass its archive, matching wgpu-native library and linker frameworks through `NT_GPU_EXECUTOR_LIBS`. Without those libraries the host cannot execute native GPU work.

```sh
NT_GPU_EXECUTOR_LIBS="/path/libntgpu-executor.a /path/libwgpu_native.a -framework Foundation -framework CoreFoundation -lobjc -liconv" hosts/macos/build.sh
build/macos/Nativetron.app/Contents/MacOS/Nativetron --native-gpu
build/macos/Nativetron.app/Contents/MacOS/Nativetron --native-gpu-selftest=wire
build/macos/Nativetron.app/Contents/MacOS/Nativetron --native-gpu-selftest=e2e
hosts/macos/native-gpu-wire-test.sh
hosts/macos/native-gpu-surface-test.sh
```

`--url file:///path/index.html` serves an owned development bundle without exposing the normal host-service broker. The native binary wire is capability-authenticated and generation-scoped. Reload/dispose cancels tasks and stale replies; callbacks enqueue work rather than entering the reactor directly.

`--native-gpu-composition=none` renders headlessly. `overlay` uses public native views but can obscure transparent DOM overlays. `underlay-spi` uses private WebKit behavior and is experimental, not a supported shipping contract. Validate visibility, clipping, DPI, color and input for any embedding; hidden-surface recovery and automatic browser fallback are not production-complete.

`NativeGPUSurface.swift` owns the CAMetalLayer lease until executor teardown. Frame credits retire on GPU completion, not on upload consumption. Display scheduling and throughput scheduling are demand-driven and must remain idle when no work is requested.

# Platform hosts

Offline shells run independently compiled UI and GPU engine wasm **inside the page**. Native code never runs the GPU engine or carries geometry/per-frame GPU commands. All hosts consume the single generated `engine/assets.json` allowlist and packaged `build/engine-assets` bundle, with correct JavaScript/wasm MIME, bounded generated control IPC and external-navigation/resource refusal. Packaging records sizes and SHA-256 hashes. A successful cross-build is not execution evidence.

## iOS

See [build and acceptance instructions](ios/README.md). UIKit/WKWebView serves `app://local` through a streaming scheme handler, with allowlisted regular files, MIME, COOP/COEP/nosniff, traversal/symlink refusals and cancelled-task ownership. The **actual scriptc static control archive** is linked into both simulator and device builds; the Swift adapter copies read-only callbacks, queues delivery outside the callback, and owns collection/disposal on one thread. No outbound library FFI, promises or timers.

```sh
hosts/ios/test.sh                     # both SDK typechecks and real compiled-library harness
hosts/ios/accept.sh sim               # iOS 18.6 simulator: assets, control, lifecycle and teardown
hosts/ios/build.sh device-compile     # unsigned iphoneos compile/link; not installable
```

Physical builds require an authorised own `NT_IOS_TEAM` and explicit `NT_IOS_DEVICE`. Prohibited identities are rejected before any toolchain action. On macOS 27 the selector refuses the crashing iOS 26 simulator; use physical iOS 26 for WebGPU or iOS 18.6 for honest unavailable-GPU fallback evidence. The current simulator passes two page/control cycles, real asset-response probes, background/foreground and release; `navigator.gpu` is absent. COOP/COEP response headers do not make its custom origin cross-origin isolated. **Physical iOS 26 GPU execution remains unverified.**

## Android

See [build and acceptance instructions](android/README.md). Bare SDK/NDK tooling (no Gradle) packages a real scriptc Android control archive behind JNI. The Java/C adapters use bounded copied queues and one library-owner thread, validate full frames, and close/reopen safely. Virtual HTTPS assets are intercepted offline; file/content access, permissions, external navigation and network loads are refused. The APK requests no permissions. Readback data stays in the in-page engine.

```sh
hosts/android/test.sh
hosts/android/build.sh               # production-style signed APK, no test intents/inspection
hosts/android/build.sh --debuggable
NT_ANDROID_SERIAL=<serial> hosts/android/run.sh
```

The runner never chooses a device or starts an emulator implicitly. An explicitly selected emulator also requires `NT_ANDROID_ALLOW_EMULATOR=1`. It tests native command delivery, pause/resume, disposal/reopen and real WebView MIME/headers/offline probes. GPU errors fail; only unavailable WebGPU yields host-only exit 3. The Android 36 arm64 16-KiB-page emulator with WebView 156.0.8078.47 passes host/control/assets/lifecycle but has **no WebGPU adapter**. This is not physical-device GPU evidence. A physical Android device remains unavailable.

## Windows

See [WebView2 build and acceptance instructions](windows/README.md). `WEBVIEW2_SDK=/path/to/sdk hosts/windows/build.sh --check` cross-links an x64 PE using Zig and the SDK as build input only. No WebView2Loader DLL, renderer or GPU runtime is shipped.

The host serves `https://nativetron.localhost/` directly from WebResourceRequested for page/worker requests, rather than virtual-folder mapping. Generated allowlists, link/real-path checks, MIME, optional COOP/COEP, CSP and offline interception are enforced. Native menu commands preserve the generated envelope. Window DPI/minimise, renderer recovery, event-token teardown and bounded self-test exit codes are implemented. Cmd/Ctrl+R changes colour; Cmd/Ctrl+K remains available to the command palette.

Portable policy/runner/PE checks and the cross-build pass on the integration Mac. **Windows runtime execution remains blocked**: no Windows machine/VM/Wine is available. Run `hosts/windows/acceptance.ps1 -Package build` on Windows with WebView2/WebGPU to verify actual worker interception, isolation, menu, DPI, lifecycle and GPU behaviour. WebView2's own browser-level background services are not claimed to be a network sandbox; application page/worker requests are blocked outside the bundle origin.

## Evidence

[Completion ledger](../docs/HOUSE-PLANNER-EXECUTION.md) and `build/acceptance/report.json` distinguish passed implementations/builds, host-only unavailable-GPU tests, and unavailable hardware. GPU on Chrome/macOS 27 is separate evidence from the required macOS 26/physical mobile/Windows matrix. Never substitute a mock, cross-build or another application's proof of concept for runtime acceptance.

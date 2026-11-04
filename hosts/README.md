# Platform hosts

Offline shells use the same packaged in-page UI and GPU engine reactors. They contain no native GPU implementation and no renderer dependency. Platform build scripts consume the single allowlisted `build/engine-assets` bundle.

Host implementation and device verification are tracked per platform; a successful cross-build is not evidence of WebGPU execution.

## iOS

`hosts/ios/build.sh sim` builds with XcodeGen, installs and launches on an available iOS 18.6 simulator. `NT_IOS_SIMULATOR` selects a simulator explicitly. The script refuses iOS 26 simulators on macOS 27 because of their WebContent JIT PAC crash. Device builds require `NT_IOS_TEAM` and `NT_IOS_DEVICE`; the two prohibited GEWISS teams are rejected before any build or signing action.

WKWebView serves `app://local` through WKURLSchemeHandler with JavaScript/wasm MIME types and COOP/COEP headers. The platform message handler validates the generated binary envelope and logs engine reports; console and uncaught JavaScript failures go to the device log. Navigation stays within the bundle origin. A weak message-handler proxy avoids a controller/WebView retain cycle.

Verified: built, installed and launched on the iOS 18.6 simulator under macOS 27.0.1. Device logs show `ENGINE_MODE main (worker WebGPU, OffscreenCanvas or rAF absent)` and `GPU_UNAVAILABLE navigator.gpu unavailable`. No physical iOS 26 device was available; iOS WebGPU rendering is untested.

## Android

`hosts/android/build.sh` uses aapt2, javac, d8, zipalign and apksigner, not Gradle. `--install` installs and launches through adb. The debug signing key is separate from Apple identities and is not a release signing configuration.

The WebView serves bundled assets on `https://appassets.androidplatform.net`, intercepts non-bundle requests with an offline response, disables file/content access and mixed content, and declares no INTERNET permission (indeed no permissions). The generated Java message bridge validates control frames. The native options menu sends the same change-colour command as desktop. Console output goes to logcat; WebView inspection is opt-in via the activity's `debug` intent extra.

Verified: signed APK builds with Android SDK platform 35/build tools 37.0.0; apksigner verification passes and aapt2 reports no requested permissions. No Android device is connected; runtime, worker and WebGPU behaviour are untested here. The house-planner S24 proof of concept is not nativetron acceptance evidence.

## Windows

`WEBVIEW2_SDK=/path/to/extracted/sdk hosts/windows/build.sh` cross-builds with Zig's MinGW toolchain. Tested with Microsoft.Web.WebView2 SDK 1.0.4314.35 and Zig 0.17.0. The SDK is build input only and is not vendored; webview/webview loads the installed WebView2 runtime. A small EventToken header supplies the documented 64-bit WinRT ABI declaration absent from Zig's MinGW headers.

Place `engine-windows.exe` alongside `engine-assets/`, both produced under `build/`. The host maps the asset directory to a virtual HTTPS origin, uses WebView2's MIME handling, rejects external resource requests, and installs a native colour-change menu. `engine-windows.exe --selftest` waits for real readback and native-menu completion, returning failure on timeout. No extra WebView2Loader DLL or GPU runtime is shipped. Optional COOP/COEP header injection is not implemented for the Windows virtual-host mapping.

Verified: cross-link produces an x86-64 PE32+ executable. There is no Windows machine or Wine installation; launch, MIME behaviour, native menu, worker support and GPU acceptance remain untested. A cross-build is not claimed as a running Windows demo.

## Checks

```sh
node --test hosts/verify.mjs ipc/platform-codec.test.mjs
```

Swift and C++ generated codecs are checked against the JS wire format. Java is compiled against android.jar during APK construction; it has not been executed on an Android runtime here. Mobile hosts run both UI and engine as wasm; this work does not demonstrate an additional scriptc-native static-library client.

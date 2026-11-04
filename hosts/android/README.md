# Android host

Offline WebView shell for the packaged in-page UI and GPU engine (both wasm in the page). Native code is limited to the scriptc `nt-control` static library, which encodes native→engine commands and validates engine→native frames at control rate. There is no native GPU path, no Gradle and no runtime dependency beyond the platform.

## Build

```sh
SCRIPTC=/path/to/scriptc/packages/cli/dist/main.js hosts/android/build.sh [--debuggable]
```

Tools: Android SDK platform 35 `android.jar`, newest build-tools (`aapt2`, `d8`, `zipalign`, `apksigner`), newest NDK clang (`ANDROID_NDK_ROOT` overrides), `javac` and `zip`, zig for scriptc's Android library target, Node for the generators. The script:

1. builds the web bundle (`engine/build.sh --web`) and checks the generated engine/control files;
2. runs `SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-linux-android ipc/build-control.sh` and copies `ipc/.scriptc/control.lib.a` (`NT_CONTROL_ARCHIVE` may name an already built Android archive of the same profile); it refuses archives that are not AArch64 ELF or lack a symbol declared in `ipc/control.generated.h`;
3. links `jni/` and the archive into `lib/arm64-v8a/libntcontrol.so` (API 29, `--no-undefined`, `-z now`, 16 KiB segments, only `JNI_OnLoad` exported; natives are bound with `RegisterNatives`);
4. generates `BundleManifest.java` from `build/engine-assets` (exact served file set plus CSP hashes of inline scripts) with `tools/bundle-manifest.mjs`;
5. links the manifest with aapt2, compiles Java with `-Werror`, dexes with d8, adds `classes.dex`, assets and the library with `zip` (aapt2 drops the `.scriptc` dot-directories; `.wasm` and `.so` are stored), aligns with `zipalign -P 16`, signs with the local debug key and verifies;
6. checks that no permission is requested, every bundle file is present, wasm and the library are uncompressed and the debuggable flag matches the request.

`--debuggable` is for the device runner only: it enables WebView inspection (`debug` extra) and the runner intents. Release-style builds ignore all of them.

The scriptc Android target needs the `@scriptc/runtime-android-arm64` runtime pack in the scriptc checkout used by `SCRIPTC`. Library builds resolve that package beside the compiler and do not consult `SCRIPTC_RUNTIME_PACK`. Without the pack, `ipc/build-control.sh` fails with `SC3003 could not read @scriptc/runtime-android-arm64/runtime-pack.json`. Build it with that package's `build:native` script and `ANDROID_NDK_ROOT` set.

## Control library integration

`NativeControl` loads `libntcontrol.so` and owns a dedicated `nt-control` HandlerThread; every library call runs there. `jni/nt_control_host.c` binds that thread as the only owner, registers the panic sink and the `controlSend`/`controlReceive` callbacks (userdata first), runs `nt_control_init`, and refuses calls from other threads (`WRONG_THREAD`) or while another owner holds the library (`BUSY`). Callbacks only copy the borrowed bytes, so they never re-enter. The copy reaches Java after the export returns, then goes to the main thread. Export status and callback delivery must agree, with exactly one delivery on success. If not, the call fails with `PROTOCOL`. A trap delivered to the sink unwinds with `longjmp` to the host frame below the entry, which is scriptc's documented survival pattern. The library is then poisoned and is never called again in the process. `NT_CONTROL_PANIC` carries the diagnostic. `close` runs `nativeClose` on the owner thread before the thread quits. A recreated activity waits for its predecessor's owner thread before reopening, and reopening runs `nt_control_init` again.

- Native menu / runner command → `nt_control_command(topic, payload)` → `controlSend` frame → `window.__nt_engine_receive(base64)` in the page. Frames are queued (up to 32) until the page proves readiness with its first engine→native frame.
- Page `ntEngine.postMessage(envelope)` (JavaBridge thread) → trusted-page check, 60/s rate limit, bounded envelope decode, Java routing pre-check → `nt_control_receive(frame)` → `controlReceive` → logcat `nt-engine`.

If the library cannot load (for example on a non-arm64 ABI), the page still runs, the menu item is disabled and `NT_CONTROL_UNAVAILABLE` is logged. There is no fallback Java encoder.

## Offline origin

`https://appassets.androidplatform.net` is served only from the generated allowlist (`AssetPolicy`). Requests are limited to GET/HEAD and port 443. The raw encoded path must match `[A-Za-z0-9._/-]` and must not contain empty, `.` or `..` segments. MIME types come from a fixed table, and unknown types are refused at build time and at run time. Other origins get 403 and are logged as `REQUEST_BLOCKED`. Main-frame navigation is limited to the entry page. Responses carry `no-store`, COOP/COEP/CORP, `nosniff`, `no-referrer` and a CSP: `default-src 'none'`, `script-src 'self'`, hashes of the inline scripts and `'wasm-unsafe-eval'`, plus `connect-src`/`worker-src 'self'`. Workers load from the same origin through the same interception. Service workers, file/content access, network loads, geolocation, popups, permission prompts and file choosers are refused. The manifest declares no permissions, not even INTERNET, and disallows cleartext and backup.

## Lifecycle

`configChanges` keeps the WebView and GPU state across rotation, resize and theme changes. `onPause`/`onResume` pause and resume the WebView and its timers. `onStop` and `onTrimMemory` run `nt_control_collect` on the owner thread. If the renderer process dies, the WebView is torn down and rebuilt, at most twice; after that the activity finishes. `onDestroy` removes the JS interface, destroys the WebView, drops pending page frames and closes the library. Lifecycle phases are logged as `NT_LIFECYCLE <phase>` and disposal as `NT_ANDROID_DISPOSED`.

## Tests and device runner

```sh
hosts/android/test.sh                         # host only: no device or emulator
NT_ANDROID_SERIAL=<serial> hosts/android/run.sh   # attached arm64 device, --debuggable APK
```

`test.sh` builds the same control profile for the development host and runs `nt_control_host.c` against it under ASan/UBSan. It covers command/receive bytes, routing refusals, size bounds, the closed state, wrong-thread and busy owners, 20,000 command/receive iterations with periodic collect, and reopening on a new owner thread. It also runs `AssetPolicy` on the host JVM, including MIME agreement with the generator, and the bundle-generator tests. A trap that reaches the panic sink cannot be triggered through the current profile, so the `longjmp` path is untested.

`run.sh` never starts an emulator or picks a device implicitly, and it refuses emulators unless `NT_ANDROID_ALLOW_EMULATOR=1`. It installs the APK and collects filtered logcat to `build/android/run/logcat.txt`. It then runs the cold selftest: engine readback, then the native command through the scriptc library, then `GPU_COLOUR_CHANGED`. After that it backgrounds and resumes the app, injects a command after resume (`--ei nt.command 1`), disposes the activity (`--ez nt.finish true`) and relaunches it to reopen the library. Exit status is 0 when everything passes, 3 when the host and control paths pass but WebGPU is unavailable on the device, and 1 on failure.

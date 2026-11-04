# Windows WebView2 host

`engine-windows.exe` runs the packaged in-page UI and GPU engine reactors in WebView2 through the vendored webview/webview backend and its built-in WebView2 loader. There is no native GPU code, no renderer dependency, and no third-party runtime DLL; the installed Evergreen WebView2 runtime is found at run time.

## Build

```sh
WEBVIEW2_SDK=/path/to/extracted/Microsoft.Web.WebView2 hosts/windows/build.sh          # cross-build + policy tests
WEBVIEW2_SDK=/path/to/extracted/Microsoft.Web.WebView2 hosts/windows/build.sh --check  # also node --test hosts/windows/verify.test.mjs
```

This uses Zig's MinGW toolchain (`x86_64-windows-gnu`); it has been tested with Zig 0.17.0 and SDK 1.0.4314.35. SDKs without `ICoreWebView2_22` are rejected. The SDK is only a build input and is not vendored. The script builds the web assets (`engine/build.sh --web`), checks the generated IPC, compiles and runs `policy.test.cc` natively against every file in `build/engine-assets`, cross-links `build/engine-windows.exe`, and checks with `pe.mjs` that the PE32+ x86-64 image imports only Windows system DLLs (never `WebView2Loader.dll`). `include/EventToken.h` provides the 64-bit WinRT `EventRegistrationToken` declaration that Zig's MinGW headers lack.

The package is `engine-windows.exe` sitting next to `engine-assets/` (both in `build/`). The host refuses to start if there is a `WebView2Loader.dll` beside the executable, because webview/webview would load that DLL in place of its built-in loader.

## Behaviour

- **Virtual origin.** `https://nativetron.localhost/` is served only from `WebResourceRequested`. No folder mapping is used, and nothing goes through DNS or the network. The filter covers all resource contexts and all request source kinds (documents, dedicated, shared and service workers).
- **Asset allowlist.** At startup the host enumerates `engine-assets` once. It skips reparse points, limits depth, file count and file size, and keeps only paths whose segments match `[A-Za-z0-9._-]` and have a known MIME type. A request is served only if its path exactly matches an allowlisted key. Encoded separators, NUL or control bytes, dot segments, empty segments, trailing dots, `:` streams and non-ASCII are all answered 400. Unknown paths and unlisted file types get 404, and methods other than GET/HEAD get 405. Files are opened without following reparse points, and their final path is checked again against the canonical bundle root.
- **MIME types and headers.** `html`, `js`/`mjs` (`text/javascript`), `wasm` (`application/wasm`), `json`, `css`, `wgsl`/`txt`, `png` and `svg` are served with `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. COOP `same-origin` and COEP `require-corp` are on by default, as on macOS and iOS; `--no-isolation` turns them off.
- **Offline enforcement.** Any request outside the origin gets a native 403 and is logged as `OFFLINE_BLOCKED`. Navigations and frame navigations outside the origin are cancelled. Popups and downloads are refused. `connect-src` keeps fetch, XHR, WebSocket and EventSource on the bundle origin, because WebSocket handshakes bypass `WebResourceRequested`. SmartScreen reputation checks, host objects, autofill, password save, zoom, pinch, swipe navigation and the default context menus and browser accelerators are disabled; `--debug` re-enables DevTools, context menus and browser accelerators.
- **IPC.** The page reaches the host through the `__nt_ipc` binding. The host accepts exactly `["<generated ntEngine envelope>"]` (at most 90,000 bytes) carrying a valid engine→native frame from `ipc/engine.generated.h`, sent from a document on the local origin, at no more than 60 messages per second. Reports are logged as `REPORT <text>` with control bytes replaced, so page text cannot forge host marker lines. Native→engine commands are generated `COMMAND` frames (requestId 0, topic 1), rate-limited and delivered to `window.__nt_engine_receive`.
- **Native menu.** The Engine menu has *Change clear colour* (Ctrl+R), a separator and *Quit* (Ctrl+Q). The accelerators work through `AcceleratorKeyPressed` while WebView2 has focus. *Change clear colour* is greyed out until the current document reports `ENGINE_MODE`, and greyed out again whenever a navigation starts.
- **Window and DPR lifecycle.** The process is per-monitor DPI aware (webview/webview). The client area is 900×700 logical pixels, with the menu bar taken into account, and is rescaled on `WM_DPICHANGED`. `WINDOWS_DPI` lines log the DPI, the devicePixelRatio and the controller rasterization scale at startup and on every change. Zoom is fixed at 1. The controller is hidden while the window is minimised and shown again on restore. `NotifyParentWindowPositionChanged` follows window moves. If the render process fails, the page is reloaded up to three times; if the browser process fails, the host exits with code 7.
- **Teardown.** Every WebView2 and DevTools event registration is removed, and the original window procedure restored, before the controller is closed and webview/webview destroys the window. No callback can reach a host that is being destroyed.

## Self-test, exit codes and logs

`engine-windows.exe --selftest` waits for a real `GPU_READBACK_OK 4096`. It then presses the enabled native menu item (posting the same `WM_COMMAND` a click produces) and waits for `GPU_COLOUR_CHANGED`. Finally it runs a DevTools `Runtime.evaluate` probe. The probe checks the origin, `crossOriginIsolated`, the wasm/JS MIME types and headers, 404/400 statuses, that an external image was refused natively, that an external fetch was refused, that a WebSocket did not open, and that devicePixelRatio matches the controller rasterization scale. `--selftest=lifecycle` also minimises and restores the window (the controller must be hidden, then visible), reloads, and requires a fresh `ENGINE_MODE` and a second readback. `--timeout-ms=N` (1000–600000, default 15000) bounds the run. `--log` (implied by self-tests) forwards console API calls, uncaught exceptions and browser log entries to stderr as `CONSOLE`, `PAGE_EXCEPTION` and `BROWSER_LOG`.

| code | name | meaning |
|---:|---|---|
| 0 | ok | self-test passed / window closed normally |
| 1 | config | bad arguments, missing or invalid `engine-assets`, planted loader DLL |
| 2 | runtime-missing | no installed WebView2 runtime |
| 3 | init-failed | window, environment, controller, handler, menu or bridge setup failed |
| 4 | timeout | self-test did not finish in time |
| 5 | gpu-unavailable | page reported `GPU_UNAVAILABLE` |
| 6 | engine-failed | `GPU_ERROR` or `GPU_READBACK_FAILED` |
| 7 | webview-failed | navigation failure or WebView2 browser/render process failure |
| 8 | closed | window closed before self-test completion |
| 9 | internal | unexpected exception |
| 10 | policy-failed | probe (isolation, MIME, offline, DPR), menu-state or lifecycle check failed |

The final stdout marker is `ENGINE_WINDOWS_OK`, `ENGINE_WINDOWS_FAILED <reason>`, `ENGINE_WINDOWS_TIMEOUT`, `ENGINE_WINDOWS_UNAVAILABLE` or `ENGINE_WINDOWS_CLOSED`, followed by `exit=<code> (<name>)`.

## Windows runtime acceptance

On a Windows 10/11 x64 machine with the WebView2 runtime and a WebGPU-capable GPU, copy `build/engine-windows.exe`, `build/engine-assets/` and this directory, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File hosts\windows\acceptance.ps1 -Package build
```

The runner first checks the package: no DLLs, no reparse points and no executables in `engine-assets`. It records the OS, the GPUs and the WebView2 runtime version from the EdgeUpdate registry. It then runs `--selftest`, `--selftest=lifecycle` and `--selftest --no-isolation`. A run that does not exit within `-TimeoutSeconds` (default 90) is killed with its process tree. For each run the runner writes stdout and stderr logs, and `summary.json` lists per-run status, exit name, missing evidence, engine mode, DPI lines, the probe, the number of offline blocks, process failures and page exceptions. A run passes only with exit 0 and every evidence line present. Exit codes 2 and 5 are classified as `blocked`, never as passes. The runner exits with 0 when everything passes, 1 on any failure and 2 when only blocked.

## Verification status

Verified on macOS arm64: the cross-build links a PE32+ x86-64 console executable that imports only system DLLs (`ole32`, `shell32`, `shlwapi`, `user32`, `version`, `advapi32`, `kernel32` and UCRT `api-ms-win-crt-*`). `policy.test.cc` passes natively with ASan/UBSan. `verify.test.mjs` passes, including the exit-code parity check between `policy.h` and `acceptance.ps1`, a PowerShell 7 parse check, and runner classification against a scripted stand-in executable.

Not verified: no Windows machine, VM or Wine was available. Launch, WebView2 interception of the virtual origin and its workers, COOP/COEP effectiveness, MIME handling, offline refusal, the native menu and accelerators, DPI and minimise behaviour, DevTools probe availability, worker/OffscreenCanvas mode, and WebGPU acceptance are therefore all unexecuted. A cross-build is not a running Windows demo, and `acceptance.ps1` is the gate that has to produce that evidence.

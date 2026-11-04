# iOS host

UIKit scene app with one WKWebView serving the allowlisted `build/engine-assets` bundle on
`app://local`, linked with the real scriptc static control library generated from
`ipc/control-profile.json`. There is no native GPU code and no network access.

## Build

```sh
hosts/ios/build.sh sim-build        # unsigned iOS Simulator (arm64) build, no simulator touched
hosts/ios/build.sh device-compile   # unsigned iphoneos compile/link check, not installable
NT_IOS_TEAM=<own team> hosts/ios/build.sh device-build   # signed device build, team verified
hosts/ios/accept.sh sim             # runtime acceptance on an iOS 18.6 simulator
NT_IOS_TEAM=<own team> NT_IOS_DEVICE=<udid> hosts/ios/accept.sh device
hosts/ios/test.sh                   # focused checks; no simulator, device or signing
```

`SCRIPTC` selects the compiler entry point. `hosts/ios/build-control.sh <sdk>` runs
`SCRIPTC_TARGET=aarch64-apple-ios-simulator|aarch64-apple-ios ipc/build-control.sh`, checks that the
archive defines every symbol of `ipc/control.generated.h` and that every member carries the
requested Mach-O platform, and stages it as `build/ios-control/<sdk>/libntcontrol.a` with
`archive.json` (target, scriptc version, minimum OS, archive/profile/source SHA-256). Xcode links it
with `-lntcontrol`; Swift sees the generated header through `Sources/NativetronControl-Bridging.h`.
Cross targets need the matching scriptc runtime pack (`@scriptc/runtime-ios-simulator-arm64`,
`@scriptc/runtime-ios-arm64`) built in the scriptc checkout; the script names the missing pack.

## Signing

`signing-policy.sh` runs before any toolchain command in every mode. `NT_IOS_TEAM` or
`DEVELOPMENT_TEAM` containing either GEWISS team (UQBV6LD494, DM6V8H4Q6Q) is refused; signed modes
require a well-formed own `NT_IOS_TEAM`; after a signed build the bundle's `TeamIdentifier` must equal
it. Simulator and compile-check builds pass `CODE_SIGNING_ALLOWED=NO` and an empty team.

## Control library

`ControlLibrary` owns the single per-process runtime instance on the main thread: `nt_control_init`,
`nt_control_sink`, then `nt_control_set_callback` for `controlSend` and `controlReceive` with the
singleton as userdata. Callbacks are userdata-first; they copy the borrowed bytes into a bounded
queue (64 frames) and return. Delivery to the page or host runs on the main queue after the export
returns, so platform work never runs inside or re-enters the library. Returns are mapped exactly:
0 accepted, 1 refused. `nt_control_collect` runs on background entry and memory warnings. A runtime
trap reaches the sink, which logs `NT_IOS_CONTROL_PANIC`; the runtime then aborts by contract.

Page → native: `ntEngine` messages from the main frame of `app://local` only, at most 60 per second
and `EngineProtocol.maxEnvelope` bytes, are decoded by the generated codec and passed to
`nt_control_receive`, which validates engine→native routing. Native → page: the button
"Change clear colour", the iPadOS Engine menu and ⌘K call `nt_control_command(1, …)`; the encoded
frame is evaluated as `window.__nt_engine_receive("<base64>")` (fixed source, base64 alphabet only)
once the page receiver exists, with a 32-frame outbox while the page is loading or backgrounded.

## Web view policy

- `AssetCatalog` enumerates regular files once (no symlinks, allowlisted extensions, 64 MiB cap);
  only exact catalogue paths are served. Percent escapes, backslashes, `.`/`..`/empty segments,
  other hosts/schemes, ports and credentials are 400; non-GET/HEAD is 405; unknown paths 404.
- Responses carry exact MIME types (`application/wasm`, `text/javascript`), `Content-Length`,
  COOP/COEP/CORP, `nosniff`, `no-store` and `no-referrer`. Reads run off the main thread and are
  never delivered to a task WebKit has stopped.
- A content rule list blocks every load except `app://local/`; navigation and new windows outside
  the origin are cancelled; the data store is non-persistent; inspection is Debug-only.
- Console output, uncaught errors and rejections are forwarded (2048 characters, 120 per second).
  Evidence lines are control-character-free and bounded.
- Message handlers are weak proxies. Scene background/foreground pause and resume delivery;
  `dispose()` detaches handlers, scripts, rules and delegates, cancels asset reads and drops queued
  work. WebContent termination reloads up to three times per minute.

## Acceptance

`accept.sh` installs the build, launches with `--nt-acceptance`, captures stdout and the unified
log (`subsystem == "dev.nativetron.gpu"`) into `build/ios-evidence/<UTC>-<mode>/`, and writes
`summary.json` with `summarize-evidence.py`. In-app, cycle 1 waits for engine reports, sends the
native command through the library, probes the asset policy from inside WebKit, disposes the host
and checks it was released; cycle 2 repeats on a fresh web view. On the simulator the runner also
backgrounds (Settings) and foregrounds the app. Exit 0 requires `GPU_COLOUR_CHANGED` in both cycles;
exit 3 means the control/asset/lifecycle path passed but the engine reported no GPU; anything else
is 1. The simulator runner refuses iOS 26 runtimes on macOS 27.

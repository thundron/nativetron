#!/usr/bin/env bash
# Host-side Android checks that need no device or emulator:
#  - nt_control_host.c against the real scriptc nt-control archive built for
#    this development host (ASan/UBSan), covering ownership, copies, routing,
#    bounds, repeated use and reopen on a new owner thread;
#  - the virtual-HTTPS asset policy on the host JVM;
#  - the bundle manifest/CSP generator.
# NT_CONTROL_HOST_ARCHIVE may name an already built host archive of the profile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/hosts/android"
OUT="$ROOT/build/android-test"
cd "$ROOT"
rm -rf "$OUT"; mkdir -p "$OUT/classes"
node ipc/generate-control.mjs --check
if [[ -n "${NT_CONTROL_HOST_ARCHIVE:-}" ]]; then
  cp "$NT_CONTROL_HOST_ARCHIVE" "$OUT/control.host.a"
else
  env -u SCRIPTC_TARGET -u SCRIPTC_CC ipc/build-control.sh
  cp ipc/.scriptc/control.lib.a "$OUT/control.host.a"
fi
clang -std=c11 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined -fno-sanitize-recover=undefined \
  -I ipc -I "$HERE/jni" -o "$OUT/control_host_test" "$HERE/test/control_host_test.c" "$HERE/jni/nt_control_host.c" "$OUT/control.host.a" -lm -lpthread
"$OUT/control_host_test"
javac -Xlint:all -Werror -d "$OUT/classes" "$HERE/src/dev/nativetron/app/AssetPolicy.java" "$HERE/src/dev/nativetron/app/BundledAssets.java" "$HERE/test/AssetPolicyTest.java"
MIME_PAIRS="$(node --input-type=module -e "const m = await import('$HERE/tools/bundle-manifest.mjs'); console.log(Object.entries(m.MIME).map(([k, v]) => k + '=' + v).join(' '))")"
java -cp "$OUT/classes" dev.nativetron.app.AssetPolicyTest $MIME_PAIRS
node --test "$HERE/test/bundle-manifest.test.mjs"
bash -n "$HERE/build.sh" "$HERE/run.sh"
echo "android host tests: ok"

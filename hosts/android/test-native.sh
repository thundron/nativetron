#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t nt-android-services.XXXXXX)"
trap 'rm -rf "$OUT"' EXIT
javac --release 17 -d "$OUT" "$HERE"/src/dev/nativetron/app/{HostArchive,PowerStateModel}.java "$HERE"/test/java/dev/nativetron/app/{HostArchiveTest,PowerStateModelTest}.java
java -cp "$OUT" dev.nativetron.app.HostArchiveTest
java -cp "$OUT" dev.nativetron.app.PowerStateModelTest

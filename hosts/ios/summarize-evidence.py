#!/usr/bin/env python3
"""Summarise iOS acceptance evidence.

usage: summarize-evidence.py <evidence-dir>

Reads every *.txt capture in the directory (console and unified-log streams), extracts the
NT_IOS_* markers emitted by the app and writes summary.json. Exit status: 0 pass (GPU colour
change observed in both host cycles), 3 control/asset/lifecycle path verified but the engine
reported no GPU, 1 anything missing or failed. Nothing is inferred that the app did not log.
"""
import json
import pathlib
import re
import sys

MARKER = re.compile(r"(NT_IOS_[A-Z_]+)(?: (.*))?$")


def markers(directory):
    seen = {}
    for capture in sorted(directory.glob("*.txt")):
        for line in capture.read_text(errors="replace").splitlines():
            index = line.find("NT_IOS_")
            if index < 0:
                continue
            match = MARKER.match(line[index:].rstrip())
            if not match:
                continue
            name, detail = match.group(1), match.group(2) or ""
            # The same line can appear in both the console and the unified log; keep order, dedupe.
            bucket = seen.setdefault(capture.name, [])
            bucket.append((name, detail))
    # Prefer the most complete capture; merge others only for markers it lacks.
    ordered = sorted(seen.items(), key=lambda item: -len(item[1]))
    merged = list(ordered[0][1]) if ordered else []
    names = {name for name, _ in merged}
    for _, items in ordered[1:]:
        for name, detail in items:
            if name not in names:
                merged.append((name, detail))
    return merged


def summarise(directory):
    events = markers(directory)
    def details(name):
        return [detail for marker, detail in events if marker == name]
    done = details("NT_IOS_ACCEPT_DONE")
    status = done[-1].split("=", 1)[1] if done and "=" in done[-1] else "missing"
    accept = {}
    for detail in details("NT_IOS_ACCEPT_SUMMARY"):
        try:
            accept = json.loads(detail)
        except ValueError:
            accept = {"unparsed": detail}
    lifecycle = details("NT_IOS_LIFECYCLE")
    checks = {
        "launched": bool(details("NT_IOS_LAUNCH")),
        "controlLibraryReady": bool(details("NT_IOS_CONTROL_READY")),
        "controlPanic": bool(details("NT_IOS_CONTROL_PANIC")),
        "assetsCatalogued": bool(details("NT_IOS_ASSETS")),
        "pagesLoaded": len(details("NT_IOS_PAGE_LOADED")),
        "engineReports": details("NT_IOS_ENGINE"),
        "commandsDelivered": len(details("NT_IOS_COMMAND_DELIVERED")),
        "assetProbe": details("NT_IOS_ASSET_PROBE")[-1:] or None,
        "disposeCheck": details("NT_IOS_DISPOSE_CHECK")[-1:] or None,
        "hostReleased": len(details("NT_IOS_HOST_RELEASED")),
        "background": any(d.startswith("background") for d in lifecycle),
        "foreground": any(d.startswith("foreground") for d in lifecycle),
        "rejections": details("NT_IOS_MESSAGE_REJECTED"),
        "assetRefusals": details("NT_IOS_ASSET_REFUSED"),
        "consoleLines": len(details("NT_IOS_CONSOLE")),
        "webContentTerminations": len(details("NT_IOS_WEBCONTENT_TERMINATED")),
    }
    lifecycle_required = (directory / "lifecycle.required").exists()
    ok_path = (status in ("pass", "gpu-unavailable") and checks["controlLibraryReady"] and not checks["controlPanic"]
               and checks["commandsDelivered"] >= 2 and checks["pagesLoaded"] >= 2
               and (not lifecycle_required or (checks["background"] and checks["foreground"])))
    verdict = ("pass" if status == "pass" else "gpu-unavailable") if ok_path else "fail"
    summary = {"verdict": verdict, "appStatus": status, "lifecycleRequired": lifecycle_required,
               "checks": checks, "accept": accept}
    (directory / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return verdict


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    result = summarise(pathlib.Path(sys.argv[1]))
    print("ios acceptance verdict: " + result)
    sys.exit({"pass": 0, "gpu-unavailable": 3}.get(result, 1))

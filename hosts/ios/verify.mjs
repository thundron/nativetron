// Policy checks for the iOS host scripts. No simulator, device or signing action is performed:
// every rejection is asserted to happen before any toolchain command runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const read = (path) => readFileSync(join(here, path), "utf8");
const PROHIBITED = ["UQBV6LD494", "DM6V8H4Q6Q"];

// A PATH whose toolchain commands only record that they ran.
function trapPath() {
  const dir = mkdtempSync(join(tmpdir(), "nt-ios-trap-"));
  const log = join(dir, "ran.log");
  for (const tool of ["xcodebuild", "xcodegen", "xcrun", "codesign", "node", "python3", "engine-build"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho ${tool} "$@" >> "${log}"\nexit 97\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  return { dir, log, env: (extra) => ({ PATH: `${dir}:/usr/bin:/bin`, HOME: process.env.HOME, ...extra }) };
}

function run(script, args, env) {
  return spawnSync("bash", [join(here, script), ...args], { env, encoding: "utf8" });
}

test("prohibited teams are refused in every mode before any toolchain command", () => {
  const trap = trapPath();
  try {
    for (const team of PROHIBITED) {
      for (const [script, mode] of [["build.sh", "device"], ["build.sh", "device-build"], ["build.sh", "sim"], ["build.sh", "sim-build"], ["build.sh", "device-compile"], ["accept.sh", "sim"], ["accept.sh", "device"]]) {
        for (const variable of ["NT_IOS_TEAM", "DEVELOPMENT_TEAM"]) {
          const result = run(script, [mode], trap.env({ [variable]: team, NT_IOS_DEVICE: "00008000-000000000000001E" }));
          assert.notEqual(result.status, 0, `${script} ${mode} ${variable}`);
          assert.match(result.stderr, /prohibited/, `${script} ${mode} ${variable}`);
        }
      }
    }
    assert.equal(existsSync(trap.log), false, "no toolchain command ran");
  } finally { rmSync(trap.dir, { recursive: true, force: true }); }
});

test("signed device modes require a well-formed own team", () => {
  const trap = trapPath();
  try {
    for (const [script, mode] of [["build.sh", "device"], ["build.sh", "device-build"], ["accept.sh", "device"]]) {
      assert.match(run(script, [mode], trap.env({})).stderr, /set NT_IOS_TEAM/);
      assert.match(run(script, [mode], trap.env({ NT_IOS_TEAM: "abc" })).stderr, /invalid Apple developer team id/);
      assert.match(run(script, [mode], trap.env({ NT_IOS_TEAM: "ABCDE12345;x" })).stderr, /invalid Apple developer team id/);
    }
    assert.equal(existsSync(trap.log), false, "no toolchain command ran");
  } finally { rmSync(trap.dir, { recursive: true, force: true }); }
});

test("no prohibited team or hard-coded team appears in the host sources", () => {
  for (const file of ["project.yml", "build.sh", "accept.sh", "build-control.sh", "Sources/App.swift"]) {
    const text = read(file);
    for (const team of PROHIBITED) assert.equal(text.includes(team), false, file);
  }
  assert.match(read("project.yml"), /DEVELOPMENT_TEAM: \$\(NT_IOS_TEAM\)/);
  assert.doesNotMatch(read("project.yml"), /DEVELOPMENT_TEAM: [A-Z0-9]{10}/);
});

const simctl = (devices) => {
  const dir = mkdtempSync(join(tmpdir(), "nt-ios-sim-"));
  const file = join(dir, "devices.json");
  writeFileSync(file, JSON.stringify({ devices }));
  return { dir, file };
};
const device = (udid, isAvailable = true) => ({ udid, isAvailable, name: "iPhone 16", state: "Shutdown" });

test("simulator selection prefers iOS 18.6 and refuses iOS 26 on macOS 27", () => {
  const fixture = simctl({
    "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [device("S26")],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [device("S18-OFF", false), device("S18")],
  });
  const select = (extra) => spawnSync("bash", [join(here, "select-simulator.sh")], { env: { ...process.env, NT_IOS_SIMULATOR: "", NT_IOS_SIMCTL_JSON: fixture.file, NT_IOS_MACOS_VERSION: "27.0.1", ...extra }, encoding: "utf8" });
  try {
    assert.equal(select({}).stdout.trim(), "S18");
    const refused = select({ NT_IOS_SIMULATOR: "S26" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /iOS 26 simulator WebContent JIT PAC crash on macOS 27/);
    assert.equal(select({ NT_IOS_SIMULATOR: "S26", NT_IOS_MACOS_VERSION: "15.6" }).stdout.trim(), "S26");
    assert.match(select({ NT_IOS_SIMULATOR: "missing" }).stderr, /not found/);
    const none = simctl({ "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [device("S26")] });
    const result = spawnSync("bash", [join(here, "select-simulator.sh")], { env: { ...process.env, NT_IOS_SIMULATOR: "", NT_IOS_SIMCTL_JSON: none.file, NT_IOS_MACOS_VERSION: "27.0.1" }, encoding: "utf8" });
    assert.match(result.stderr, /iOS 18.6 simulator required/);
    rmSync(none.dir, { recursive: true, force: true });
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

function evidence(lines, lifecycle) {
  const dir = mkdtempSync(join(tmpdir(), "nt-ios-evidence-"));
  writeFileSync(join(dir, "console.txt"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "unified-log.txt"), lines.map((line) => `2026-11-04 22:00:00.000 Df Nativetron[1:2] [dev.nativetron.gpu:host] ${line}`).join("\n") + "\n");
  if (lifecycle) writeFileSync(join(dir, "lifecycle.required"), "");
  return dir;
}
const summarize = (dir) => spawnSync("python3", [join(here, "summarize-evidence.py"), dir], { encoding: "utf8" });
const base = [
  "NT_IOS_LAUNCH iOS 18.6 iPhone simulator acceptance=true", "NT_IOS_CONTROL_READY controlSend=0 controlReceive=0",
  "NT_IOS_ASSETS files=14 entry=engine/page.html", "NT_IOS_PAGE_LOADED app://local/engine/page.html",
  "NT_IOS_ENGINE kind=5 topic=0 ENGINE_MODE main (Worker or OffscreenCanvas unavailable)", "NT_IOS_COMMAND topic=1 status=accepted",
  "NT_IOS_COMMAND_DELIVERED bytes=16", "NT_IOS_DISPOSED", "NT_IOS_HOST_RELEASED", "NT_IOS_DISPOSE_CHECK released=true attempts=1",
  "NT_IOS_PAGE_LOADED app://local/engine/page.html", "NT_IOS_COMMAND_DELIVERED bytes=16",
];

test("evidence summary distinguishes pass, GPU-unavailable and failure", () => {
  const dirs = [];
  try {
    const unavailable = evidence([...base, "NT_IOS_ACCEPT_DONE status=gpu-unavailable", "NT_IOS_LIFECYCLE background outbox=0 collected=true", "NT_IOS_LIFECYCLE foreground outbox=0"], true);
    dirs.push(unavailable);
    assert.equal(summarize(unavailable).status, 3);
    const summary = JSON.parse(readFileSync(join(unavailable, "summary.json"), "utf8"));
    assert.equal(summary.verdict, "gpu-unavailable");
    assert.equal(summary.checks.pagesLoaded, 2, "duplicate captures are not double counted");
    const pass = evidence([...base, "NT_IOS_ACCEPT_DONE status=pass"], false);
    dirs.push(pass);
    assert.equal(summarize(pass).status, 0);
    const noLifecycle = evidence([...base, "NT_IOS_ACCEPT_DONE status=pass"], true);
    dirs.push(noLifecycle);
    assert.equal(summarize(noLifecycle).status, 1, "required lifecycle transitions must be observed");
    const missing = evidence(base, false);
    dirs.push(missing);
    assert.equal(summarize(missing).status, 1, "no DONE marker is a failure");
    const panic = evidence([...base, "NT_IOS_CONTROL_PANIC address=0 x", "NT_IOS_ACCEPT_DONE status=pass"], false);
    dirs.push(panic);
    assert.equal(summarize(panic).status, 1, "a control-library panic fails acceptance");
  } finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
});

test("host integrates the generated control header and never links a substitute", () => {
  const bridge = read("Sources/NativetronControl-Bridging.h");
  assert.match(bridge, /#include "control.generated.h"/);
  assert.doesNotMatch(bridge, /nt_control_\w+\s*\(/, "declarations come only from the generated header");
  const project = read("project.yml");
  assert.match(project, /OTHER_LDFLAGS: -lntcontrol/);
  assert.match(project, /build\/ios-control\/iphonesimulator/);
  assert.match(project, /build\/ios-control\/iphoneos/);
  const control = read("build-control.sh");
  assert.match(control, /ipc\/build-control\.sh/);
  assert.match(control, /aarch64-apple-ios-simulator/);
  assert.match(control, /SCRIPTC_TARGET="\$TARGET"/);
  const swift = read("Sources/ControlLibrary.swift");
  for (const symbol of ["nt_control_init", "nt_control_sink", "nt_control_set_callback", "nt_control_command", "nt_control_receive", "nt_control_collect"]) assert.match(swift, new RegExp(symbol));
  assert.match(read("Sources/App.swift"), /EngineProtocol\.decodeEnvelope/);
  for (const file of ["Sources/App.swift", "Sources/ControlLibrary.swift", "Sources/AssetSchemeHandler.swift", "Sources/Acceptance.swift"]) {
    assert.doesNotMatch(read(file), /https?:\/\/(?!local)/, `${file} references no network origin`);
  }
});

#!/usr/bin/env node
// Serialized acceptance on the integration host. No device is selected or emulator started here.
// Exit 0 all passed, 1 failed, 2 explicit external blockers. See docs/HOUSE-PLANNER-EXECUTION.md.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { cpus, release } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build/acceptance");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--quick", "--measure", "--measure-only"].includes(flag)) throw new Error(`unknown flag ${flag}`);
const quick = flags.has("--quick"), measureOnly = flags.has("--measure-only"), measure = flags.has("--measure") || measureOnly;
if (quick && measure) throw new Error("--measure requires the full gate");
const env = { ...process.env, SCRIPTC: process.env.SCRIPTC ?? resolve(root, "../../scriptc/packages/cli/dist/main.js"), NT_GPU_SKIP_MEASURE: "1" };
const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const snapshot = directory => ({ directory, revision: git(directory, "rev-parse", "HEAD"), status: git(directory, "status", "--porcelain"), refsSha256: hash(git(directory, "for-each-ref", "--format=%(refname) %(objectname)")) });
const readonly = [resolve(dirname(env.SCRIPTC), "../../.."), resolve(root, "../../house-planner")].filter(path => existsSync(join(path, ".git"))).map(snapshot);
mkdirSync(output, { recursive: true });
let report = { version: 2, revision: git(root, "rev-parse", "HEAD"), started: new Date().toISOString(), scope: quick ? "quick" : "full", measured: measure, environment: { node: process.version, icu: process.versions.icu, platform: process.platform, os: release(), cpu: cpus()[0]?.model, scriptc: env.SCRIPTC }, readonly, checks: [], artifacts: [] };
if (measureOnly) {
  const prior = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
  if (prior.scope !== "full" || prior.summary.failed || prior.revision !== report.revision) throw new Error("--measure-only requires a successful full gate at the current source revision");
  if (env.NT_MEASURE_EXCLUSIVE !== "1") throw new Error("stop simulators/emulators/other builds, then set NT_MEASURE_EXCLUSIVE=1 for --measure-only");
  report = { ...prior, measured: true, measurementStarted: new Date().toISOString() };
}
let active;
const save = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
function add(id, status, detail = {}) { const entry = { id, status, ...detail }; const existing = report.checks.findIndex(check => check.id === id); if (existing >= 0) report.checks[existing] = entry; else report.checks.push(entry); console.log(`${status.toUpperCase()} ${id}${detail.reason ? `: ${detail.reason}` : ""}`); save(); return entry; }
const blocked = (id, reason) => add(id, "blocked", { reason });
function artifact(path) { if (existsSync(path)) { const bytes = readFileSync(path); report.artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) }); save(); } }
async function run(id, command, args = [], { timeout = 240000, blockedCodes = {} } = {}) {
  const path = join(output, `${id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.log`);
  const log = openSync(path, "w"), started = Date.now();
  let timedOut = false, launchError, escalation;
  const child = spawn(command, args, { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", log, log] });
  active = child;
  const stop = signal => { try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
  const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); escalation = setTimeout(() => stop("SIGKILL"), 3000); }, timeout);
  const code = await new Promise(done => { child.on("error", error => { launchError = String(error); done(-1); }); child.on("close", code => done(code)); });
  clearTimeout(timer); clearTimeout(escalation); closeSync(log); active = null;
  const status = !timedOut && !launchError && code === 0 ? "passed" : !timedOut && !launchError && blockedCodes[code] ? "blocked" : "failed";
  const text = readFileSync(path, "utf8"), counters = {};
  for (const match of text.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) counters[match[1]] = Number(match[2]);
  const entry = add(id, status, { command: [command, ...args], exitCode: code, durationMs: Date.now() - started, log: path, ...(Object.keys(counters).length ? { nodeTests: counters } : {}), ...(status === "blocked" ? { reason: blockedCodes[code] } : {}), ...(timedOut ? { reason: "timeout" } : {}), ...(launchError ? { reason: launchError } : {}) });
  if (status === "failed") throw new Error(`${id} failed; inspect ${path}`);
  return entry;
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (active?.pid) { try { if (process.platform !== "win32") process.kill(-active.pid, "SIGTERM"); else active.kill(); } catch {} }
  report.interrupted = signal; save(); process.exit(130);
});
const node = (id, args, options) => run(id, process.execPath, args, options);
const shell = (id, args, options) => run(id, "bash", args, options);

try {
  if (!measureOnly) {
  for (const generator of ["abi/generate.mjs", "canvas/generate.mjs", "gpu/generate.mjs", "ipc/generate.mjs", "ipc/generate-engine.mjs", "ipc/generate-control.mjs", "engine/generate-assets.mjs", "i18n/generate.mjs", "commands/generate.mjs", "desktop/generate.mjs", "compat/generate.mjs"])
    await node(`drift-${generator.replaceAll("/", "-")}`, [generator, "--check"]);
  // Explicit discovery: never accidentally execute interactive browser runners or timing scripts.
  const tests = ["abi/event-contract.test.mjs", "host/dom-host.test.mjs", "host/resize.test.mjs", "gpu/verify.mjs", "gpu/request-errors.test.mjs", "gpu/measure.test.mjs", "gpu/encode.test.mjs", "engine/assets.test.mjs", "engine/assets-native.test.mjs", "engine/lane.test.mjs", "engine/lifecycle.test.mjs", "ipc/codec.test.mjs", "ipc/engine.test.mjs", "ipc/control.test.mjs", "ipc/platform-codec.test.mjs", "i18n/i18n.test.mjs", "i18n/compiled.test.mjs", "commands/commands.test.mjs", "hosts/verify.mjs", "hosts/ios/verify.mjs", "hosts/android/test/bundle-manifest.test.mjs", "hosts/android/test/asset-probe.test.mjs", "security/transport.test.mjs", "packaging/package.test.mjs"];
  await node("focused-contracts", ["--test", "--test-reporter=tap", "--test-concurrency=1", ...tests], { timeout: 900000 });
  if (!quick) {
    await node("components-browser", ["framework/components.test.mjs"]);
    await node("commands-browser", ["commands/palette.test.mjs"]);
    await node("virtual-browser", ["framework/virtual.test.mjs"], { timeout: 360000 });
    await shell("web-build", ["web/build-web.sh"]);
    await node("web-wasm-conformance", ["web/verify.mjs"]);
    await shell("gpu-engine-build", ["engine/build.sh"], { timeout: 600000 });
    await node("gpu-conformance-main-worker", ["gpu/conformance-test.mjs"]);
    await node("gpu-demo", ["gpu/browser-test.mjs"]);
    await node("engine-browser", ["engine/browser-test.mjs"]);
    await node("engine-lifecycle-browser", ["engine/lifecycle.browser-test.mjs"]);
    if (process.platform === "darwin") {
      await shell("native-build", ["build.sh"], { timeout: 600000 });
      env.NT_SELFTEST = "click";
      await run("native-click", "./build/main", [], { timeout: 45000 });
      delete env.NT_SELFTEST;
      await node("native-lifecycle-stress", ["stress/lifecycle.test.mjs"], { timeout: 240000 });
      await run("node-addon-build", "npm", ["--prefix", "node", "run", "build"]);
      await node("node-native-react-bindings", ["node/test.mjs"]);
      env.NT_ENGINE_SELFTEST = "1";
      await run("macos27-engine-menu-runtime", "./build/engine-desktop", [], { timeout: 60000 });
      delete env.NT_ENGINE_SELFTEST;
      await shell("ios-host-tests", ["hosts/ios/test.sh"], { timeout: 600000 });
      await shell("ios18-simulator-runtime", ["hosts/ios/accept.sh", "sim"], { timeout: 600000, blockedCodes: { 3: "iOS 18.6 simulator host/control/assets/lifecycle verified; navigator.gpu unavailable, not iOS 26 WebGPU acceptance" } });
      const directories = readdirSync(join(root, "build/ios-evidence")).filter(name => name.endsWith("-sim")).sort();
      const evidence = join(root, "build/ios-evidence", directories.at(-1), "summary.json");
      const summary = JSON.parse(readFileSync(evidence, "utf8")), checks = summary.checks;
      if (!checks.controlLibraryReady || checks.commandsDelivered < 2 || !checks.background || !checks.foreground || checks.hostReleased !== 1 || summary.accept.failures.length) throw new Error(`incomplete iOS host/control evidence: ${evidence}`);
      add("ios18-host-control-lifecycle", "passed", { evidence, control: summary.accept.results.control, gpu: summary.appStatus });
      artifact(evidence);
      env.NT_IOS_SKIP_ENGINE = "1";
      await shell("ios26-unsigned-device-build", ["hosts/ios/build.sh", "device-compile"], { timeout: 600000 });
      delete env.NT_IOS_SKIP_ENGINE;
      await shell("android-host-tests", ["hosts/android/test.sh"], { timeout: 600000 });
      await shell("android-production-build", ["hosts/android/build.sh"], { timeout: 600000 });
      artifact(join(root, "build/android/nativetron.apk"));
      if (env.NT_ANDROID_SERIAL) {
        await shell("android-debug-build", ["hosts/android/build.sh", "--debuggable"], { timeout: 600000 });
        await shell("android-runtime", ["hosts/android/run.sh"], { timeout: 360000, blockedCodes: { 3: "host/control/lifecycle verified on selected Android runtime; WebGPU unavailable" } });
      } else blocked("android-runtime", "NT_ANDROID_SERIAL must explicitly select an attached arm64 device/emulator; no runtime chosen implicitly");
      if (env.WEBVIEW2_SDK) {
        await shell("windows-cross-build", ["hosts/windows/build.sh", "--check"], { timeout: 600000 });
        artifact(join(root, "build/engine-windows.exe"));
      } else blocked("windows-cross-build", "set WEBVIEW2_SDK to the extracted Microsoft WebView2 SDK");
      await node("windows-portable-tests", ["--test", "--test-reporter=tap", "hosts/windows/verify.test.mjs"]);
    } else blocked("platform-host-gates", "this integration gate's native/mobile build section requires macOS and the documented SDKs; use each platform's acceptance runner");
    blocked("macos26-runtime", "no macOS 26 hardware available; current macOS 27 evidence is separate");
    blocked("ios26-physical-device", "no physical iOS 26 device/authorised signing identity; unsigned link and iOS 18.6 fallback are not physical WebGPU evidence");
    blocked("android-physical-device", "emulator acceptance, if supplied, is not physical-device WebGPU evidence; no physical device attached");
    blocked("windows-runtime", "no Windows machine/VM/Wine; execute hosts/windows/acceptance.ps1 on Windows with WebView2/WebGPU");
    await shell("bvh-build", ["bench/engine-bvh/build.sh"], { timeout: 600000 });
    await node("bvh-smoke", ["bench/engine-bvh/run.mjs"], { timeout: 900000 });
    await node("bvh-compiler-inspection", ["bench/engine-bvh/inspect.mjs"]);
  }
  }
  if (measure) {
    const trees = git(root, "worktree", "list", "--porcelain");
    if ((trees.match(/^worktree /gm) ?? []).length !== 1) throw new Error("exclusive measurements require all temporary agent worktrees removed");
    if (env.NT_ANDROID_SERIAL?.startsWith("emulator-")) throw new Error("stop emulator and rerun measurement separately on an idle machine; do not record while it is running");
    // All compilation is finished before either recording. No agents/builds may run concurrently.
    delete env.NT_GPU_SKIP_MEASURE; env.NT_RECORD_GPU = "1";
    await node("record-gpu", ["gpu/browser-test.mjs"]);
    delete env.NT_RECORD_GPU;
    env.NT_BVH_EXCLUSIVE = "1";
    await node("record-bvh", ["bench/engine-bvh/run.mjs", "--final"], { timeout: 1800000 });
    delete env.NT_BVH_EXCLUSIVE;
    artifact(join(root, "gpu/last-run.json")); artifact(join(root, "bench/engine-bvh/last-run.json"));
  }
} catch (error) {
  report.error = error.stack || String(error);
  if (!report.checks.some(check => check.status === "failed")) add("gate", "failed", { reason: String(error) });
} finally {
  for (const before of readonly) {
    const after = snapshot(before.directory);
    add(`readonly-${before.directory.split("/").at(-1)}`, JSON.stringify(before) === JSON.stringify(after) ? "passed" : "failed", { before, after });
  }
  artifact(join(root, "build/engine-assets/asset-manifest.json"));
  report.finished = new Date().toISOString();
  report.summary = Object.fromEntries(["passed", "failed", "blocked"].map(status => [status, report.checks.filter(check => check.status === status).length]));
  save(); console.log(JSON.stringify(report.summary), join(output, "report.json"));
  process.exitCode = report.summary.failed ? 1 : report.summary.blocked ? 2 : 0;
}

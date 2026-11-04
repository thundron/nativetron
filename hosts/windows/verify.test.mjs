// Portable checks for the Windows WebView2 host. None of these execute
// WebView2; Windows runtime evidence comes only from acceptance.ps1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkPe } from "./pe.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");
const read = (name) => readFileSync(join(here, name), "utf8");
const policy = read("policy.h"), main = read("main.cc"), runner = read("acceptance.ps1");
const exe = join(root, "build", "engine-windows.exe");
const assets = join(root, "build", "engine-assets");

const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [relative(assets, path).split("\\").join("/")];
});

const compiler = () => {
  for (const candidate of [process.env.CXX, "c++", "clang++", "g++"].filter(Boolean)) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return [candidate];
  }
  return ["zig", "c++"];
};

test("portable policy tests pass natively, including every packaged asset", () => {
  const dir = mkdtempSync(join(tmpdir(), "nt-windows-policy-"));
  try {
    const binary = join(dir, "policy-test");
    const [cxx, ...prefix] = compiler();
    execFileSync(cxx, [...prefix, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", join(root, "native/vendor/webview/include"), join(here, "policy.test.cc"), "-o", binary], { stdio: "pipe" });
    const keys = existsSync(assets) ? files(assets) : [];
    const output = execFileSync(binary, keys, { encoding: "utf8" });
    assert.match(output, /checks, 0 failures/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit-code table is identical in policy.h and acceptance.ps1", () => {
  const numbers = Object.fromEntries([...policy.matchAll(/^\s+(exit_[a-z_]+) = (\d+),/gm)].map((m) => [m[1], Number(m[2])]));
  const names = Object.fromEntries([...policy.matchAll(/case (exit_[a-z_]+): return "([a-z-]+)";/g)].map((m) => [numbers[m[1]], m[2]]));
  const ps = Object.fromEntries([...runner.matchAll(/^\s+(\d+) = '([a-z-]+)'$/gm)].map((m) => [Number(m[1]), m[2]]));
  assert.equal(Object.keys(numbers).length, 11);
  assert.deepEqual(ps, names);
  assert.match(runner, /\$BlockedCodes = @\(2, 5\)/);
  assert.equal(numbers.exit_runtime_missing, 2);
  assert.equal(numbers.exit_gpu_unavailable, 5);
});

test("runner only passes options the host accepts", () => {
  const accepted = new Set([...policy.matchAll(/arg == "(--[a-z=-]+)"/g)].map((m) => m[1]));
  accepted.add("--timeout-ms");
  const used = [...runner.matchAll(/'(--[a-z=-]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 3);
  for (const option of used) assert.ok(accepted.has(option), option);
  assert.match(runner, /--timeout-ms=\$hostTimeoutMs/);
});

test("host applies the shared policy and generated IPC, without folder mapping", () => {
  assert.match(main, /engine\.generated\.h/);
  for (const name of ["plan_response", "response_headers", "decode_ipc_request", "command_script", "is_local_document", "check_probe", "accelerator", "rate_limiter"]) {
    assert.ok(main.includes(name), name);
  }
  assert.doesNotMatch(main, /SetVirtualHostNameToFolderMapping/);
  assert.doesNotMatch(main, /nt_engine::base64\(nt_engine::command/);  // command frames come from policy::command_script
  assert.match(main, /COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL/);
  assert.match(main, /put_IsReputationCheckingRequired\(FALSE\)/);
});

test("every WebView2 event registration is removed at teardown", () => {
  const added = new Set([...main.matchAll(/->add_([A-Za-z]+)\(/g)].map((m) => m[1]));
  const removed = new Set([...main.matchAll(/->remove_([A-Za-z]+)\(/g)].map((m) => m[1]));
  assert.ok(added.size >= 9);
  assert.deepEqual([...added].sort(), [...removed].sort());
});

test("cross-built executable is x86-64 and imports only Windows system DLLs", (t) => {
  if (!existsSync(exe)) {
    if (process.env.NT_WINDOWS_REQUIRE_EXE === "1") assert.fail(`${exe} missing; run hosts/windows/build.sh`);
    t.skip("build/engine-windows.exe not built");
    return;
  }
  const result = checkPe(readFileSync(exe));
  assert.deepEqual(result.problems, []);
  assert.ok(result.imports.some((dll) => dll.toLowerCase() === "ole32.dll"));
  assert.ok(![...result.imports, ...result.delayed].some((dll) => /webview2loader/i.test(dll)));
  const bytes = readFileSync(exe).toString("latin1");
  assert.ok(bytes.includes("https://nativetron.localhost"));
});

test("PowerShell runner parses when pwsh is available", (t) => {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
  if (probe.status !== 0) { t.skip("pwsh not installed"); return; }
  const script = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${join(here, "acceptance.ps1")}', [ref]$null, [ref]$errors) | Out-Null; if ($errors) { $errors | ForEach-Object { $_.ToString() }; exit 1 }`;
  const parsed = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
});

// Drives acceptance.ps1 against a scripted stand-in executable to check its
// evidence, blocked and failure classification. This tests the runner only.
test("acceptance runner classifies pass, blocked, missing evidence and bad packages", (t) => {
  if (process.platform === "win32" || spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0) { t.skip("needs pwsh on a non-Windows build machine"); return; }
  const dir = mkdtempSync(join(tmpdir(), "nt-windows-runner-"));
  try {
    mkdirSync(join(dir, "engine-assets", "engine"), { recursive: true });
    writeFileSync(join(dir, "engine-assets", "engine", "page.html"), "");
    const fake = join(dir, "engine-windows.exe");
    writeFileSync(fake, `#!/bin/bash
echo "WEBVIEW2_VERSION 140.0.0.0"; echo "WINDOWS_DPI initial dpi=96 dpr=1.000 rasterization=1.000"; echo "REPORT ENGINE_MODE worker"
if [ "$NT_FAKE" = gpu ]; then echo "REPORT GPU_UNAVAILABLE no adapter"; echo "ENGINE_WINDOWS_UNAVAILABLE exit=5 (gpu-unavailable)"; exit 5; fi
echo "REPORT GPU_READBACK_OK 4096"
[ "$NT_FAKE" = nomenu ] || echo "MENU_PRESSED change-colour"
echo "COMMAND topic=1"; echo "REPORT GPU_COLOUR_CHANGED"; echo 'PROBE {}'
case "$*" in *lifecycle*) echo "LIFECYCLE minimise=hidden restore=visible";; esac
echo "OFFLINE_BLOCKED https://example.com/nativetron-offline-probe.png" >&2
echo "ENGINE_WINDOWS_OK exit=0 (ok)"
`);
    chmodSync(fake, 0o755);
    const run = (mode, name) => {
      const logs = join(dir, name);
      const result = spawnSync("pwsh", ["-NoProfile", "-File", join(here, "acceptance.ps1"), "-Package", dir, "-LogDirectory", logs, "-TimeoutSeconds", "20"],
        { env: { ...process.env, OS: "Windows_NT", NT_FAKE: mode }, encoding: "utf8" });
      return { status: result.status, output: result.stdout + result.stderr, summary: JSON.parse(readFileSync(join(logs, "summary.json"), "utf8").replace(/^\uFEFF/, "")) };
    };
    const pass = run("pass", "pass");
    assert.equal(pass.status, 0, pass.output);
    assert.deepEqual(pass.summary.runs.map((r) => [r.name, r.status]), [["selftest", "pass"], ["lifecycle", "pass"], ["no-isolation", "pass"]]);
    assert.equal(pass.summary.runs[0].offlineBlocked, 1);
    const gpu = run("gpu", "gpu");
    assert.equal(gpu.status, 2, gpu.output);
    assert.equal(gpu.summary.status, "blocked");
    assert.equal(gpu.summary.runs[0].exitName, "gpu-unavailable");
    const nomenu = run("nomenu", "nomenu");
    assert.equal(nomenu.status, 1, nomenu.output);
    assert.ok(nomenu.summary.runs[0].missingEvidence.some((line) => line.includes("MENU_PRESSED")));
    writeFileSync(join(dir, "WebView2Loader.dll"), "");
    const planted = run("pass", "planted");
    assert.equal(planted.status, 1, planted.output);
    assert.ok(planted.summary.packageProblems.some((line) => line.includes("WebView2Loader.dll")));
    assert.deepEqual(planted.summary.runs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

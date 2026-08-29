#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // bench/
const REPO = dirname(ROOT);
const STARTUP_RUNS = 5;
const RUNTIME_SAMPLE_MS = 3000;
const SAMPLE_EVERY_MS = 100;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const kb = (n) => `${n.toLocaleString()} KB`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function dirSizeBytes(p) {
  const out = sh("du", ["-sk", p]);
  return parseInt(out.split(/\s+/)[0], 10) * 1024;
}
function fileSize(p) {
  return existsSync(p) ? statSize(p) : 0;
}
function statSize(p) {
  return statSyncSafe(p)?.size ?? 0;
}
function statSyncSafe(p) {
  try { return statSync(p); } catch { return null; }
}

function resolveElectron() {
  const cacheRoot = join(homedir(), "Library", "Caches", "electron");
  if (!existsSync(cacheRoot)) return null;
  let newest = null;
  for (const d of readdirSync(cacheRoot)) {
    const sub = join(cacheRoot, d);
    if (!statSyncSafe(sub)?.isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (/^electron-v.*-darwin-arm64\.zip$/.test(f)) {
        const full = join(sub, f);
        const m = statSyncSafe(full)?.mtimeMs ?? 0;
        if (!newest || m > newest.mtime) newest = { zip: full, mtime: m, name: f };
      }
    }
  }
  if (!newest) return null;
  const dest = join(tmpdir(), "nt-bench-electron");
  const app = join(dest, "Electron.app");
  const bin = join(app, "Contents", "MacOS", "Electron");
  if (!existsSync(bin)) {
    mkdirSync(dest, { recursive: true });
    execFileSync("ditto", ["-x", "-k", newest.zip, dest]);
  }
  try { execFileSync("xattr", ["-dr", "com.apple.quarantine", app]); } catch {}
  if (!existsSync(bin)) return null;
  const version = sh(bin, ["--version"]).replace(/^v/, "");
  return { bin, app, version };
}

function treePids(root) {
  const out = [root];
  let kids = [];
  try {
    kids = sh("pgrep", ["-P", String(root)]).split("\n").filter(Boolean).map(Number);
  } catch { kids = []; }
  for (const k of kids) out.push(...treePids(k));
  return [...new Set(out)];
}
function sampleTree(root) {
  const pids = treePids(root);
  if (pids.length === 0) return { cpu: 0, rss: 0, procs: 0 };
  let cpu = 0, rss = 0;
  try {
    const out = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", pids.join(",")], { encoding: "utf8" });
    for (const line of out.trim().split("\n")) {
      const [c, r] = line.trim().split(/\s+/).map(Number);
      if (!Number.isNaN(c)) cpu += c;
      if (!Number.isNaN(r)) rss += r;
    }
  } catch {}
  return { cpu, rss, procs: pids.length };
}

function measureStartup(spawnCmd, spawnArgs) {
  const walls = []; // app self-quits on paint; spawnSync blocks to exit

  let readyMs = null;
  for (let i = 0; i < STARTUP_RUNS; i++) {
    const t0 = Date.now();
    const r = spawnSync(spawnCmd, spawnArgs, {
      env: { ...process.env, NT_BENCH_QUIT: "1" },
      encoding: "utf8",
      timeout: 30000,
    });
    walls.push(Date.now() - t0);
    const m = /NT_READY_MS=(\d+)/.exec((r.stdout || "") + (r.stderr || ""));
    if (m) readyMs = Number(m[1]);
  }
  return { wallMedian: median(walls), walls, readyMs };
}

async function measureRuntime(spawnCmd, spawnArgs) {
  const child = spawn(spawnCmd, spawnArgs, { stdio: "ignore", detached: false });
  const root = child.pid;
  await sleep(600); // let it come up
  let peakRSS = 0, steadyRSS = 0, peakCPU = 0, procs = 0;
  const n = Math.floor(RUNTIME_SAMPLE_MS / SAMPLE_EVERY_MS);
  for (let i = 0; i < n; i++) {
    const s = sampleTree(root);
    peakRSS = Math.max(peakRSS, s.rss);
    peakCPU = Math.max(peakCPU, s.cpu);
    procs = Math.max(procs, s.procs);
    if (i >= n - 5) steadyRSS = Math.max(steadyRSS, s.rss); // last ~0.5s
    await sleep(SAMPLE_EVERY_MS);
  }
  try { process.kill(-root); } catch {}
  try { child.kill("SIGKILL"); } catch {}
  return { peakRSS, steadyRSS, peakCPU, procs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nt = {
  main: join(REPO, "build", "main"),
  renderer: join(REPO, "build", "renderer"),
  core: join(REPO, "native", "nativetron_core.o"),
};
const ntBuilt = existsSync(nt.main) && existsSync(nt.renderer);
const electron = resolveElectron();
const electronAppDir = join(ROOT, "electron-app");

const lines = [];
const log = (s = "") => { lines.push(s); console.log(s); };

log(`# nativetron vs Electron — benchmark run`);
log(`host: ${process.platform} ${process.arch}   node: ${process.version}`);
log(`electron: ${electron ? "v" + electron.version + " (cached, de-quarantined)" : "n/a (no cached Electron found)"}`);
log(`date: ${new Date().toISOString()}`);
log("");

const ntDisk = ntBuilt ? fileSize(nt.main) + fileSize(nt.renderer) + fileSize(nt.core) : 0;
const elDisk = electron ? dirSizeBytes(electron.app) : 0;

let ntStart = null, ntRun = null, elStart = null, elRun = null;
if (ntBuilt) {
  log("measuring nativetron (build/renderer)…");
  ntStart = measureStartup(nt.renderer, []);
  ntRun = await measureRuntime(nt.renderer, []);
} else {
  log("nativetron not built — run ./build.sh first.");
}
if (electron) {
  log("measuring Electron (bench/electron-app)…");
  elStart = measureStartup(electron.bin, [electronAppDir]);
  elRun = await measureRuntime(electron.bin, [electronAppDir]);
}
log("");

const ratio = (a, b) => (a && b ? `${(b / a).toFixed(1)}×` : "n/a");
const cell = (v) => (v == null ? "n/a" : v);
log(`## Results\n`);
log(`| metric | nativetron | electron | electron / nativetron |`);
log(`|---|---|---|---|`);
log(`| **Disk (shipped runtime)** | ${ntDisk ? mb(ntDisk) : "n/a"} | ${elDisk ? mb(elDisk) : "n/a"} | ${ratio(ntDisk, elDisk)} |`);
log(`| **Cold start → first paint** (median of ${STARTUP_RUNS}) | ${cell(ntStart && ntStart.wallMedian + " ms")} | ${cell(elStart && elStart.wallMedian + " ms")} | ${ratio(ntStart?.wallMedian, elStart?.wallMedian)} |`);
log(`| **Peak RSS** (process tree) | ${cell(ntRun && kb(ntRun.peakRSS))} | ${cell(elRun && kb(elRun.peakRSS))} | ${ratio(ntRun?.peakRSS, elRun?.peakRSS)} |`);
log(`| **Steady RSS** | ${cell(ntRun && kb(ntRun.steadyRSS))} | ${cell(elRun && kb(elRun.steadyRSS))} | ${ratio(ntRun?.steadyRSS, elRun?.steadyRSS)} |`);
log(`| **Processes** | ${cell(ntRun?.procs)} | ${cell(elRun?.procs)} | — |`);
log(`| **Peak CPU%** (startup, tree) | ${cell(ntRun && ntRun.peakCPU.toFixed(1) + "%")} | ${cell(elRun && elRun.peakCPU.toFixed(1) + "%")} | — |`);
log("");
log(`_Notes: RSS is the summed resident set of the process tree (sampled every`);
log(`${SAMPLE_EVERY_MS} ms). nativetron's out-of-process WKWebView content helper is`);
log(`system-spawned (not a child) and may be undercounted; Electron's helpers are`);
log(`children and fully counted. Disk = what each app ships (nativetron binaries`);
log(`vs the Electron.app runtime); nativetron reuses the OS WebKit, not shipped._`);

writeFileSync(join(ROOT, "last-run.json"), JSON.stringify({
  date: new Date().toISOString(),
  electron: electron?.version ?? null,
  nativetron: ntBuilt ? { diskBytes: ntDisk, ...ntStart, ...ntRun } : null,
  electronResult: electron ? { diskBytes: elDisk, ...elStart, ...elRun } : null,
}, null, 2));

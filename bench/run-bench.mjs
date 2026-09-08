#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const WARMUP_ROUNDS = 3;
const STARTUP_ROUNDS = 15;
const RUNTIME_ROUNDS = 5;
const RUNTIME_SAMPLE_MS = 3000;
const SAMPLE_EVERY_MS = 100;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const kb = (value) => `${value.toLocaleString()} KB`;
const mb = (value) => `${(value / 1048576).toFixed(1)} MB`;

function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}

function directoryBytes(path) {
  return parseInt(sh("du", ["-sk", path]).split(/\s+/)[0], 10) * 1024;
}

function resolveElectron() {
  const cache = join(homedir(), "Library", "Caches", "electron");
  if (!existsSync(cache)) return null;
  let newest = null;
  for (const directory of readdirSync(cache)) {
    const location = join(cache, directory);
    if (!statSafe(location)?.isDirectory()) continue;
    for (const file of readdirSync(location)) {
      const match = /^electron-v(.+)-darwin-arm64\.zip$/.exec(file);
      if (match === null) continue;
      const zip = join(location, file);
      const modified = statSafe(zip)?.mtimeMs ?? 0;
      if (newest === null || modified > newest.modified) newest = { zip, modified, version: match[1] };
    }
  }
  if (newest === null) return null;
  const destination = join(tmpdir(), "nt-bench-electron");
  const app = join(destination, "Electron.app");
  const binary = join(app, "Contents", "MacOS", "Electron");
  if (!existsSync(binary)) {
    mkdirSync(destination, { recursive: true });
    execFileSync("ditto", ["-x", "-k", newest.zip, destination]);
  }
  try { execFileSync("xattr", ["-dr", "com.apple.quarantine", app]); } catch {}
  return existsSync(binary) ? { binary, app, version: newest.version } : null;
}

function treePids(root) {
  const output = [root];
  let children = [];
  try { children = sh("pgrep", ["-P", String(root)]).split("\n").filter(Boolean).map(Number); } catch {}
  for (const child of children) output.push(...treePids(child));
  return [...new Set(output)];
}

function processRows(pids) {
  if (pids.length === 0) return [];
  try {
    const output = execFileSync("ps", ["-o", "pid=,ppid=,%cpu=,rss=,comm=", "-p", pids.join(",")], { encoding: "utf8" });
    return output.trim().split("\n").filter(Boolean).map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
      return match === null ? null : {
        pid: +match[1], ppid: +match[2], cpu: +match[3], rss: +match[4], command: match[5],
      };
    }).filter((row) => row !== null);
  } catch { return []; }
}

function webKitPids() {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
    return new Set(output.trim().split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match !== null && /com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(match[2]) ? [+match[1]] : [];
    }));
  } catch { return new Set(); }
}

function footprintKb(pid) {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("/usr/bin/footprint", ["-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(output);
    if (match === null) return null;
    return Math.round(+match[1] * (match[2] === "GB" ? 1048576 : match[2] === "MB" ? 1024 : 1));
  } catch { return null; }
}

function startupProbe(spec) {
  const started = Date.now();
  const result = spawnSync(spec.command, spec.args, {
    env: { ...process.env, ...spec.env, NT_BENCH_QUIT: "1", NT_BENCH_START_MS: String(started) },
    encoding: "utf8",
    timeout: 30000,
  });
  const output = (result.stdout || "") + (result.stderr || "");
  const ready = /NT_READY_MS=(\d+)/.exec(output);
  if (result.status !== 0 || ready === null) throw new Error(`${spec.name} startup probe failed:\n${output}`);
  const phases = {};
  for (const match of output.matchAll(/NT_BENCH_PHASE=([a-z-]+):(\d+)/g)) phases[match[1]] = +match[2];
  return { ready: +ready[1], wall: Date.now() - started, phases };
}

function measurePairedStartup(first, second) {
  for (let round = 0; round < WARMUP_ROUNDS; round++) {
    const order = round % 2 === 0 ? [first, second] : [second, first];
    for (const spec of order) startupProbe(spec);
  }
  const results = { [first.name]: [], [second.name]: [] };
  for (let round = 0; round < STARTUP_ROUNDS; round++) {
    const order = round % 2 === 0 ? [first, second] : [second, first];
    for (const spec of order) results[spec.name].push(startupProbe(spec));
  }
  return results;
}

function summarizeStartup(samples) {
  const phaseNames = new Set(samples.flatMap((sample) => Object.keys(sample.phases)));
  const phases = {};
  for (const name of phaseNames) phases[name] = median(samples.flatMap((sample) => sample.phases[name] === undefined ? [] : [sample.phases[name]]));
  return {
    readyMedian: median(samples.map((sample) => sample.ready)),
    ready: samples.map((sample) => sample.ready),
    wallMedian: median(samples.map((sample) => sample.wall)),
    phases,
  };
}

async function measureRuntime(spec) {
  const beforeServices = webKitPids();
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env, NT_BENCH_RUNTIME: "1", NT_BENCH_START_MS: String(Date.now()) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 30000;
  while (!output.includes("NT_RUNTIME_READY=1") && Date.now() < deadline) await sleep(20);
  if (!output.includes("NT_RUNTIME_READY=1")) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    throw new Error(`${spec.name} runtime readiness failed:\n${output}`);
  }

  let peakRSS = 0;
  let steadyRSS = 0;
  let peakCPU = 0;
  let processes = 0;
  let lastRows = [];
  const steadyCPUValues = [];
  const samples = Math.floor(RUNTIME_SAMPLE_MS / SAMPLE_EVERY_MS);
  for (let index = 0; index < samples; index++) {
    const rows = processRows(treePids(child.pid));
    const rss = rows.reduce((sum, row) => sum + row.rss, 0);
    const cpu = rows.reduce((sum, row) => sum + row.cpu, 0);
    peakRSS = Math.max(peakRSS, rss);
    peakCPU = Math.max(peakCPU, cpu);
    processes = Math.max(processes, rows.length);
    if (index >= samples - 5) {
      steadyRSS = Math.max(steadyRSS, rss);
      steadyCPUValues.push(cpu);
    }
    lastRows = rows;
    await sleep(SAMPLE_EVERY_MS);
  }

  const afterServices = webKitPids();
  const servicePids = [...afterServices].filter((pid) => !beforeServices.has(pid));
  const serviceRows = processRows(servicePids);
  const serviceRSS = serviceRows.reduce((sum, row) => sum + row.rss, 0);
  const footprintRows = [...lastRows, ...serviceRows].map((row) => ({ ...row, footprint: footprintKb(row.pid) }));
  const footprint = footprintRows.reduce((sum, row) => sum + (row.footprint ?? 0), 0);
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await sleep(200);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  const serviceDeadline = Date.now() + 3000;
  while (servicePids.some((pid) => processRows([pid]).length > 0) && Date.now() < serviceDeadline) await sleep(100);
  return {
    peakRSS, steadyRSS, serviceRSS, accountedRSS: steadyRSS + serviceRSS,
    peakCPU, steadyCPU: median(steadyCPUValues), processes, footprint, rows: footprintRows,
  };
}

function summarizeRuntime(samples) {
  const metrics = ["peakRSS", "steadyRSS", "serviceRSS", "accountedRSS", "peakCPU", "steadyCPU", "processes", "footprint"];
  const summary = {};
  for (const metric of metrics) summary[metric] = median(samples.map((sample) => sample[metric]));
  const representative = [...samples].sort((a, b) => Math.abs(a.footprint - summary.footprint) - Math.abs(b.footprint - summary.footprint))[0];
  summary.rows = representative.rows;
  summary.trials = samples.map(({ rows: _rows, ...sample }) => sample);
  return summary;
}

const electron = resolveElectron();
const nativeMain = join(ROOT, "desktop-app", "build", "main");
const nativeRenderer = join(ROOT, "desktop-app", "build", "renderer");
if (!existsSync(nativeMain) || !existsSync(nativeRenderer)) throw new Error("run ./bench/build-desktop-app.sh first");
if (electron === null) throw new Error("no cached Electron runtime found");

const nativeSpec = {
  name: "nativetron",
  command: nativeMain,
  args: [],
  env: { NT_RENDERER_PATH: nativeRenderer },
};
const electronSpec = {
  name: "electron",
  command: electron.binary,
  args: [join(ROOT, "electron-app")],
  env: {},
};

console.log(`warming and measuring ${STARTUP_ROUNDS} paired/interleaved startup rounds…`);
const paired = measurePairedStartup(nativeSpec, electronSpec);
const nativeStartup = summarizeStartup(paired.nativetron);
const electronStartup = summarizeStartup(paired.electron);
console.log(`measuring ${RUNTIME_ROUNDS} paired/interleaved runtime rounds…`);
const runtimeSamples = { nativetron: [], electron: [] };
for (let round = 0; round < RUNTIME_ROUNDS; round++) {
  const order = round % 2 === 0 ? [nativeSpec, electronSpec] : [electronSpec, nativeSpec];
  for (const spec of order) runtimeSamples[spec.name].push(await measureRuntime(spec));
}
const nativeRuntime = summarizeRuntime(runtimeSamples.nativetron);
const electronRuntime = summarizeRuntime(runtimeSamples.electron);
const nativeDisk = statSync(nativeMain).size + statSync(nativeRenderer).size;
const electronDisk = directoryBytes(electron.app);
const ratio = (native, other) => native > 0 ? `${(other / native).toFixed(1)}×` : "n/a";

const lines = [];
const log = (line = "") => { lines.push(line); console.log(line); };
log("# nativetron vs Electron — equivalent desktop benchmark");
log(`host: ${process.platform} ${process.arch}   node: ${process.version}`);
log(`electron: v${electron.version}`);
log(`date: ${new Date().toISOString()}`);
log("");
log("| metric | nativetron | Electron | Electron / nativetron |");
log("|---|---:|---:|---:|");
log(`| Shipped runtime | ${mb(nativeDisk)} | ${mb(electronDisk)} | ${ratio(nativeDisk, electronDisk)} |`);
log(`| Warm launch → first frame (${STARTUP_ROUNDS}-run median) | ${nativeStartup.phases["frame-one"]} ms | ${electronStartup.phases["frame-one"]} ms | ${ratio(nativeStartup.phases["frame-one"], electronStartup.phases["frame-one"])} |`);
log(`| Warm launch → double-rAF confirmation | ${nativeStartup.readyMedian} ms | ${electronStartup.readyMedian} ms | ${ratio(nativeStartup.readyMedian, electronStartup.readyMedian)} |`);
log(`| Process-tree steady RSS | ${kb(nativeRuntime.steadyRSS)} | ${kb(electronRuntime.steadyRSS)} | ${ratio(nativeRuntime.steadyRSS, electronRuntime.steadyRSS)} |`);
log(`| Newly observed system WebKit RSS | ${kb(nativeRuntime.serviceRSS)} | ${kb(electronRuntime.serviceRSS)} | — |`);
log(`| Accounted steady RSS | ${kb(nativeRuntime.accountedRSS)} | ${kb(electronRuntime.accountedRSS)} | ${ratio(nativeRuntime.accountedRSS, electronRuntime.accountedRSS)} |`);
log(`| Summed physical footprint | ${kb(nativeRuntime.footprint)} | ${kb(electronRuntime.footprint)} | ${ratio(nativeRuntime.footprint, electronRuntime.footprint)} |`);
log(`| Child-tree processes | ${nativeRuntime.processes} | ${electronRuntime.processes} | — |`);
log(`| Steady CPU | ${nativeRuntime.steadyCPU.toFixed(1)}% | ${electronRuntime.steadyCPU.toFixed(1)}% | — |`);
log("");
log("Aligned startup milestones from the parent timestamp:");
log("");
log("| milestone | nativetron | Electron |");
log("|---|---:|---:|");
const alignedPhases = [
  ["Main process/runtime entered", "main-entry"],
  ["Native application ready", "app-ready"],
  ["Renderer code entered", "renderer-entry"],
  ["Window created", "window-created"],
  ["Browser surface created", "browser-created"],
  ["Document ready", "host-ready"],
  ["Initial UI applied", "ui-applied"],
  ["First animation frame", "frame-one"],
];
for (const [label, key] of alignedPhases) {
  const nativeValue = nativeStartup.phases[key];
  const electronValue = electronStartup.phases[key];
  if (nativeValue === undefined || electronValue === undefined) throw new Error(`missing aligned startup phase: ${key}`);
  log(`| ${label} | ${nativeValue} ms | ${electronValue} ms |`);
}
if (nativeStartup.phases["contentful-paint"] !== undefined && electronStartup.phases["contentful-paint"] !== undefined) {
  log(`| Browser-reported first contentful paint | ${nativeStartup.phases["contentful-paint"]} ms | ${electronStartup.phases["contentful-paint"]} ms |`);
}
log(`| Double-rAF confirmation | ${nativeStartup.readyMedian} ms | ${electronStartup.readyMedian} ms |`);
log("");
log(`_Startup uses ${WARMUP_ROUNDS} discarded warmups and alternating AB/BA order. Both apps render the same heading, copy, button, and reactive counter. Milestones are equivalent outcomes even where framework ordering differs. The paint marker is delivered after two animation frames. System WebKit attribution is the RSS of matching service processes first observed after nativetron launch; pre-existing or reused services remain a limitation._`);

const report = {
  date: new Date().toISOString(),
  rounds: { warmup: WARMUP_ROUNDS, startup: STARTUP_ROUNDS, runtime: RUNTIME_ROUNDS, order: "alternating AB/BA" },
  electron: electron.version,
  nativetron: { diskBytes: nativeDisk, startup: nativeStartup, runtime: nativeRuntime },
  electronResult: { diskBytes: electronDisk, startup: electronStartup, runtime: electronRuntime },
};
writeFileSync(join(ROOT, "last-run.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(ROOT, "last-run.md"), lines.join("\n") + "\n");

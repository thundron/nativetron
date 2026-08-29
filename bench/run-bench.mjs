#!/usr/bin/env node
// nativetron-vs-Electron benchmark harness.
//
// Runs on macOS arm64. Measures what is *robustly* measurable in a headless /
// non-interactive shell and is explicit about what is not. See bench/README.md
// for the full methodology and caveats.
//
//   node bench/run-bench.mjs
//
// Metrics
//   1. Artifact size on disk — the "what you actually ship" comparison.
//        nativetron = build/main + build/renderer + native/nativetron_core.o
//                     (the vendored webview is header-only, compiled into the
//                      renderer, so it is already counted inside those bytes).
//        electron   = node_modules/electron/dist  (the Chromium+V8 runtime that
//                     every Electron app ships).
//   2. Cold-start RSS + process/thread counts — launch each app, sample the
//        whole process tree every 100ms for ~3s, record peak & steady RSS.
//        Honest about launches that get killed or exit immediately.

import { spawn, execSync, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, ".."); // nativetron repo root
const ELECTRON_APP = join(__dirname, "electron-app");
const ELECTRON_DIST = join(ELECTRON_APP, "node_modules", "electron", "dist");
const ELECTRON_INSTALL_JS = join(
  ELECTRON_APP,
  "node_modules",
  "electron",
  "install.js",
);

const SAMPLE_MS = 100;
const SAMPLE_COUNT = 30; // ~3s

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dirSizeBytes(path) {
  // `du -sk` in KiB blocks; multiply to bytes (block-usage, matches "on disk").
  try {
    const kb = parseInt(
      execSync(`du -sk ${JSON.stringify(path)}`, { encoding: "utf8" })
        .trim()
        .split(/\s+/)[0],
      10,
    );
    return kb * 1024;
  } catch {
    return null;
  }
}

function fileSizeBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function fmtBytes(n) {
  if (n == null) return "n/a";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]} (${n.toLocaleString()} B)`;
}

function fmtKb(kb) {
  if (kb == null) return "n/a";
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB (${kb.toLocaleString()} KB)`;
}

// Snapshot every process: pid -> {ppid, rss}
function psSnapshot() {
  const out = execSync("ps -axo pid=,ppid=,rss=", { encoding: "utf8" });
  const map = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    map.set(+m[1], { ppid: +m[2], rssKb: +m[3] });
  }
  return map;
}

// All pids in the subtree rooted at `root` (inclusive) that are currently live.
function subtree(root, snap) {
  const children = new Map();
  for (const [pid, { ppid }] of snap) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (snap.has(pid)) out.push(pid);
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return out;
}

function threadCount(pid) {
  try {
    const out = execSync(`ps -M -p ${pid}`, { encoding: "utf8" });
    // header line + one line per thread
    return Math.max(0, out.trim().split("\n").length - 1);
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Launch a binary, sample its process tree, then tear it down.
// Returns a result object describing what happened.
async function profile(label, cmd, args, cwd) {
  const res = {
    label,
    launched: false,
    diedEarly: false,
    exitReason: null,
    samples: [], // { procCount, sumRssKb, threadCount }
    peakRssKb: null,
    steadyRssKb: null,
    peakProcs: 0,
    peakThreads: 0,
  };

  if (!existsSync(cmd)) {
    res.exitReason = `binary not found: ${cmd}`;
    return res;
  }

  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
  } catch (e) {
    res.exitReason = `spawn failed: ${e.message}`;
    return res;
  }

  let exited = null; // { code, signal }
  child.on("error", (e) => {
    if (!res.exitReason) res.exitReason = `spawn error: ${e.message}`;
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const root = child.pid;
  res.launched = Number.isInteger(root);

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    await sleep(SAMPLE_MS);
    const snap = psSnapshot();
    const pids = subtree(root, snap);
    if (pids.length === 0) {
      // whole tree gone
      if (exited) {
        res.diedEarly = true;
        res.exitReason = exited.signal
          ? `killed by ${exited.signal} after ~${((i + 1) * SAMPLE_MS) / 1000}s`
          : `exited code ${exited.code} after ~${((i + 1) * SAMPLE_MS) / 1000}s`;
      }
      break;
    }
    let sumRss = 0;
    let threads = 0;
    for (const p of pids) {
      sumRss += snap.get(p).rssKb;
      threads += threadCount(p);
    }
    res.samples.push({ procCount: pids.length, sumRssKb: sumRss, threadCount: threads });
    res.peakProcs = Math.max(res.peakProcs, pids.length);
    res.peakThreads = Math.max(res.peakThreads, threads);
  }

  // tear down the whole tree
  try {
    execSync(`pkill -TERM -P ${root} 2>/dev/null; kill -TERM ${root} 2>/dev/null`);
  } catch {}
  await sleep(200);
  try {
    execSync(`pkill -KILL -P ${root} 2>/dev/null; kill -KILL ${root} 2>/dev/null`);
  } catch {}

  if (res.samples.length && !res.diedEarly) {
    res.peakRssKb = Math.max(...res.samples.map((s) => s.sumRssKb));
    // steady = median of the last third of samples
    const tail = res.samples.slice(Math.floor(res.samples.length * 2 / 3));
    const sorted = tail.map((s) => s.sumRssKb).sort((a, b) => a - b);
    res.steadyRssKb = sorted[Math.floor(sorted.length / 2)];
  } else if (res.diedEarly) {
    // A launch that was killed / exited before completing init produced only
    // transient stub samples — NOT a representative resident set. Report those
    // as not-measured rather than pretending Electron uses ~0 MB.
    res.peakRssKb = null;
    res.steadyRssKb = null;
    res.peakProcs = 0;
    res.peakThreads = 0;
  } else if (!res.exitReason) {
    res.exitReason = exited
      ? exited.signal
        ? `killed by ${exited.signal} before first sample`
        : `exited code ${exited.code} before first sample`
      : "no RSS samples captured";
    res.diedEarly = true;
  }

  // Heuristic: a GUI runtime (webview host / Chromium) that never grew beyond a
  // single tiny process across the whole window did not actually initialize
  // — it was suspended/blocked by host policy. A real running desktop UI tree
  // is tens of MB across >1 process. Treat such a stub as not-measured rather
  // than reporting a bogus ~0 MB figure.
  if (res.peakRssKb != null && res.peakProcs <= 1 && res.peakRssKb < 20000) {
    res.exitReason =
      `runtime did not initialize — stayed a single ${res.peakRssKb}KB process ` +
      `(no child renderer/GPU processes) for the full ${(SAMPLE_COUNT * SAMPLE_MS) / 1000}s window; ` +
      `blocked/suspended by host security policy`;
    res.diedEarly = true;
    res.peakRssKb = null;
    res.steadyRssKb = null;
    res.peakProcs = 0;
    res.peakThreads = 0;
  }

  return res;
}

// ---------------------------------------------------------------------------
// electron availability (the runtime gets re-extracted here if missing; note
// that on this machine the OS deletes it again on launch — see README)
// ---------------------------------------------------------------------------

function ensureElectron() {
  const bin = join(ELECTRON_DIST, "Electron.app", "Contents", "MacOS", "Electron");
  if (existsSync(bin)) return { ok: true, bin, note: "present" };
  if (existsSync(ELECTRON_INSTALL_JS)) {
    try {
      execFileSync("node", [ELECTRON_INSTALL_JS], {
        cwd: dirname(ELECTRON_INSTALL_JS),
        timeout: 240000,
        stdio: "ignore",
      });
    } catch (e) {
      return { ok: false, bin, note: `re-extract failed: ${e.message}` };
    }
    if (existsSync(bin)) return { ok: true, bin, note: "re-extracted" };
    return { ok: false, bin, note: "re-extract ran but binary still missing" };
  }
  return { ok: false, bin, note: "electron not installed (no install.js)" };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function ratio(nt, el) {
  if (nt == null || el == null || nt === 0) return "n/a";
  // express Electron as a multiple of nativetron (higher = nativetron leaner)
  return `${(el / nt).toFixed(el / nt >= 10 ? 0 : 1)}× (Electron / nativetron)`;
}

async function main() {
  console.log(`# nativetron vs Electron — benchmark run`);
  console.log(`host: ${execSync("uname -sm").toString().trim()}  node: ${process.version}`);
  console.log(`time: ${new Date().toISOString()}\n`);

  // --- sizes (measure BEFORE launching electron; launching may delete it) ---
  const ntMain = fileSizeBytes(join(ROOT, "build", "main"));
  const ntRend = fileSizeBytes(join(ROOT, "build", "renderer"));
  const ntCore = fileSizeBytes(join(ROOT, "native", "nativetron_core.o"));
  const ntTotal =
    ntMain != null && ntRend != null && ntCore != null
      ? ntMain + ntRend + ntCore
      : null;

  const elec = ensureElectron();
  const elDistBytes = elec.ok ? dirSizeBytes(ELECTRON_DIST) : null;

  // --- cold start / RSS ---
  console.log(`## launching nativetron (./build/main)…`);
  const ntProf = await profile(
    "nativetron",
    join(ROOT, "build", "main"),
    [],
    ROOT,
  );
  console.log(`   ${describeProf(ntProf)}\n`);

  console.log(`## launching Electron (${elec.ok ? "runtime present" : elec.note})…`);
  let elProf;
  if (elec.ok) {
    elProf = await profile("electron", elec.bin, [ELECTRON_APP], ELECTRON_APP);
  } else {
    elProf = {
      label: "electron",
      launched: false,
      diedEarly: true,
      exitReason: elec.note,
      samples: [],
      peakRssKb: null,
      steadyRssKb: null,
      peakProcs: 0,
      peakThreads: 0,
    };
  }
  console.log(`   ${describeProf(elProf)}\n`);

  // --- results table ---
  const rows = [];
  rows.push(["**Artifact size shipped**", fmtBytes(ntTotal), fmtBytes(elDistBytes), ratio(ntTotal, elDistBytes)]);
  rows.push(["  — main", fmtBytes(ntMain), "(inside runtime)", "—"]);
  rows.push(["  — renderer", fmtBytes(ntRend), "(inside runtime)", "—"]);
  rows.push(["  — native core .o", fmtBytes(ntCore), "(inside runtime)", "—"]);
  rows.push(["**Peak tree RSS**", fmtKb(ntProf.peakRssKb), fmtKb(elProf.peakRssKb), ratio(ntProf.peakRssKb, elProf.peakRssKb)]);
  rows.push(["**Steady tree RSS**", fmtKb(ntProf.steadyRssKb), fmtKb(elProf.steadyRssKb), ratio(ntProf.steadyRssKb, elProf.steadyRssKb)]);
  rows.push(["**Peak process count**", ntProf.peakProcs || "n/a", elProf.peakProcs || "n/a", "—"]);
  rows.push(["**Peak thread count**", ntProf.peakThreads || "n/a", elProf.peakThreads || "n/a", "—"]);
  rows.push(["**Launch outcome**", launchWord(ntProf), launchWord(elProf), "—"]);

  console.log(`## Results\n`);
  console.log(`| metric | nativetron | electron | ratio |`);
  console.log(`|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
  console.log("");

  console.log(`### Notes`);
  console.log(`- Electron runtime: ${elec.note}.`);
  if (ntProf.exitReason) console.log(`- nativetron launch: ${ntProf.exitReason}.`);
  if (elProf.exitReason) console.log(`- Electron launch: ${elProf.exitReason}.`);
  console.log(`- "Artifact size shipped" is block-usage on disk. The vendored webview is header-only and compiled into the renderer, so it is already inside those bytes; nativetron reuses the OS WKWebView (not shipped). Electron ships its own Chromium+V8 (node_modules/electron/dist).`);
  console.log(`- RSS is the summed resident set of the whole process tree, sampled every ${SAMPLE_MS}ms for up to ${(SAMPLE_COUNT * SAMPLE_MS) / 1000}s.`);
}

function describeProf(p) {
  if (p.diedEarly || !p.samples.length) return `outcome: ${p.exitReason || "no samples"}`;
  return `peakRSS=${p.peakRssKb}KB steadyRSS=${p.steadyRssKb}KB procs=${p.peakProcs} threads=${p.peakThreads}`;
}

function launchWord(p) {
  if (p.samples.length && !p.diedEarly) return "ran, sampled";
  if (p.diedEarly) return `not measured (${p.exitReason || "died early"})`;
  return `not measured (${p.exitReason || "unknown"})`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

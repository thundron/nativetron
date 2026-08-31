import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = path.join(root, "build/main");
const cycles = +(process.env.NT_STRESS_CYCLES ?? "10");
const seconds = +(process.env.NT_STRESS_SECONDS ?? "30");

function launch(mode) {
  const child = spawn(main, [], {
    cwd: root,
    env: { ...process.env, NT_SELFTEST: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => { output += b.toString(); });
  child.stderr.on("data", (b) => { output += b.toString(); });
  return { child, output: () => output };
}

function exited(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function waitFor(run, marker, timeout = 10000) {
  const start = Date.now();
  while (!run.output().includes(marker)) {
    if (run.child.exitCode !== null) throw new Error(`process exited before ${marker}:\n${run.output()}`);
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${marker}:\n${run.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function processTable() {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,command="]);
  return stdout.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: +match[1], ppid: +match[2], rss: +match[3], command: match[4] } : null;
  }).filter(Boolean);
}

function descendants(rows, rootPid) {
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid));
}

async function waitGone(pids, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const rows = await processTable();
    const live = rows.filter((row) => pids.includes(row.pid));
    if (live.length === 0) return;
    if (Date.now() - start > timeout) throw new Error(`processes did not exit: ${live.map((x) => x.pid).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (let i = 0; i < cycles; i++) {
  const run = launch("ipc");
  const result = await exited(run.child);
  assert.equal(result.code, 0, run.output());
  assert.match(run.output(), /NT_IPC_SELFTEST=OK/);
}

const crash = launch("renderer-crash");
const crashResult = await exited(crash.child);
assert.equal(crashResult.code, 23, crash.output());

const idle = launch("stress-idle");
await waitFor(idle, "NT_STRESS_READY=OK");
const initialRows = await processTable();
const initialTree = descendants(initialRows, idle.child.pid);
assert.ok(initialTree.some((row) => row.command.includes("build/renderer")), "renderer child was not found");
const trackedPids = initialTree.map((row) => row.pid);
const samples = [];
for (let i = 0; i < seconds; i++) {
  const tree = descendants(await processTable(), idle.child.pid);
  samples.push(tree.reduce((sum, row) => sum + row.rss, 0));
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const steady = samples.slice(Math.floor(samples.length / 3));
const quarter = Math.max(1, Math.floor(steady.length / 4));
const first = steady.slice(0, quarter).sort((a, b) => a - b)[Math.floor(quarter / 2)];
const lastPart = steady.slice(-quarter).sort((a, b) => a - b);
const last = lastPart[Math.floor(lastPart.length / 2)];
assert.ok(last <= first + 24 * 1024, `idle RSS grew from ${first} KiB to ${last} KiB`);

idle.child.kill("SIGTERM");
await exited(idle.child);
await waitGone(trackedPids);

const leftovers = (await processTable()).filter((row) =>
  row.command.includes(path.join(root, "build/main")) || row.command.includes(path.join(root, "build/renderer")));
assert.deepEqual(leftovers, []);

console.log(`stress: ${cycles} lifecycle cycles, renderer crash propagation, ${seconds}s idle RSS, and parent-death cleanup passed`);

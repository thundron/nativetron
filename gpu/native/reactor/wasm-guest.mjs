// Wasm guest for nt-reactor: runs a scriptc wasm32-wasi reactor (hp-engine.mjs + hp-engine.wasm) in Node/V8 and
// serves its exports over the guest pipe protocol (guest-pipe.c) on fds 3 (requests) and 4 (replies). The parent
// nt-reactor process owns the GPU executor, the queues and the pump, so the native and the wasm reactor run against
// the same executor, driver and script; only the guest differs.
//   node wasm-guest.mjs <dir with hp-engine.mjs/.wasm> [prefix=hp_] [module basename=hp-engine]
import { readSync, writeSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, prefix = 'hp_', base = 'hp-engine'] = process.argv.slice(2);
const IN = 3, OUT = 4;
const pause = new Int32Array(new SharedArrayBuffer(4));
const td = new TextDecoder();

function readExact(n) {
  const b = Buffer.allocUnsafe(n);
  for (let at = 0; at < n;) {
    let k;
    try { k = readSync(IN, b, at, n - at, null); } catch (e) { if (e.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 1); continue; } throw e; }
    if (k === 0) return null;
    at += k;
  }
  return b;
}
function recv() {
  const h = readExact(5);
  if (!h) return null;
  const len = h.readUInt32LE(0);
  return { tag: String.fromCharCode(h[4]), p: len > 1 ? readExact(len - 1) : Buffer.alloc(0) };
}
function writeAll(buf) {
  for (let at = 0; at < buf.length;) {
    try { at += writeSync(OUT, buf, at, buf.length - at); } catch (e) { if (e.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 1); continue; } throw e; }
  }
}
function send(tag, ...parts) {
  const len = 1 + parts.reduce((n, p) => n + p.length, 0);
  const h = Buffer.alloc(5); h.writeUInt32LE(len, 0); h[4] = tag.charCodeAt(0);
  writeAll(h);
  for (const p of parts) if (p.length) writeAll(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
}
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };

let api = null, poisoned = false, wantSha = false, trapped = false;
class Trap extends Error {}
const host = {
  gpuPresent(batch, uploads, readbacks) {
    const sha = wantSha ? createHash('sha256').update(readbacks).digest() : null;
    send('p', u32(batch.length), batch, u32(uploads.length), uploads, u64(readbacks.length), Buffer.from([sha ? 1 : 0]), sha ?? Buffer.alloc(0));
  },
  gpuReport(text) { send('r', Buffer.from(String(text), 'utf8')); },
  engineSend(frame) { send('s', frame); },
  engineOffer(frame) {
    send('o', frame);
    const r = recv();
    if (!r || r.tag !== 'O') process.exit(3);
    return r.p[0];
  },
  panic(message) { trapped = true; send('x', Buffer.from(String(message), 'utf8')); throw new Trap(message); },
};

const NAMES = ['start', 'frame', 'event', 'message', 'receive', 'readback'];
function call(which, a, bytes) {
  const f = api[`${prefix}${NAMES[which]}`];
  switch (which) {
    case 0: return f();
    case 1: return f(a[0]);
    case 2: return f(a[0], a[1], a[2], a[3], a[4], td.decode(bytes));
    case 3: return f(a[0], bytes);
    case 4: return f(bytes);
    case 5: return f(a[0], bytes);
  }
  throw new Error(`bad export ${which}`);
}
function trap(error) {
  poisoned = true;
  // a JS throw that did not go through the panic import (e.g. a RangeError in the glue) is still a trap
  if (!trapped) send('x', Buffer.from(`wasm guest threw: ${error?.stack ?? error}`, 'utf8'));
  send('P');
}

for (;;) {
  const m = recv();
  if (!m) break;
  if (m.tag === 'B') {
    wantSha = m.p[0] === 1;
    try {
      const glue = await import(pathToFileURL(join(dir, `${base}.mjs`)).href);
      // instantiateFromBytes binds the imports (callbacks) and then runs _initialize and the init symbol
      api = await glue.instantiateFromBytes(readFileSync(join(dir, `${base}.wasm`)), host);
      send('R', f64(0));
    } catch (error) { trap(error); }
  } else if (m.tag === 'C') {
    if (poisoned || !api) { send('P'); continue; }
    const which = m.p[0];
    const a = [0, 1, 2, 3, 4].map((i) => m.p.readDoubleLE(1 + 8 * i));
    const n = m.p.readUInt32LE(41);
    const bytes = new Uint8Array(m.p.buffer, m.p.byteOffset + 45, n).slice();
    try { send('R', f64(Number(call(which, a, bytes)))); } catch (error) { trap(error); }
  } else send('E', Buffer.from('unexpected frame'));
}

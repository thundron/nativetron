// nativetron compile-time-reactive core (Solid/Svelte-style), native-first.
//
// Minimal signals/effects with fine-grained dependency tracking. Written in the
// scriptc SUBSET: no Map/Set of functions, no exotic stdlib. Dependency graph is
// kept in plain parallel arrays keyed by integer ids.
//
// Model:
//   - Every effect gets an integer id. A global `currentEffect` points at the
//     effect running right now (-1 when none). Reading a signal during a run
//     records the dependency both ways (signal->effect and effect->signal).
//   - Writing a signal re-runs every subscribed effect. Before an effect runs we
//     clear its old subscriptions so stale deps don't linger (dynamic tracking).

// ---- effect registry -------------------------------------------------------
// Parallel arrays indexed by effect id.
const effectFns: Array<() => void> = []; // the effect body
// For each effect, the list of signal ids it currently depends on.
const effectDeps: number[][] = [];

let currentEffect = -1;

// ---- signal registry -------------------------------------------------------
// Signals are identified by integer id. Only the (homogeneous) subscriber graph
// lives in a global array — the VALUE lives inside each signal's closure as a
// typed `let`, so there is no heterogeneous global store to lower. Per signal we
// keep a list of subscriber effect ids.
const signalSubs: number[][] = []; // subscriber effect ids per signal

export interface Signal<T> {
  get(): T;
  set(v: T): void;
}

function subscribe(sid: number): void {
  if (currentEffect < 0) return;
  const subs = signalSubs[sid];
  // avoid duplicate subscription for the current effect
  for (let i = 0; i < subs.length; i++) {
    if (subs[i] === currentEffect) return;
  }
  subs.push(currentEffect);
  effectDeps[currentEffect].push(sid);
}

export function signal<T>(initial: T): Signal<T> {
  const sid = signalSubs.length;
  signalSubs.push([]);
  let value = initial; // typed `T`, held in the closure — no global `any` store
  return {
    get(): T {
      subscribe(sid);
      return value;
    },
    set(v: T): void {
      value = v;
      // Snapshot subscribers: running an effect re-subscribes, mutating the list.
      const subs = signalSubs[sid];
      const ids: number[] = [];
      for (let i = 0; i < subs.length; i++) ids.push(subs[i]);
      for (let i = 0; i < ids.length; i++) runEffect(ids[i]);
    },
  };
}

// ---- effects ---------------------------------------------------------------
// Remove `eid` from every signal it currently depends on, then clear its dep list.
function clearDeps(eid: number): void {
  const deps = effectDeps[eid];
  for (let i = 0; i < deps.length; i++) {
    const subs = signalSubs[deps[i]];
    for (let j = 0; j < subs.length; j++) {
      if (subs[j] === eid) {
        subs.splice(j, 1);
        break;
      }
    }
  }
  effectDeps[eid] = [];
}

function runEffect(eid: number): void {
  clearDeps(eid);
  const prev = currentEffect;
  currentEffect = eid;
  effectFns[eid]();
  currentEffect = prev;
}

export function effect(fn: () => void): void {
  const eid = effectFns.length;
  effectFns.push(fn);
  effectDeps.push([]);
  runEffect(eid);
}

// ---- computed (derived signal) --------------------------------------------
// Implemented on top of signal+effect: an effect recomputes and writes into a
// backing signal whenever its inputs change.
export function computed<T>(fn: () => T): Signal<T> {
  const s = signal<T>(fn());
  effect(() => {
    s.set(fn());
  });
  return s;
}

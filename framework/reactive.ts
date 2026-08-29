const effectFns: Array<() => void> = []; // the effect body
const effectDeps: number[][] = [];

let currentEffect = -1;

const signalSubs: number[][] = []; // subscriber effect ids per signal

export interface Signal<T> {
  get(): T;
  set(v: T): void;
}

function subscribe(sid: number): void {
  if (currentEffect < 0) return;
  const subs = signalSubs[sid];
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
      const subs = signalSubs[sid];
      const ids: number[] = [];
      for (let i = 0; i < subs.length; i++) ids.push(subs[i]);
      for (let i = 0; i < ids.length; i++) runEffect(ids[i]);
    },
  };
}

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

export function computed<T>(fn: () => T): Signal<T> {
  const s = signal<T>(fn());
  effect(() => {
    s.set(fn());
  });
  return s;
}

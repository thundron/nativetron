export type Cleanup = () => void;
export type EffectBody = () => void | Cleanup;

const effectFns: EffectBody[] = [];
const effectDeps: number[][] = [];
const effectCleanups: Cleanup[] = [];
const effectHasCleanup: boolean[] = [];
const effectActive: boolean[] = [];
const effectPins: number[] = [];
const effectGenerations: number[] = [];
const freeEffects: number[] = [];

let currentEffect = -1;

const signalSubs: number[][] = [];
const signalGenerations: number[] = [];
const signalActive: boolean[] = [];
const freeSignals: number[] = [];
const scopeCleanups: Cleanup[][] = [];

export interface Signal<T> {
  get(): T;
  set(v: T): void;
}

function noop(): void {}

function subscribe(sid: number, generation: number): void {
  if (currentEffect < 0 || !signalActive[sid] ||
      signalGenerations[sid] !== generation) return;
  const subs = signalSubs[sid];
  for (let i = 0; i < subs.length; i++) {
    if (subs[i] === currentEffect) return;
  }
  subs.push(currentEffect);
  effectDeps[currentEffect].push(sid);
}

export function signal<T>(initial: T): Signal<T> {
  let sid: number;
  if (freeSignals.length > 0) {
    sid = freeSignals.pop()!;
    signalSubs[sid] = [];
    signalGenerations[sid] = signalGenerations[sid]! + 1;
    signalActive[sid] = true;
  } else {
    sid = signalSubs.length;
    signalSubs.push([]);
    signalGenerations.push(1);
    signalActive.push(true);
  }
  const generation = signalGenerations[sid]!;
  let value = initial;
  const release = () => releaseSignal(sid, generation);
  if (scopeCleanups.length > 0) scopeCleanups[scopeCleanups.length - 1]!.push(release);
  return {
    get(): T {
      subscribe(sid, generation);
      return value;
    },
    set(v: T): void {
      value = v;
      if (!signalActive[sid] || signalGenerations[sid] !== generation) return;
      const subs = signalSubs[sid];
      const ids: number[] = [];
      for (let i = 0; i < subs.length; i++) {
        const eid = subs[i]!;
        ids.push(eid);
        effectPins[eid] = effectPins[eid]! + 1;
      }
      try {
        for (let i = 0; i < ids.length; i++) runEffect(ids[i]!);
      } finally {
        for (let i = 0; i < ids.length; i++) {
          const eid = ids[i]!;
          effectPins[eid] = effectPins[eid]! - 1;
        }
      }
    },
  };
}

function releaseSignal(sid: number, generation: number): void {
  if (!signalActive[sid] || signalGenerations[sid] !== generation) return;
  signalActive[sid] = false;
  const subs = signalSubs[sid];
  for (let i = 0; i < subs.length; i++) {
    const deps = effectDeps[subs[i]!];
    for (let j = deps.length - 1; j >= 0; j--) {
      if (deps[j] === sid) deps.splice(j, 1);
    }
  }
  signalSubs[sid] = [];
  freeSignals.push(sid);
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

function runCleanup(eid: number): void {
  if (!effectHasCleanup[eid]) return;
  effectHasCleanup[eid] = false;
  const cleanup = effectCleanups[eid];
  effectCleanups[eid] = noop;
  cleanup();
}

function runEffect(eid: number): void {
  if (!effectActive[eid]) return;
  const prev = currentEffect;
  currentEffect = -1;
  try {
    clearDeps(eid);
    runCleanup(eid);
    currentEffect = eid;
    const cleanup = effectFns[eid]();
    if (typeof cleanup === "function") {
      if (effectActive[eid]) {
        effectCleanups[eid] = cleanup;
        effectHasCleanup[eid] = true;
      } else {
        cleanup();
      }
    }
  } finally {
    currentEffect = prev;
  }
}

function disposeEffect(eid: number, generation: number): void {
  if (!effectActive[eid] || effectGenerations[eid] !== generation) return;
  effectActive[eid] = false;
  const prev = currentEffect;
  currentEffect = -1;
  try {
    clearDeps(eid);
    runCleanup(eid);
    effectFns[eid] = noop;
    freeEffects.push(eid);
  } finally {
    currentEffect = prev;
  }
}

export function effect(fn: EffectBody): Cleanup {
  let eid = -1;
  for (let i = freeEffects.length - 1; i >= 0; i--) {
    const candidate = freeEffects[i]!;
    if (effectPins[candidate] === 0) {
      eid = candidate;
      freeEffects.splice(i, 1);
      break;
    }
  }
  if (eid < 0) {
    eid = effectFns.length;
    effectFns.push(fn);
    effectDeps.push([]);
    effectCleanups.push(noop);
    effectHasCleanup.push(false);
    effectActive.push(true);
    effectPins.push(0);
    effectGenerations.push(1);
  } else {
    effectFns[eid] = fn;
    effectDeps[eid] = [];
    effectCleanups[eid] = noop;
    effectHasCleanup[eid] = false;
    effectActive[eid] = true;
    effectGenerations[eid] = effectGenerations[eid]! + 1;
  }
  runEffect(eid);
  const generation = effectGenerations[eid]!;
  const dispose = () => disposeEffect(eid, generation);
  if (scopeCleanups.length > 0) scopeCleanups[scopeCleanups.length - 1]!.push(dispose);
  return dispose;
}

export function beginEffectScope(): void {
  scopeCleanups.push([]);
}

export function onScopeCleanup(cleanup: Cleanup): void {
  if (scopeCleanups.length > 0) scopeCleanups[scopeCleanups.length - 1]!.push(cleanup);
}

export function endEffectScope(): Cleanup {
  const cleanups = scopeCleanups.pop()!;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]!();
  };
}

export function computed<T>(fn: () => T): Signal<T> {
  const s = signal<T>(fn());
  effect(() => {
    s.set(fn());
  });
  return s;
}

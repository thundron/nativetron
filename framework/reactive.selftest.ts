import { signal, effect, computed, beginEffectScope, endEffectScope } from "./reactive.js";

const a = signal<number>(1);
const b = signal<number>(100); // unrelated signal — the effect never reads it

let runs = 0;
effect(() => {
  runs = runs + 1;
  console.log(`effect run #${runs}: a=${a.get()}`);
});

a.set(2);
a.set(3);

b.set(200);
console.log(`after b.set: runs=${runs}`);

a.set(4);

const doubled = computed<number>(() => a.get() * 2);
console.log(`computed doubled=${doubled.get()}`);
a.set(5);
console.log(`computed doubled=${doubled.get()}`);

console.log(`total effect runs=${runs}`);

const replay = signal<number>(0);
let victimRuns = 0;
let replacementRuns = 0;
let victimDispose = (): void => {};
effect(() => {
  const value = replay.get();
  if (value === 1) {
    victimDispose();
    effect(() => { replacementRuns++; });
  }
});
victimDispose = effect(() => {
  replay.get();
  victimRuns++;
});
replay.set(1);
console.log(`pinned replay=${victimRuns}/${replacementRuns}`);

const reused = signal<number>(0);
let reusedRuns = 0;
const oldDispose = effect(() => { reused.get(); });
oldDispose();
const newDispose = effect(() => {
  reused.get();
  reusedRuns++;
});
oldDispose();
reused.set(1);
newDispose();
console.log(`generation reuse=${reusedRuns}`);

beginEffectScope();
const staleSignal = signal<number>(0);
endEffectScope()();
beginEffectScope();
const currentSignal = signal<number>(0);
let signalRuns = 0;
effect(() => { currentSignal.get(); signalRuns++; });
staleSignal.set(1);
currentSignal.set(1);
endEffectScope()();
console.log(`signal generation reuse=${signalRuns}`);

const lifecycle = signal<number>(0);
const cleanupOnly = signal<number>(0);
let lifecycleRuns = 0;
let lifecycleCleanups = 0;
const dispose = effect(() => {
  const value = lifecycle.get();
  lifecycleRuns++;
  console.log(`lifecycle run #${lifecycleRuns}: value=${value}`);
  return () => {
    cleanupOnly.get();
    lifecycleCleanups++;
    console.log(`lifecycle cleanup #${lifecycleCleanups}`);
  };
});
lifecycle.set(1);
cleanupOnly.set(1);
dispose();
lifecycle.set(2);
console.log(`lifecycle totals=${lifecycleRuns}/${lifecycleCleanups}`);

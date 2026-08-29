import { signal, effect, computed } from "./reactive.js";

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

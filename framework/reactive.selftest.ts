// Headless NATIVE self-test for the reactive core. No DOM, no FFI — just
// signal/effect + console.log. Proves: (1) an effect runs once on creation,
// (2) it re-runs when a dependency changes, (3) it does NOT re-run when an
// unrelated signal changes.
//
// Build & run:
//   node "$SCRIPTC" build framework/reactive.selftest.ts --backend c \
//     -o build/reactive-selftest && ./build/reactive-selftest
// Expected stdout is captured in framework/reactive.selftest.expected.txt.
import { signal, effect, computed } from "./reactive.js";

const a = signal<number>(1);
const b = signal<number>(100); // unrelated signal — the effect never reads it

let runs = 0;
effect(() => {
  runs = runs + 1;
  // reads `a` only -> depends on `a`, not on `b`
  console.log(`effect run #${runs}: a=${a.get()}`);
});

// (2) changing a dependency re-runs the effect
a.set(2);
a.set(3);

// (3) changing an unrelated signal must NOT re-run the effect
b.set(200);
console.log(`after b.set: runs=${runs}`);

// setting `a` to a new value re-runs again
a.set(4);

// computed derives from `a` and updates when `a` changes
const doubled = computed<number>(() => a.get() * 2);
console.log(`computed doubled=${doubled.get()}`);
a.set(5);
console.log(`computed doubled=${doubled.get()}`);

console.log(`total effect runs=${runs}`);
